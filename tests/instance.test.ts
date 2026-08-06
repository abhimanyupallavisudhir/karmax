import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { duplicateInstanceMessage, scanInstances, isInsideDir } from '../src/util/instance.js';

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
