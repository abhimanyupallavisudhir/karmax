import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run a git command in `cwd`. Never throws on non-zero; returns the code. */
export async function git(cwd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<GitResult> {
  try {
    const { stdout, stderr } = await pexec('git', args, {
      cwd,
      timeout: opts.timeoutMs ?? 120_000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { stdout, stderr, code: 0 };
  } catch (e: any) {
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? String(e?.message ?? e), code: e.code ?? 1 };
  }
}

/** git that throws on failure (for steps that must succeed). */
export async function gitOrThrow(cwd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
  const r = await git(cwd, args, opts);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

export async function isGitRepo(dir: string): Promise<boolean> {
  const r = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  return r.code === 0 && r.stdout.trim() === 'true';
}

export async function currentBranch(dir: string): Promise<string> {
  return gitOrThrow(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

export async function headSha(dir: string): Promise<string> {
  return gitOrThrow(dir, ['rev-parse', 'HEAD']);
}

/** Has the worktree at `dir` got staged/unstaged changes? */
export async function isDirty(dir: string): Promise<boolean> {
  const r = await git(dir, ['status', '--porcelain']);
  return r.stdout.trim().length > 0;
}

/** Configure a deterministic committer identity for a repo (used in scratch repos / CI). */
export async function ensureIdentity(dir: string) {
  const name = await git(dir, ['config', 'user.name']);
  if (name.code !== 0 || !name.stdout.trim()) {
    await git(dir, ['config', 'user.name', 'karmax']);
  }
  const email = await git(dir, ['config', 'user.email']);
  if (email.code !== 0 || !email.stdout.trim()) {
    await git(dir, ['config', 'user.email', 'karmax@localhost']);
  }
}
