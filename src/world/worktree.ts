import { scrubbedEnv } from '../autonomy/config-homes.js';
import { missingBaseAdjustment } from './branch-fallback.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { World, WorldHandle, WorldProvider, WorldSpec, WorldRepo, WorldCheckoutSpec, ExecOptions, ExecResult, WorldProcess, WorldProcessSpec, WorldPty, WorldPtySpec, worldRelativePath, worldRepos, worldWorkingDirectory } from './types.js';
import { git, gitOrThrow, isGitRepo, ensureIdentity, isolatedGitEnvironment } from './git.js';
import { withWorktreeLock } from './worktree-lock.js';
import { paths } from '../config/paths.js';
import { expandPath } from '../util/expand.js';
import { openLocalPty, startLocalProcess, runLocalCommand } from './local-execution.js';
import { addCheckoutWith } from './checkout.js';
import { materializeGitCredential } from './git-credential.js';
import { readRegularFilePrefix } from './file-prefix.js';
import { taskBranch } from '../domain/brand.js';

const pexec = promisify(execFile);
const managedRepoClones = new Map<string, Promise<string>>();

function listPlainFiles(root: string, relative = ''): string[] {
  const directory = relative ? path.join(root, relative) : root;
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const next = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...listPlainFiles(root, next));
    else if (entry.isFile() || entry.isSymbolicLink()) files.push(next.split(path.sep).join('/'));
  }
  return files;
}

/**
 * Local git-worktree world (SPEC §11.2, the default backend). Each task gets an
 * isolated worktree on a `tavya/<taskId>` branch off the project's base. Work
 * is committed and merged into the target branch — the real deliverable lands in
 * the user's repo. The worktree dir is removed at destroy; the branch is kept so
 * the attempt stays inspectable in git history.
 */
export class WorktreeProvider implements WorldProvider {
  readonly kind = 'worktree' as const;
  readonly parkable = false;
  /** Declared (rather than left undefined) so `/api/meta`'s worldProviders has
   * one shape for every provider, and so `capabilities.remote` is the single
   * question callers ask instead of matching on provider-name lists. */
  readonly capabilities = { remote: false, pty: true, snapshots: false, ports: false, networkPolicy: false } as const;

  constructor(private home = paths().worlds) {}

  async create(spec: WorldSpec): Promise<World> {
    fs.mkdirSync(this.home, { recursive: true });
    const branch = spec.checkouts?.[0]?.branch ?? spec.branch ?? taskBranch(spec.taskId);
    const root = path.join(this.home, spec.taskId);

    // Normalize the configured sources: `repos` (multi) wins over `repo` (legacy single).
    const sources = (spec.repos?.length ? spec.repos : spec.repo ? [spec.repo] : [])
      .map((s) => s?.trim())
      .filter((s): s is string => !!s);

    // Resolve local paths and materialize network sources as persistent managed
    // checkouts. Project Settings deliberately accepts both forms; worktrees
    // always need a local repository to branch from.
    const resolvedSources: Array<{ repo: string; source: string; managed: boolean }> = [];
    for (const s of sources) {
      const r = expandPath(s);
      if (await isGitRepo(r)) {
        resolvedSources.push({ repo: await gitOrThrow(r, ['rev-parse', '--show-toplevel']), source: s, managed: false });
      } else if (isNetworkGitSource(s)) {
        resolvedSources.push({ repo: await this.managedClone(s, spec), source: s, managed: true });
      } else {
        throw new Error(
          `Configured repository "${s}" is not a git repository (resolved to "${r}"). ` +
            `Fix the repository in project Settings (a Git URL, an absolute path, or one starting with ~), ` +
            `or run \`git init\` at that path.`,
        );
      }
    }
    const repos: WorldRepo[] = [];
    const warnings: string[] = [];
    const ephemeralPaths: string[] = [];
    let scratchWorkdir: string | undefined;
    if (resolvedSources.length === 0) {
      // Zero-repo worlds still need a cwd for agent runtimes and commands, but
      // there is no Git deliverable: create only a plain task directory.
      if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
      fs.mkdirSync(root, { recursive: true });
    } else if (resolvedSources.length === 1 && spec.layout !== 'nested' && !spec.scratch) {
      // Single repo: the worktree IS the world root (unchanged layout).
      const resolved = resolvedSources[0]!;
      const source = spec.repositoryOrigins?.[resolved.source] ?? (resolved.managed ? resolved.source : undefined);
      repos.push(await this.addWorktree(resolved.repo, root, spec.checkouts?.[0]?.name ?? repoName(resolved.source), branch,
        { ...this.repoSpec(spec, resolved.source), ...spec.checkouts?.[0] }, warnings, source, ephemeralPaths,
        '', Boolean(spec.repositoryBranches?.[resolved.source]?.target), resolved.source));
    } else {
      // Multi-repo (or a lone repo a multi-PR task asked to nest): the world root
      // is a parent dir holding one worktree per checkout, each in a subdirectory
      // named after the repo (deduped on collision).
      if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
      fs.mkdirSync(root, { recursive: true });
      const names = uniqueNames([...(spec.scratch ? ['scratch'] : []),
        ...resolvedSources.map((resolved, index) => spec.checkouts?.[index]?.name ?? repoName(resolved.source))]);
      if (spec.scratch) {
        scratchWorkdir = path.join(root, names.shift()!);
        fs.mkdirSync(scratchWorkdir, { recursive: true });
      }
      for (let i = 0; i < resolvedSources.length; i++) {
        const name = names[i]!;
        const resolved = resolvedSources[i]!;
        const source = spec.repositoryOrigins?.[resolved.source] ?? (resolved.managed ? resolved.source : undefined);
        repos.push(await this.addWorktree(resolved.repo, path.join(root, name), name, spec.checkouts?.[i]?.branch ?? branch,
          { ...this.repoSpec(spec, resolved.source), ...spec.checkouts?.[i] }, warnings, source,
          ephemeralPaths, name, Boolean(spec.repositoryBranches?.[resolved.source]?.target), resolved.source));
      }
    }

    for (const repo of repos.slice(1)) {
      if (repo.branchAdjustment || (repos[0]?.branchAdjustment && repo.target && repo.target !== repos[0].target)) repo.targetPinned = true;
    }

    const handle: WorldHandle = {
      kind: 'worktree',
      id: spec.taskId,
      root,
      // A nested lone repo leaves the world root a bare parent directory, so
      // point the agent at the checkout rather than at the container holding it.
      // With several repos the agent is meant to see them side by side at the
      // root, and createWorld picks the workdir for companion-repo layouts.
      ...(scratchWorkdir ? { workdir: scratchWorkdir }
        : spec.layout === 'nested' && repos.length === 1 ? { workdir: repos[0]!.root } : {}),
      branch,
      base: repos[0]?.base ?? spec.base,
      ...(repos[0] ? { repo: repos[0].repo } : {}),
      target: repos[0]?.target ?? spec.target,
      repos,
      ...(ephemeralPaths.length ? { meta: { ephemeralPaths } } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
    return new WorktreeWorld(handle);
  }

  /**
   * Add a `tavya/<taskId>` worktree for one repo at `wt`, off `spec.base`
   * (falling back to HEAD if that ref is absent). Returns the `WorldRepo` record.
   */
  private async addWorktree(repo: string, wt: string, name: string, branch: string, spec: WorldSpec,
    warnings?: string[], source?: string, ephemeralPaths?: string[], worldPrefix = '', pinnedTarget = false,
    credentialSource = source ?? repo): Promise<WorldRepo> {
    // Resolve a real base ref per repo; fall back to HEAD if the named base is absent.
    let base = spec.base;
    let target = spec.target;
    let branchAdjustment;
    let baseRef = base;
    let baseSha: string | undefined;
    if (spec.sourceAuthority === 'origin') {
      const refreshed = await this.refreshOriginRefs(repo, spec.base, spec.branch, credentialSource, spec);
      baseRef = refreshed.ref;
      if (refreshed.base !== base) {
        branchAdjustment = missingBaseAdjustment(name, base, target, refreshed.base);
        base = branchAdjustment.base;
        target = branchAdjustment.target;
        warnings?.push(branchAdjustment.warning);
      }
      baseSha = refreshed.sha;
      const local = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${spec.base}`]);
      if (local.code === 0 && local.stdout.trim() !== baseSha) {
        warnings?.push(`repo "${name}": local ${spec.base} differs from origin/${spec.base} — PR policy forked off origin`);
      }
    }
    let verify = await git(repo, ['rev-parse', '--verify', baseRef]);
    if (verify.code !== 0) {
      const fallback = await git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      if (fallback.code !== 0) throw new Error(`Repository "${name}" has no named fallback branch for missing base "${base}"`);
      branchAdjustment = missingBaseAdjustment(name, base, target, fallback.stdout.trim());
      base = branchAdjustment.base;
      target = branchAdjustment.target;
      baseRef = `refs/heads/${base}`;
      warnings?.push(branchAdjustment.warning);
      verify = await git(repo, ['rev-parse', '--verify', baseRef]);
    }
    // The ancestry check needs the exact provisioned commit, not a branch name
    // that may move later. Origin-authoritative worlds set this while fetching;
    // local/project-authoritative worlds resolve the same immutable fact here.
    baseSha ??= verify.code === 0 ? verify.stdout.trim() : undefined;

    // Clean any stale worktree at this path, then claim a fresh one. The prune
    // and the add share one critical section: the prune frees admin-dir names
    // and the add takes the lowest free one, so anything else adding/removing a
    // worktree of this repo in between could be handed — or delete — ours.
    await withWorktreeLock(repo, async () => {
      if (fs.existsSync(wt)) {
        await git(repo, ['worktree', 'remove', '--force', wt]);
        fs.rmSync(wt, { recursive: true, force: true });
      }
      await git(repo, ['worktree', 'prune']);
      if (spec.resetBranch) await deleteForReset(repo, branch, base);
      // Reuse the branch if it already exists, else create it.
      const branchExists = (await git(repo, ['rev-parse', '--verify', branch])).code === 0;
      const originBranch = spec.sourceAuthority === 'origin' && spec.branch && !spec.resetBranch
        ? `refs/remotes/origin/${spec.branch}`
        : undefined;
      const originBranchExists = originBranch
        ? (await git(repo, ['rev-parse', '--verify', originBranch])).code === 0
        : false;
      const addArgs = branchExists
        ? ['worktree', 'add', wt, branch]
        : originBranchExists
          ? ['worktree', 'add', '-b', branch, wt, originBranch!]
        : ['worktree', 'add', '-b', branch, wt, baseRef];
      await gitOrThrow(repo, addArgs);
    });
    await this.applyIdentity(wt, spec.gitIdentity);

    // Make the checkout runnable: a git worktree does NOT inherit the origin
    // repo's `node_modules` (it's gitignored), so any Node project checked out
    // into a world cannot run itself — e.g. karmax dogfooding karmax fails at
    // `import('@anthropic-ai/claude-agent-sdk')` with "Cannot find package …"
    // resolved from the world's own src/. Link the origin's installed deps in so
    // module resolution (and `npm start`/`tsx`) works without a per-world install.
    await this.linkNodeModules(repo, wt);

    // Copy gitignored files the project names (e.g. .env) into this repo's worktree.
    if (spec.copyGlobs?.length) {
      const copied = await this.copyGlobs(repo, wt, spec.copyGlobs);
      ephemeralPaths?.push(...copied.map((file) => worldPrefix ? `${worldPrefix}/${file}` : file));
    }

    return { name, repo, ...(source ? { source } : {}), root: wt, branch, base,
      ...(target ? { target } : {}), targetPinned: pinnedTarget,
      ...(branchAdjustment ? { branchAdjustment } : {}),
      ...(baseSha ? { baseSha } : {}), ...(spec.sourceAuthority === 'origin' ? { sourceAuthority: 'origin' as const } : {}) };
  }

  /** Apply a first-class repository attachment's per-repo branch policy. */
  private repoSpec(spec: WorldSpec, source: string): WorldSpec {
    const policy = spec.repositoryBranches?.[source];
    const sourceAuthority = spec.repositoryAuthorities?.[source] ?? spec.sourceAuthority;
    return {
      ...spec,
      ...(policy ? { base: policy.base, target: policy.target } : {}),
      ...(sourceAuthority ? { sourceAuthority } : {}),
    };
  }

  /** Refresh only the requested PR base into a remote-tracking ref. The user's
   * local branch is never moved: it may deliberately contain local-policy work,
   * while a `pr` task must start from GitHub's protected target. Credentials are
   * materialized for this one trusted fetch and removed immediately. */
  private async refreshOriginRefs(repo: string, base: string, branch: string | undefined, credentialSource: string,
    spec: WorldSpec): Promise<{ ref: string; sha: string; base: string }> {
    const origin = await git(repo, ['remote']);
    const names = origin.stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
    const remote = names.includes('origin') ? 'origin' : names.length === 1 ? names[0]! : undefined;
    if (!remote) throw new Error(`PR-policy repository "${credentialSource}" needs an origin (or exactly one Git remote)`);

    const credentialDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-pr-base-'));
    const key = spec.gitCredentials?.repositories?.[credentialSource] ?? spec.gitCredentials?.sshKey;
    const httpsToken = spec.gitCredentials?.httpsTokens?.[credentialSource];
    const baseEnv: Record<string, string> = spec.gitCredentials?.isolated ? isolatedGitEnvironment() : {};
    const { env } = materializeGitCredential(credentialDir, {
      ...(key ? { sshKey: key } : {}),
      ...(httpsToken ? { httpsToken } : {}),
      env: baseEnv,
    });
    try {
      // Probe before fetching so an authentication/transport failure is never
      // mistaken for a missing branch. Resolve fallback from the remote's HEAD.
      const advertised = await git(repo, ['ls-remote', '--heads', remote, `refs/heads/${base}`], { env });
      if (advertised.code !== 0) throw new Error(`Could not verify PR base "${base}": ${advertised.stderr || advertised.stdout}`);
      if (!advertised.stdout.trim() && !branch) {
        const head = await git(repo, ['ls-remote', '--symref', remote, 'HEAD'], { env });
        const fallback = head.code === 0 ? head.stdout.match(/^ref: refs\/heads\/(.+)\tHEAD$/m)?.[1] : undefined;
        if (!fallback) throw new Error(`PR base "${base}" is missing and ${remote} has no resolvable default branch`);
        base = missingBaseAdjustment(credentialSource, base, spec.target, fallback).base;
      }
      if (spec.target && spec.target !== spec.base && !branch) {
        const advertisedTarget = await git(repo, ['ls-remote', '--heads', remote, `refs/heads/${spec.target}`], { env });
        if (advertisedTarget.code !== 0) throw new Error(`Could not verify PR target "${spec.target}": ${advertisedTarget.stderr || advertisedTarget.stdout}`);
        if (!advertisedTarget.stdout.trim()) throw new Error(`repository "${credentialSource}": target branch "${spec.target}" does not exist; choose an existing target before starting the task`);
      }
      const ref = `refs/remotes/origin/${base}`;
      const wanted = [...new Set([base, branch].filter((value): value is string => Boolean(value)))];
      const fetched = await git(repo, ['fetch', '--no-tags', remote, ...wanted.map((name) =>
        `+refs/heads/${name}:refs/remotes/origin/${name}`)], { env, timeoutMs: 10 * 60_000 });
      if (fetched.code !== 0) {
        throw new Error(`Could not refresh PR base "${base}" from ${remote}: ${fetched.stderr || fetched.stdout}`);
      }
      const resolved = await git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
      const sha = resolved.stdout.trim();
      if (resolved.code !== 0 || !/^[0-9a-f]{40,64}$/i.test(sha))
        throw new Error(`PR base "${base}" fetched from ${remote} has no resolvable commit`);
      return { ref, sha, base };
    } finally {
      fs.rmSync(credentialDir, { recursive: true, force: true });
    }
  }

  /** Clone a configured URL once into Karmax-owned storage. The clone is the
   * stable merge target shared by task worktrees; its origin remains the user's
   * configured remote for optional push/PR policy. Concurrent first tasks share
   * one in-process clone promise so they cannot race a partially-created repo. */
  private async managedClone(source: string, spec: WorldSpec): Promise<string> {
    const destination = managedRepoPath(source, this.home);
    const parent = path.dirname(destination);
    const existing = managedRepoClones.get(destination);
    if (existing) return existing;
    const clone = this.cloneManagedRepo(source, destination, parent, spec);
    managedRepoClones.set(destination, clone);
    try {
      return await clone;
    } finally {
      if (managedRepoClones.get(destination) === clone) managedRepoClones.delete(destination);
    }
  }

  private async cloneManagedRepo(source: string, destination: string, parent: string, spec: WorldSpec): Promise<string> {
    if (await isGitRepo(destination)) return destination;
    fs.mkdirSync(parent, { recursive: true });
    const temporary = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
    const credentialDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-local-clone-'));
    const key = spec.gitCredentials?.repositories?.[source] ?? spec.gitCredentials?.sshKey;
    const httpsToken = spec.gitCredentials?.httpsTokens?.[source];
    const baseEnv: Record<string, string> = spec.gitCredentials?.isolated ? isolatedGitEnvironment() : {};
    const { env } = materializeGitCredential(credentialDir, {
      ...(key ? { sshKey: key } : {}),
      ...(httpsToken ? { httpsToken } : {}),
      env: baseEnv,
    });
    try {
      // `env` already carries the isolated ssh command for a tenant clone; only a
      // host-shell clone with no ssh command of its own gets the fallback.
      if (!key && !httpsToken && /^(?:ssh:\/\/|[^\s/@]+@[^\s/:]+:)/i.test(source) && !env.GIT_SSH_COMMAND && !process.env.GIT_SSH_COMMAND) {
        // A first-ever GitHub clone must not stop on an interactive host-key
        // question; accept-new preserves mismatch protection on later connects.
        env.GIT_SSH_COMMAND = 'ssh -o StrictHostKeyChecking=accept-new';
      }
      const cloned = await git(parent, ['clone', '-q', '--origin', 'origin', source, temporary],
        { timeoutMs: 10 * 60_000, env });
      if (cloned.code !== 0) throw new Error(`Could not clone configured repository "${source}": ${cloned.stderr || cloned.stdout}`);
      if (fs.existsSync(destination)) {
        if (await isGitRepo(destination)) return destination;
        throw new Error(`Managed repository path is not a git repository: ${destination}`);
      }
      fs.renameSync(temporary, destination);
      return destination;
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
      fs.rmSync(credentialDir, { recursive: true, force: true });
    }
  }

  async open(handle: WorldHandle): Promise<World> {
    return new WorktreeWorld(handle);
  }

  /**
   * Give this worktree its git identity (wiki plans/PLAN-git-config §4A). With a profile
   * identity, everything is WORKTREE-scoped (`extensions.worktreeConfig`): the
   * user's own checkout and sibling worlds are untouched, and two concurrent
   * worlds can commit as different accounts. Enabling the extension itself is the
   * one (additive, idempotent) write to the shared repo config. Without a
   * profile, keep the karmax@localhost fallback for identity-less hosts.
   */
  private async applyIdentity(wt: string, id?: WorldSpec['gitIdentity']) {
    if (!id) {
      await ensureIdentity(wt);
      return;
    }
    await git(wt, ['config', 'extensions.worktreeConfig', 'true']);
    await git(wt, ['config', '--worktree', 'user.name', id.name]);
    await git(wt, ['config', '--worktree', 'user.email', id.email]);
    if (id.signingKeyPath) {
      await git(wt, ['config', '--worktree', 'gpg.format', 'ssh']);
      await git(wt, ['config', '--worktree', 'user.signingKey', id.signingKeyPath]);
      await git(wt, ['config', '--worktree', 'commit.gpgsign', 'true']);
    }
  }

  /**
   * Symlink the origin repo's `node_modules` into the worktree so the checkout
   * is immediately runnable (deps resolve, the project can run itself). No-op
   * when the origin has no `node_modules` (non-Node project or deps not yet
   * installed) or the worktree already has one. Best-effort: a failure here must
   * never abort world creation — the world is still usable for source edits.
   */
  private async linkNodeModules(repo: string, root: string) {
    try {
      const src = path.join(repo, 'node_modules');
      const dst = path.join(root, 'node_modules');
      if (!fs.existsSync(src)) return; // nothing to link (e.g. scratch/non-Node repo)
      if (fs.existsSync(dst)) return; // worktree already has its own deps
      fs.symlinkSync(src, dst, 'dir');
      // A `node_modules/` .gitignore rule (trailing slash) matches directories
      // only — NOT a symlink named `node_modules`. Left untracked, an agent's
      // `git add -A` would stage the link and it could be committed/merged. Add
      // an anchored ignore rule to the worktree's exclude so git never sees it.
      await this.ensureIgnored(root, '/node_modules');
    } catch {
      // Best-effort — a broken/duplicate link is preferable to failing the world.
    }
  }

  /** Idempotently add a pattern to this worktree's git exclude file. */
  private async ensureIgnored(root: string, pattern: string) {
    const r = await git(root, ['rev-parse', '--git-path', 'info/exclude']);
    if (r.code !== 0) return;
    const excludePath = path.resolve(root, r.stdout.trim());
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const cur = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
    if (cur.split('\n').some((l) => l.trim() === pattern)) return; // already ignored
    fs.appendFileSync(excludePath, `${cur && !cur.endsWith('\n') ? '\n' : ''}${pattern}\n`);
  }

  private async copyGlobs(repo: string, root: string, globs: string[]): Promise<string[]> {
    const copied = new Set<string>();
    for (const g of globs) {
      // Simple top-level glob support; copy matching files from repo root.
      const entries = fs.existsSync(repo) ? fs.readdirSync(repo) : [];
      const re = globToRegExp(g);
      for (const e of entries) {
        if (re.test(e)) {
          const src = path.join(repo, e);
          const dst = path.join(root, e);
          if (fs.statSync(src).isFile()) {
            fs.copyFileSync(src, dst);
            // Copied gitignored files (canonically `.env` secrets) must not become
            // committable in the worktree — exclude them so `git add -A` can't
            // stage them, matching the node_modules and resource-attachment paths.
            await this.ensureIgnored(root, `/${e}`);
            copied.add(e);
          }
        }
      }
    }
    return [...copied];
  }
}

class WorktreeWorld implements World {
  constructor(public handle: WorldHandle) {}

  async exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const cwd = opts.cwd ?? worldWorkingDirectory(this.handle);
    if (cmd === 'git' && opts.input === undefined) return git(cwd, args, opts);
    const env = scrubbedEnv({ provider: 'mock', extra: opts.env });
    // STDIN (a secret fed to an in-world helper) needs a spawn-based path;
    // execFile cannot pass input. Keep the fast pexec path for the common case.
    if (opts.input !== undefined) {
      return runLocalCommand(cmd, args, { cwd, env, timeoutMs: opts.timeoutMs, input: opts.input });
    }
    try {
      const { stdout, stderr } = await pexec(cmd, args, {
        cwd,
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 64 * 1024 * 1024,
        env,
      });
      return { stdout, stderr, code: 0 };
    } catch (e: any) {
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? String(e?.message ?? e), code: e.code ?? 1 };
    }
  }

  async readFile(relPath: string): Promise<string> {
    return fs.promises.readFile(this.filePath(relPath), 'utf8');
  }

  async readFileBuffer(relPath: string): Promise<Buffer> {
    return fs.promises.readFile(this.filePath(relPath));
  }

  async readFilePrefix(relPath: string, maxBytes: number): Promise<Buffer> {
    return readRegularFilePrefix(this.filePath(relPath), maxBytes);
  }

  async *readFileStream(relPath: string): AsyncGenerator<Buffer> {
    for await (const chunk of fs.createReadStream(this.filePath(relPath))) yield chunk as Buffer;
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    const abs = this.filePath(relPath);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, content);
  }
  async writeFileBuffer(relPath: string, content: Buffer): Promise<void> {
    const abs = this.filePath(relPath);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, content);
  }

  async startProcess(spec: WorldProcessSpec): Promise<WorldProcess> {
    return startLocalProcess(this.handle.root, {
      ...spec,
      cwd: spec.cwd ?? worldWorkingDirectory(this.handle),
    });
  }

  async openPty(spec: WorldPtySpec = {}): Promise<WorldPty> {
    return openLocalPty(this.handle.root, {
      ...spec,
      cwd: spec.cwd ?? worldWorkingDirectory(this.handle),
    });
  }

  /**
   * Check out another branch of one of this world's repos, side by side with the
   * existing ones (SPEC §11.1 `addCheckout`). This is the whole multi-PR
   * primitive on the local backend: a `WorldRepo` is already
   * `(source, dir, branch, base, target)` and merge/PR/queue all iterate them,
   * so an extra entry IS an extra pull request.
   */
  async addCheckout(spec: WorldCheckoutSpec): Promise<WorldHandle> {
    this.handle = await addCheckoutWith(this.handle, spec, {
      git: (cwd, args) => git(cwd, args),
      removeDir: async (absPath) => { fs.rmSync(absPath, { recursive: true, force: true }); },
    }, (from, added) => this.inheritWorktreeSetup(from.root, added.root));
    return this.handle;
  }

  /** Copy the forked checkout's worktree-scoped identity and node_modules link
   *  onto a newly added one, so a branch added mid-task commits as the same
   *  author and can still run the project. Best-effort, like world creation. */
  private async inheritWorktreeSetup(from: string, to: string) {
    try {
      for (const key of ['user.name', 'user.email', 'gpg.format', 'user.signingKey', 'commit.gpgsign']) {
        const value = await git(from, ['config', '--get', key]);
        if (value.code !== 0 || !value.stdout.trim()) continue;
        if (key === 'user.name') await git(to, ['config', 'extensions.worktreeConfig', 'true']);
        await git(to, ['config', '--worktree', key, value.stdout.trim()]);
      }
      const src = path.join(from, 'node_modules');
      const dst = path.join(to, 'node_modules');
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.symlinkSync(fs.realpathSync(src), dst, 'dir');
        const exclude = await git(to, ['rev-parse', '--git-path', 'info/exclude']);
        if (exclude.code === 0) {
          const excludePath = path.resolve(to, exclude.stdout.trim());
          fs.mkdirSync(path.dirname(excludePath), { recursive: true });
          fs.appendFileSync(excludePath, '/node_modules\n');
        }
      }
    } catch {
      // A missing identity or link must not cost the task its branch.
    }
  }

  async listFiles(): Promise<string[]> {
    const repos = worldRepos(this.handle);
    if (!repos.length) return listPlainFiles(this.handle.root);
    // Single-repo world: root is the worktree, list it directly.
    if (repos.length === 1) {
      const dir = repos[0]!.root;
      const r = await git(dir, ['ls-files', '--cached', '--others', '--exclude-standard']);
      return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    }
    // Multi-repo world: root is the parent — aggregate each repo, prefixed by its subdir.
    const out: string[] = [];
    for (const r of repos) {
      const listed = await git(r.root, ['ls-files', '--cached', '--others', '--exclude-standard']);
      for (const f of listed.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) out.push(`${r.name}/${f}`);
    }
    return out;
  }

  async destroy(): Promise<void> {
    const repos = worldRepos(this.handle);
    for (const r of repos) {
      await withWorktreeLock(r.repo, async () => {
        await git(r.repo, ['worktree', 'remove', '--force', r.root]);
        await git(r.repo, ['worktree', 'prune']);
      });
    }
    if (fs.existsSync(this.handle.root)) fs.rmSync(this.handle.root, { recursive: true, force: true });
  }

  private filePath(relPath: string): string {
    const safe = worldRelativePath(relPath);
    if (safe === '.') throw new Error('path is a directory');
    return path.join(this.handle.root, ...safe.split('/'));
  }
}

/** Stable host-side checkout location for network repositories. Onboarding can
 * inspect it without imposing any repository layout on the user. */
export function managedRepoPath(source: string, home = paths().worlds): string {
  const hash = crypto.createHash('sha256').update(source).digest('hex').slice(0, 20);
  const name = repoName(source).replace(/[^a-zA-Z0-9_.-]/g, '-') || 'repo';
  return path.join(home, '.repositories', `${name}-${hash}`);
}

/**
 * Delete a task branch so a reset world starts from its base. A branch that
 * survives would be reused below with its old commits, so any failure other
 * than "no such branch" stops the reset. Git refuses to delete (or force-move)
 * a branch checked out in another worktree, and moving it anyway would rewrite
 * that checkout under its owner, so the owner is told how to release it.
 */
async function deleteForReset(repo: string, branch: string, base: string): Promise<void> {
  const deleted = await git(repo, ['branch', '-D', branch]);
  if (deleted.code === 0 || (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code !== 0) return;
  const holder = /(?:checked out|used by worktree) at '([^']+)'/.exec(deleted.stderr)?.[1];
  throw new Error(holder
    ? `can't reset branch "${branch}" to "${base}": it is checked out at ${holder}. `
      + `Switch that checkout off it (\`git -C ${holder} switch --detach\`), then reset again.`
    : `can't reset branch "${branch}" to "${base}": ${deleted.stderr.trim() || `git branch -D exited ${deleted.code}`}`);
}

/** The repo's basename (its worktree subdirectory name in a multi-repo world). */
function repoName(repo: string): string {
  return (repo.split(/[/:]/).filter(Boolean).pop() ?? 'repo').replace(/\.git$/i, '');
}

/** Git's common network transports, including file:// for self-hosted remotes. */
function isNetworkGitSource(source: string): boolean {
  return /^(?:(?:https?|ssh|git|file):\/\/|[^\s/@]+@[^\s/:]+:)[^\s]+$/i.test(source.trim());
}

/** Disambiguate colliding repo basenames by suffixing `-2`, `-3`, … in order. */
function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const count = seen.get(n) ?? 0;
    seen.set(n, count + 1);
    return count === 0 ? n : `${n}-${count + 1}`;
  });
}

function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`);
}
