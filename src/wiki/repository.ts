import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { wikiRoot } from './wiki.js';

export const PROJECT_WIKI_BRANCH = 'main';

function git(root: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: env ? { ...process.env, ...env } : process.env,
  }).trim();
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

export function setProjectWikiRemote(root: string, remote: string, sshKey: string): void {
  try { git(root, ['remote', 'set-url', 'origin', remote]); }
  catch { git(root, ['remote', 'add', 'origin', remote]); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-wiki-key-'));
  const key = path.join(dir, 'id');
  try {
    fs.writeFileSync(key, sshKey, { mode: 0o600 });
    git(root, ['push', '-u', 'origin', `${PROJECT_WIKI_BRANCH}:${PROJECT_WIKI_BRANCH}`], {
      GIT_SSH_COMMAND: `ssh -i ${key} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
