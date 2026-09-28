import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { withWorktreeLock } from '../src/world/worktree-lock.js';
import { holdWorktreeLock } from './helpers/lock-waiters.js';

/**
 * The lock that keeps concurrent world create/release out of each other's git
 * worktree admin namespace. See src/world/worktree-lock.ts for the failure it
 * exists to prevent.
 */
describe('worktree lock', () => {
  let repos: string[];
  const makeRepo = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-wtlock-'));
    execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
    repos.push(dir);
    return dir;
  };
  const lockDir = (repo: string) => path.join(repo, '.git', 'karmax-worktree.lock');
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  beforeEach(() => { repos = []; });
  afterEach(() => { for (const r of repos) fs.rmSync(r, { recursive: true, force: true }); });

  it('never lets two sections on the same repo overlap', async () => {
    const repo = makeRepo();
    let inside = 0;
    let overlapped = false;
    const section = async () => withWorktreeLock(repo, async () => {
      inside++;
      if (inside > 1) overlapped = true;
      await settle();
      inside--;
    });
    await Promise.all([section(), section(), section(), section()]);
    expect(overlapped).toBe(false);
    expect(fs.existsSync(lockDir(repo))).toBe(false); // released
  });

  it('locks per repository, so unrelated repos still run in parallel', async () => {
    const [a, b] = [makeRepo(), makeRepo()];
    let both = false;
    let inA = false;
    await Promise.all([
      withWorktreeLock(a, async () => { inA = true; await settle(); await settle(); inA = false; }),
      withWorktreeLock(b, async () => { await settle(); both = inA; }),
    ]);
    expect(both).toBe(true);
  });

  it('shares one lock between a repo and a worktree of it', async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'f.txt'), 'x\n');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'init']);
    const checkout = path.join(repo, '..', `${path.basename(repo)}-wt`);
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'side', checkout, 'main']);
    try {
      let overlapped = false;
      let inside = false;
      await Promise.all([
        withWorktreeLock(repo, async () => { inside = true; await settle(); inside = false; }),
        withWorktreeLock(checkout, async () => { if (inside) overlapped = true; await settle(); if (inside) overlapped = true; }),
      ]);
      expect(overlapped).toBe(false);
    } finally {
      fs.rmSync(checkout, { recursive: true, force: true });
    }
  });

  it('releases the lock when the section throws', async () => {
    const repo = makeRepo();
    await expect(withWorktreeLock(repo, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(fs.existsSync(lockDir(repo))).toBe(false);
    await expect(withWorktreeLock(repo, async () => 'next')).resolves.toBe('next');
  });

  it('takes over a lock abandoned by a process that is gone', async () => {
    const repo = makeRepo();
    const dir = lockDir(repo);
    fs.mkdirSync(dir, { recursive: true });
    // A pid that cannot be running: the holder died without releasing.
    fs.writeFileSync(path.join(dir, 'owner'), JSON.stringify({ pid: 0x7fffffff, ts: Date.now() }));
    await expect(withWorktreeLock(repo, async () => 'taken')).resolves.toBe('taken');
  });

  it('waits for a live holder rather than stealing its lock', async () => {
    const repo = makeRepo();
    const holder = holdWorktreeLock(repo);
    expect(holder.dir).toBe(lockDir(repo));
    let entered = false;
    const waiting = withWorktreeLock(repo, async () => { entered = true; });
    try {
      await holder.waiting();
      expect(entered).toBe(false);
    } finally { holder.release(); }
    await waiting;
    expect(entered).toBe(true);
  });
});
