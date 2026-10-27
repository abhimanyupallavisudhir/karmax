import { it, expect } from 'vitest';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Worker } from '@temporalio/worker';
import { historyFromJson } from './helpers/stub-task-worker.js';
import { bundleTaskWorkflows } from './helpers/long-history.js';

// pramana#111: a softwareDev@1.30.0 run of 3,964 events took ~31 s to replay
// after the worker's cache evicted it, so each workflow task timed out (10 s)
// and was replayed again, and a Confirm took effect 2 min later. Every
// publication fingerprinted the whole conversation, which made replay
// quadratic in history length.
//
// Recorded at e0b033ee with benchmarks/workflow-replay.ts --events 3900 (stub
// activities, 2 KB replies, 400 B follow-ups, 3 repositories): 3,961 events,
// 3.1 MB, still running and past 2,000 events, so replay also proves that runs
// started before CONTINUE_SOONER keep the 4,000-event threshold. It replayed in
// 11.6 s at e0b033ee and 2.1 s after the fix on a 4-CPU task sandbox.
it('replays a long software-dev history in time linear in its length', async () => {
  const json = JSON.parse(zlib.gunzipSync(fs.readFileSync(
    new URL('./fixtures/history-long-v1_30-prechange.json.gz', import.meta.url))).toString('utf8'));
  const full = historyFromJson(json);
  // The same run a quarter as long: cut after a completed workflow task.
  const completed = 'EVENT_TYPE_WORKFLOW_TASK_COMPLETED';
  const cut = json.events.findIndex((event: any, i: number) => i >= json.events.length / 4 && event.eventType === completed);
  const quarter = historyFromJson({ events: json.events.slice(0, cut + 1) });
  const workflowBundle = await bundleTaskWorkflows();
  const replay = async (history: unknown, name: string) => {
    const started = performance.now();
    await Worker.runReplayHistory({ workflowBundle }, history, name);
    return performance.now() - started;
  };
  await replay(quarter, 'warm-up');
  // The fastest of a few, to discount a busy machine.
  const best = async (history: unknown, name: string) =>
    Math.min(await replay(history, name), await replay(history, name));
  const quarterMs = await best(quarter, 'quarter');
  const fullMs = await best(full, 'full');
  process.stderr.write(`replay-time ${JSON.stringify({ events: json.events.length, quarterEvents: cut + 1,
    quarterMs: Math.round(quarterMs), fullMs: Math.round(fullMs) })}\n`);
  // Linear: about 4×. Quadratic (before the fix) measured 9–10×.
  expect(fullMs / quarterMs).toBeLessThan(6);
  // Inside Temporal's default workflow-task timeout with room to spare even on
  // a slow runner; production gives task workflows TASK_WORKFLOW_TASK_TIMEOUT.
  expect(fullMs).toBeLessThan(10_000);
}, 180_000);
