import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { wikiRoot } from './wiki.js';

export const PROJECT_WIKI_BRANCH = 'main';

function git(root: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: env ? { ...process.env, ...env } : process.env,
    // Remote wiki provisioning runs before the gateway binds. An unreachable SSH
    // endpoint must fail best-effort setup, never freeze the entire task system.
    timeout: 15_000,
    killSignal: 'SIGKILL',
  }).trim();
}

function gitAsync(root: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', root, ...args], {
      encoding: 'utf8',
      env: env ? { ...process.env, ...env } : process.env,
      timeout: 15_000,
      killSignal: 'SIGKILL',
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

function githubSshOverHttpsRemote(remote: string): string | undefined {
  const match = /^git@github\.com:([^\s]+)$/.exec(remote);
  return match ? `ssh://git@ssh.github.com:443/${match[1]}` : undefined;
}

function sshConnectivityFailure(error: unknown, port: number): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes(`port ${port}`)
    && /timed out|timeout|refused|unreachable|no route to host|connection reset/.test(message);
}

function setRemote(root: string, remote: string): void {
  let exists = true;
  try { git(root, ['remote', 'get-url', 'origin']); } catch { exists = false; }
  git(root, exists ? ['remote', 'set-url', 'origin', remote] : ['remote', 'add', 'origin', remote]);
}

/** Existing project wiki folders are migrated in place: initializing Git does
 * not rewrite any page, and the first commit simply establishes their baseline. */
export function ensureProjectWikiRepository(contentDir: string, projectId: string): string {
  const root = wikiRoot(contentDir, 'project', projectId);
  fs.mkdirSync(root, { recursive: true });
  if (!fs.existsSync(path.join(root, '.git'))) {
    execFileSync('git', ['init', '-q', '-b', PROJECT_WIKI_BRANCH, root]);
    git(root, ['config', 'user.name', 'karmax']);
    git(root, ['config', 'user.email', 'karmax@localhost']);
  }
  try { git(root, ['rev-parse', '--verify', 'HEAD']); }
  catch {
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '--allow-empty', '-m', 'karmax: initialize project wiki']);
  }
  try { git(root, ['rev-parse', '--verify', `refs/heads/${PROJECT_WIKI_BRANCH}`]); }
  catch { git(root, ['branch', PROJECT_WIKI_BRANCH, 'HEAD']); }
  const current = git(root, ['branch', '--show-current']);
  if (current && current !== PROJECT_WIKI_BRANCH) git(root, ['switch', '-q', PROJECT_WIKI_BRANCH]);
  return root;
}

export function commitProjectWiki(root: string, message: string): string {
  git(root, ['add', '-A']);
  try { git(root, ['commit', '-q', '-m', message]); }
  catch (error) {
    const status = git(root, ['status', '--porcelain']);
    if (status) throw error;
  }
  return git(root, ['rev-parse', 'HEAD']);
}

export function projectWikiBranches(root: string): string[] {
  try {
    return git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
      .split('\n').map((value) => value.trim()).filter(Boolean);
  } catch {
    return [PROJECT_WIKI_BRANCH];
  }
}

/** Materialize a read-only branch view as a detached worktree. This is kept
 * outside the repository so wiki traversal never exposes Git internals. */
export function projectWikiBranchView(contentDir: string, projectId: string, ref: string): string {
  if (!/^[A-Za-z0-9._/-]+$/.test(ref) || ref.includes('..') || ref.startsWith('-'))
    throw new Error('invalid wiki branch');
  const root = ensureProjectWikiRepository(contentDir, projectId);
  git(root, ['check-ref-format', '--branch', ref]);
  const branchRef = `refs/heads/${ref}`;
  git(root, ['rev-parse', '--verify', branchRef]);
  const key = crypto.createHash('sha256').update(ref).digest('hex').slice(0, 16);
  const view = path.join(contentDir, 'wiki-views', projectId, key);
  fs.mkdirSync(path.dirname(view), { recursive: true });
  if (fs.existsSync(view)) {
    try { git(root, ['worktree', 'remove', '--force', view]); }
    catch { fs.rmSync(view, { recursive: true, force: true }); }
  }
  git(root, ['worktree', 'prune']);
  git(root, ['worktree', 'add', '--force', '--detach', view, branchRef]);
  return view;
}

export async function setProjectWikiRemote(root: string, remote: string, sshKey: string): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-wiki-key-'));
  const key = path.join(dir, 'id');
  try {
    fs.writeFileSync(key, sshKey, { mode: 0o600 });
    const push = async (url: string) => {
      setRemote(root, url);
      await gitAsync(root, ['push', '-u', 'origin', `${PROJECT_WIKI_BRANCH}:${PROJECT_WIKI_BRANCH}`], {
        GIT_SSH_COMMAND: `ssh -i ${key} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 -o ServerAliveInterval=5 -o ServerAliveCountMax=1`,
      });
    };
    const alternate = githubSshOverHttpsRemote(remote);
    let current: string | undefined;
    try { current = git(root, ['remote', 'get-url', 'origin']); } catch { /* no origin yet */ }

    // GitHub exposes its SSH service on ssh.github.com:443 specifically for
    // networks whose firewalls block the normal github.com:22 endpoint. Once
    // that fallback succeeds, leave it as origin and prefer it on later boots
    // so startup does not repeatedly wait for a known-blocked port 22.
    if (alternate && current === alternate) {
      try {
        await push(alternate);
        return;
      } catch (alternateError) {
        if (!sshConnectivityFailure(alternateError, 443)) throw alternateError;
        try {
          await push(remote);
          return;
        } catch (standardError) {
          throw new AggregateError([alternateError, standardError],
            'Could not push the project wiki to GitHub over SSH ports 443 or 22');
        }
      }
    }

    try {
      await push(remote);
    } catch (standardError) {
      if (!alternate || !sshConnectivityFailure(standardError, 22)) throw standardError;
      try {
        await push(alternate);
      } catch (alternateError) {
        throw new AggregateError([standardError, alternateError],
          'Could not push the project wiki to GitHub over SSH ports 22 or 443');
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
