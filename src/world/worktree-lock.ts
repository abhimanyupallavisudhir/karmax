import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Serialize every mutation of one repository's worktree admin namespace
 * (`<git-common-dir>/worktrees/<name>`).
 *
 * Git derives that directory's name from the checkout's basename and RECYCLES
 * it — `worktree add` claims the first free `<basename><n>` — while `worktree
 * remove` deletes the checkout FIRST (slow: a whole tree, plus whatever build
 * output an agent left in it) and deletes the admin directory by NAME only
 * afterwards. Every task in a project branches off the same origin repo, and in
 * a multi-repo world each checkout is named after its repo, so every world in
 * the project queues for one name sequence. A `prune` + `add` landing inside a
 * remove's window is handed the very name that remove is about to delete: the
 * `add` still exits 0, and the new world is then left with a `.git` pointing at
 * nothing — it cannot commit or merge, and nothing anywhere reports an error.
 *
 * That is how task 193's world was born broken on 2026-07-28: a merged task
 * released its world 0.9 s after the next task booted its own against the same
 * origin repo, and the release took the newcomer's admin directory with it.
 *
 * Keyed by git common dir, so a repo and every checkout of it share one lock,
 * and held on disk rather than in memory: karmax deliberately tolerates a second
 * app instance against the same home (`src/util/instance.ts`) and those
 * instances share the user's repositories.
 */

/** A checkout of a large repository is the slowest thing under this lock, so a
 *  holder is only presumed dead after minutes — and only if its pid is gone. */
const STALE_MS = 10 * 60_000;
const POLL_MS = 20;

/** Same-process waiters queue in memory instead of spinning on the lock. */
const queues = new Map<string, Promise<unknown>>();
const namespaces = new Map<string, string>();
let steals = 0;

/** The `.git` directory that actually owns `worktrees/` — shared by a repo and
 *  every worktree of it, so all of them resolve to the same lock. */
function worktreeNamespace(repo: string): string {
  const key = path.resolve(repo);
  let dir = namespaces.get(key);
  if (!dir) {
    try {
      const common = execFileSync('git', ['-C', key, 'rev-parse', '--git-common-dir'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      dir = path.resolve(key, common);
    } catch {
      dir = path.join(key, '.git'); // not a repo (yet) — lock the obvious place
    }
    namespaces.set(key, dir);
  }
  return dir;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM'; // owned by another user
  }
}

/** Did the holder die without releasing? Its pid is the signal; the age is only
 *  a backstop for a pid that has since been reused by something unrelated. */
function abandoned(dir: string): boolean {
  let owner: { pid?: number; ts?: number } | undefined;
  try {
    owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner'), 'utf8'));
  } catch {
    // Mid-acquire (the directory exists, `owner` is not written yet) or a crash
    // between the two — fall back to the directory's own age.
    try {
      return Date.now() - fs.statSync(dir).mtimeMs > STALE_MS;
    } catch {
      return false; // released underneath us; the next mkdir will win
    }
  }
  if (typeof owner?.ts === 'number' && Date.now() - owner.ts > STALE_MS) return true;
  return typeof owner?.pid === 'number' && !alive(owner.pid);
}

/** Renaming the lock aside is atomic, so of two processes that both judge a lock
 *  abandoned exactly one succeeds — the loser retries against the winner's lock
 *  instead of deleting it. */
function steal(dir: string): void {
  const aside = `${dir}.abandoned-${process.pid}-${steals++}`;
  try {
    fs.renameSync(dir, aside);
  } catch {
    return; // another waiter got there first
  }
  try {
    fs.rmSync(aside, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

async function acquire(dir: string): Promise<void> {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  for (;;) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'owner'), JSON.stringify({ pid: process.pid, ts: Date.now() }));
      return;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e;
      if (abandoned(dir)) steal(dir);
      else await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
}

function release(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
}

/**
 * Run `fn` with exclusive rights to `repo`'s worktree admin namespace. Every
 * `git worktree add|remove|prune` against a repo must be inside one of these,
 * and a `prune` that precedes an `add` must share the section with it so no one
 * can claim the name in between.
 */
export async function withWorktreeLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const dir = path.join(worktreeNamespace(repo), 'karmax-worktree.lock');
  const run = (queues.get(dir) ?? Promise.resolve()).then(async () => {
    await acquire(dir);
    try {
      return await fn();
    } finally {
      release(dir);
    }
  });
  const queued = run.then(() => undefined, () => undefined);
  queues.set(dir, queued);
  try {
    return await run;
  } finally {
    if (queues.get(dir) === queued) queues.delete(dir);
  }
}
