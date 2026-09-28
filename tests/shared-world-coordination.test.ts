import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { SharedWorldCoordination } from '../src/world/shared-coordination.js';
import { WorldOperationLock } from '../src/world/operation-lock.js';
import { WorldRegistry } from '../src/world/registry.js';
import { acquireFileLock } from '../src/util/file-lock.js';
import { lockContended } from './helpers/lock-waiters.js';

const linux = process.platform === 'linux' ? it : it.skip;
const directories: string[] = [];
const children: ChildProcess[] = [];
const releases: Array<() => void> = [];
function directory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-shared-world-'));
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const closed = once(child, 'close');
    child.kill('SIGKILL');
    await closed;
  }
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function childOwner(dir: string, kind: 'operation' | 'access') {
  const module = new URL('../src/world/shared-coordination.ts', import.meta.url).href;
  const code = `
    import { SharedWorldCoordination } from ${JSON.stringify(module)};
    const coordination = new SharedWorldCoordination(${JSON.stringify(dir)});
    setInterval(() => {}, 1000);
    if (${JSON.stringify(kind)} === 'access') {
      await coordination.holdAccess('world');
      process.send('acquired');
    } else {
      await coordination.operation('world', async () => {
        process.send('acquired');
        await new Promise(() => {});
      });
    }
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('lock owner did not become ready')), 10_000);
    child.once('message', () => { clearTimeout(timer); resolve(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('lock owner exited before readiness')); });
  });
  return child;
}

linux('excludes another process until its transition owner dies, without blocking the event loop', async () => {
  const dir = directory();
  const owner = await childOwner(dir, 'operation');
  const coordination = new SharedWorldCoordination(dir);
  let entered = false;
  const waiting = coordination.operation('world', async () => { entered = true; });
  // Blocked in the kernel behind the owner's lock, while this test keeps running.
  await lockContended((coordination as any).filename('world', 'operation'));
  expect(entered).toBe(false);
  const closed = once(owner, 'close');
  owner.kill('SIGKILL');
  await closed;
  await waiting;
  expect(entered).toBe(true);
});

linux('observes another process access pin and releases it on process death', async () => {
  const dir = directory();
  const owner = await childOwner(dir, 'access');
  const registry = new WorldRegistry({ coordinationDirectory: dir });
  expect(registry.activeAccessCount('world')).toBe(0);
  expect(await registry.hasActiveAccess('world')).toBe(true);
  expect(await registry.hasActiveAccess('different-world')).toBe(false);
  const local = await registry.holdAccess('world');
  releases.push(local);
  const closed = once(owner, 'close');
  owner.kill('SIGKILL');
  await closed;
  expect(await registry.hasActiveAccess('world')).toBe(true);
  local(); local();
  expect(await registry.hasActiveAccess('world')).toBe(false);
});

linux('keeps nested transition operations reentrant and releases on failure', async () => {
  const shared = new SharedWorldCoordination(directory());
  const first = new WorldOperationLock(shared);
  const second = new WorldOperationLock(shared);
  await expect(first.run('world', () => first.run('world', async () => {
    throw new Error('provider failed');
  }))).rejects.toThrow('provider failed');
  expect(await second.run('world', async () => 'recovered')).toBe('recovered');
});

linux('times out contention and closes the failed waiter before another acquisition', async () => {
  const filename = path.join(directory(), 'stable.lock');
  const release = (await acquireFileLock(filename))!;
  releases.push(release);
  expect(await acquireFileLock(filename, { waitMs: 0 })).toBeUndefined();
  await expect(acquireFileLock(filename, { waitMs: 20 })).rejects.toThrow('timed out');
  release();
  const next = await acquireFileLock(filename, { waitMs: 0 });
  expect(next).toBeTypeOf('function');
  next!();
});
