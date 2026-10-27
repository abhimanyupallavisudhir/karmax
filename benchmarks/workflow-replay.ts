/**
 * Replay time of a long software-dev history (pramana#111: 3,964 events,
 * 6.1 MB, ~31 s to replay after a cache eviction, so every workflow task
 * after it timed out at Temporal's default 10 s and was retried).
 *
 * Records one run of `softwareDev@<version>` over stub activities (a real
 * Temporal server and worker, tests/helpers/stub-task-worker.ts) until it holds
 * `--events` events, then replays it with `Worker.runReplayHistory`.
 *
 *   node --import tsx benchmarks/workflow-replay.ts [--events 4000] \
 *     [--reply-bytes 2000] [--followup-bytes 400] [--world-repos 3] \
 *     [--version 1.30.0] [--save history.json.gz] [--history history.json.gz] \
 *     [--replays 3] [--profile out.cpuprofile] [--out result.json]
 *
 * `--history` replays a saved history instead of recording one (a production
 * export too: `{ events: [...] }` as JSON, optionally gzipped). `--profile`
 * replays once more under the inspector's CPU profiler (a replay worker runs
 * workflows on this thread).
 */
import fs from 'node:fs';
import os from 'node:os';
import zlib from 'node:zlib';
import inspector from 'node:inspector/promises';
import { parseArgs } from 'node:util';
import { Worker } from '@temporalio/worker';
import { startStubTaskWorker, historyChain, historyFromJson } from '../tests/helpers/stub-task-worker.js';
import { bundleTaskWorkflows, historyBreakdown, longTaskStubs } from '../tests/helpers/long-history.js';

const { values } = parseArgs({ options: {
  events: { type: 'string', default: '4000' }, 'reply-bytes': { type: 'string', default: '2000' },
  'followup-bytes': { type: 'string', default: '400' }, 'world-repos': { type: 'string', default: '3' },
  version: { type: 'string', default: '1.30.0' }, save: { type: 'string' }, history: { type: 'string' },
  replays: { type: 'string', default: '3' }, profile: { type: 'string' }, out: { type: 'string' },
} });

function readHistory(file: string) {
  const raw = fs.readFileSync(file);
  const json = JSON.parse((file.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8'));
  return historyFromJson(json);
}

async function record() {
  const stubs = longTaskStubs({ replyBytes: Number(values['reply-bytes']), worldRepos: Number(values['world-repos']) });
  const env = await startStubTaskWorker(stubs.activities);
  const workflowId = 'replay-benchmark';
  try {
    const handle = await env.client.workflow.start(`softwareDev@${values.version}`, { taskQueue: env.taskQueue, workflowId,
      args: [stubs.input(workflowId, { continueAfterEvents: 1_000_000 })] });
    const target = Number(values.events);
    const started = Date.now();
    for (let i = 1; ; i++) {
      await stubs.parked(handle, i);
      const { historyLength } = await handle.describe();
      if (i % 20 === 0) process.stderr.write(`turn ${i}: ${historyLength} events (${Math.round((Date.now() - started) / 1000)} s)\n`);
      if (historyLength >= target) break;
      await handle.signal('followUp', stubs.followUp(i, Number(values['followup-bytes'])));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    const [run] = await historyChain(env.client, workflowId);
    await handle.terminate('recorded').catch(() => undefined);
    return run!.history;
  } finally { await env.stop(); }
}

const history = values.history ? readHistory(values.history) : await record();
if (values.save) {
  const json = Buffer.from(JSON.stringify(history.toJSON()));
  fs.writeFileSync(values.save, values.save.endsWith('.gz') ? zlib.gzipSync(json) : json);
}
const breakdown = historyBreakdown(history);
process.stderr.write(`${JSON.stringify(breakdown.summary)}\n`);

const workflowBundle = await bundleTaskWorkflows();
const replays: number[] = [];
for (let i = 0; i < Number(values.replays); i++) {
  const started = performance.now();
  await Worker.runReplayHistory({ workflowBundle }, history, `replay-${i}`);
  replays.push(Math.round(performance.now() - started));
  process.stderr.write(`replay ${i}: ${replays.at(-1)} ms\n`);
}
if (values.profile) {
  const session = new inspector.Session();
  session.connect();
  await session.post('Profiler.enable');
  await session.post('Profiler.setSamplingInterval', { interval: 200 });
  await session.post('Profiler.start');
  await Worker.runReplayHistory({ workflowBundle }, history, 'replay-profiled');
  const { profile } = await session.post('Profiler.stop');
  fs.writeFileSync(values.profile, JSON.stringify(profile));
  session.disconnect();
}
const result = { kind: 'workflow-replay', version: values.version, ...breakdown.summary,
  bytesByKind: breakdown.byKind, replayMs: replays,
  environment: { node: process.version, cpus: os.availableParallelism(), cpu: os.cpus()[0]?.model, collectedAt: new Date().toISOString() } };
console.log(JSON.stringify({ events: result.events, bytes: result.bytes, replayMs: replays }));
if (values.out) fs.writeFileSync(values.out, JSON.stringify(result, null, 2) + '\n');
process.exit(0);
