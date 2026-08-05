import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { World, WorldGitIdentity, WorldRepo } from './types.js';
import { sharesHostRefDatabase, worldRepos, worldRepoSource, worldRepoTarget } from './types.js';
import { ensureIdentity, git, isGitRepo } from './git.js';
import { finalizeMergeRepo, scratchWorktreeHome, type MergeResult } from './merge.js';
import { materializeGitCredential, type GitCredential } from './git-credential.js';
import { canonicalRepositoryIdentity } from './repository-identity.js';

export interface GitBrokerCredential extends GitCredential {}
export type GitBrokerAuth = Record<string, string> | ((repo: WorldRepo) => Promise<GitBrokerCredential>);
export interface GitBrokerPublishResult {
  pushed: string[];
  skipped: string[];
  /** Per-repository diagnostics for partial publication failures. */
  errors?: Record<string, string>;
}

export function describePublishFailures(result: GitBrokerPublishResult): string {
  if (!result.skipped.length) return '';
  return result.skipped
    .map((repo) => result.errors?.[repo] ? `${repo}: ${result.errors[repo]}` : repo)
    .join('; ');
}

/**
 * Trusted Git handoff for cloud worlds. The untrusted sandbox never receives a
 * write credential: it emits a git bundle, the broker downloads that bundle,
 * performs the authenticated push/merge in a short-lived host checkout, then
 * removes the checkout. Credentials remain JIT host process environment only.
 *
 * Every repo has exactly ONE authoritative repository. A repo provisioned from
 * a host-local checkout (`WorldRepo.localPath`) is authoritative to that
 * checkout: branches and merges land THERE — the same place worktree worlds
 * land — and origin is only the sandbox's clone transport. Repos configured by
 * URL are authoritative to origin (the pre-existing broker behavior). Without
 * this split, cloud merges land on origin while local merges land in the
 * checkout, and the two histories silently diverge.
 */
export async function brokerPublishBranch(world: World, auth: GitBrokerAuth): Promise<GitBrokerPublishResult> {
  const pushed: string[] = [];
  const skipped: string[] = [];
  const errors: Record<string, string> = {};
  for (const repo of worldRepos(world.handle)) {
    try {
      // Worktree-backed worlds already share refs with their source repository.
      // Trying to bundle/fetch the live branch back into that same repository
      // either mistakes its local path for an SSH remote or hits Git's
      // checked-out branch safety interlock. Verify the shared ref instead; no
      // transfer is necessary for another task on this Karmax host to import
      // it. Container worlds qualify too — they bind-mount the very same host
      // worktree — so this must not be a `kind === 'worktree'` test, which used
      // to fall all the way through to "Git broker requires an SSH remote".
      const shared = sharesHostRefDatabase(world.handle.kind);
      const local = await localAuthority(repo, shared);
      if (local && shared) await verifySharedWorktreeBranch(world, repo, local);
      else if (local) await importBranchToLocal(world, repo, local);
      else await pushBranchToOrigin(world, repo, auth);
      pushed.push(repo.name);
    } catch (error) {
      skipped.push(repo.name);
      errors[repo.name] = error instanceof Error ? error.message : String(error);
    }
  }
  return { pushed, skipped, ...(skipped.length ? { errors } : {}) };
}

/** The host-local repository this repo is authoritative to, if any. A recorded
 * checkout that has since vanished is a loud error — silently falling back to
 * origin would reintroduce the split-brain this field exists to prevent.
 * `worldRepoIsLocal` means "this world's checkouts live on the host", i.e. the
 * caller has already established `capabilities.remote === false`. */
async function localAuthority(repo: WorldRepo, worldRepoIsLocal = false): Promise<string | undefined> {
  if (repo.localPath) {
    if (!(await isGitRepo(repo.localPath)))
      throw new Error(`repo "${repo.name}" was provisioned from local checkout ${repo.localPath}, which is no longer a git repository`);
    return repo.localPath;
  }
  // Host-backed handles store their source checkout in `repo`; unlike an
  // explicit localPath this may also be a network URL in test/provider shapes.
  if (worldRepoIsLocal && await isGitRepo(repo.repo)) return repo.repo;
  return undefined;
}

/** A local worktree and its source checkout share one ref database. Publication
 * is therefore a consistency check, not a push or bundle round-trip. */
async function verifySharedWorktreeBranch(world: World, repo: WorldRepo, localRepo: string): Promise<void> {
  if (!safeBranch(repo.branch)) throw new Error('Git broker rejected an invalid task branch');
  const ref = `refs/heads/${repo.branch}`;
  const worldTip = await world.exec('git', ['rev-parse', '--verify', ref], { cwd: repo.root });
  if (worldTip.code !== 0) throw new Error(`world task branch "${repo.branch}" is unavailable: ${worldTip.stderr || worldTip.stdout}`);
  const localTip = await git(localRepo, ['rev-parse', '--verify', ref]);
  if (localTip.code !== 0) throw new Error(`local task branch "${repo.branch}" is unavailable: ${localTip.stderr || localTip.stdout}`);
  if (worldTip.stdout.trim() !== localTip.stdout.trim())
    throw new Error(`world and local task branch "${repo.branch}" disagree`);
  if (repo.baseSha) {
    const ancestor = await git(localRepo, ['merge-base', '--is-ancestor', repo.baseSha, ref]);
    if (ancestor.code !== 0) throw new Error('world branch is not descended from its recorded base commit');
  }
}

async function pushBranchToOrigin(world: World, repo: WorldRepo, auth: GitBrokerAuth): Promise<void> {
  await withTransferredRepo(world, repo, auth, async (clone, env) => {
    const result = await git(clone, ['push', 'origin', `refs/heads/${repo.branch}:refs/heads/${repo.branch}`], { env });
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || 'push failed');
  });
}

/** Import the world's task branch into its authoritative local checkout. The
 * bundle is fetched to a staging ref first so the base-ancestry guard runs
 * before any branch ref moves; the final self-fetch keeps git's refusal to
 * update a checked-out branch as the safety interlock. The world's copy of its
 * own task branch always wins over the local mirror — the only local-side
 * commits it can overwrite are this machinery's own earlier merge commits,
 * which a retry recreates. Returns the imported tip sha. */
async function importBranchToLocal(world: World, repo: WorldRepo, localRepo: string): Promise<string> {
  const staging = `refs/karmax/incoming/${cryptoSafeName(repo.branch)}`;
  const bundle = await readBranchBundle(world, repo);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-git-land-'));
  try {
    const bundlePath = path.join(temp, 'world.bundle');
    await fs.promises.writeFile(bundlePath, bundle, { mode: 0o600 });
    const fetched = await git(localRepo, ['fetch', bundlePath, `+refs/heads/${repo.branch}:${staging}`]);
    if (fetched.code !== 0) throw new Error(`local checkout could not import the world branch: ${fetched.stderr || fetched.stdout}`);
    if (repo.baseSha) {
      const ancestor = await git(localRepo, ['merge-base', '--is-ancestor', repo.baseSha, staging]);
      if (ancestor.code !== 0) throw new Error('world branch is not descended from its recorded base commit');
    }
    const updated = await git(localRepo, ['fetch', '.', `+${staging}:refs/heads/${repo.branch}`]);
    if (updated.code !== 0) throw new Error(`could not update local task branch "${repo.branch}": ${updated.stderr || updated.stdout}`);
    return (await git(localRepo, ['rev-parse', staging])).stdout.trim();
  } finally {
    await git(localRepo, ['update-ref', '-d', staging]);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

/** Pull a human's pushed task-branch commits into a cloud world without ever
 * putting GitHub credentials in that world. The control plane clones through
 * the broker, uploads a credential-free bundle, and accepts only a clean
 * fast-forward. This is the reverse half of brokerPublishBranch. */
export async function brokerRefreshBranch(world: World, auth: GitBrokerAuth): Promise<{
  updated: Array<{ repo: string; branch: string; sha: string }>;
}> {
  const repos = worldRepos(world.handle);
  const updated: Array<{ repo: string; branch: string; sha: string }> = [];
  for (const repo of repos) {
    if (!safeBranch(repo.branch)) throw new Error(`repo "${repo.name}" has an invalid task branch`);
    const dirty = await world.exec('git', ['status', '--porcelain'], { cwd: repo.root });
    if (dirty.code !== 0) throw new Error(`could not inspect repo "${repo.name}": ${dirty.stderr || dirty.stdout}`);
    if (dirty.stdout.trim()) throw new Error(`repo "${repo.name}" has uncommitted cloud changes; commit or discard them before refreshing`);

    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-git-refresh-'));
    const bundleName = `.karmax-incoming-${repo.name.replace(/[^a-zA-Z0-9_.-]/g, '-')}.bundle`;
    const bundleRelative = repos.length > 1 ? `${repo.name}/${bundleName}` : bundleName;
    try {
      const basis = await world.exec('git', ['rev-parse', 'HEAD'], { cwd: repo.root });
      const bundlePath = await authorityBundle(temp, repo, repo.branch, auth,
        basis.code === 0 ? basis.stdout.trim() : undefined, sharesHostRefDatabase(world.handle.kind));
      const data = fs.readFileSync(bundlePath);
      const maxBytes = Number(process.env.KARMAX_MAX_GIT_BUNDLE_MB ?? 256) * 1024 * 1024;
      if (data.length > maxBytes) throw new Error(`incoming branch bundle exceeds ${Math.floor(maxBytes / 1024 / 1024)} MiB policy`);
      if (!world.writeFileBuffer) throw new Error('world provider cannot receive binary Git handoffs');
      await world.writeFileBuffer(bundleRelative, data);
      const fetched = await world.exec('git', ['fetch', bundleName,
        `refs/heads/${repo.branch}:refs/karmax/handoff`], { cwd: repo.root, timeoutMs: 10 * 60_000 });
      if (fetched.code !== 0) throw new Error(`cloud world could not import the branch: ${fetched.stderr || fetched.stdout}`);
      const ancestor = await world.exec('git', ['merge-base', '--is-ancestor', 'HEAD', 'refs/karmax/handoff'], { cwd: repo.root });
      if (ancestor.code !== 0)
        throw new Error(`pushed branch for "${repo.name}" diverged from the cloud world; pull the task branch locally and push a non-destructive fast-forward`);
      const merged = await world.exec('git', ['merge', '--ff-only', 'refs/karmax/handoff'], { cwd: repo.root });
      if (merged.code !== 0) throw new Error(`could not fast-forward repo "${repo.name}": ${merged.stderr || merged.stdout}`);
      const head = await world.exec('git', ['rev-parse', 'HEAD'], { cwd: repo.root });
      if (head.code !== 0) throw new Error(`could not read refreshed commit for "${repo.name}"`);
      updated.push({ repo: repo.name, branch: repo.branch, sha: head.stdout.trim() });
    } finally {
      await world.exec('git', ['update-ref', '-d', 'refs/karmax/handoff'], { cwd: repo.root }).catch(() => undefined);
      await world.exec('rm', ['-f', bundleName], { cwd: repo.root }).catch(() => undefined);
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
  return { updated };
}

export interface ImportedGitRef { repo: string; branch: string; ref: string; sha: string }
export interface GitBrokerRefreshResult {
  refs: ImportedGitRef[];
  skipped: string[];
  /** Per-repository diagnostics when other repositories refreshed successfully. */
  errors?: Record<string, string>;
}

/** Fetch another task branch through the trusted broker and expose it as a
 * namespaced local ref. Nothing is merged automatically: the receiving agent
 * can inspect, test, cherry-pick, or merge it using ordinary local Git. */
export async function brokerImportTaskBranch(destination: World, source: import('./types.js').WorldHandle,
  sourceTaskId: string, auth: GitBrokerAuth): Promise<ImportedGitRef[]> {
  const sourceByRemote = new Map(worldRepos(source)
    .map((repo) => [canonicalRepositoryIdentity(worldRepoSource(repo)), repo]));
  const imported: ImportedGitRef[] = [];
  for (const repo of worldRepos(destination.handle)) {
    const sourceRepo = sourceByRemote.get(canonicalRepositoryIdentity(worldRepoSource(repo)));
    if (!sourceRepo) continue;
    const suffix = sourceTaskId.replace(/[^A-Za-z0-9._-]/g, '-');
    const ref = `refs/karmax/tasks/${suffix}/${repo.name.replace(/[^A-Za-z0-9._-]/g, '-')}`;
    const sha = await brokerFetchRef(destination, repo, sourceRepo.branch, ref, auth);
    imported.push({ repo: repo.name, branch: sourceRepo.branch, ref, sha });
  }
  if (!imported.length) throw new Error('source and destination tasks do not share an enrolled repository');
  return imported;
}

/** Refresh an upstream branch without putting a clone key in the sandbox. The
 * resulting origin/* ref behaves exactly like a normal git fetch to the agent. */
export async function brokerRefreshUpstream(world: World, auth: GitBrokerAuth,
  requestedBranch?: string, targetAuthority: 'project' | 'origin' = 'project'): Promise<GitBrokerRefreshResult> {
  const refreshed: ImportedGitRef[] = [];
  const skipped: string[] = [];
  const errors: Record<string, string> = {};
  for (const repo of worldRepos(world.handle)) {
    try {
      const branch = requestedBranch ?? repo.target ?? repo.base;
      if (!safeBranch(branch)) throw new Error(`invalid upstream branch "${branch}"`);
      const ref = `refs/remotes/origin/${branch}`;
      const sha = await brokerFetchRef(world, repo, branch, ref, auth, targetAuthority === 'origin');
      refreshed.push({ repo: repo.name, branch, ref, sha });
    } catch (error) {
      skipped.push(repo.name);
      errors[repo.name] = error instanceof Error ? error.message : String(error);
    }
  }
  if (!refreshed.length && !skipped.length) throw new Error('task world has no remote repository');
  return { refs: refreshed, skipped, ...(skipped.length ? { errors } : {}) };
}

async function brokerFetchRef(world: World, destinationRepo: WorldRepo, branch: string, destinationRef: string,
  auth: GitBrokerAuth, preferOrigin = false): Promise<string> {
  if (!safeBranch(branch)) throw new Error(`Git broker rejected invalid branch "${branch}"`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-git-import-'));
  const bundleName = `.karmax-import-${cryptoSafeName(destinationRepo.name)}.bundle`;
  const bundleRelative = worldRepos(world.handle).length > 1 ? `${destinationRepo.name}/${bundleName}` : bundleName;
  try {
    const known = await world.exec('git', ['rev-parse', '--verify', '--quiet', destinationRef], { cwd: destinationRepo.root });
    const bundlePath = await authorityBundle(temp, destinationRepo, branch, auth,
      known.code === 0 ? known.stdout.trim() : undefined, sharesHostRefDatabase(world.handle.kind), preferOrigin);
    const data = fs.readFileSync(bundlePath);
    const maxBytes = Number(process.env.KARMAX_MAX_GIT_BUNDLE_MB ?? 256) * 1024 * 1024;
    if (data.length > maxBytes) throw new Error(`incoming branch bundle exceeds ${Math.floor(maxBytes / 1024 / 1024)} MiB policy`);
    if (!world.writeFileBuffer) throw new Error('world provider cannot receive binary Git handoffs');
    await world.writeFileBuffer(bundleRelative, data);
    // These are imported tracking/staging refs, never a checked-out branch. A
    // local-project seed may have moved origin/* to a divergent local commit;
    // refreshing a GitHub PR target must be allowed to restore origin's truth.
    const fetched = await world.exec('git', ['fetch', bundleName, `+refs/heads/${branch}:${destinationRef}`],
      { cwd: destinationRepo.root, timeoutMs: 10 * 60_000 });
    if (fetched.code !== 0) throw new Error(`world could not import branch "${branch}": ${fetched.stderr || fetched.stdout}`);
    const head = await world.exec('git', ['rev-parse', destinationRef], { cwd: destinationRepo.root });
    if (head.code !== 0) throw new Error(`could not resolve imported ref ${destinationRef}`);
    return head.stdout.trim();
  } finally {
    await world.exec('rm', ['-f', bundleName], { cwd: destinationRepo.root }).catch(() => undefined);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function cryptoSafeName(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, '-'); }

/** Bundle `branch` from the repo's authoritative source: the host-local
 * checkout when the world was provisioned from one and it holds the ref
 * (branches of tasks that predate local landing still live only on origin),
 * otherwise an authenticated clone of the SSH remote. `basisSha`, when the
 * receiver already holds it, thins the bundle to just the missing history. */
async function authorityBundle(temp: string, repo: WorldRepo, branch: string, auth: GitBrokerAuth,
  basisSha?: string, worldRepoIsLocal = false, preferOrigin = false): Promise<string> {
  const bundlePath = path.join(temp, 'incoming.bundle');
  const local = preferOrigin ? undefined : await localAuthority(repo, worldRepoIsLocal);
  if (local && (await git(local, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0) {
    const basis = basisSha && (await git(local, ['cat-file', '-e', `${basisSha}^{commit}`])).code === 0
      ? ['--not', basisSha] : [];
    let bundled = await git(local, ['bundle', 'create', bundlePath, `refs/heads/${branch}`, ...basis]);
    // A receiver already at (or past) the tip makes the thin bundle empty, which
    // git refuses to create — fall back to a full bundle; the fetch then no-ops.
    if (bundled.code !== 0 && basis.length) bundled = await git(local, ['bundle', 'create', bundlePath, `refs/heads/${branch}`]);
    if (bundled.code !== 0) throw new Error(`could not package branch "${branch}": ${bundled.stderr || bundled.stdout}`);
    return bundlePath;
  }
  if (!/^(?:ssh:\/\/|git@)/.test(repo.repo)) throw new Error('Git broker requires an SSH remote');
  const credential = await resolveCredential(auth, repo);
  const { env } = materializeGitCredential(temp, credential);
  const clone = path.join(temp, 'repo');
  const cloned = await git(temp, ['clone', '-q', '--branch', branch, '--single-branch', repo.repo, clone],
    { env, timeoutMs: 10 * 60_000 });
  if (cloned.code !== 0) throw new Error(`could not fetch branch "${branch}": ${cloned.stderr || cloned.stdout}`);
  const bundled = await git(clone, ['bundle', 'create', bundlePath, `refs/heads/${branch}`]);
  if (bundled.code !== 0) throw new Error(`could not package branch "${branch}": ${bundled.stderr || bundled.stdout}`);
  return bundlePath;
}

export async function brokerFinalizeMerge(
  world: World,
  target: string,
  identity: WorldGitIdentity | undefined,
  auth: GitBrokerAuth,
): Promise<MergeResult> {
  const repos = worldRepos(world.handle);
  if (!repos.length) return { merged: false, landedFiles: [], note: 'cloud scratch world has no remote repository' };
  const landedFiles: string[] = [];
  let sha: string | undefined;
  for (const repo of repos) {
    const repoTarget = worldRepoTarget(repo, target);
    const dirty = await world.exec('git', ['status', '--porcelain'], { cwd: repo.root });
    if (dirty.code !== 0) return { merged: false, landedFiles, note: `repo "${repo.name}": could not inspect worktree: ${dirty.stderr || dirty.stdout}` };
    if (dirty.stdout.trim()) {
      return {
        merged: false,
        landedFiles,
        dirty: dirty.stdout.split('\n').map((line) => line.slice(3).trim()).filter(Boolean).map((file) => repos.length > 1 ? `${repo.name}/${file}` : file).join('\n'),
        note: `repo "${repo.name}": uncommitted changes — commit what belongs in the change; gitignore or delete what does not`,
      };
    }
    try {
      const local = await localAuthority(repo);
      if (local) {
        // Land in the authoritative local checkout through the exact machinery
        // worktree worlds use — same conflict guards, same target worktree.
        // Nothing is pushed here: origin only moves under the project's remote
        // policy (the pushTarget activity), like every local merge.
        await importBranchToLocal(world, repo, local);
        const one = await landLocalBranch(local, repo, repoTarget, world.handle.id, identity);
        landedFiles.push(...one.landedFiles.map((file) => repos.length > 1 ? `${repo.name}/${file}` : file));
        if (!one.merged) return { ...one, landedFiles };
        sha = one.sha;
        continue;
      }
      const one = await withTransferredRepo(world, repo, auth, async (clone, env) => {
        const fetched = await git(clone, ['fetch', 'origin', repoTarget], { env });
        if (fetched.code !== 0) throw new Error(`target "${repoTarget}" is unavailable: ${fetched.stderr || fetched.stdout}`);
        const changed = await git(clone, ['diff', '--name-only', `origin/${repoTarget}...${repo.branch}`]);
        const files = changed.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
        const marked = await conflictMarkerFiles(clone, repo.branch, files);
        if (marked.length) return { merged: false, landedFiles: files, conflict: marked.join('\n'), note: 'conflict markers are committed in the branch' } satisfies MergeResult;
        const checkout = await git(clone, ['checkout', '-q', '-B', repoTarget, `origin/${repoTarget}`]);
        if (checkout.code !== 0) throw new Error(checkout.stderr || checkout.stdout);
        if (!identity) await ensureIdentity(clone);
        const merge = await git(clone, [
          ...identityArgs(identity),
          'merge', '--no-ff', '--no-edit', '-m', `karmax: merge ${repo.branch} into ${repoTarget}`, repo.branch,
        ]);
        if (merge.code !== 0) {
          const conflicts = await git(clone, ['diff', '--name-only', '--diff-filter=U']);
          await git(clone, ['merge', '--abort']);
          return { merged: false, landedFiles: files, conflict: conflicts.stdout.trim() || merge.stderr || merge.stdout } satisfies MergeResult;
        }
        const pushBranch = await git(clone, ['push', 'origin', `refs/heads/${repo.branch}:refs/heads/${repo.branch}`], { env });
        if (pushBranch.code !== 0) throw new Error(`branch push failed: ${pushBranch.stderr || pushBranch.stdout}`);
        // A concurrent target update becomes a safe non-fast-forward failure; no
        // remote history is overwritten and Temporal can retry through Resolve.
        const pushTarget = await git(clone, ['push', 'origin', `refs/heads/${repoTarget}:refs/heads/${repoTarget}`], { env });
        if (pushTarget.code !== 0) throw new Error(`target push failed (protected or advanced concurrently): ${pushTarget.stderr || pushTarget.stdout}`);
        const head = await git(clone, ['rev-parse', 'HEAD']);
        return { merged: true, sha: head.stdout.trim(), landedFiles: files } satisfies MergeResult;
      });
      landedFiles.push(...one.landedFiles.map((file) => repos.length > 1 ? `${repo.name}/${file}` : file));
      if (!one.merged) return { ...one, landedFiles };
      sha = one.sha;
    } catch (error) {
      return { merged: false, landedFiles, note: `repo "${repo.name}": ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { merged: true, sha, landedFiles, note: `landed by the trusted Git broker${repos.length > 1 ? ` across ${repos.length} repos` : ''}` };
}

/**
 * Push every repo's task branch to its origin. Unlike `brokerPublishBranch`
 * (which routes a repo to its authoritative destination), remote policy 'pr'
 * explicitly sanctions the remote op — so the branch goes to origin even for
 * repos whose merges land in a host-local checkout, because that is where the
 * pull request has to read it from.
 */
export async function brokerPushBranches(
  world: World,
  auth: GitBrokerAuth,
  repos: WorldRepo[] = worldRepos(world.handle),
): Promise<GitBrokerPublishResult> {
  const pushed: string[] = [];
  const skipped: string[] = [];
  const errors: Record<string, string> = {};
  for (const repo of repos) {
    try {
      await pushBranchToOrigin(world, repo, auth);
      pushed.push(repo.name);
    } catch (error) {
      skipped.push(repo.name);
      errors[repo.name] = error instanceof Error ? error.message : String(error);
    }
  }
  return { pushed, skipped, ...(skipped.length ? { errors } : {}) };
}

/** Package the world's named task ref as a bundle and hand it to the host.
 * The BRANCH ref, not HEAD, crosses the boundary: human review terminals and
 * verification servers may legitimately sit on another revision while a
 * committed snapshot is published. */
async function readBranchBundle(world: World, repo: WorldRepo): Promise<Buffer> {
  if (!safeBranch(repo.branch)) throw new Error('Git broker rejected an invalid task branch');
  const transferName = `.karmax-transfer-${cryptoSafeName(repo.name)}.bundle`;
  const transferRel = worldRepos(world.handle).length > 1 ? `${repo.name}/${transferName}` : transferName;
  try {
    const bundle = await world.exec('git', ['bundle', 'create', transferName, `refs/heads/${repo.branch}`],
      { cwd: repo.root, timeoutMs: 10 * 60_000 });
    if (bundle.code !== 0) throw new Error(`could not package cloud branch: ${bundle.stderr || bundle.stdout}`);
    const transferred = await world.readFileBuffer(transferRel);
    const maxBytes = Number(process.env.KARMAX_MAX_GIT_BUNDLE_MB ?? 256) * 1024 * 1024;
    if (transferred.length > maxBytes) throw new Error(`world bundle exceeds ${Math.floor(maxBytes / 1024 / 1024)} MiB policy`);
    return transferred;
  } finally {
    await world.exec('rm', ['-f', transferName], { cwd: repo.root }).catch(() => undefined);
  }
}

/** Land an imported task branch in its authoritative local checkout, through
 * the same per-repo primitive local worktree worlds use. The branch is checked
 * out in a throwaway worktree so `finalizeMergeRepo`'s guards (conflict
 * markers, target-into-branch merge, target-worktree landing) run unchanged. */
async function landLocalBranch(localRepo: string, repo: WorldRepo, target: string, worldId: string,
  identity?: WorldGitIdentity): Promise<MergeResult> {
  // Under karmax storage, never beside the user's repository: a crash between
  // `worktree add` and the `finally` would otherwise litter their source tree
  // with a directory they never created.
  const tmp = path.join(scratchWorktreeHome(), `.karmax-land-${cryptoSafeName(worldId)}-${cryptoSafeName(repo.name)}`);
  if (fs.existsSync(tmp)) {
    await git(localRepo, ['worktree', 'remove', '--force', tmp]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const added = await git(localRepo, ['worktree', 'add', '--force', tmp, repo.branch]);
  if (added.code !== 0) throw new Error(`could not check out the task branch for landing: ${added.stderr || added.stdout}`);
  try {
    return await finalizeMergeRepo({ ...repo, repo: localRepo, root: tmp }, target, worldId, identity);
  } finally {
    await git(localRepo, ['worktree', 'remove', '--force', tmp]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function withTransferredRepo<T>(
  world: World,
  repo: WorldRepo,
  auth: GitBrokerAuth,
  use: (clone: string, env: Record<string, string>) => Promise<T>,
): Promise<T> {
  if (!/^(?:ssh:\/\/|git@)/.test(repo.repo)) throw new Error('Git broker requires an SSH remote');
  const transferred = await readBranchBundle(world, repo);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-git-broker-'));
  try {
    const credential = await resolveCredential(auth, repo);
    const { env } = materializeGitCredential(temp, credential);
    const bundlePath = path.join(temp, 'world.bundle');
    await fs.promises.writeFile(bundlePath, transferred, { mode: 0o600 });
    const clone = path.join(temp, 'repo');
    const cloned = await git(temp, ['clone', '-q', '--no-checkout', repo.repo, clone], { env, timeoutMs: 10 * 60_000 });
    if (cloned.code !== 0) throw new Error(`authenticated clone failed: ${cloned.stderr || cloned.stdout}`);
    const fetched = await git(clone, ['fetch', bundlePath, `refs/heads/${repo.branch}:refs/heads/${repo.branch}`]);
    if (fetched.code !== 0) throw new Error(`bundle import failed: ${fetched.stderr || fetched.stdout}`);
    if (repo.baseSha) {
      const ancestor = await git(clone, ['merge-base', '--is-ancestor', repo.baseSha, repo.branch]);
      if (ancestor.code !== 0) throw new Error('world branch is not descended from its recorded base commit');
    }
    return await use(clone, env);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function resolveCredential(auth: GitBrokerAuth, repo: WorldRepo): Promise<GitBrokerCredential> {
  return typeof auth === 'function' ? auth(repo) : { env: auth };
}

function identityArgs(identity?: WorldGitIdentity): string[] {
  if (!identity) return [];
  const args = ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`];
  if (identity.signingKeyPath) args.push('-c', 'gpg.format=ssh', '-c', `user.signingKey=${identity.signingKeyPath}`, '-c', 'commit.gpgsign=true');
  return args;
}

async function conflictMarkerFiles(dir: string, branch: string, files: string[]): Promise<string[]> {
  if (!files.length) return [];
  const grep = async (pattern: string): Promise<Set<string>> => {
    const result = await git(dir, ['grep', '-l', '-E', pattern, branch, '--', ...files]);
    return new Set(result.stdout.split('\n').map((line) => line.replace(new RegExp(`^${escapeRegExp(branch)}:`), '').trim()).filter(Boolean));
  };
  const open = await grep('^<{7}( |$)');
  const close = await grep('^>{7}( |$)');
  return [...open].filter((file) => close.has(file));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeBranch(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(value)
    && !value.includes('..') && !value.includes('@{') && !value.endsWith('/')
    && !value.endsWith('.lock') && !value.includes('//');
}
