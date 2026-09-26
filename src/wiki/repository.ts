import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { wikiRoot } from './wiki.js';
import { materializeGitCredential, type GitCredential } from '../world/git-credential.js';
import { BRAND } from '../domain/brand.js';

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

function setRemote(root: string, remote: string): void {
  let exists = true;
  try { git(root, ['remote', 'get-url', 'origin']); } catch { exists = false; }
  git(root, exists ? ['remote', 'set-url', 'origin', remote] : ['remote', 'add', 'origin', remote]);
}

/** Canonical wiki writes and remote reconciliation both mutate the same `main`
 * worktree. Keep them in one per-repository lane: otherwise a second browser
 * save can commit while the first save is fetching/merging origin, or startup's
 * best-effort remote wiring can race an interface edit through Git's index. */
const projectWikiOperations = new Map<string, Promise<unknown>>();

async function serializeProjectWikiOperation<T>(root: string, operation: () => Promise<T> | T): Promise<T> {
  const key = path.resolve(root);
  const previous = projectWikiOperations.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  projectWikiOperations.set(key, current);
  try {
    return await current;
  } finally {
    if (projectWikiOperations.get(key) === current) projectWikiOperations.delete(key);
  }
}

export class ProjectWikiPublishError extends Error {
  readonly code = 'wiki_remote_sync_failed';
  readonly status = 502;

  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Project wiki was committed locally, but publishing it to GitHub failed: ${detail}`);
    this.name = 'ProjectWikiPublishError';
    this.cause = cause;
  }
}

/** Existing project wiki folders are migrated in place: initializing Git does
 * not rewrite any page, and the first commit simply establishes their baseline. */
export function ensureProjectWikiRepository(contentDir: string, projectId: string): string {
  const root = wikiRoot(contentDir, 'project', projectId);
  fs.mkdirSync(root, { recursive: true });
  if (!fs.existsSync(path.join(root, '.git'))) {
    execFileSync('git', ['init', '-q', '-b', PROJECT_WIKI_BRANCH, root]);
    git(root, ['config', 'user.name', BRAND]);
    git(root, ['config', 'user.email', `${BRAND}@localhost`]);
  }
  try { git(root, ['rev-parse', '--verify', 'HEAD']); }
  catch {
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '--allow-empty', '-m', `${BRAND}: initialize project wiki`]);
  }
  try { git(root, ['rev-parse', '--verify', `refs/heads/${PROJECT_WIKI_BRANCH}`]); }
  catch { git(root, ['branch', PROJECT_WIKI_BRANCH, 'HEAD']); }
  const current = git(root, ['branch', '--show-current']);
  if (current && current !== PROJECT_WIKI_BRANCH) git(root, ['switch', '-q', PROJECT_WIKI_BRANCH]);
  return root;
}

/**
 * Commit wiki changes.
 *
 * `pathspecs` scopes the commit to the entries the caller actually touched.
 * `git add -A` stages the WHOLE shared canonical root, and the root is shared by
 * every agent and browser tab editing that project's wiki — so with two
 * concurrent edits (write A → write B → commit A → commit B) commit A carried
 * B's half-finished page and commit B was empty. The version history then
 * attributes each change to the wrong author and the wrong message, which is
 * exactly what the history exists to prevent.
 *
 * Omitting `pathspecs` keeps the old whole-tree behaviour, which is still what
 * baseline/initialization commits want.
 *
 * The two per-page call sites in `src/platform/api.ts` (`wiki: update …` and
 * `wiki: delete …`) pass their page path so a per-page edit is a per-page commit;
 * a rename passes both the new and previous path.
 */
export function commitProjectWiki(root: string, message: string, pathspecs?: string[]): string {
  const specs = (pathspecs ?? []).filter((spec) => spec && !spec.startsWith('-') && !spec.includes('..'));
  // `--` separates pathspecs from options, so a page path can never be read as a
  // git flag even if the filter above is bypassed.
  git(root, specs.length ? ['add', '--all', '--', ...specs] : ['add', '-A']);
  try { git(root, ['commit', '-q', '-m', message, ...(specs.length ? ['--', ...specs] : [])]); }
  catch (error) {
    const status = git(root, ['status', '--porcelain', ...(specs.length ? ['--', ...specs] : [])]);
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
  const head = git(root, ['rev-parse', branchRef]);
  // REUSE a valid view instead of rebuilding it. This is a read path — two people
  // opening the same wiki branch at the same time is the normal case — and the
  // unconditional `worktree remove --force` + re-add meant the second request
  // deleted the directory the first was midway through reading, so the first saw
  // a half-empty wiki (or ENOENT). A detached worktree already at the right commit
  // is byte-identical to the one the rebuild would produce, so there is nothing to
  // gain from rebuilding it.
  if (fs.existsSync(path.join(view, '.git'))) {
    try {
      if (git(view, ['rev-parse', 'HEAD']) === head) return view;
      // Same view, different commit: move it forward in place rather than
      // deleting and recreating the directory under a concurrent reader.
      git(view, ['checkout', '-q', '--detach', head]);
      return view;
    } catch { /* corrupt or stale view — fall through and rebuild it */ }
  }
  if (fs.existsSync(view)) {
    try { git(root, ['worktree', 'remove', '--force', view]); }
    catch { fs.rmSync(view, { recursive: true, force: true }); }
  }
  // Deliberately no `worktree prune` here. A prune frees admin-dir names across
  // the whole repo, and this wiki repo is also checked out into every multi-repo
  // world — so a prune racing a world's `worktree remove` can hand that world's
  // name away mid-removal (see src/world/worktree-lock.ts). This view's own name
  // is the content hash below, which nothing else can be given, and `add` just
  // suffixes it if the rm fallback above left a stale entry; world create and
  // destroy prune the repo properly, under the lock.
  git(root, ['worktree', 'add', '--force', '--detach', view, branchRef]);
  return view;
}

async function reconcileProjectWikiRemote(root: string, remote: string, credential: GitCredential): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-wiki-auth-'));
  try {
    // The canonical checkout is shared with the wiki editor. Its normal writes
    // are committed before entering this serialized lane, so dirt here means an
    // interrupted/manual operation that must be preserved rather than swept
    // into an automatic remote reconciliation merge.
    const status = git(root, ['status', '--porcelain']);
    if (status) throw new Error(`canonical project wiki has uncommitted changes:\n${status}`);
    const { env } = materializeGitCredential(dir, credential);
    setRemote(root, remote);
    // A PR-policy task is landed by GitHub, so origin/main can legitimately be
    // ahead of the canonical local checkout the next time the gateway starts.
    // Fetch and reconcile that history before publishing local wiki edits. A
    // blind push here used to fail forever with "fetch first" after every wiki
    // PR merge because the retry repeated the exact same push without fetching.
    const remoteHead = await gitAsync(root,
      ['ls-remote', '--heads', 'origin', `refs/heads/${PROJECT_WIKI_BRANCH}`], env);
    if (remoteHead) {
      const tracking = `refs/remotes/origin/${PROJECT_WIKI_BRANCH}`;
      await gitAsync(root, ['fetch', '--no-tags', 'origin',
        `+refs/heads/${PROJECT_WIKI_BRANCH}:${tracking}`], env);
      let remoteIsAncestor = true;
      try { git(root, ['merge-base', '--is-ancestor', tracking, PROJECT_WIKI_BRANCH]); }
      catch { remoteIsAncestor = false; }
      if (!remoteIsAncestor) {
        try {
          // This fast-forwards the ordinary GitHub-merge case. If local wiki
          // edits raced the remote merge, retain both with a normal merge commit
          // rather than overwriting either side. Unrelated history is possible
          // when a repository was initialized manually before it was connected.
          await gitAsync(root, [
            '-c', `user.name=${BRAND}`, '-c', `user.email=${BRAND}@localhost`,
            'merge', '--no-edit', '--allow-unrelated-histories',
            '-m', `${BRAND}: sync origin/${PROJECT_WIKI_BRANCH}`,
            tracking,
          ]);
        } catch (error) {
          // Never leave the shared canonical wiki in a conflicted merge state.
          await gitAsync(root, ['merge', '--abort']).catch(() => undefined);
          throw error;
        }
      }
    }
    await gitAsync(root, ['push', '-u', 'origin', `${PROJECT_WIKI_BRANCH}:${PROJECT_WIKI_BRANCH}`], env);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Wire/reconcile a canonical project wiki with its remote. This shares the
 * same lane as interface edits, so startup synchronization cannot race a save. */
export async function setProjectWikiRemote(root: string, remote: string, credential: GitCredential): Promise<void> {
  await serializeProjectWikiOperation(root, () => reconcileProjectWikiRemote(root, remote, credential));
}

/** Apply one canonical wiki mutation and publish its resulting commit before
 * acknowledging the write. `publish` is resolved inside the repository lane so
 * its short-lived credential and the fetch/merge/push are contiguous with the
 * commit. A task-branch edit must not use this helper: it lands through the
 * task's ordinary Review/Merge path instead. */
export async function mutateAndPublishProjectWiki<T>(
  root: string,
  mutation: () => T,
  publish: () => Promise<{ remote: string; credential: GitCredential } | undefined>,
): Promise<T> {
  return serializeProjectWikiOperation(root, async () => {
    const result = mutation();
    try {
      const target = await publish();
      if (target) await reconcileProjectWikiRemote(root, target.remote, target.credential);
    } catch (error) {
      throw new ProjectWikiPublishError(error);
    }
    return result;
  });
}
