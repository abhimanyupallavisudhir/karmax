import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { admitWorkerProcess, claimWorkerOwnership, registerAppInstance } from '../src/util/instance.js';

const test = process.platform === 'linux' ? it : it.skip;
let home: string;
let registration: ReturnType<typeof registerAppInstance> | undefined;
const children: Array<{ child: ChildProcess; exited: Promise<void> }> = [];
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-worker-admission-'));
  vi.stubEnv('KARMAX_HOME', home);
});
afterEach(async () => {
  for (const { child, exited } of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
  registration?.release();
  registration = undefined;
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});
async function start() {
  const child = fork(fileURLToPath(new URL('./fixtures/worker-admission.ts', import.meta.url)), [], {
    env: { PATH: process.env.PATH, KARMAX_HOME: home },
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  children.push({ child, exited });
  const reply = await new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('admission fixture timed out')), 5_000);
    child.once('message', value => { clearTimeout(timer); resolve(value as { ok: boolean; error?: string }); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', () => { clearTimeout(timer); reject(new Error('admission fixture closed before replying')); });
  });
  return { child, exited, reply };
}

test('refuses an unregistered IPC parent before creating application directories', async () => {
  expect((await start()).reply).toMatchObject({ ok: false, error: expect.stringContaining('not registered') });
  expect(fs.readdirSync(home)).toEqual([]);
});

test('admits one child and releases ownership after graceful stop and process death', async () => {
  registration = registerAppInstance();
  const first = await start();
  expect(first.reply).toEqual({ ok: true });
  expect((await start()).reply).toMatchObject({ ok: false, error: expect.stringContaining('still running') });
  first.child.send('stop');
  await first.exited;
  const second = await start();
  expect(second.reply).toEqual({ ok: true });
  second.child.kill('SIGKILL');
  await second.exited;
  expect((await start()).reply).toEqual({ ok: true });
});

test('rejects a registration for a recycled parent identity', async () => {
  registration = registerAppInstance();
  const file = path.join(home, 'state', 'instances', `${process.pid}.pid`);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...record, pidStart: 'invalid-start-time' }));
  expect((await start()).reply).toMatchObject({ ok: false, error: expect.stringContaining('live identity') });
});

test('uses the same ownership lock for combined and supervised runtimes', async () => {
  registration = registerAppInstance();
  const release = await claimWorkerOwnership(home);
  try {
    expect((await start()).reply).toMatchObject({ ok: false, error: expect.stringContaining('still running') });
  } finally { release(); }
  const worker = await start();
  expect(worker.reply).toEqual({ ok: true });
  await expect(claimWorkerOwnership(home)).rejects.toThrow('still running');
});

test('rejects a stale registration after the primary relinquishes its lock', async () => {
  registration = registerAppInstance();
  const file = path.join(home, 'state', 'instances', `${process.pid}.pid`);
  const contents = fs.readFileSync(file);
  registration.release();
  fs.writeFileSync(file, contents);
  expect((await start()).reply).toMatchObject({ ok: false, error: expect.stringContaining('application lock') });
});

test('requires a supervisor channel even when the local home has a registered primary', async () => {
  registration = registerAppInstance();
  // Vitest itself may have IPC, but its parent is not this home's primary.
  await expect(admitWorkerProcess(home)).rejects.toThrow(/IPC|not registered/);
});
