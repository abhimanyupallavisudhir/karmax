import { Worker, NativeConnection, Runtime, DefaultLogger, WorkflowBundle } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import { TASK_QUEUE, TemporalConn } from './config.js';
import { buildActivities, ActivityDeps } from '../activities/index.js';
import type { HeapUsage } from '../runtime/memory-budget.js';

export interface WorkerHandle {
  run(): Promise<void>;
  shutdown(): void;
  /** Cached workflows, and the heap of the thread they run in (RT-35). */
  status(): Promise<WorkerStatus>;
  /** Heap snapshots of the workflow threads (each forces a full GC first).
   * Diagnostics and benchmarks only: a snapshot needs about the heap again. */
  workflowHeapSnapshots(): Promise<NodeJS.ReadableStream[]>;
}

export interface WorkerStatus {
  cachedWorkflows: number;
  cacheLimit: number;
  /** The workflow thread's own V8 isolate, separate from the process's main
   * heap: the SDK runs every workflow (and so the sticky cache) in a worker
   * thread. Absent if the SDK stops exposing it. */
  workflowHeap?: HeapUsage;
}

type HeapThread = {
  getHeapStatistics(): Promise<{ used_heap_size: number; heap_size_limit: number }>;
  getHeapSnapshot(): Promise<NodeJS.ReadableStream>;
};

/** The SDK's workflow threads (@temporalio/worker 1.24: `workflowCreator.
 * workerThreadClients[].workerThread`). Internal, so feature-detected; the
 * worker-process Temporal test fails if an upgrade moves it. */
function workflowThreads(worker: Worker): HeapThread[] {
  const clients = (worker as unknown as { workflowCreator?: { workerThreadClients?: { workerThread?: unknown }[] } })
    .workflowCreator?.workerThreadClients ?? [];
  return clients.map(client => client.workerThread as HeapThread)
    .filter(thread => typeof thread?.getHeapStatistics === 'function');
}

async function workflowHeap(worker: Worker): Promise<HeapUsage | undefined> {
  const threads = workflowThreads(worker);
  if (!threads.length) return undefined;
  const stats = await Promise.all(threads.map(thread => thread.getHeapStatistics()));
  return { heapUsed: stats.reduce((sum, s) => sum + s.used_heap_size, 0),
    heapLimit: stats.reduce((sum, s) => sum + s.heap_size_limit, 0) };
}

export interface WorkerOpts {
  /**
   * A prebuilt workflow bundle (from `buildVersionedBundle`) to run instead of
   * the default `workflows/index.ts`. Used when the worker must include
   * externally-loaded workflow packages (§21c); omit for the built-ins only.
   */
  workflowBundle?: WorkflowBundle;
  shutdownGraceTime?: string;
  /** Overrides `workflowCacheSize()`; the heap governor rolls the worker with less. */
  maxCachedWorkflows?: number;
}

let runtimeInstalled = false;
function ensureQuietRuntime() {
  if (runtimeInstalled) return;
  // Keep worker logs quiet by default; KARMAX_TEMPORAL_LOG=debug to see them.
  const level = (process.env.KARMAX_TEMPORAL_LOG ?? 'WARN').toUpperCase() as any;
  Runtime.install({ logger: new DefaultLogger(level) });
  runtimeInstalled = true;
}

/** Generic worker envelope, separate from per-organization agent admission.
 * Hosted tenant queues and trusted usage admission are the concurrency
 * authority, so hosted must not inherit the private machine's conservative 8. */
export function activityTaskConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  return env.KARMAX_MAX_ACT ? Number(env.KARMAX_MAX_ACT)
    : env.KARMAX_DEPLOYMENT === 'hosted' ? 1_000 : 8;
}

/** Sticky workflow cache. Every open task's workflow is queried by the console
 * and by its own running turn, and a query or task for an evicted workflow
 * replays its whole history. The private default suits one person's handful
 * of tasks; a hosted cell keeps hundreds open. karmax workflows hold their
 * conversation, so this stays well under the SDK's heap-derived default
 * (about 600 per GiB of heap), which assumes much smaller workflow state. */
export function workflowCacheSize(env: NodeJS.ProcessEnv = process.env): number {
  return env.KARMAX_MAX_CACHED_WORKFLOWS ? Number(env.KARMAX_MAX_CACHED_WORKFLOWS)
    : env.KARMAX_DEPLOYMENT === 'hosted' ? 250 : 20;
}

export async function makeWorker(conn: TemporalConn, deps: ActivityDeps = {}, opts: WorkerOpts = {}): Promise<WorkerHandle> {
  const cacheLimit = opts.maxCachedWorkflows ?? workflowCacheSize();
  ensureQuietRuntime();
  const connection = await NativeConnection.connect({ address: conn.address, apiKey: conn.apiKey, tls: conn.tls });
  // Resource caps. The Worker's reusable-VM cache and task-execution pools
  // default to sizes that scale with CPU cores; on a multi-core box several of
  // these (one per test file, plus the dev server) can exhaust RAM. These caps
  // keep one worker small without affecting correctness. Tune via env for prod.
  const num = (v: string | undefined, d: number) => (v ? Number(v) : d);
  // Run a prebuilt bundle (built-ins + external packages) when provided, else
  // bundle the built-in workflows from their source path.
  const source = opts.workflowBundle
    ? { workflowBundle: opts.workflowBundle }
    : { workflowsPath: fileURLToPath(new URL('../workflows/index.ts', import.meta.url)) };
  const worker = await Worker.create({
    connection,
    namespace: conn.namespace,
    taskQueue: TASK_QUEUE,
    ...source,
    activities: buildActivities(deps),
    maxCachedWorkflows: cacheLimit,
    maxConcurrentWorkflowTaskExecutions: num(process.env.KARMAX_MAX_WFT, 8),
    maxConcurrentActivityTaskExecutions: activityTaskConcurrency(),
    // Agent activities heartbeat once a second so Temporal can deliver a pending
    // cancellation to their AbortSignal promptly. The SDK otherwise throttles
    // heartbeats for these 2-minute-timeout activities for up to 60 seconds,
    // leaving a cancelled provider subprocess alive long after its task closed.
    maxHeartbeatThrottleInterval: '1 second',
    // Share ONE V8 context across all cached workflows instead of one isolate per
    // workflow. With up to `maxCachedWorkflows` sticky executions, per-isolate
    // heap dominates the worker's RAM; a shared context is the single biggest memory
    // lever here. All bundled code must be trusted: Temporal determinism and
    // VM reuse do not provide a security boundary for tenant-supplied code.
    reuseV8Context: true,
    // Prompt shutdown: stop polling at once and, after a short grace, CANCEL
    // in-flight activities (the agent adapters kill their subprocess on abort),
    // so the drain completes in ~1-2s instead of waiting out a long-running agent
    // turn. tsx-watch SIGKILLs the process 5s after a reload — and karmax
    // landing on its own repo triggers exactly such a reload — so an unbounded
    // drain gets force-killed mid-activity, orphaning agent subprocesses.
    // NOTE: no shutdownForceTime — force-resolving run() skips native worker
    // finalization, which pins the Runtime singleton and breaks every later
    // harness boot in the test suite (main.ts has its own exit backstop for a
    // truly wedged drain).
    shutdownGraceTime: opts.shutdownGraceTime ?? '1 second',
  });

  let runPromise: Promise<void> | undefined;
  return {
    async run() {
      runPromise = worker.run();
      await runPromise;
      await connection.close();
    },
    shutdown() {
      worker.shutdown();
    },
    async status() {
      return { cachedWorkflows: worker.getStatus().numCachedWorkflows, cacheLimit,
        ...await workflowHeap(worker).then(heap => heap ? { workflowHeap: heap } : {}, () => ({})) };
    },
    workflowHeapSnapshots: () => Promise.all(workflowThreads(worker).map(thread => thread.getHeapSnapshot())),
  };
}
