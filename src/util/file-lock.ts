import fs from 'node:fs';
import { spawn } from 'node:child_process';

let pending = 0;

/** Same-host Linux coordination. The helper locks an inherited open file
 * description; after it exits, the parent's descriptor retains the kernel lock.
 * Closing that descriptor (including process death) releases it. Lock files
 * must never be unlinked or replaced while contenders can still use them.
 * This is not a distributed lease for hosts with independent filesystems.
 */
export async function acquireFileLock(filename: string, options: {
  shared?: boolean;
  waitMs?: number;
} = {}): Promise<(() => void) | undefined> {
  if (process.platform !== 'linux') throw new Error('shared file coordination requires Linux');
  const waitMs = options.waitMs ?? 30_000;
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error('invalid file lock wait');
  if (pending >= 64) throw new Error('file lock admission is full');
  pending++;
  let fd: number | undefined;
  try {
    fd = fs.openSync(filename, 'a', 0o600);
    const descriptor = fd;
    const status = await new Promise<number | null>((resolve, reject) => {
      const child = spawn('flock', [options.shared ? '--shared' : '--exclusive',
        '--timeout', String(waitMs / 1000), '--conflict-exit-code', '73', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', descriptor],
        timeout: waitMs + 5_000, killSignal: 'SIGKILL',
      });
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (status === 73 && waitMs === 0) return undefined;
    if (status === 73) throw new Error('file lock admission timed out');
    if (status !== 0) throw new Error('file lock helper failed');
    fd = undefined; // Ownership transfers to the idempotent release callback.
    let released = false;
    return () => {
      if (released) return;
      released = true;
      fs.closeSync(descriptor);
    };
  } finally {
    pending--;
    if (fd !== undefined) fs.closeSync(fd);
  }
}
