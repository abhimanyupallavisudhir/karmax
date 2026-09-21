import { timed } from '../timing/index.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createGitBundle, knownGitCommits, downloadGitBundle, uploadGitBundle, type GitBundle } from './git-transfer.js';
import { validGitBranch } from '../util/git-ref.js';
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
/** Called with the immutable tip actually transported, never a later world HEAD. */
export type OriginPublicationRecorder = (repo: WorldRepo, headSha: string) => void;
export interface GitBrokerPublishResult {
  pushed: string[];
  skipped: string[];
  /** Per-repository diagnostics for partial publication failures. */
  errors?: Record<string, string>;
}

export interface GitBrokerEnrollmentSpec {
  /** Enrolled SSH-shaped repository URL. Credentials are resolved only by the
   * trusted broker and are never written into the task world. */
  source: string;
  /** Preferred checkout name. A deterministic suffix is added on collision. */
  name?: string;
  branch: string;
  base: string;
  target?: string;
  targetPinned?: boolean;
  identity?: WorldGitIdentity;
}

/**
 * Add a newly attached repository to an already-running world.
 *
 * The authenticated clone and any initialization push happen in a disposable
 * host directory. The world receives only a Git bundle and the public origin
 * URL, preserving the same secret boundary as ordinary world provisioning.
 * Empty repositories are initialized on their configured base branch before
 * the task branch is materialized, so children and later PRs have a real base.
 */
export async function brokerEnrollRepository(
  world: World,
  spec: GitBrokerEnrollmentSpec,
  auth: GitBrokerAuth,
): Promise<WorldRepo> {
  if (!/^(?:ssh:\/\/|git@)/.test(spec.source)) throw new Error('dynamic repository enrollment requires an SSH remote');
  if (!validGitBranch(spec.branch)) throw new Error(`invalid task branch "${spec.branch}"`);
  if (!validGitBranch(spec.base)) throw new Error(`invalid repository base branch "${spec.base}"`);
  if (spec.target && !validGitBranch(spec.target)) throw new Error(`invalid repository target branch "${spec.target}"`);

  const enrolled = worldRepos(world.handle).find((repo) =>
    canonicalRepositoryIdentity(worldRepoSource(repo)) === canonicalRepositoryIdentity(spec.source));
  if (enrolled) return enrolled;
  if (worldRepos(world.handle).some((repo) => repo.root === world.handle.root)) {
    throw new Error('the running world uses a flat repository layout and cannot add another checkout; retry the task to provision the newly attached repository');
  }
  if (!world.writeFileBuffer) throw new Error('this world provider cannot receive brokered Git bundles; retry the task after attaching the repository');

  const name = uniqueEnrollmentName(worldRepos(world.handle), spec.name ?? repositoryName(spec.source));
  const root = path.posix.join(world.handle.root, name);
  const exists = await world.exec('test', ['-e', root], { cwd: world.handle.root });
  if (exists.code === 0) throw new Error(`checkout path "${name}" already exists but is not enrolled; move it aside or retry the task`);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-git-enroll-'));
  let createdWorldPath = false;
  try {
    const provisional: WorldRepo = {
      name, repo: spec.source, root, branch: spec.branch, base: spec.base,
      ...(spec.target ? { target: spec.target } : {}), targetPinned: spec.targetPinned ?? false,
      sourceAuthority: 'origin',
    };
    const credential = await resolveCredential(auth, provisional);
    const { env } = materializeGitCredential(temp, credential);
    const clone = path.join(temp, 'repo');
    const cloned = await git(temp, ['clone', '-q', '--no-checkout', spec.source, clone],
      { env, timeoutMs: 10 * 60_000 });
    if (cloned.code !== 0) throw new Error(`authenticated clone failed: ${cloned.stderr || cloned.stdout}`);

    let baseSha = await firstCommit(clone, [
      `refs/remotes/origin/${spec.branch}`,
      `refs/remotes/origin/${spec.base}`,
      'refs/remotes/origin/HEAD',
    ]);
    if (!baseSha) {
      await ensureIdentity(clone);
      const checkout = await git(clone, ['checkout', '-q', '--orphan', spec.base]);
      if (checkout.code !== 0) throw new Error(`could not initialize empty repository base "${spec.base}": ${checkout.stderr || checkout.stdout}`);
      const commit = await git(clone, [
        ...identityArgs(spec.identity), 'commit', '--allow-empty', '-q', '-m', 'karmax: initialize repository',
      ]);
      if (commit.code !== 0) throw new Error(`could not initialize empty repository: ${commit.stderr || commit.stdout}`);
      const pushed = await git(clone, ['push', 'origin', `refs/heads/${spec.base}:refs/heads/${spec.base}`], { env });
      if (pushed.code !== 0) {
        // A concurrent initializer may have won after our empty clone. Adopt its
        // commit instead of treating the harmless race as a broken attachment.
        const fetched = await git(clone, ['fetch', 'origin', spec.base], { env });
        if (fetched.code !== 0) throw new Error(`could not publish repository base "${spec.base}": ${pushed.stderr || pushed.stdout}`);
        baseSha = await firstCommit(clone, [`refs/remotes/origin/${spec.base}`]);
      } else baseSha = (await git(clone, ['rev-parse', 'HEAD'])).stdout.trim();
    }
    if (!baseSha) throw new Error(`repository has no resolvable base commit after initializing "${spec.base}"`);

    const bootstrapRef = 'refs/heads/karmax-enrollment-bootstrap';
    const updated = await git(clone, ['update-ref', bootstrapRef, baseSha]);
    if (updated.code !== 0) throw new Error(`could not prepare repository bootstrap: ${updated.stderr || updated.stdout}`);
    const bundlePath = path.join(temp, 'bootstrap.bundle');
    const bundled = await git(clone, ['bundle', 'create', bundlePath, bootstrapRef]);
    if (bundled.code !== 0) throw new Error(`could not package repository bootstrap: ${bundled.stderr || bundled.stdout}`);

    const made = await world.exec('mkdir', ['-p', root], { cwd: world.handle.root });
    if (made.code !== 0) throw new Error(`could not create checkout directory: ${made.stderr || made.stdout}`);
    createdWorldPath = true;
    const relativeRoot = path.posix.relative(world.handle.root, root);
    const bundleRelative = `${relativeRoot}/.karmax-enrollment.bundle`;
    await uploadGitBundle(world, bundlePath, bundleRelative);
    await worldGitOrThrow(world, root, ['init', '-q']);
    await worldGitOrThrow(world, root, ['config', 'user.name', spec.identity?.name ?? 'karmax']);
    await worldGitOrThrow(world, root, ['config', 'user.email', spec.identity?.email ?? 'karmax@localhost']);
    await worldGitOrThrow(world, root, ['remote', 'add', 'origin', spec.source]);
    await worldGitOrThrow(world, root, ['fetch', '.karmax-enrollment.bundle',
      `${bootstrapRef}:refs/heads/${spec.branch}`]);
    await worldGitOrThrow(world, root, ['checkout', '-q', spec.branch]);
    await world.exec('rm', ['-f', '.karmax-enrollment.bundle'], { cwd: root });

    const added: WorldRepo = { ...provisional, baseSha };
    world.handle = { ...world.handle, repos: [...worldRepos(world.handle), added] };
    return added;
  } catch (error) {
    if (createdWorldPath) await world.exec('rm', ['-rf', root], { cwd: world.handle.root }).catch(() => undefined);
    throw error;
  } finally {
    removeTemporaryDirectory(temp);
  }
}

async function firstCommit(repo: string, refs: string[]): Promise<string | undefined> {
  for (const ref of refs) {
    const result = await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (result.code === 0 && /^[0-9a-f]{40,64}$/i.test(result.stdout.trim())) return result.stdout.trim();
  }
  return undefined;
}

async function worldGitOrThrow(world: World, cwd: string, args: string[]): Promise<void> {
  const result = await world.exec('git', args, { cwd, timeoutMs: 10 * 60_000 });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || `git ${args[0]} failed`);
}

function repositoryName(remote: string): string {
  const raw = remote.replace(/\/$/, '').split(/[/:]/).pop()?.replace(/\.git$/, '') || 'repo';
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '-');
  return safe && !/^\.+$/.test(safe) ? safe : 'repo';
}

function uniqueEnrollmentName(repos: WorldRepo[], preferred: string): string {
  const used = new Set(repos.map((repo) => repo.name));
  if (!used.has(preferred)) return preferred;
  for (let suffix = 2; ; suffix++) if (!used.has(`${preferred}-${suffix}`)) return `${preferred}-${suffix}`;
}

/** Recursive removal can transiently report ENOTEMPTY/EBUSY after a Git child
 * exits on busy CI filesystems. Node only retries those errors when maxRetries
 * is explicitly set. */
function removeTemporaryDirectory(directory: string): void {
  fs.rmSync(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
}

export function describePublishFailures(result: GitBrokerPublishResult): string {
  if (!result.skipped.length) return '';
  return result.skipped
    .map((repo) => result.errors?.[repo] ? `${repo}: ${result.errors[repo]}` : repo)
    .join('; ');
}

const NON_FAST_FORWARD = /non-fast-forward|fetch first|stale info|\brejected\b/i;
const GIT_AUTHORIZATION = /authentication failed|permission denied|could not read from remote repository|repository not found|http basic: access denied|403\b|401\b/i;

/** Turn Git's provider prose into errors that identify the failing safety layer.
 * In particular, a remote ref race must never be rendered as an instruction to
 * connect a GitHub profile, and a local ancestry break must never mention remote
 * credentials at all. */
export function describeGitPushError(repo: WorldRepo, detail: string): string {
  const compact = detail.trim().replace(/\s+/g, ' ').slice(0, 500);
  if (NON_FAST_FORWARD.test(detail)) {
    return `remote task branch non-fast-forward for "${repo.branch}": origin advanced or diverged, so Karmax did not overwrite it. `
      + `Fetch origin/${repo.branch} and integrate the remote work, or retry a Karmax-owned rebase only after its exact prior PR head is recorded. `
      + `Reconnect GitHub will not fix this remote-state conflict.${compact ? ` Git said: ${compact}` : ''}`;
  }
  if (GIT_AUTHORIZATION.test(detail)) {
    return `GitHub repository transport authorization is missing or expired for "${repo.name}". `
      + `Reconnect or re-authorize the repository's GitHub App installation, then retry.${compact ? ` Git said: ${compact}` : ''}`;
  }
  return compact || 'git push failed';
}

function recordedBaseViolation(repo: WorldRepo): string {
  return `local recorded-base ancestry violation for branch "${repo.branch}"`
    + `${repo.baseSha ? ` (base ${repo.baseSha.slice(0, 12)})` : ''}: the branch no longer descends from the commit provisioned for this task. `
    + 'Karmax did not publish it; reconnecting GitHub will not help. Restore the provisioned HEAD as an ancestor and integrate the selected target normally.';
}

/**
 * Trusted Git handoff for cloud worlds. The untrusted sandbox never receives a
 * write credential: it emits a git bundle, the broker downloads that bundle,
 * performs the authenticated push/merge in a short-lived host checkout, then
 * removes the checkout. Credentials remain JIT host process environment only.
 *
 * Every repo has exactly ONE authoritative repository. A repo provisioned from
 * a host-local checkout (`WorldRepo.localPath`) normally lands there — the same
 * place worktree worlds land — while an explicit `sourceAuthority: 'origin'`
 * records the PR-policy exception where GitHub owns base and landing history.
 * Without this distinction, cloud and local operations silently diverge.
 */
export async function brokerPublishBranch(
  world: World, auth: GitBrokerAuth, expectedRemoteHeads: Record<string, string> = {},
  onPublished?: OriginPublicationRecorder,
): Promise<GitBrokerPublishResult> {
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
      else await pushBranchToOrigin(world, repo, auth, expectedRemoteHeads[repo.name], onPublished);
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
  // PR-policy worlds explicitly name GitHub as their authority. `localPath`
  // remains useful for compatibility files and diagnostics, but must not make
  // the broker route branches or target reads back through a stale checkout.
  if (repo.sourceAuthority === 'origin') return undefined;
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
  if (!validGitBranch(repo.branch)) throw new Error('Git broker rejected an invalid task branch');
  const ref = `refs/heads/${repo.branch}`;
  const worldTip = await world.exec('git', ['rev-parse', '--verify', ref], { cwd: repo.root });
  if (worldTip.code !== 0) throw new Error(`world task branch "${repo.branch}" is unavailable: ${worldTip.stderr || worldTip.stdout}`);
  const localTip = await git(localRepo, ['rev-parse', '--verify', ref]);
  if (localTip.code !== 0) throw new Error(`local task branch "${repo.branch}" is unavailable: ${localTip.stderr || localTip.stdout}`);
  if (worldTip.stdout.trim() !== localTip.stdout.trim())
    throw new Error(`world and local task branch "${repo.branch}" disagree`);
  if (repo.baseSha) {
    const ancestor = await git(localRepo, ['merge-base', '--is-ancestor', repo.baseSha, ref]);
    if (ancestor.code !== 0) throw new Error(recordedBaseViolation(repo));
  }
}

async function pushBranchToOrigin(
  world: World,
  repo: WorldRepo,
  auth: GitBrokerAuth,
  expectedRemoteHead?: string,
  onPublished?: OriginPublicationRecorder,
): Promise<void> {
  await withTransferredRepo(world, repo, auth, async (clone, env) => {
    const ref = `refs/heads/${repo.branch}`;
    const tip = await git(clone, ['rev-parse', '--verify', ref]);
    if (tip.code !== 0) throw new Error(tip.stderr || tip.stdout);
    let result = await git(clone, ['push', 'origin', `${ref}:${ref}`], { env });
    // Integration repair commonly rebases the task-owned proposal branch. That
    // deliberately makes its new tip a non-descendant of the prior PR head, so
    // an ordinary push cannot publish it. Replace only the exact head Karmax
    // recorded at publication: a concurrent writer makes the lease fail instead
    // of being overwritten. With no recorded head we never force an existing
    // branch—the collision needs investigation rather than an ownership guess.
    if (result.code !== 0 && expectedRemoteHead && NON_FAST_FORWARD.test(result.stderr || result.stdout)) {
      result = await git(clone, [
        'push', `--force-with-lease=${ref}:${expectedRemoteHead}`, 'origin', `${ref}:${ref}`,
      ], { env });
    }
    // A child PR merges into its parent's task branch on GitHub. The parent's
    // parked world can race that merge: its checkpoint push starts first, the
    // child advances origin a moment later, and the otherwise-clean checkpoint
    // is rejected as non-fast-forward. If origin contains the complete local
    // task branch, no judgment-bearing merge is needed and no history can be
    // lost: mirror that strict fast-forward back into the world. Genuine
    // divergence still falls through to the diagnostic below.
    if (result.code !== 0 && NON_FAST_FORWARD.test(result.stderr || result.stdout)) {
      const reconciled = await fastForwardWorldFromOrigin(world, repo, clone, env);
      if (reconciled) {
        // This path adopted another writer's advance; it is not authority to
        // overwrite that writer's commit with a later amended proposal.
        return;
      }
    }
    if (result.code !== 0) throw new Error(describeGitPushError(repo, result.stderr || result.stdout || 'push failed'));
    onPublished?.(repo, tip.stdout.trim());
  });
}

/** Mirror a remote-ahead task branch into its sandbox without exposing the
 * broker credential there. The remote must contain the exact world tip; an
 * unrelated or rewritten remote branch is never integrated automatically. */
async function fastForwardWorldFromOrigin(
  world: World,
  repo: WorldRepo,
  clone: string,
  env: Record<string, string>,
): Promise<boolean> {
  const branchRef = `refs/heads/${repo.branch}`;
  const trackingRef = `refs/remotes/origin/${repo.branch}`;
  const fetched = await git(clone, [
    'fetch', '--no-tags', 'origin', `+${branchRef}:${trackingRef}`,
  ], { env, timeoutMs: 10 * 60_000 });
  if (fetched.code !== 0)
    throw new Error(`could not inspect the advanced remote task branch: ${fetched.stderr || fetched.stdout}`);

  const contained = await git(clone, ['merge-base', '--is-ancestor', branchRef, trackingRef]);
  if (contained.code !== 0) return false;

  const transferRef = `refs/karmax/remote-ahead/${cryptoSafeName(repo.branch)}`;
  const incomingRef = 'refs/karmax/remote-ahead';
  const bundleName = `.karmax-remote-ahead-${repo.name.replace(/[^A-Za-z0-9_.-]/g, '-')}.bundle`;
  const bundleRelative = worldRepos(world.handle).length > 1 ? `${repo.name}/${bundleName}` : bundleName;
  const bundlePath = path.join(clone, bundleName);
  try {
    const staged = await git(clone, ['update-ref', transferRef, trackingRef]);
    if (staged.code !== 0) throw new Error(staged.stderr || staged.stdout);
    const known = await knownGitCommits(args => world.exec('git', args, { cwd: repo.root }));
    const bundle = await createGitBundle(args => git(clone, args), transferRef, bundlePath, known);
    if (bundle.path) await uploadGitBundle(world, bundle.path, bundleRelative);

    const imported = await world.exec('git', [
      'fetch', bundle.path ? bundleName : '.', `${bundle.ref}:${incomingRef}`,
    ], { cwd: repo.root, timeoutMs: 10 * 60_000 });
    if (imported.code !== 0)
      throw new Error(`cloud world could not import the advanced task branch: ${imported.stderr || imported.stdout}`);
    const localTip = await world.exec('git', ['rev-parse', '--verify', branchRef], { cwd: repo.root });
    if (localTip.code !== 0)
      throw new Error(`cloud world task branch "${repo.branch}" is unavailable`);
    const stillContained = await world.exec('git', [
      'merge-base', '--is-ancestor', branchRef, incomingRef,
    ], { cwd: repo.root });
    if (stillContained.code !== 0) return false;

    const current = await world.exec('git', ['symbolic-ref', '--quiet', 'HEAD'], { cwd: repo.root });
    const advanced = current.code === 0 && current.stdout.trim() === branchRef
      ? await world.exec('git', ['merge', '--ff-only', incomingRef], { cwd: repo.root })
      : await world.exec('git', [
          'update-ref', branchRef, incomingRef, localTip.stdout.trim(),
        ], { cwd: repo.root });
    if (advanced.code !== 0)
      throw new Error(`could not fast-forward cloud task branch "${repo.branch}": ${advanced.stderr || advanced.stdout}`);
    return true;
  } finally {
    await git(clone, ['update-ref', '-d', transferRef]).catch(() => undefined);
    await world.exec('git', ['update-ref', '-d', incomingRef], { cwd: repo.root }).catch(() => undefined);
    await world.exec('rm', ['-f', bundleName], { cwd: repo.root }).catch(() => undefined);
    fs.rmSync(bundlePath, { force: true });
  }
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
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-git-land-'));
  try {
    await importWorldBranch(world, repo, localRepo, staging, temp);
    if (repo.baseSha) {
      const ancestor = await git(localRepo, ['merge-base', '--is-ancestor', repo.baseSha, staging]);
      if (ancestor.code !== 0) throw new Error(recordedBaseViolation(repo));
    }
    const updated = await git(localRepo, ['fetch', '.', `+${staging}:refs/heads/${repo.branch}`]);
    if (updated.code !== 0) throw new Error(`could not update local task branch "${repo.branch}": ${updated.stderr || updated.stdout}`);
    return (await git(localRepo, ['rev-parse', staging])).stdout.trim();
  } finally {
    await git(localRepo, ['update-ref', '-d', staging]);
    removeTemporaryDirectory(temp);
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
    if (!validGitBranch(repo.branch)) throw new Error(`repo "${repo.name}" has an invalid task branch`);
    const dirty = await world.exec('git', ['status', '--porcelain'], { cwd: repo.root });
    if (dirty.code !== 0) throw new Error(`could not inspect repo "${repo.name}": ${dirty.stderr || dirty.stdout}`);
    if (dirty.stdout.trim()) throw new Error(`repo "${repo.name}" has uncommitted cloud changes; commit or discard them before refreshing`);

    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-git-refresh-'));
    const bundleName = `.karmax-incoming-${crypto.randomUUID()}.bundle`;
    const bundleRelative = repos.length > 1 ? `${repo.name}/${bundleName}` : bundleName;
    try {
      const known = await knownGitCommits(args => world.exec('git', args, { cwd: repo.root }));
      const bundle = await authorityBundle(temp, repo, repo.branch, auth, known, sharesHostRefDatabase(world.handle.kind));
      if (bundle.path) await uploadGitBundle(world, bundle.path, bundleRelative);
      const fetched = await world.exec('git', ['fetch', bundle.path ? bundleName : '.',
        `${bundle.ref}:refs/karmax/handoff`], { cwd: repo.root, timeoutMs: 10 * 60_000 });
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
      removeTemporaryDirectory(temp);
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
      if (!validGitBranch(branch)) throw new Error(`invalid upstream branch "${branch}"`);
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
  if (!validGitBranch(branch)) throw new Error(`Git broker rejected invalid branch "${branch}"`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-git-import-'));
  const bundleName = `.karmax-import-${crypto.randomUUID()}.bundle`;
  const bundleRelative = worldRepos(world.handle).length > 1 ? `${destinationRepo.name}/${bundleName}` : bundleName;
  try {
    const known = await knownGitCommits(args => world.exec('git', args, { cwd: destinationRepo.root }),
      destinationRepo.baseSha ? [destinationRepo.baseSha] : [], [destinationRef]);
    const bundle = await authorityBundle(temp, destinationRepo, branch, auth,
      known, sharesHostRefDatabase(world.handle.kind), preferOrigin);
    if (bundle.path) await uploadGitBundle(world, bundle.path, bundleRelative);
    // Tracking/staging refs may legitimately move backwards or diverge.
    const fetched = await world.exec('git', ['fetch', bundle.path ? bundleName : '.', `+${bundle.ref}:${destinationRef}`],
      { cwd: destinationRepo.root, timeoutMs: 10 * 60_000 });
    if (fetched.code !== 0) throw new Error(`world could not import branch "${branch}": ${fetched.stderr || fetched.stdout}`);
    const head = await world.exec('git', ['rev-parse', destinationRef], { cwd: destinationRepo.root });
    if (head.code !== 0) throw new Error(`could not resolve imported ref ${destinationRef}`);
    return head.stdout.trim();
  } finally {
    await world.exec('rm', ['-f', bundleName], { cwd: destinationRepo.root }).catch(() => undefined);
    removeTemporaryDirectory(temp);
  }
}

function cryptoSafeName(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, '-'); }

/** Bundle `branch` from the repo's authoritative source: the host-local
 * checkout when the world was provisioned from one and it holds the ref
 * (branches of tasks that predate local landing still live only on origin),
 * otherwise an authenticated clone of the SSH remote. Destination-owned commit
 * IDs thin the bundle to missing history. */
async function authorityBundle(temp: string, repo: WorldRepo, branch: string, auth: GitBrokerAuth,
  known: string[], worldRepoIsLocal = false, preferOrigin = false): Promise<GitBundle> {
  const bundlePath = path.join(temp, 'incoming.bundle');
  const local = preferOrigin ? undefined : await localAuthority(repo, worldRepoIsLocal);
  if (local && (await git(local, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0)
    return createGitBundle(args => git(local, args, { timeoutMs: 10 * 60_000 }), `refs/heads/${branch}`, bundlePath, known);
  const source = worldRepoSource(repo);
  if (!/^(?:ssh:\/\/|git@)/.test(source)) throw new Error('Git broker requires an SSH remote');
  const credential = await resolveCredential(auth, repo);
  const { env } = materializeGitCredential(temp, credential);
  const clone = path.join(temp, 'repo');
  const cloned = await git(temp, ['clone', '-q', '--no-checkout', '--branch', branch, '--single-branch', source, clone],
    { env, timeoutMs: 10 * 60_000 });
  if (cloned.code !== 0) throw new Error(`could not fetch branch "${branch}": ${cloned.stderr || cloned.stdout}`);
  return createGitBundle(args => git(clone, args, { timeoutMs: 10 * 60_000 }), `refs/heads/${branch}`, bundlePath, known);
}

export async function brokerFinalizeMerge(
  world: World,
  target: string,
  identity: WorldGitIdentity | undefined,
  auth: GitBrokerAuth,
): Promise<MergeResult> {
  const repos = worldRepos(world.handle);
  if (!repos.length) return { merged: false, landedFiles: [], note: 'cloud scratch world has no remote repository' };
  if (!validGitBranch(target)) throw new Error(`invalid target branch "${target}"`);
  const landedFiles: string[] = [];
  let sha: string | undefined;
  for (const repo of repos) {
    const repoTarget = worldRepoTarget(repo, target);
    if (!validGitBranch(repoTarget)) throw new Error(`invalid target branch "${repoTarget}" for ${repo.root}`);
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
  expectedRemoteHeads: Record<string, string> = {},
  onPublished?: OriginPublicationRecorder,
): Promise<GitBrokerPublishResult> {
  const pushed: string[] = [];
  const skipped: string[] = [];
  const errors: Record<string, string> = {};
  for (const repo of repos) {
    try {
      await pushBranchToOrigin(world, repo, auth, expectedRemoteHeads[repo.name], onPublished);
      pushed.push(repo.name);
    } catch (error) {
      skipped.push(repo.name);
      errors[repo.name] = error instanceof Error ? error.message : String(error);
    }
  }
  return { pushed, skipped, ...(skipped.length ? { errors } : {}) };
}

/** Negotiate against the actual receiving repository, never stale sandbox
 * origin refs. Pin and import only the named task branch, independently of HEAD. */
async function importWorldBranch(world: World, repo: WorldRepo, receiver: string, destinationRef: string, temp: string): Promise<void> {
  if (!validGitBranch(repo.branch)) throw new Error('Git broker rejected an invalid task branch');
  const transferName = `.karmax-transfer-${crypto.randomUUID()}.bundle`;
  const transferRel = worldRepos(world.handle).length > 1 ? `${repo.name}/${transferName}` : transferName;
  const known = await knownGitCommits(args => git(receiver, args), repo.baseSha ? [repo.baseSha] : [],
    [destinationRef, `refs/remotes/origin/${repo.branch}`]);
  try {
    const bundle = await createGitBundle(args => world.exec('git', args,
      { cwd: repo.root, timeoutMs: 10 * 60_000 }), `refs/heads/${repo.branch}`, transferName, known);
    const bundlePath = path.join(temp, 'world.bundle');
    if (bundle.path) await downloadGitBundle(world, transferRel, bundlePath);
    const fetched = await git(receiver, ['fetch', bundle.path ? bundlePath : '.', `+${bundle.ref}:${destinationRef}`],
      { timeoutMs: 10 * 60_000 });
    if (fetched.code !== 0) throw new Error(`bundle import failed: ${fetched.stderr || fetched.stdout}`);
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
    removeTemporaryDirectory(tmp);
  }
  const added = await git(localRepo, ['worktree', 'add', '--force', tmp, repo.branch]);
  if (added.code !== 0) throw new Error(`could not check out the task branch for landing: ${added.stderr || added.stdout}`);
  try {
    return await finalizeMergeRepo({ ...repo, repo: localRepo, root: tmp }, target, worldId, identity);
  } finally {
    await git(localRepo, ['worktree', 'remove', '--force', tmp]);
    removeTemporaryDirectory(tmp);
  }
}

async function withTransferredRepo<T>(
  world: World,
  repo: WorldRepo,
  auth: GitBrokerAuth,
  use: (clone: string, env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const source = worldRepoSource(repo);
  if (!/^(?:ssh:\/\/|git@)/.test(source)) throw new Error('Git broker requires an SSH remote');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-git-broker-'));
  let operationFailed = false;
  try {
    const credential = await resolveCredential(auth, repo);
    const { env } = materializeGitCredential(temp, credential);
    const clone = path.join(temp, 'repo');
    const cloned = await timed('git-broker.clone', () => git(temp, ['clone', '-q', '--no-checkout', source, clone], { env, timeoutMs: 10 * 60_000 }));
    if (cloned.code !== 0) throw new Error(`authenticated clone failed: ${cloned.stderr || cloned.stdout}`);
    await timed('git-broker.import-world', () => importWorldBranch(world, repo, clone, `refs/heads/${repo.branch}`, temp));
    if (repo.baseSha) {
      const ancestor = await git(clone, ['merge-base', '--is-ancestor', repo.baseSha, repo.branch]);
      if (ancestor.code !== 0) throw new Error(recordedBaseViolation(repo));
    }
    return await timed('git-broker.operation', () => use(clone, env));
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      removeTemporaryDirectory(temp);
    } catch (cleanupError) {
      // Cleanup must not replace the useful Git rejection (for example a stale
      // force-with-lease) with an incidental filesystem error.
      if (!operationFailed) throw cleanupError;
    }
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

