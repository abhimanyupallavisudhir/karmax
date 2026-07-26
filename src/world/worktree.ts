import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { World, WorldHandle, WorldProvider, WorldSpec, WorldRepo, ExecOptions, ExecResult, WorldProcess, WorldProcessSpec, WorldPty, WorldPtySpec, worldRelativePath, worldRepos, worldWorkingDirectory } from './types.js';
import { git, gitOrThrow, isGitRepo, ensureIdentity, isolatedGitEnvironment } from './git.js';
import { paths } from '../config/paths.js';
import { expandPath } from '../util/expand.js';
import { openLocalPty, startLocalProcess } from './local-execution.js';

const pexec = promisify(execFile);
const managedRepoClones = new Map<string, Promise<string>>();

/**
 * Local git-worktree world (SPEC §11.2, the default backend). Each task gets an
 * isolated worktree on a `karmax/<taskId>` branch off the project's base. Work
 * is committed and merged into the target branch — the real deliverable lands in
 * the user's repo. The worktree dir is removed at destroy; the branch is kept so
 * the attempt stays inspectable in git history.
 */
export class WorktreeProvider implements WorldProvider {
  readonly kind = 'worktree' as const;
  readonly parkable = false;

  constructor(private home = paths().worlds) {}

  async create(spec: WorldSpec): Promise<World> {
    fs.mkdirSync(this.home, { recursive: true });
    const branch = spec.branch ?? `karmax/${spec.taskId}`;
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
    if (spec.scratch && resolvedSources.length) {
      const scratch = await this.makeScratchRepo(spec.taskId, spec.base);
      resolvedSources.unshift({ repo: scratch, source: 'scratch', managed: false });
    }

    const repos: WorldRepo[] = [];
    const warnings: string[] = [];
    const ephemeralPaths: string[] = [];
    if (resolvedSources.length === 0) {
      // No repo configured — a scratch sandbox (the world itself is the deliverable).
      const scratch = await this.makeScratchRepo(spec.taskId, spec.base);
      repos.push(await this.addWorktree(scratch, root, 'scratch', branch, spec, warnings, undefined, ephemeralPaths));
    } else if (resolvedSources.length === 1) {
      // Single repo: the worktree IS the world root (unchanged layout).
      const resolved = resolvedSources[0]!;
      repos.push(await this.addWorktree(resolved.repo, root, repoName(resolved.source), branch,
        this.repoSpec(spec, resolved.source), warnings, resolved.managed ? resolved.source : undefined, ephemeralPaths,
        '', Boolean(spec.repositoryBranches?.[resolved.source]?.target)));
    } else {
      // Multi-repo: the world root is a parent dir holding one worktree per repo,
      // each in a subdirectory named after the repo (deduped on collision).
      if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
      fs.mkdirSync(root, { recursive: true });
      const names = uniqueNames(resolvedSources.map((resolved) => repoName(resolved.source)));
      for (let i = 0; i < resolvedSources.length; i++) {
        const name = names[i]!;
        const resolved = resolvedSources[i]!;
        repos.push(await this.addWorktree(resolved.repo, path.join(root, name), name, branch,
          this.repoSpec(spec, resolved.source), warnings, resolved.managed ? resolved.source : undefined,
          ephemeralPaths, name, Boolean(spec.repositoryBranches?.[resolved.source]?.target)));
      }
    }

    const handle: WorldHandle = {
      kind: 'worktree',
      id: spec.taskId,
      root,
      branch,
      base: spec.base,
      repo: repos[0]!.repo,
      target: spec.target,
      repos,
      ...(ephemeralPaths.length ? { meta: { ephemeralPaths } } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
    return new WorktreeWorld(handle);
  }

  /**
   * Add a `karmax/<taskId>` worktree for one repo at `wt`, off `spec.base`
   * (falling back to HEAD if that ref is absent). Returns the `WorldRepo` record.
   */
  private async addWorktree(repo: string, wt: string, name: string, branch: string, spec: WorldSpec,
    warnings?: string[], source?: string, ephemeralPaths?: string[], worldPrefix = '', pinnedTarget = false): Promise<WorldRepo> {
    // Resolve a real base ref per repo; fall back to HEAD if the named base is absent.
    let baseRef = spec.base;
    const verify = await git(repo, ['rev-parse', '--verify', `${spec.base}`]);
    if (verify.code !== 0) {
      baseRef = await gitOrThrow(repo, ['rev-parse', 'HEAD']);
      // Don't fork off the wrong ref silently — surface that the configured base
      // was ignored so the misconfiguration is visible (and merges downstream can
      // no longer resolve `base` either; see finalizeMergeRepo).
      warnings?.push(`repo "${name}": base branch "${spec.base}" not found — forked off HEAD instead`);
    }

    // Clean any stale worktree at this path.
    if (fs.existsSync(wt)) {
      await git(repo, ['worktree', 'remove', '--force', wt]);
      fs.rmSync(wt, { recursive: true, force: true });
    }
    await git(repo, ['worktree', 'prune']);
    // Reuse the branch if it already exists, else create it.
    const branchExists = (await git(repo, ['rev-parse', '--verify', branch])).code === 0;
    const addArgs = branchExists
      ? ['worktree', 'add', wt, branch]
      : ['worktree', 'add', '-b', branch, wt, baseRef];
    await gitOrThrow(repo, addArgs);
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

    return { name, repo, ...(source ? { source } : {}), root: wt, branch, base: spec.base,
      ...(spec.target ? { target: spec.target } : {}), targetPinned: pinnedTarget };
  }

  /** Apply a first-class repository attachment's per-repo branch policy. */
  private repoSpec(spec: WorldSpec, source: string): WorldSpec {
    const policy = spec.repositoryBranches?.[source];
    return policy ? { ...spec, base: policy.base, target: policy.target } : spec;
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
    const env: Record<string, string> = spec.gitCredentials?.isolated ? isolatedGitEnvironment() : {};
    try {
      if (key) {
        const keyPath = path.join(credentialDir, 'repository.key');
        fs.writeFileSync(keyPath, key.endsWith('\n') ? key : `${key}\n`, { mode: 0o600 });
        env.GIT_SSH_COMMAND = `ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
      } else if (/^(?:ssh:\/\/|[^\s/@]+@[^\s/:]+:)/i.test(source) && !process.env.GIT_SSH_COMMAND) {
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
   * Give this worktree its git identity (PLAN-git-config.md §4A). With a profile
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

  private async makeScratchRepo(taskId: string, base: string): Promise<string> {
    const repo = path.join(this.home, `scratch-${taskId}`);
    fs.mkdirSync(repo, { recursive: true });
    await gitOrThrow(repo, ['init', '-q', '-b', base || 'main']);
    await ensureIdentity(repo);
    const readme = path.join(repo, 'README.md');
    if (!fs.existsSync(readme)) fs.writeFileSync(readme, `# karmax scratch repo\n`);
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', 'init']);
    return repo;
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
    try {
      const { stdout, stderr } = await pexec(cmd, args, {
        cwd: opts.cwd ?? worldWorkingDirectory(this.handle),
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 64 * 1024 * 1024,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
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

  async listFiles(): Promise<string[]> {
    const repos = worldRepos(this.handle);
    // Single-repo world: root is the worktree, list it directly.
    if (repos.length <= 1) {
      const dir = repos[0]?.root ?? this.handle.root;
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
      await git(r.repo, ['worktree', 'remove', '--force', r.root]);
      await git(r.repo, ['worktree', 'prune']);
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
