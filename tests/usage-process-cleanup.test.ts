import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { probeClaudeUsage } from '../src/agent/usage.js';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('escalates a timed-out usage CLI that ignores SIGTERM to SIGKILL', async () => {
  vi.useFakeTimers();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-usage-kill-'));
  fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-token', refreshToken: 'fixture-refresh' } }));
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(),
    kill: vi.fn((signal: string) => { if (signal === 'SIGKILL') queueMicrotask(() => child.emit('exit', null, signal)); return true; }),
  });
  spawn.mockReturnValue(child);
  try {
    const probe = probeClaudeUsage({ configHome: home, timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(await probe).toMatchObject({ ok: false, reason: expect.stringContaining('timed out') });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
