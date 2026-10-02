import { describe, it, expect, vi } from 'vitest';
import { StartupProtocolTrace, collectStartupProbe } from '../src/agent/startup-diagnostics.js';
import { withClaudeStartupDeadline } from '../src/agent/sdk-stream.js';
import { runTurn } from '../src/agent/runtime.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { RemoteSpawnedProcess } from '../src/agent/remote-process.js';
import { pendingTimers } from './helpers/pending-timers.js';

describe('agent startup diagnostics', () => {
  it('collects live process and memory evidence while omitting raw stderr and command lines', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-probe-'));
    try {
      const trace = path.join(root, 'trace.log'), stderr = path.join(root, 'stderr.log');
      fs.writeFileSync(trace, JSON.stringify({ phase: 'relay-started', pid: process.pid, at: Math.floor(Date.now() / 1000) }) + '\n');
      fs.writeFileSync(stderr, 'ECONNREFUSED authentication failed password=never-archive-this\n');
      const world = { async exec(command: string, args: string[]) {
        const r = spawnSync(command, args, { encoding: 'utf8', timeout: 3000 });
        return { code: r.status, stdout: r.stdout, stderr: r.stderr };
      } } as any;
      const probe: any = await collectStartupProbe(world, trace, stderr);
      expect(probe.status).toBe('ok');
      expect(probe.processes).toContainEqual(expect.objectContaining({ pid: process.pid, rssKb: expect.any(Number) }));
      expect(probe.memory.totalKb).toBeGreaterThan(0);
      expect(probe.memory.availableKb).toBeGreaterThan(0);
      expect(probe.stderr).toMatchObject({ codes: ['ECONNREFUSED'], flags: ['auth'] });
      expect(JSON.stringify(probe)).not.toMatch(/password|never-archive|cmdline/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('distinguishes queued input from delivered input and clears protocol tracing once connected', async () => {
    let output!: (data: string) => void;
    let delivered!: () => void;
    const write = new Promise<void>(resolve => { delivered = resolve; });
    const child = new RemoteSpawnedProcess({ async openPty() { return {
      onData(listener: typeof output) { output = listener; return () => {}; },
      onExit() { return () => {}; }, write: () => write, close() {}, resize() {},
    }; } } as any, 'unused', '/workspace', {});
    child.stdin.write('{"type":"control_request","request":{"subtype":"initialize","secret":"hidden"}}\n');
    await Promise.resolve();
    expect((await child.startupDiagnostics()).transport).toMatchObject({
      ptyOpened: true, protocolReady: false, writesStarted: 1, writesCompleted: 0,
      sentFrames: [{ type: 'control_request', subtype: 'initialize' }],
    });
    output('\x1eKARMAX_AGENT_READY\x1e\n');
    delivered();
    await vi.waitFor(async () => expect((await child.startupDiagnostics()).transport).toMatchObject({ writesCompleted: 1 }));
    output('{"type":"control_response","response":{"subtype":"success","secret":"hidden"}}\n');
    expect((await child.startupDiagnostics()).transport).toMatchObject({
      protocolReady: true, receivedFrames: [{ type: 'control_response', subtype: 'success' }],
    });
    expect(JSON.stringify(await child.startupDiagnostics())).not.toContain('hidden');
    child.startupComplete();
    output('{"type":"assistant","message":"hidden"}\n');
    expect((await child.startupDiagnostics()).transport).toMatchObject({ sentFrames: [], receivedFrames: [] });
  });

  it('awaits durable diagnostic publication before returning an activity failure', async () => {
    const order: string[] = [];
    let release!: () => void;
    const stored = new Promise<void>(resolve => { release = resolve; });
    const turn = runTurn({ profile: { provider: 'mock' }, world: { handle: {} }, messages: [], systemPrompt: '' } as any, {
      adapters: new Map([['mock', { provider: 'mock', async runTurn(_input, ctx) {
        await ctx.emitActivity({ id: 'diagnostic', kind: 'error', phase: 'failed', title: 'Agent startup stalled' });
        order.push('adapter-failure');
        throw new Error('timeout');
      } }]]),
      async onActivity(activity) {
        if (activity.id !== 'diagnostic') return;
        order.push('storing'); await stored; order.push('stored');
      },
    }).catch(error => error);
    await vi.waitFor(() => expect(order).toEqual(['storing']));
    release();
    expect((await turn).message).toBe('timeout');
    expect(order).toEqual(['storing', 'stored', 'adapter-failure']);
  });

  it('rejects arbitrary data returned by a modified sandbox executable', async () => {
    const response = { steps: [{ phase: 'secret-phase', pid: 4, at: 6 }, { phase: 'cli-exec', pid: 4, at: 6, secret: 'private' }],
      processes: [{ pid: 4, ppid: 'private', state: 'secret', wait: 'secret', cmdline: 'secret' }],
      memory: { totalKb: 'secret' }, stderr: { bytes: 10, codes: ['EACCES', 'secret'], flags: ['auth', 'secret'] }, secret: 'private' };
    const world = { exec: async () => ({ code: 0, stdout: JSON.stringify(response), stderr: '' }) } as any;
    const probe = await collectStartupProbe(world, '/trace', '/stderr');
    expect(probe).toMatchObject({ status: 'ok', steps: [{ phase: 'cli-exec', pid: 4, at: 6 }],
      stderr: { bytes: 10, codes: ['EACCES'], flags: ['auth'] } });
    expect(JSON.stringify(probe)).not.toMatch(/secret|private/);
  });
  it('records fragmented protocol envelope types without retaining prompts, IDs or credentials', () => {
    const trace = new StartupProtocolTrace();
    trace.read('{"type":"control_req');
    trace.read('uest","request_id":"secret-id","request":{"subtype":"mcp_message","secret":"private"}}\n');
    trace.read('{"type":"secret-frame","subtype":"private"}\n');
    trace.read('{"type":"control_response","response":{"subtype":"success","response":{"secret":"private"}}}\n');
    expect(trace.snapshot()).toEqual([
      { type: 'control_request', subtype: 'mcp_message' },
      { type: 'other' },
      { type: 'control_response', subtype: 'success' },
    ]);
    expect(JSON.stringify(trace)).not.toMatch(/secret|private/);
  });

  it('bounds oversized and malformed frames, then recovers at the next newline', () => {
    const trace = new StartupProtocolTrace();
    trace.read('x'.repeat(300_000));
    trace.read('"secret"\n');
    for (let i = 0; i < 30; i++) trace.read('{"type":"user","message":"private"}\n');
    expect(trace.snapshot()).toHaveLength(8);
    expect(trace.snapshot().at(-1)).toEqual({ type: 'user' });
    expect(JSON.stringify(trace)).not.toContain('private');
    expect(JSON.stringify(trace).length).toBeLessThan(2000);
  });

  it('does not let an unresponsive diagnostic probe prevent retry', async () => {
    vi.useFakeTimers();
    const pending = pendingTimers(/src[\\/]agent[\\/]/);
    try {
      const probe = collectStartupProbe({ exec: () => new Promise(() => {}) } as any, '/startup.log', '/stderr.log');
      await vi.advanceTimersByTimeAsync(3500);
      expect(await probe).toEqual({ status: 'timeout' });
      expect(pending()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('takes the diagnostic snapshot before aborting the silent process', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const stream = (async function* () { await new Promise(() => {}); })();
    try {
      const result = withClaudeStartupDeadline(stream, () => { order.push('abort'); }, async () => {
        order.push('snapshot');
        await new Promise(resolve => setTimeout(resolve, 20));
        order.push('persisted');
      }).next().catch(error => error);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(order).toEqual(['snapshot']);
      await vi.advanceTimersByTimeAsync(20);
      expect(order).toEqual(['snapshot', 'persisted', 'abort']);
      expect(await result).toMatchObject({ code: 'ETIMEDOUT' });
    } finally { vi.useRealTimers(); }
  });

  it.each(['reject', 'hang'])('still aborts and retries when diagnostic publication can %s', async (failure) => {
    vi.useFakeTimers();
    const pending = pendingTimers(/src[\\/]agent[\\/]/);
    const abort = vi.fn();
    try {
      const stream = (async function* () { await new Promise(() => {}); })();
      const result = withClaudeStartupDeadline(stream, abort, () => failure === 'hang'
        ? new Promise(() => {}) : Promise.reject(new Error('diagnostics unavailable'))).next().catch(error => error);
      await vi.advanceTimersByTimeAsync(305_000);
      expect(await result).toMatchObject({ code: 'ETIMEDOUT' });
      expect(abort).toHaveBeenCalledOnce();
      expect(pending()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
