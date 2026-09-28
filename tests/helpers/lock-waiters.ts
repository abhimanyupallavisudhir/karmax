import fs from 'node:fs';
import path from 'node:path';
import { expect, vi } from 'vitest';

/**
 * Barriers for "the other side is still waiting" assertions. Sleeping and then
 * checking that a waiter has not run passes vacuously on a slow runner, where
 * the waiter may not have reached the lock yet. Each helper here instead
 * resolves once the waiter is observably blocked on the lock.
 */

/** Number of requests the kernel reports as blocked on `file`'s flock/POSIX
 * locks (`->` entries in /proc/locks, which name the file by inode). */
export function blockedLockRequests(file: string): number {
  const inode = fs.statSync(file).ino;
  return fs.readFileSync('/proc/locks', 'utf8').split('\n')
    .filter((line) => line.includes('->') && line.split(/\s+/).some((field) => field.endsWith(`:${inode}`))).length;
}

/** Resolves once some process is blocked waiting for a lock on `file`. */
export function lockContended(file: string): Promise<void> {
  return vi.waitFor(() => expect(blockedLockRequests(file)).toBeGreaterThan(0), { timeout: 10_000 });
}

/**
 * Hold `repo`'s worktree lock (src/world/worktree-lock.ts) as a live holder in
 * another process would: its directory exists and names a running pid, so a
 * contender polls instead of stealing it. `waiting()` resolves once a
 * contender has found it held twice, i.e. has decided to wait rather than
 * take it over.
 */
export function holdWorktreeLock(repo: string) {
  const dir = path.join(repo, '.git', 'karmax-worktree.lock');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'owner'), JSON.stringify({ pid: process.pid, ts: Date.now() }));
  const mkdir = vi.spyOn(fs, 'mkdirSync');
  const refused = () => mkdir.mock.calls.filter(([target], index) => target === dir
    && mkdir.mock.results[index]?.type === 'throw').length;
  return {
    dir,
    waiting: () => vi.waitFor(() => expect(refused()).toBeGreaterThanOrEqual(2), { timeout: 10_000 }),
    release: () => { mkdir.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
