import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { World, WorldHandle, WorldProvider, WorldSpec, WorldRepo, ExecOptions, ExecResult, worldRepos } from './types.js';
import { git, gitOrThrow, isGitRepo, ensureIdentity } from './git.js';
import { paths } from '../config/paths.js';
import { expandPath } from '../util/expand.js';

const pexec = promisify(execFile);

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

    // Resolve + validate each source to its git toplevel up-front, so a bad path
    // fails before we start creating worktrees.
    const resolvedSources: string[] = [];
    for (const s of sources) {
      const r = expandPath(s);
      if (!(await isGitRepo(r))) {
        throw new Error(
          `Configured repository "${s}" is not a git repository (resolved to "${r}"). ` +
            `Fix the repository path in project Settings (an absolute path, or one starting with ~), ` +
            `or run \`git init\` there.`,
        );
      }
      resolvedSources.push(await gitOrThrow(r, ['rev-parse', '--show-toplevel']));
    }

    const repos: WorldRepo[] = [];
    if (resolvedSources.length === 0) {
      // No repo configured — a scratch sandbox (the world itself is the deliverable).
      const scratch = await this.makeScratchRepo(spec.taskId, spec.base);
      repos.push(await this.addWorktree(scratch, root, 'scratch', branch, spec));
    } else if (resolvedSources.length === 1) {
      // Single repo: the worktree IS the world root (unchanged layout).
      repos.push(await this.addWorktree(resolvedSources[0]!, root, repoName(resolvedSources[0]!), branch, spec));
    } else {
      // Multi-repo: the world root is a parent dir holding one worktree per repo,
      // each in a subdirectory named after the repo (deduped on collision).
      if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
      fs.mkdirSync(root, { recursive: true });
      const names = uniqueNames(resolvedSources.map(repoName));
      for (let i = 0; i < resolvedSources.length; i++) {
        const name = names[i]!;
        repos.push(await this.addWorktree(resolvedSources[i]!, path.join(root, name), name, branch, spec));
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
    };
    return new WorktreeWorld(handle);
  }

  /**
   * Add a `karmax/<taskId>` worktree for one repo at `wt`, off `spec.base`
   * (falling back to HEAD if that ref is absent). Returns the `WorldRepo` record.
   */
  private async addWorktree(repo: string, wt: string, name: string, branch: string, spec: WorldSpec): Promise<WorldRepo> {
    // Resolve a real base ref per repo; fall back to HEAD if the named base is absent.
    let baseRef = spec.base;
    const verify = await git(repo, ['rev-parse', '--verify', `${spec.base}`]);
    if (verify.code !== 0) baseRef = await gitOrThrow(repo, ['rev-parse', 'HEAD']);

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
    await ensureIdentity(wt);

    // Copy gitignored files the project names (e.g. .env) into this repo's worktree.
    if (spec.copyGlobs?.length) await this.copyGlobs(repo, wt, spec.copyGlobs);

    return { name, repo, root: wt, branch, base: spec.base };
  }

  async open(handle: WorldHandle): Promise<World> {
    return new WorktreeWorld(handle);
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

  private async copyGlobs(repo: string, root: string, globs: string[]) {
    for (const g of globs) {
      // Simple top-level glob support; copy matching files from repo root.
      const entries = fs.existsSync(repo) ? fs.readdirSync(repo) : [];
      const re = globToRegExp(g);
      for (const e of entries) {
        if (re.test(e)) {
          const src = path.join(repo, e);
          const dst = path.join(root, e);
          if (fs.statSync(src).isFile()) fs.copyFileSync(src, dst);
        }
      }
    }
  }
}

class WorktreeWorld implements World {
  constructor(public handle: WorldHandle) {}

  async exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await pexec(cmd, args, {
        cwd: opts.cwd ?? this.handle.root,
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
    return fs.promises.readFile(path.join(this.handle.root, relPath), 'utf8');
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    const abs = path.join(this.handle.root, relPath);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, content);
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
}

/** The repo's basename (its worktree subdirectory name in a multi-repo world). */
function repoName(repo: string): string {
  return repo.split('/').filter(Boolean).pop() ?? 'repo';
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
