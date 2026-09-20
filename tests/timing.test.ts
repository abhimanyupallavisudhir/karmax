import { describe, it, expect } from 'vitest';
import { TimingTrace, timingReport, distribution } from '../src/timing/index.js';

describe('latency evidence', () => {
  it('unions overlapping spans, preserves unknowns and does not add nested work', async () => {
    let now = 0; const rows: any[] = [];
    const t = new TimingTrace({ taskId: 't', turnId: 'turn', attempt: 1 }, r => rows.push(r), () => now);
    const root = (await t.start('agent.attempt'));
    now = 10; const a = (await t.start('tool.execution'));
    now = 20; const b = (await t.start('tool.execution'));
    now = 30; (await a()); now = 50; (await b()); now = 60; (await t.mark('first.text'));
    now = 100; (await root());
    const r = timingReport(rows).attempts[0]!;
    expect(r.totalMs).toBe(100);
    expect(r.firstTextMs).toBe(60);
    expect(r.coveredMs).toBe(40);
    expect(r.unattributedMs).toBe(60);
    expect(r.spans.find(s => s.name === 'tool.execution')?.sumMs).toBe(50);
  });
  it('isolates retries and clocks, and leaves interrupted attempts incomplete', async () => {
    const rows: any[] = []; let now = 0;
    const one = new TimingTrace({ taskId: 't', turnId: 'turn', attempt: 1 }, r => rows.push(r), () => now);
    (await one.start('agent.attempt')); (await one.start('tool.execution'));
    now = 10;
    const two = new TimingTrace({ taskId: 't', turnId: 'turn', attempt: 2 }, r => rows.push(r), () => now);
    const end = (await two.start('agent.attempt')); now = 20; (await end('failed'));
    const r = timingReport([...rows, ...rows]); // duplicate export pages are idempotent
    expect(r.attempts).toHaveLength(2);
    expect(r.attempts[0]?.totalMs).toBeNull();
    expect(r.attempts[0]?.openSpans).toBe(2);
    expect(r.attempts[1]?.status).toBe('failed');
    expect(r.completion.count).toBe(0);
  });
  it('records errors without error text and counts missing samples', async () => {
    const rows: any[] = [];
    const t = new TimingTrace({ taskId: 't', turnId: 'turn', attempt: 1 }, r => rows.push(r));
    await expect(t.measure('tool.execution', async () => { throw new Error('SECRET'); })).rejects.toThrow('SECRET');
    expect(JSON.stringify(rows)).not.toContain('SECRET');
    expect(rows.at(-1).status).toBe('failed');
    expect(distribution([null, 1, 2, 3, 100])).toEqual({ count: 4, missing: 1, medianMs: 2.5, p95Ms: 100 });
  });
});

import { TimingDelivery } from '../src/timing/delivery.js';
import { withTiming, currentTiming, timed } from '../src/timing/index.js';
import { runTurn } from '../src/agent/runtime.js';
import type { TurnInput } from '../src/agent/types.js';

it('keeps concurrent async traces separate and propagates cancellation', async () => {
  const rows: any[] = [];
  await Promise.all([1, 2].map(async attempt => {
    const trace = new TimingTrace({ taskId: 't', turnId: 'x', attempt }, row => rows.push(row));
    const abort = new AbortController();
    await expect((await withTiming(trace, () => trace.measure('agent.attempt', async () => {
      await Promise.resolve(); expect((await currentTiming())).toBe(trace);
      return timed('tool.execution', async () => { abort.abort(); throw Error('stop'); });
    }, undefined, abort.signal)))).rejects.toThrow('stop');
  }));
  expect(timingReport(rows).attempts.map(a => a.status)).toEqual(['cancelled', 'cancelled']);
});

it('does not count tool output as first assistant text or reassign live followups', async () => {
  const rows: any[] = []; let now = 0;
  const trace = new TimingTrace({ taskId: 't', turnId: 'turn', attempt: 1, requestIds: ['t:m0'] }, row => rows.push(row), () => now);
  const input = { profile: { provider: 'mock' }, world: { handle: { kind: 'memory' } }, role: 'do',
    messages: [{ id: 'm0', text: 'SECRET', role: 'user' }], systemPrompt: 'SECRET' } as TurnInput;
  const followup = { id: 'u1', role: 'user' as const, text: 'PRIVATE', ts: 0 };
  await withTiming(trace, () => trace.measure('agent.attempt', () => runTurn(input, {
    pullFollowUps: async () => [followup],
    adapters: new Map([['mock', { provider: 'mock', async runTurn(_input, ctx) {
      now = 10; ctx.emit('$ tool output');
      now = 20; await ctx.pullFollowUps?.(1); await ctx.pullFollowUps?.(1);
      now = 30; ctx.emitActivity({ id: 'text', kind: 'message', phase: 'completed', title: 'PRIVATE' });
      now = 40; return { termination: { kind: 'success', status: 'completed' }, output: 'PRIVATE', usage: { inputTokens: 3, outputTokens: 2 } };
    } }]]),
  })));
  const report = timingReport(rows);
  expect(report.attempts[0]).toMatchObject({ firstOutputMs: 10, firstTextMs: 30, totalMs: 40 });
  expect(rows.filter(r => r.name === 'followup.offered')).toHaveLength(1);
  expect(report.attempts[0]?.metadata.cacheReadTokens).toBeUndefined();
  expect(JSON.stringify(rows)).not.toMatch(/SECRET|PRIVATE/);
});

it('does not subtract clocks to manufacture end-to-end precision', async () => {
  const rows: any[] = []; let now = 0;
  const api = new TimingTrace({ taskId: 't' }, r => rows.push(r), () => now, 'gateway');
  (await api.mark('request.received', { requestId: 't:m0' }));
  const worker = new TimingTrace({ taskId: 't', turnId: 'turn', requestIds: ['t:m0'] }, r => rows.push(r), () => now, 'worker');
  const end = (await worker.start('agent.attempt')); now = 5; (await worker.mark('first.text')); now = 10; (await end());
  const r = timingReport(rows);
  expect(r.requests[0]?.firstTextMs).toBeNull();
  expect(r.requests[0]?.firstTextWallEstimateMs).not.toBeNull();
});

it('accepts a browser frame receipt only for the socket delivery once', async () => {
  const rows: any[] = [];
  const delivery = new TimingDelivery(r => rows.push(r));
  (await delivery.acknowledge({ type: 'timing.frame', id: 'made-up', frameMs: 2 }));
  expect(rows).toHaveLength(0);
  const id = (await delivery.offer({ taskId: 't', turnId: 'x', attempt: 1 }));
  expect((await delivery.offer({ taskId: 't', turnId: 'x', attempt: 1 }))).toBeUndefined();
  (await delivery.acknowledge({ type: 'timing.frame', id, frameMs: -1 }));
  (await delivery.acknowledge({ type: 'timing.frame', id, frameMs: 2 }));
  (await delivery.acknowledge({ type: 'timing.frame', id, frameMs: 2 }));
  expect(rows.filter(r => r.name === 'delivery.browser-frame')).toHaveLength(1);
  expect(rows.filter(r => r.phase === 'end')).toHaveLength(1);
});

import { ReportedUsage } from '../src/timing/usage.js';
it('preserves missing usage and cache fields across continuation rounds', () => {
  const usage = new ReportedUsage();
  usage.add({ input_tokens: 3, output_tokens: 4 }, 'claude');
  expect(usage.total()).toEqual({ inputTokens: 3, outputTokens: 4, inputTokensIncludeCacheRead: false });
  usage.add(undefined, 'claude');
  expect(usage.total()).toBeUndefined();
  const openai = new ReportedUsage();
  openai.add({ input_tokens: 5, output_tokens: 2, input_tokens_details: { cached_tokens: 3 } }, 'codex');
  expect(openai.total()).toMatchObject({ totalTokens: 7, cacheReadTokens: 3 });
});

import { toolFailed } from '../src/timing/index.js';
it('records tool-reported failures without changing their transport result', async () => {
  const rows: any[] = [];
  const trace = new TimingTrace({ taskId: 't' }, r => rows.push(r));
  const value = { isError: true, content: [{ text: 'SECRET' }] };
  expect(await withTiming(trace, () => timed('tool.execution', async () => value, undefined, toolFailed))).toBe(value);
  expect(rows.at(-1)?.status).toBe('failed');
  expect(JSON.stringify(rows)).not.toContain('SECRET');
});

it('keeps interrupted steering out of successful completion', async () => {
  const rows: any[] = [];
  const trace = new TimingTrace({ taskId: 't', turnId: 'turn', attempt: 1, requestIds: ['t:m0'] }, r => rows.push(r));
  (await trace.mark('request.received', { requestId: 't:m0' }));
  const end = (await trace.start('agent.attempt')); (await trace.mark('provider.interrupted')); (await end());
  const report = timingReport(rows);
  expect(report.attempts[0]?.status).toBe('interrupted');
  expect(report.requestCompletion.count).toBe(0);
});

it('accounts for request preparation and shows retry gaps as unattributed', async () => {
  let now = 0; const rows: any[] = [];
  const trace = new TimingTrace({ taskId: 't', turnId: 'turn', attempt: 1, requestIds: ['t:m0'] }, r => rows.push(r), () => now);
  (await trace.mark('request.received', { requestId: 't:m0' }));
  const dispatch = (await trace.start('workflow.dispatch')); now = 5; (await dispatch());
  now = 20; const attempt = (await trace.start('agent.attempt'));
  now = 30; const work = (await trace.start('tool.execution')); now = 50; (await work());
  now = 60; (await trace.mark('first.text')); now = 70; (await attempt());
  const report = timingReport(rows);
  expect(report.requests[0]).toMatchObject({ preActivityMs: 20, firstTextMs: 60, completionMs: 70,
    completionBreakdown: { coveredMs: 25, unattributedMs: 45 } });
});

it('does not merge reused turn IDs across replacement workflow executions', async () => {
  const rows: any[] = []; let now = 0;
  const first = new TimingTrace({ taskId: 't', turnId: 't#0', workflowRunId: 'run-1', attempt: 1 }, r => rows.push(r), () => now);
  const a = (await first.start('agent.attempt')); now = 10; (await a());
  const second = new TimingTrace({ taskId: 't', turnId: 't#0', workflowRunId: 'run-2', attempt: 1 }, r => rows.push(r), () => now);
  const b = (await second.start('agent.attempt'));
  const service = new TimingTrace({ taskId: 't', turnId: 't#0', workflowRunId: 'run-2', attempt: 1 }, r => rows.push(r), () => now);
  const s = (await service.start('service.execution')); now = 30; (await s()); (await b());
  const report = timingReport(rows);
  expect(report.attempts[0]?.spans).toHaveLength(0);
  expect(report.attempts[1]?.spans).toEqual([expect.objectContaining({ name: 'service.execution', unionMs: 20 })]);
});

it('correlates external service spans without adding cross-clock coverage', async () => {
  const rows: any[] = []; let now = 0;
  const worker = new TimingTrace({ taskId: 't', turnId: 'x', workflowRunId: 'run', attempt: 1 }, r => rows.push(r), () => now, 'worker');
  const root = (await worker.start('agent.attempt'));
  const gateway = new TimingTrace(worker.context, r => rows.push(r), () => now, 'gateway');
  now = 5; const call = (await gateway.start('service.execution')); now = 10; (await call()); now = 20; (await root());
  const result = timingReport(rows).attempts[0]!;
  expect(result.coveredMs).toBe(0);
  expect(result.unattributedMs).toBe(20);
  expect(result.externalSpans).toEqual([expect.objectContaining({ name: 'service.execution', durationMs: 5 })]);
});

it('summarizes browser receipts and counts unacknowledged deliveries as missing', async () => {
  const rows: any[] = [];
  const delivery = new TimingDelivery(row => rows.push(row));
  const id = (await delivery.offer({ taskId: 't', turnId: 'one', attempt: 1 }));
  (await delivery.offer({ taskId: 't', turnId: 'two', attempt: 1 }));
  (await delivery.acknowledge({ type: 'timing.frame', id, frameMs: 12 }));
  expect(timingReport(rows).browserFrame).toEqual({ count: 1, missing: 1, medianMs: 12, p95Ms: 12 });
});
