import fs from 'node:fs';
import { spawn } from 'node:child_process';

let pending = 0;

/** Another holder kept the lock for the whole wait. */
export class FileLockTimeout extends Error {
  constructor() { super('file lock admission timed out'); this.name = 'FileLockTimeout'; }
}

/** The helper could not take the lock: it exited otherwise than with the lock
 * or a conflict. Names its status and what it printed. */
export class FileLockHelperFailed extends Error {
  constructor(readonly status: number | null, readonly signal: NodeJS.Signals | null, stderr: string) {
    const how = signal ? `killed by ${signal}` : `exit ${status}`;
    super(`file lock helper failed (${how})${stderr ? `: ${stderr}` : ''}`);
    this.name = 'FileLockHelperFailed';
  }
}

/** Same-host Linux coordination. The helper locks an inherited open file
 * description; after it exits, the parent's descriptor retains the kernel lock.
 * Closing that descriptor (including process death) releases it. Lock files
 * must never be unlinked or replaced while contenders can still use them.
 * This is not a distributed lease for hosts with independent filesystems.
 *
 * The helper runs in its own session: a signal to the app's process group
 * (the container init forwarding SIGTERM, a terminal's Ctrl-C) is the app's to
 * handle, and must not end a lock wait the app's graceful shutdown still
 * awaits. If the app dies, the helper ends within its wait and holds nothing.
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
    const { status, signal, stderr } = await new Promise<{ status: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve, reject) => {
      const child = spawn('flock', [options.shared ? '--shared' : '--exclusive',
        '--timeout', String(waitMs / 1000), '--conflict-exit-code', '73', '3'], {
        stdio: ['ignore', 'ignore', 'pipe', descriptor], detached: true,
        timeout: waitMs + 5_000, killSignal: 'SIGKILL',
      });
      let stderr = '';
      child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { if (stderr.length < 2000) stderr += chunk; });
      child.once('error', reject);
      child.once('close', (status, signal) => resolve({ status, signal, stderr: stderr.trim().slice(0, 2000) }));
    });
    if (status === 73 && waitMs === 0) return undefined;
    if (status === 73) throw new FileLockTimeout();
    if (status !== 0) throw new FileLockHelperFailed(status, signal, stderr);
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
