import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { duplicateInstanceMessage, scanInstances, isInsideDir, registerAppInstance } from '../src/util/instance.js';

// Cheap unit test (no Temporal, no worker): duplicate app-instance detection
// against a temp "instances" dir with an injected liveness probe (karmax#4).

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-instances-'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (pid: number, record: Record<string, unknown> = {}) =>
  fs.writeFileSync(path.join(dir, `${pid}.pid`), JSON.stringify({ pid, ...record }));

describe('scanInstances', () => {
  it('renders duplicate admission as a correctness failure', () => {
    expect(duplicateInstanceMessage('/srv/karmax', [1001, 1002]))
      .toMatch(/already running.*pids 1001, 1002.*steal activities.*workflow coherence/i);
  });
  it('reports live OTHER instances and excludes self', () => {
    write(1001);
    write(1002);
    write(4242); // self
    const others = scanInstances(dir, 4242, () => true);
    expect(others).toEqual([1001, 1002]);
  });

  it('prunes stale pidfiles for dead instances and does not report them', () => {
    write(1001); // dead
    write(1002); // alive
    const alive = (pid: number) => pid === 1002;
    const others = scanInstances(dir, 4242, alive);
    expect(others).toEqual([1002]);
    // The dead one's pidfile is cleaned up.
    expect(fs.existsSync(path.join(dir, '1001.pid'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '1002.pid'))).toBe(true);
  });

  it('returns empty when alone (only self registered)', () => {
    write(4242);
    expect(scanInstances(dir, 4242, () => true)).toEqual([]);
  });

  it('returns empty when the instances dir does not exist', () => {
    expect(scanInstances(path.join(dir, 'nope'), 4242, () => true)).toEqual([]);
  });

  it('ignores non-pidfile entries', () => {
    write(1001);
    fs.writeFileSync(path.join(dir, 'README.txt'), 'not a pidfile');
    fs.mkdirSync(path.join(dir, 'subdir'));
    expect(scanInstances(dir, 4242, () => true)).toEqual([1001]);
  });

  it('prunes a reused PID but preserves the process whose start identity matches', () => {
    write(1001, { pidStart: '100', bootId: 'boot' });
    write(1002, { pidStart: '200', bootId: 'boot' });
    expect(scanInstances(dir, 4242, () => true, () => ({ pidStart: '200', bootId: 'boot' })))
      .toEqual([1002]);
    expect(fs.existsSync(path.join(dir, '1001.pid'))).toBe(false);
  });

  it('does not confuse a start tick reused after reboot with the previous process', () => {
    write(1001, { pidStart: '100', bootId: 'old-boot' });
    expect(scanInstances(dir, 4242, () => true, () => ({ pidStart: '100', bootId: 'new-boot' })))
      .toEqual([]);
  });

  it('migrates legacy PID records without mistaking tsx or esbuild for the app', () => {
    write(30, { argv: ['/app/src/main.ts'] });
    write(32, { argv: ['/app/src/main.ts'] });
    const identity = (pid: number) => ({ cwd: '/app', argv: pid === 30
      ? ['/usr/bin/node', '--import', 'tsx', 'src/main.ts']
      : ['/app/node_modules/esbuild/bin/esbuild', '--service=0.28.1'] });
    expect(scanInstances(dir, 4242, () => true, identity)).toEqual([30]);
    expect(fs.existsSync(path.join(dir, '32.pid'))).toBe(false);
  });

  it('preserves live owners when process identity cannot be inspected', () => {
    write(1001, { pidStart: '100', argv: ['/app/src/main.ts'] });
    expect(scanInstances(dir, 4242, () => true, () => ({}))).toEqual([1001]);
  });

  it('uses the acquired kernel lock as authority across container PID namespaces', () => {
    write(1001, { processLock: true, pidStart: '100' });
    const identity = () => ({ pidStart: '100' });
    // Merely observing a lock-aware record does not license removing it.
    expect(scanInstances(dir, 4242, () => true, identity)).toEqual([1001]);
    // Only a successful lock acquisition proves the prior lock holder is gone.
    expect(scanInstances(dir, 4242, () => true, identity, true)).toEqual([]);
    expect(fs.existsSync(path.join(dir, '1001.pid'))).toBe(false);
  });
});

describe.skipIf(process.platform !== 'linux')('kernel instance admission', () => {
  it('excludes a second contender even with the same PID, then permits a graceful successor', () => {
    vi.stubEnv('KARMAX_HOME', dir);
    const first = registerAppInstance();
    try {
      expect(first.others).toEqual([]);
      expect(() => registerAppInstance()).toThrow(/exclusive process lock is held/);
      const record = JSON.parse(fs.readFileSync(path.join(dir, 'state/instances', `${process.pid}.pid`), 'utf8'));
      expect(record.processLock).toBe(true);
      expect(record.pidStart).toMatch(/^\d+$/);
      expect(record.bootId).toBeTruthy();
    } finally { first.release(); }
    first.release(); // idempotent, must not close a successor's descriptor
    const next = registerAppInstance();
    try { expect(next.others).toEqual([]); } finally { next.release(); }
    expect(fs.existsSync(path.join(dir, 'state/instances/app.lock'))).toBe(true);
  });

  it('recovers after SIGKILL without weakening live-process exclusion', async () => {
    vi.stubEnv('KARMAX_HOME', dir);
    const moduleUrl = new URL('../src/util/instance.ts', import.meta.url).href;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      `import { registerAppInstance } from ${JSON.stringify(moduleUrl)};
       registerAppInstance(); console.log('ready'); setInterval(() => {}, 1000);`],
    { env: { ...process.env, KARMAX_HOME: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    try {
      const ready = await Promise.race([once(child.stdout, 'data'), exited.then(() => { throw new Error('lock holder exited before ready'); })]);
      expect(String(ready[0])).toContain('ready');
      expect(() => registerAppInstance()).toThrow(/already running/);
      child.kill('SIGKILL');
      await exited;
      const stale = path.join(dir, 'state/instances', `${child.pid}.pid`);
      expect(fs.existsSync(stale)).toBe(true); // no shutdown cleanup ran
      const successor = registerAppInstance();
      try {
        expect(successor.others).toEqual([]);
        expect(fs.existsSync(stale)).toBe(false);
      } finally { successor.release(); }
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    }
  });

  it('fails closed if flock is unavailable and leaves no claimed registration', () => {
    vi.stubEnv('KARMAX_HOME', dir);
    vi.stubEnv('PATH', '');
    expect(() => registerAppInstance()).toThrow(/requires util-linux\/flock/);
    expect(fs.existsSync(path.join(dir, 'state/instances', `${process.pid}.pid`))).toBe(false);
  });
});

// World-rooted self-poisoning guard (karmax#3): main.ts refuses to boot when the
// app checkout sits inside the KARMAX_HOME worlds dir it would serve.
describe('isInsideDir', () => {
  it('detects a checkout nested inside the worlds dir', () => {
    const worlds = path.join(dir, 'worlds');
    const checkout = path.join(worlds, 'task_abc123');
    fs.mkdirSync(checkout, { recursive: true });
    expect(isInsideDir(checkout, worlds)).toBe(true);
    expect(isInsideDir(path.join(checkout, 'src'), worlds)).toBe(true);
  });

  it('rejects siblings, parents, and the dir itself', () => {
    const worlds = path.join(dir, 'worlds');
    fs.mkdirSync(worlds, { recursive: true });
    expect(isInsideDir(dir, worlds)).toBe(false); // parent
    expect(isInsideDir(worlds, worlds)).toBe(false); // itself
    expect(isInsideDir(path.join(dir, 'elsewhere'), worlds)).toBe(false); // sibling
    // A sibling whose name shares the worlds dir as a string prefix.
    expect(isInsideDir(path.join(dir, 'worlds-other'), worlds)).toBe(false);
  });

  it('resolves symlinked paths to their real location', () => {
    const worlds = path.join(dir, 'worlds');
    const checkout = path.join(worlds, 'task_abc123');
    fs.mkdirSync(checkout, { recursive: true });
    const link = path.join(dir, 'link-to-checkout');
    fs.symlinkSync(checkout, link, 'dir');
    expect(isInsideDir(link, worlds)).toBe(true);
  });

  it('still classifies a deleted directory by its resolved path', () => {
    // The orphaned-instance case: the world was removed post-merge but the
    // process (and its recorded path) lives on.
    const worlds = path.join(dir, 'worlds');
    expect(isInsideDir(path.join(worlds, 'task_gone', 'src'), worlds)).toBe(true);
  });
});
