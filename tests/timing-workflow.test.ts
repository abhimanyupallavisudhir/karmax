import { it, expect } from 'vitest';
import { benchmarkLatency } from '../benchmarks/latency.js';

it('correlates HTTP receipt, real Temporal dispatch, fresh/resumed worlds and managed actions', async () => {
  const result = await benchmarkLatency(1);
  expect(result.disabledRecordingRows).toBe(0);
  expect(result.groups).toHaveLength(8);
  for (const group of result.groups) {
    expect(group.attempts).toBe(1);
    expect(group.firstResponse.count).toBe(1);
    expect(group.completion.count).toBe(1);
    expect(group.completion.medianMs!).toBeGreaterThanOrEqual(group.firstResponse.medianMs!);
  }
  const rows = result.report.observations;
  for (const name of ['request.received', 'workflow.dispatch', 'world.prepare', 'queue.slot.requested',
    'world.open', 'admission.host', 'adapter.invoked', 'tool.discovery.managed', 'service.execution',
    'service.action.remote', 'first.text', 'provider.completed']) expect(rows.some(r => r.name === name), name).toBe(true);
  for (const row of rows.filter(r => r.name === 'service.execution')) {
    expect(row.turnId).toBeTruthy(); expect(row.attempt).toBe(1);
    expect(result.report.attempts.some(a => a.turnId === row.turnId)).toBe(true);
  }
  expect(result.report.attempts.filter(a => a.metadata.sessionMode === 'resumed')).toHaveLength(4);
  expect(result.report.attempts.every(a => a.metadata.inputTokens === undefined)).toBe(true);
  expect(JSON.stringify(rows)).not.toContain('isolated-fixture-key');
}, 180_000);
