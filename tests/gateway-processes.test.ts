import { expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { trackProcess } from '../src/util/processes.js';
import { stubGateway } from './helpers/stub-gateway.js';

it.skipIf(process.platform !== 'linux')('cancels the owning task when stopping an agent process (AD-22)', async () => {
  const signalTask = vi.fn(async () => {});
  const h = await stubGateway({ api: { signalTask } as any });
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  const kill = vi.fn();
  const untrack = trackProcess({ pid: child.pid!, kind: 'agent', label: 'agent',
    taskId: 'task_stop', startedAt: Date.now(), kill });
  try {
    const token = (await h.tokens.mintPrincipal('user:test', ['*'])).token;
    const response = await fetch(`${h.base}/api/processes/kill`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ pid: child.pid, signal: 'SIGKILL' }) });
    expect(response.status).toBe(200);
    expect(signalTask).toHaveBeenCalledExactlyOnceWith(token, 'task_stop', 'cancel');
    expect(kill).not.toHaveBeenCalled();
  } finally { untrack(); child.kill('SIGKILL'); await h.close(); }
});
