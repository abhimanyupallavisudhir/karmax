import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkerProcessManager } from '../src/temporal/worker-process.js';

const managers: WorkerProcessManager[] = [];
const test = process.platform === 'linux' ? it : it.skip;
afterEach(async () => { for (const manager of managers.splice(0)) await manager.stop(); });
function manager(mode = '', options: Partial<ConstructorParameters<typeof WorkerProcessManager>[0]> = {}) {
  const result = new WorkerProcessManager({
    entrypoint: fileURLToPath(new URL('./fixtures/worker-process.mjs', import.meta.url)),
    env: { PATH: process.env.PATH, WORKER_FIXTURE_MODE: mode },
    execArgv: ['--import', 'tsx', '--max-old-space-size=64'], requestTimeoutMs: 5_000, stopTimeoutMs: 1_000,
    ...options,
  });
  managers.push(result);
  return result;
}

test('waits for readiness and drains accepted refreshes before stopping', async () => {
  const worker = manager();
  expect(worker.isReady).toBe(false);
  await worker.start();
  expect(worker.isReady).toBe(true);
  const packages = [{ type: 'fixture@1', entryFile: '/fixture/one.ts' }];
  const refreshing = worker.refresh(packages);
  packages[0]!.entryFile = '/changed-after-admission.ts';
  const stopping = worker.stop();
  await expect(worker.refresh([])).rejects.toThrow('not accepting');
  await Promise.all([refreshing, stopping, worker.stop()]);
  expect(worker.packages[0]?.entryFile).toBe('/fixture/one.ts');
  expect(worker.isReady).toBe(false);
  expect(worker.failure).toBeUndefined();
  await expect(worker.start()).rejects.toThrow('cannot be started again');
});

test('keeps the previous package set when a refresh is rejected', async () => {
  const worker = manager('reject-refresh');
  const original = [{ type: 'fixture@1', entryFile: '/fixture/one.ts' }];
  await worker.start(original);
  await expect(worker.refresh([{ type: 'fixture@2', entryFile: '/fixture/two.ts' }])).rejects.toThrow('bundle rejected');
  expect(worker.isReady).toBe(true);
  expect(worker.packages).toEqual(original);
});

test('drains a start already accepted when shutdown arrives', async () => {
  const worker = manager();
  const starting = worker.start();
  await Promise.all([starting, worker.stop()]);
  expect(worker.isReady).toBe(false);
  expect(worker.failure).toBeUndefined();
});

test('reports a failed child drain instead of treating its exit as clean', async () => {
  const worker = manager('failed-stop');
  await worker.start();
  await worker.stop();
  expect(worker.isReady).toBe(false);
  expect(worker.failure).toBeInstanceOf(Error);
});

test('contains a frozen child while the parent event loop keeps progressing', async () => {
  const failed = vi.fn();
  const worker = manager('frozen', { requestTimeoutMs: 300, onFailure: failed });
  const starting = expect(worker.start()).rejects.toThrow('timed out');
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 10);
  try { await starting; }
  finally { clearInterval(timer); }
  expect(ticks).toBeGreaterThan(0);
  expect(worker.isReady).toBe(false);
  expect(failed).toHaveBeenCalledTimes(1);
  await worker.stop();
});

test('rejects accepted work when the child exits unexpectedly', async () => {
  const failed = vi.fn();
  const worker = manager('crash-refresh', { onFailure: failed });
  await worker.start();
  await expect(worker.refresh([])).rejects.toThrow(/exited|disconnected/);
  expect(worker.isReady).toBe(false);
  expect(failed).toHaveBeenCalledTimes(1);
  await worker.stop();
});

test('bounds refresh admission and kills a child that cannot drain on shutdown', async () => {
  const worker = manager('frozen-refresh', { stopTimeoutMs: 150 });
  await worker.start();
  // Observe all accepted results immediately, including the ones that fail
  // after the frozen child is killed, so none become unhandled rejections.
  const accepted = Array.from({ length: 16 }, () => worker.refresh([]).then(() => 'ok', () => 'failed'));
  await expect(worker.refresh([])).rejects.toThrow('admission is full');
  await worker.stop();
  expect(await Promise.all(accepted)).toEqual(Array(16).fill('failed'));
  expect(worker.failure?.message).toBe('worker shutdown timed out');
});

it('can stop before startup and rejects invalid timeouts', async () => {
  const worker = manager();
  await worker.stop();
  await expect(worker.start()).rejects.toThrow('cannot be started again');
  expect(() => manager('', { requestTimeoutMs: -1 })).toThrow('positive');
});

test('kills an event-loop-stalled worker after its supervisor dies', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/worker-process.mjs', import.meta.url));
  const parent = spawn(process.execPath, ['--input-type=module', '-e', `
    import { fork } from 'node:child_process';
    const child = fork(${JSON.stringify(fixture)}, [], {
      execArgv: ['--import', 'tsx', '--max-old-space-size=64'],
      env: { PATH: process.env.PATH, WORKER_FIXTURE_MODE: 'frozen' },
      stdio: ['ignore','ignore','ignore','ipc'],
    });
    child.once('message', () => {
      child.send({type:'worker.request',id:1,action:'start',packages:[]});
      process.send({pid:child.pid});
    });
  `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const closed = once(parent, 'close');
  let childPid: number | undefined;
  const alive = () => {
    if (!childPid) return false;
    try {
      const stat = fs.readFileSync(`/proc/${childPid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
  try {
    const [message] = await once(parent, 'message', { signal: AbortSignal.timeout(5_000) });
    childPid = message.pid;
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(alive()).toBe(true);
    parent.kill('SIGKILL');
    await closed;
    await vi.waitFor(() => expect(alive()).toBe(false), { timeout: 5_000, interval: 50 });
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
    await closed;
    if (alive()) process.kill(childPid!, 'SIGKILL');
  }
});
