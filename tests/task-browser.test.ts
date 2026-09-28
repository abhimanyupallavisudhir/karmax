import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CUSTODY_ENV, registerAgent } from '../src/agent/custody.js';
import { localTaskBrowserUrl } from '../src/autonomy/task-browser.js';

// AU-14/AU-32: a local fill types into the browser that this task's own agent
// launched, found by the custody marker its descendants inherit, never into a
// DevTools endpoint the agent names.
describe('a local task’s own browser', () => {
  let home: string;
  const children: ChildProcess[] = [];
  const idle = 'setInterval(() => {}, 1000)';
  const run = (args: string[], custody?: string) => {
    const child = spawn(process.execPath, ['-e', idle, '--', ...args], { stdio: 'ignore',
      env: { PATH: process.env.PATH ?? '', ...(custody ? { [CUSTODY_ENV]: custody } : {}) } });
    children.push(child);
    return child;
  };
  const agent = (taskId: string, custodyId: string) => {
    const child = run([], custodyId);
    registerAgent({ pid: child.pid!, cmd: 'node', taskId, owner: process.pid, custodyId, startedAt: Date.now() });
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-task-browser-'));
    vi.stubEnv('KARMAX_HOME', home);
  });
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it.each(['linux', 'darwin'])('finds it by its agent’s custody marker (%s)', async (platform) => {
    if (process.platform !== 'linux') return;
    const real = process.platform;
    Object.defineProperty(process, 'platform', { value: platform });
    try {
      agent('task_a', 'custody-a');
      agent('task_b', 'custody-b');
      // Another task's browser, and one nobody's agent started.
      run(['--remote-debugging-port=45101'], 'outer,custody-b');
      run(['--remote-debugging-port=45102']);
      await settle();
      expect(() => localTaskBrowserUrl('task_a')).toThrow(/no browser of its own/);
      run(['--remote-debugging-port=45103'], 'outer,custody-a');
      await settle();
      expect(localTaskBrowserUrl('task_a')).toBe('http://127.0.0.1:45103');
      expect(localTaskBrowserUrl('task_b')).toBe('http://127.0.0.1:45101');
      expect(() => localTaskBrowserUrl('task_c')).toThrow(/no agent of this task is running/);
      expect(() => localTaskBrowserUrl(undefined)).toThrow(/call this from a task/);
    } finally { Object.defineProperty(process, 'platform', { value: real }); }
  });
});
