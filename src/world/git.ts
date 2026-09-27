import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Disable every ordinary host Git credential path for tenant-scoped subprocesses. */
export function isolatedGitEnvironment(): Record<string, string> {
  return {
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
    SSH_AUTH_SOCK: '',
    GIT_ASKPASS: '/bin/false',
    GIT_SSH_COMMAND: 'ssh -F /dev/null -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
  };
}

/** Run a git command in `cwd`. Never throws on non-zero; returns the code.
 *  `opts.env` layers extra vars (e.g. a git profile's GIT_SSH_COMMAND) over the
 *  minimal host environment; interactive prompts stay disabled regardless. */
export async function git(cwd: string, args: string[], opts: { timeoutMs?: number; env?: Record<string, string> } = {}): Promise<GitResult> {
  try {
    await validateGitDirectory(cwd);
    const env = { ...hostGitEnvironment(), ...(opts.env ?? {}), GIT_TERMINAL_PROMPT: '0' };
    // Only the repository's own configuration (and what it includes) can be
    // written from an agent's checkout; operator and karmax-supplied scopes are
    // trusted, so an operator's LFS filter or credential helper keeps working.
    // Refused: settings that run a program, and core.worktree, which points
    // host staging and checkout at any directory.
    const config = await pexec('git', ['config', '--show-scope', '--includes', '--null', '--get-regexp',
      '^(filter\\..*\\.(clean|smudge|process)|merge\\..*\\.driver|diff\\..*\\.(command|textconv)|diff\\.external|core\\.(sshcommand|gitproxy|alternaterefscommand|askpass|worktree)|gpg(\\..*)?\\.program|gpg\\.ssh\\.defaultkeycommand|credential(\\..*)?\\.helper|remote\\..*\\.(uploadpack|receivepack)|submodule\\..*\\.update)$'],
      { cwd, env, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 1024 * 1024 }).catch(error => {
        if (error.code === 1 && !error.killed) return { stdout: '' };
        throw error;
      });
    const fields = config.stdout.split('\0');
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const scope = fields[index]!, setting = fields[index + 1]!;
      const separator = setting.indexOf('\n');
      if ((scope === 'local' || scope === 'worktree') && separator >= 0 && setting.slice(separator + 1).trim())
        throw new Error(`refusing unsafe repository Git configuration: ${setting.slice(0, separator)}`);
    }
    const { stdout, stderr } = await pexec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
      '-c', 'core.quotePath=false', '-c', 'protocol.ext.allow=never', ...args], {
      cwd,
      timeout: opts.timeoutMs ?? 120_000,
      maxBuffer: 64 * 1024 * 1024,
      env,
    });
    return { stdout, stderr, code: 0 };
  } catch (e: any) {
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? String(e?.message ?? e), code: typeof e.code === 'number' && !e.killed ? e.code : 128 };
  }
}

/** git that throws on failure (for steps that must succeed). */
export async function gitOrThrow(cwd: string, args: string[], opts: { timeoutMs?: number; env?: Record<string, string> } = {}): Promise<string> {
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

/** The repo's actual default branch (origin/HEAD, else the checked-out branch). */
export async function defaultBranch(repo: string): Promise<string | undefined> {
  const origin = await git(repo, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']);
  if (origin.code === 0 && origin.stdout.trim()) return origin.stdout.trim().replace(/^origin\//, '');
  const cur = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const b = cur.stdout.trim();
  return cur.code === 0 && b && b !== 'HEAD' ? b : undefined;
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

/** The environment host Git inherits. An allowlist, so karmax's own secrets and
 * inherited GIT_DIR-style overrides never reach a Git subprocess; what it keeps
 * is the operator's trusted setup — global/system config files, environment
 * config chains (which appendGitConfig extends), proxies and CA bundles.
 * Tenant-scoped callers layer isolatedGitEnvironment() over this. */
function hostGitEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'XDG_CONFIG_HOME',
    'SSH_AUTH_SOCK', 'GIT_TRACE2_EVENT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_SSH',
    'GIT_SSH_COMMAND', 'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy'])
    if (process.env[key]) env[key] = process.env[key]!;
  const count = Number(process.env.GIT_CONFIG_COUNT ?? 0);
  if (Number.isSafeInteger(count) && count > 0) {
    env.GIT_CONFIG_COUNT = String(count);
    for (let index = 0; index < count; index++) {
      env[`GIT_CONFIG_KEY_${index}`] = process.env[`GIT_CONFIG_KEY_${index}`] ?? '';
      env[`GIT_CONFIG_VALUE_${index}`] = process.env[`GIT_CONFIG_VALUE_${index}`] ?? '';
    }
  }
  return env;
}

/** A linked worktree must have a reciprocal registration in its common repo.
 * Never let an agent replace .git with a symlink or an arbitrary host gitdir. */
async function validateGitDirectory(cwd: string): Promise<void> {
  const root = await fs.promises.realpath(cwd);
  const marker = path.join(root, '.git');
  const stat = await fs.promises.lstat(marker).catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!stat) {
    const parent = path.dirname(root);
    if (parent !== root) await validateGitDirectory(parent);
    return; // init, clone, bare repositories, or a validated enclosing checkout
  }
  if (stat.isSymbolicLink()) throw new Error('refusing symlinked Git directory');
  if (stat.isDirectory()) {
    if (fs.existsSync(path.join(marker, 'commondir'))) throw new Error('unexpected common Git directory');
    return;
  }
  const text = await fs.promises.readFile(marker, 'utf8');
  if (!text.startsWith('gitdir: ')) throw new Error('invalid Git worktree registration');
  const directory = path.resolve(root, text.slice(8).trim());
  if (await fs.promises.realpath(directory) !== directory) throw new Error('symlinked Git worktree registration');
  const backlink = (await fs.promises.readFile(path.join(directory, 'gitdir'), 'utf8')).trim();
  if (path.resolve(directory, backlink) !== marker) throw new Error('foreign Git worktree registration');
  const common = path.resolve(directory, (await fs.promises.readFile(path.join(directory, 'commondir'), 'utf8')).trim());
  if (path.dirname(path.dirname(directory)) !== common || path.basename(path.dirname(directory)) !== 'worktrees')
    throw new Error('foreign common Git directory');
}
