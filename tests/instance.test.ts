import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanInstances } from '../src/util/instance.js';

// Cheap unit test (no Temporal, no worker): duplicate app-instance detection
// against a temp "instances" dir with an injected liveness probe (karmax#4).

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-instances-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (pid: number) => fs.writeFileSync(path.join(dir, `${pid}.pid`), JSON.stringify({ pid }));

describe('scanInstances', () => {
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
});
