import { afterEach, expect, it, vi } from 'vitest';
import { ExecutionOutput, EXECUTION_OUTPUT_BYTES } from '../src/gateway/execution-output.js';
import { utf8Tail } from '../src/util/utf8-tail.js';
import { Store } from '../src/store/db.js';
import { ReviewActionRunner } from '../src/gateway/review-actions.js';
import { pendingTimers } from './helpers/pending-timers.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
afterEach(() => vi.useRealTimers());

it('coalesces a noisy stream behind one write and drains its bounded UTF-8 tail', async () => {
  const blocked = gate();
  const chunks: string[] = [];
  const persist = vi.fn(async (data: string) => { chunks.push(data); await blocked.promise; });
  const writer = new ExecutionOutput(persist);
  writer.append('first\n');
  await Promise.resolve();
  let expected = '';
  for (let i = 0; i < 1000; i++) {
    const chunk = `${i}:` + '🙂'.repeat(100);
    expected = utf8Tail(expected + chunk, EXECUTION_OUTPUT_BYTES);
    writer.append(chunk);
  }
  expect(persist).toHaveBeenCalledTimes(1);
  let closed = false;
  const closing = writer.close().then(() => { closed = true; });
  expect(closed).toBe(false);
  blocked.release();
  await closing;
  expect(chunks).toEqual(['first\n', expected]);
  expect(Buffer.byteLength(chunks[1]!)).toBeLessThanOrEqual(EXECUTION_OUTPUT_BYTES);
  expect(chunks[1]).not.toContain('\ufffd');
});

it('retries a failed bounded tail without unhandled rejections, then drains on close', async () => {
  vi.useFakeTimers();
  const pending = pendingTimers(/src[\\/]gateway[\\/]execution-output/);
  const error = new Error('storage unavailable');
  const persist = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
  const report = vi.fn();
  const writer = new ExecutionOutput(persist, report);
  writer.append('before');
  await vi.advanceTimersByTimeAsync(1);
  writer.append('after');
  expect(persist).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  await writer.close();
  expect(report).toHaveBeenCalledWith(error);
  expect(persist.mock.calls.map(call => call[0])).toEqual(['before', 'beforeafter']);
  expect(pending()).toBe(0);
});

it('reports a drain failure and cancels its retry timer on shutdown', async () => {
  vi.useFakeTimers();
  const pending = pendingTimers(/src[\\/]gateway[\\/]execution-output/);
  const persist = vi.fn(async () => { throw new Error('offline'); });
  const writer = new ExecutionOutput(persist, () => {});
  writer.append('kept');
  await expect(writer.close()).rejects.toThrow('offline');
  await vi.advanceTimersByTimeAsync(5000);
  expect(persist).toHaveBeenCalledTimes(1);
  expect(pending()).toBe(0);
});

it('keeps oversized newest frames within the durable reconnect budget', async () => {
  const store = await Store.create(':memory:');
  try {
    await store.appendExecutionFrame('test-execution', 'old history');
    const newest = await store.appendExecutionFrame('test-execution', '🙂'.repeat(100_000));
    const frames = await store.executionFrames('test-execution');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.seq).toBe(newest.seq);
    expect(Buffer.byteLength(frames[0]!.data)).toBe(EXECUTION_OUTPUT_BYTES);
    expect(frames[0]!.data).not.toContain('\ufffd');
  } finally { await store.close(); }
});

it('delivers review output immediately and records completion only after persistence drains', async () => {
  const blocked = gate();
  let output!: (data: string) => void;
  let exit!: (code: number | null) => void;
  const process = { onOutput: (fn: typeof output) => { output = fn; return () => {}; },
    onExit: (fn: typeof exit) => { exit = fn; return () => {}; }, kill: vi.fn() };
  const frames: string[] = [];
  const store = {
    getTask: async () => ({ projectId: 'project' }), getProject: async () => ({ id: 'project', organizationId: 'org' }),
    createExecution: async () => {}, setExecutionRunning: async () => {},
    appendExecutionFrame: vi.fn(async (_id: string, data: string) => { await blocked.promise; frames.push(data); }),
    finishExecution: vi.fn(async () => { expect(frames.join('')).toBe('firstsecond'); }),
    heartbeatExecution: async () => {}, execution: async () => ({}),
  };
  const worlds = { get: () => ({}), open: async () => ({ startProcess: async () => process }) };
  const runner = new ReviewActionRunner(worlds as any, store as any);
  try {
    const rec = await runner.start({ taskId: 'task', world: { id: 'world', kind: 'memory' } as any,
      label: 'Test', command: 'test' });
    const delivered: string[] = [];
    let finished!: () => void;
    const complete = new Promise<void>(resolve => { finished = resolve; });
    await runner.attach(rec.procId, (data, done) => { delivered.push(data); if (done) finished(); });
    output('first');
    await Promise.resolve();
    output('second');
    exit(0);
    expect(delivered).toEqual(['first', 'second']);
    expect(store.finishExecution).not.toHaveBeenCalled();
    blocked.release();
    await complete;
    expect(store.finishExecution).toHaveBeenCalledTimes(1);
    expect(runner.get(rec.procId)).toBeUndefined();
  } finally { blocked.release(); await runner.stopAll(); }
});
