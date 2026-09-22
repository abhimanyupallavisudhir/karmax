import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { acquireFileLock } from '../util/file-lock.js';

/** Shared by a supervised same-host gateway/worker group. Separate lock inodes
 * let an accessor pin itself before waiting for a world transition, and release
 * its pin while holding the transition lock, without reversing lock order.
 */
export class SharedWorldCoordination {
  constructor(private directory: string) {
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

  async holdAccess(worldId: string): Promise<() => void> {
    return (await acquireFileLock(this.filename(worldId, 'access'), { shared: true }))!;
  }

  async hasAccess(worldId: string): Promise<boolean> {
    const release = await acquireFileLock(this.filename(worldId, 'access'), { waitMs: 0 });
    if (!release) return true;
    release();
    return false;
  }
}
