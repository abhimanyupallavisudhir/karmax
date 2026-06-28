import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { World, WorldHandle, WorldProvider, WorldSpec, ExecOptions, ExecResult } from './types.js';
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

    let repo = spec.repo ? expandPath(spec.repo) : undefined;
    if (repo) {
      // A repo was configured. It MUST be a valid git repo — never silently fall
      // back to a throwaway scratch repo (that produces invisible "merges").
      if (!(await isGitRepo(repo))) {
        throw new Error(
          `Configured repository "${spec.repo}" is not a git repository (resolved to "${repo}"). ` +
            `Fix the repository path in project Settings (an absolute path, or one starting with ~), ` +
            `or run \`git init\` there.`,
        );
      }
      repo = await gitOrThrow(repo, ['rev-parse', '--show-toplevel']);
    } else {
      // No repo configured at all — a scratch sandbox (the world is the deliverable).
      repo = await this.makeScratchRepo(spec.taskId, spec.base);
    }

    // Resolve a real base ref; fall back to HEAD if the named base is absent.
    let baseRef = spec.base;
    const verify = await git(repo, ['rev-parse', '--verify', `${spec.base}`]);
    if (verify.code !== 0) baseRef = await gitOrThrow(repo, ['rev-parse', 'HEAD']);

    // Clean any stale worktree at this path.
    if (fs.existsSync(root)) {
      await git(repo, ['worktree', 'remove', '--force', root]);
      fs.rmSync(root, { recursive: true, force: true });
    }
    await git(repo, ['worktree', 'prune']);
    // Reuse the branch if it already exists, else create it.
    const branchExists = (await git(repo, ['rev-parse', '--verify', branch])).code === 0;
    const addArgs = branchExists
      ? ['worktree', 'add', root, branch]
      : ['worktree', 'add', '-b', branch, root, baseRef];
    await gitOrThrow(repo, addArgs);
    await ensureIdentity(root);

    // Copy gitignored files the project names (e.g. .env) into the world.
    if (spec.copyGlobs?.length) await this.copyGlobs(repo, root, spec.copyGlobs);

    const handle: WorldHandle = {
      kind: 'worktree',
      id: spec.taskId,
      root,
      branch,
      base: spec.base,
      repo,
      target: spec.target,
    };
    return new WorktreeWorld(handle);
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
    const r = await git(this.handle.root, ['ls-files', '--cached', '--others', '--exclude-standard']);
    return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  async destroy(): Promise<void> {
    const { repo, root } = this.handle;
    if (repo) {
      await git(repo, ['worktree', 'remove', '--force', root]);
      await git(repo, ['worktree', 'prune']);
    }
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  }
}

function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`);
}
