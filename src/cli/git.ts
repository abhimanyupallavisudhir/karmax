import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CliError } from './util.js';

export interface GitResult { code: number; stdout: string; stderr: string }

/** Git with the user's own configuration and credentials. */
export function git(cwd: string, args: string[], options: { inherit?: boolean } = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: options.inherit ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: process.stdin.isTTY ? process.env.GIT_TERMINAL_PROMPT ?? '1' : '0' } });
    let stdout = ''; let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => reject((error as NodeJS.ErrnoException).code === 'ENOENT' ? new CliError('git is not installed') : error));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

export async function gitOk(cwd: string, args: string[], what: string): Promise<string> {
  const result = await git(cwd, args);
  if (result.code !== 0) throw new CliError(`${what}: ${(result.stderr || result.stdout).trim().split('\n').slice(-2).join(' ')}`);
  return result.stdout.trim();
}

export function isRepository(dir: string): boolean { return fs.existsSync(path.join(dir, '.git')); }

export async function currentBranch(dir: string): Promise<string | undefined> {
  const result = await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/** Uncommitted paths (tracked changes and untracked files). */
export async function dirty(dir: string): Promise<string[]> {
  const result = await git(dir, ['status', '--porcelain']);
  return result.stdout.split('\n').filter(Boolean);
}

/** Commits ahead of / behind `ref` (undefined when `ref` does not exist). */
export async function aheadBehind(dir: string, ref: string): Promise<{ ahead: number; behind: number } | undefined> {
  const result = await git(dir, ['rev-list', '--left-right', '--count', `HEAD...${ref}`]);
  if (result.code !== 0) return undefined;
  const [ahead, behind] = result.stdout.trim().split(/\s+/).map(Number);
  return { ahead: ahead ?? 0, behind: behind ?? 0 };
}

/** Keep a path out of `git status` in this clone only (`.git/info/exclude`),
 * as worlds do: tavya never writes into a repository's own files. */
export function excludeFromGit(repository: string, relative: string): void {
  if (!relative || relative === '.' || relative.startsWith('..')) return;
  const gitDir = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: repository, encoding: 'utf8' });
  if (gitDir.status !== 0) return;
  const file = path.join(gitDir.stdout.trim(), 'info', 'exclude');
  const pattern = `/${relative.replace(/\\/g, '/')}`;
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (existing.split('\n').includes(pattern)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${existing && !existing.endsWith('\n') ? '\n' : ''}${pattern}\n`);
}
