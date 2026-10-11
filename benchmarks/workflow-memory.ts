/**
 * Heap per open task (RT-35). Boots the real harness — Temporal dev server,
 * worker, SQLite store, local git worlds — with a scripted agent whose replies
 * and tool activity have realistic sizes, opens N software-dev tasks, runs each
 * for T turns and leaves them waiting for input, and measures the V8 heap after
 * a full GC as the open tasks accumulate. The slope is the heap one open task
 * costs while it stays in the worker's sticky cache.
 *
 *   node --expose-gc --import tsx benchmarks/workflow-memory.ts \
 *     [--tasks 60] [--turns 8] [--message-bytes 4096] [--activities 30] \
 *     [--cache 250] [--snapshot /tmp/x.heapsnapshot] [--out file.json]
 *
 * `--cache 1` evicts every idle task, so the difference from a run at the
 * hosted default is what the sticky workflow cache itself retains.
 */
import fs from 'node:fs';
import os from 'node:os';
import v8 from 'node:v8';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  tasks: { type: 'string', default: '60' }, turns: { type: 'string', default: '8' },
  'message-bytes': { type: 'string', default: '4096' }, activities: { type: 'string', default: '30' },
  cache: { type: 'string', default: '250' }, snapshot: { type: 'string' }, out: { type: 'string' },
  concurrency: { type: 'string', default: '8' },
} });
const tasks = Number(values.tasks), turns = Number(values.turns), messageBytes = Number(values['message-bytes']);
const activities = Number(values.activities), concurrency = Number(values.concurrency);
// The worker reads these when the harness creates it.
process.env.KARMAX_MAX_CACHED_WORKFLOWS = values.cache;
process.env.KARMAX_AGENT_MIN_FREE_MB = '0';
process.env.KARMAX_AGENT_MAX_LOAD_FACTOR = '0';
if (typeof globalThis.gc !== 'function') throw new Error('run with node --expose-gc');

const { bootHarness } = await import('../tests/helpers/harness.js');
type Harness = import('../tests/helpers/harness.js').Harness;
type AgentAdapter = import('../src/agent/types.js').AgentAdapter;

/** Prose-like text of `bytes` bytes that carries a unique marker, so a heap
 * snapshot can count how many copies of each message the process holds. */
function text(marker: string, bytes: number): string {
  const words = ['the', 'worker', 'conversation', 'workflow', 'review', 'branch', 'test', 'memory', 'agent', 'task'];
  let out = `‹${marker}› `;
  for (let i = 0; out.length < bytes; i++) out += words[(i * 7 + marker.length) % words.length] + (i % 13 ? ' ' : '.\n');
  return out.slice(0, bytes);
}

const adapter: AgentAdapter = { provider: 'mock', async runTurn(input, ctx) {
  const turn = input.messages.filter(m => m.role === 'user').length;
  // Each task's prompt carries its own marker; its turns extend it.
  const task = /‹(prompt-[^›]+)›/.exec(input.messages[0]?.text ?? '')?.[1] ?? 'task';
  const marker = `${task}:${turn}`;
  for (let i = 0; i < activities; i++)
    await ctx.emitActivity({ id: `tool-${turn}-${i}`, kind: i % 3 ? 'command' : 'file', phase: 'completed',
      title: `Step ${i}`, detail: text(`${marker}:activity:${i}`, 1024) });
  ctx.onSession?.(`session-${task}`);
  return { termination: { kind: 'success', status: 'completed' }, output: text(`${marker}:reply`, messageBytes),
    session: `session-${task}` };
} };

/** Both isolates the worker uses, after a full GC of each: the process's main
 * heap (activities, store, gateway) and the workflow thread's (every cached
 * workflow). A thread heap snapshot is the only way to force its GC. */
async function heap(h: Harness, keep?: string) {
  globalThis.gc!(); globalThis.gc!();
  const snapshots = await h.worker().workflowHeapSnapshots();
  // stream.pipeline never settles on a worker's HeapSnapshotStream (Node 22.16).
  await Promise.all(snapshots.map((stream, i) => new Promise<void>((resolve, reject) => {
    const file = keep ? fs.createWriteStream(`${keep}.workflows-${i}.heapsnapshot`) : undefined;
    stream.on('data', (chunk) => file?.write(chunk));
    stream.on('error', reject);
    stream.on('end', () => file ? file.end(resolve) : resolve());
  })));
  const status = await h.worker().status();
  const stats = v8.getHeapStatistics(), usage = process.memoryUsage();
  return { mainHeapUsed: stats.used_heap_size, mainHeapLimit: stats.heap_size_limit,
    workflowHeapUsed: status.workflowHeap?.heapUsed ?? NaN, workflowHeapLimit: status.workflowHeap?.heapLimit ?? NaN,
    cachedWorkflows: status.cachedWorkflows, rss: usage.rss, external: usage.external };
}

/** Least-squares slope of `y` against open tasks: bytes per open task. */
function slope(points: { x: number; y: number }[]): number {
  const n = points.length, mx = points.reduce((s, p) => s + p.x, 0) / n, my = points.reduce((s, p) => s + p.y, 0) / n;
  return points.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / points.reduce((s, p) => s + (p.x - mx) ** 2, 0);
}

const h = await bootHarness('mock', adapter);
const samples: ({ openTasks: number; turns: number } & Awaited<ReturnType<typeof heap>>)[] = [];
try {
  await h.store.setSettings('global', 'agent-queue', { capacity: concurrency });
  const repo = await h.makeRepo('memory');
  const project = await h.store.createProject('Memory fixture', { repos: [repo],
    worldProvider: 'worktree', openGithubPr: false });
  const token = (await h.tokens.mintPrincipal('user:a', ['*'], project.id)).token;
  const agentReplies = async (taskId: string) =>
    ((await h.store.getTask(taskId))?.lastView?.messages ?? []).filter(m => m.role === 'agent').length;
  const waitFor = async (taskId: string, replies: number) => {
    const deadline = Date.now() + 120_000;
    for (;;) {
      const view = (await h.store.getTask(taskId))?.lastView;
      if (view?.status === 'failed') throw new Error(`task ${taskId} failed: ${view.error ?? ''}`);
      if ((await agentReplies(taskId)) >= replies && !view?.agentTurn && view?.waitingFor) return;
      if (Date.now() > deadline) throw new Error(`task ${taskId} did not reach ${replies} replies`);
      await new Promise(r => setTimeout(r, 50));
    }
  };
  const runTask = async (index: number) => {
    const task = await h.api.createTask(token, { projectId: project.id, title: `Memory ${index}`,
      prompt: text(`prompt-${index}`, messageBytes), params: { worldProvider: 'worktree', doProvider: 'mock' } as any });
    await waitFor(task.id, 1);
    for (let t = 1; t < turns; t++) {
      await h.api.signalTask(token, task.id, 'followUp', text(`${task.id}:followup:${t}`, messageBytes), 'do');
      await waitFor(task.id, t + 1);
    }
    return task.id;
  };
  // Warm up: load the workflow bundle and every code path once, then cancel.
  const warm = await runTask(-1);
  await h.api.signalTask(token, warm, 'cancel');
  await h.client.workflow.getHandle(warm).result().catch(() => {});
  samples.push({ openTasks: 0, turns: 0, ...await heap(h) });
  console.log(JSON.stringify(samples.at(-1)));
  const step = Math.max(1, Math.ceil(tasks / 4));
  for (let opened = 0; opened < tasks;) {
    const batch = Math.min(step, tasks - opened);
    const ids: string[] = [];
    for (let i = 0; i < batch; i += concurrency)
      ids.push(...await Promise.all(Array.from({ length: Math.min(concurrency, batch - i) }, (_, j) => runTask(opened + i + j))));
    opened += batch;
    // Let trailing publications settle before measuring.
    await new Promise(r => setTimeout(r, 2_000));
    samples.push({ openTasks: opened, turns: opened * turns,
      ...await heap(h, opened === tasks ? values.snapshot : undefined) });
    console.log(JSON.stringify(samples.at(-1)));
  }
  if (values.snapshot) { globalThis.gc!(); v8.writeHeapSnapshot(`${values.snapshot}.main.heapsnapshot`); }
  // The first batch also pays one-off warm-up, so fit the slope from there on.
  const fitted = samples.slice(1);
  const perTask = { workflowHeap: Math.round(slope(fitted.map(s => ({ x: s.openTasks, y: s.workflowHeapUsed })))),
    mainHeap: Math.round(slope(fitted.map(s => ({ x: s.openTasks, y: s.mainHeapUsed })))),
    rss: Math.round(slope(fitted.map(s => ({ x: s.openTasks, y: s.rss })))) };
  const conversationBytes = 2 * turns * messageBytes;
  const result = { kind: 'workflow-memory', cache: Number(values.cache), tasks, turns, messageBytes, activities,
    conversationBytes, perTaskBytes: perTask,
    workflowHeapPerConversationByte: +(perTask.workflowHeap / conversationBytes).toFixed(2),
    environment: { node: process.version, cpus: os.availableParallelism(), collectedAt: new Date().toISOString() },
    samples };
  console.log(JSON.stringify({ perTaskBytes: result.perTaskBytes, workflowHeapPerConversationByte: result.workflowHeapPerConversationByte }));
  if (values.out) fs.writeFileSync(values.out, JSON.stringify(result, null, 2) + '\n');
} finally {
  await h.stop();
}
process.exit(0);
