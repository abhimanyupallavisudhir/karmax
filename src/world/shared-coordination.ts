import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { acquireFileLock } from '../util/file-lock.js';

/** Shared by a supervised same-host gateway/worker group. Separate lock inodes
 * let an accessor pin itself before waiting for a world transition, and release
 * its pin while holding the transition lock, without reversing lock order.
 *
 * Taking a lock forks a `flock` helper, which costs a process with a large heap
 * milliseconds of CPU: at 96 tenants it was a third of the activity worker's
 * core (2026-10 load test). So a process holds one shared access lock per world
 * however many of its accessors pin it, and `hasAccess` reads /proc/locks
 * instead of trying the lock.
 */
export class SharedWorldCoordination {
  private access = new Map<string, { holders: number; lock: Promise<() => void> }>();

  constructor(private directory: string, private procLocks = '/proc/locks') {
    if (process.platform !== 'linux') throw new Error('shared world coordination requires Linux');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  private filename(worldId: string, kind: 'operation' | 'access'): string {
    return path.join(this.directory, `${crypto.createHash('sha256').update(worldId).digest('hex')}.${kind}.lock`);
  }

  async operation<T>(worldId: string, work: () => Promise<T>): Promise<T> {
    const release = await acquireFileLock(this.filename(worldId, 'operation'));
    try { return await work(); }
    finally { release!(); }
  }

  /** Pin `worldId` until the returned release: a shared lock this process
   * takes for its first holder and drops after its last. */
  async holdAccess(worldId: string): Promise<() => void> {
    let entry = this.access.get(worldId);
    if (!entry) {
      const created = { holders: 0, lock: acquireFileLock(this.filename(worldId, 'access'), { shared: true }).then((release) => release!) };
      created.lock.catch(() => { if (this.access.get(worldId) === created) this.access.delete(worldId); });
      this.access.set(worldId, entry = created);
    }
    const held = entry;
    held.holders++;
    let release: () => void;
    try { release = await held.lock; }
    catch (error) { held.holders--; throw error; }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--held.holders > 0) return;
      if (this.access.get(worldId) === held) this.access.delete(worldId);
      release();
    };
  }

  /** Whether any process pins `worldId`: a lock on its access file. Only the
   * inode is compared, so a coincidence answers "in use", the safe answer. */
  async hasAccess(worldId: string): Promise<boolean> {
    const filename = this.filename(worldId, 'access');
    let inode: string;
    try { inode = (await fs.promises.stat(filename, { bigint: true })).ino.toString(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    let locks: string;
    try { locks = await fs.promises.readFile(this.procLocks, 'utf8'); }
    catch {
      const release = await acquireFileLock(filename, { waitMs: 0 });
      if (!release) return true;
      release();
      return false;
    }
    // `1: FLOCK  ADVISORY  READ 1234 00:2f:5678 0 EOF`, or `1: -> FLOCK …` for a waiter.
    return locks.split('\n').some((line) => {
      const fields = line.trim().split(/\s+/);
      if (!fields.includes('FLOCK')) return false;
      const id = fields.find((field) => /^[0-9a-f]+:[0-9a-f]+:\d+$/i.test(field));
      return id?.split(':')[2] === inode;
    });
  }
}
