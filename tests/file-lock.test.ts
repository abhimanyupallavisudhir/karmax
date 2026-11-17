import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { acquireFileLock, FileLockHelperFailed } from '../src/util/file-lock.js';
import { lockContended } from './helpers/lock-waiters.js';

const linux = process.platform === 'linux' ? it : it.skip;
const directories: string[] = [];
const children: ChildProcess[] = [];
const releases: Array<() => void> = [];
const originalPath = process.env.PATH;

function directory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-file-lock-'));
  directories.push(dir);
  return dir;
}

afterEach(async () => {
  process.env.PATH = originalPath;
  for (const release of releases.splice(0)) release();
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const closed = once(child, 'close');
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    await closed;
  }
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A `flock` on PATH that fails the way the real one can. */
function fakeFlock(script: string) {
  const bin = directory();
  fs.writeFileSync(path.join(bin, 'flock'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${originalPath}`;
}

// tavya.error eb2d2aee986d5e4d (2026-11-10): the container's init (dumb-init)
// forwards SIGTERM to the app's whole process group, and so did a terminal's
// Ctrl-C to `npm start`. A lock helper in that group died mid-wait, and a sweep
// step that was only waiting for a world failed "file lock helper failed".
linux('keeps waiting through a signal sent to the app\'s process group', async () => {
  const file = path.join(directory(), 'world.lock');
  const holder = await acquireFileLock(file);
  releases.push(holder!);
  const module = new URL('../src/util/file-lock.ts', import.meta.url).href;
  const code = `
    import { acquireFileLock } from ${JSON.stringify(module)};
    process.on('SIGTERM', () => {}); // the app shuts down gracefully, finishing its work
    acquireFileLock(${JSON.stringify(file)}, { waitMs: 20_000 })
      .then((release) => { release(); process.send('acquired'); },
        (error) => process.send('failed: ' + error.message))
      .finally(() => process.disconnect());
  `;
  // detached: the app leads its own process group, as under dumb-init.
  const app = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'], detached: true,
  });
  children.push(app);
  const outcome = new Promise<string>((resolve, reject) => {
    app.once('message', (message) => resolve(String(message)));
    app.once('error', reject);
  });
  await lockContended(file);
  process.kill(-app.pid!, 'SIGTERM');
  // A helper killed by the signal answers at once; give it the chance.
  await new Promise((resolve) => setTimeout(resolve, 300));
  releases.pop()!();
  holder!();
  expect(await outcome).toBe('acquired');
});

linux('says how the helper failed: its exit status and what it printed', async () => {
  const file = path.join(directory(), 'lock');
  fakeFlock(`echo "flock: cannot flock descriptor 3: Cannot allocate memory" >&2; exit 71`);
  const failure = await acquireFileLock(file, { waitMs: 1000 }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(FileLockHelperFailed);
  expect((failure as Error).message).toBe('file lock helper failed (exit 71): flock: cannot flock descriptor 3: Cannot allocate memory');
});

linux('says which signal killed the helper', async () => {
  const file = path.join(directory(), 'lock');
  fakeFlock('kill -KILL $$');
  await expect(acquireFileLock(file, { waitMs: 1000 })).rejects.toThrow('file lock helper failed (killed by SIGKILL)');
});

linux('still takes, times out and releases the lock', async () => {
  const file = path.join(directory(), 'lock');
  const first = await acquireFileLock(file, { waitMs: 0 });
  expect(first).toBeTypeOf('function');
  expect(await acquireFileLock(file, { waitMs: 0 })).toBeUndefined();
  await expect(acquireFileLock(file, { waitMs: 100 })).rejects.toThrow('file lock admission timed out');
  first!();
  const second = await acquireFileLock(file, { waitMs: 0 });
  expect(second).toBeTypeOf('function');
  second!();
});
