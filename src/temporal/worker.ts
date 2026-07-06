import { Worker, NativeConnection, Runtime, DefaultLogger, WorkflowBundle } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import { TASK_QUEUE, TemporalConn } from './config.js';
import { buildActivities, ActivityDeps } from '../activities/index.js';

export interface WorkerHandle {
  run(): Promise<void>;
  shutdown(): void;
}

export interface WorkerOpts {
  /**
   * A prebuilt workflow bundle (from `buildVersionedBundle`) to run instead of
   * the default `workflows/index.ts`. Used when the worker must include
   * externally-loaded workflow packages (§21c); omit for the built-ins only.
   */
  workflowBundle?: WorkflowBundle;
}

let runtimeInstalled = false;
function ensureQuietRuntime() {
  if (runtimeInstalled) return;
  // Keep worker logs quiet by default; KARMAX_TEMPORAL_LOG=debug to see them.
  const level = (process.env.KARMAX_TEMPORAL_LOG ?? 'WARN').toUpperCase() as any;
  Runtime.install({ logger: new DefaultLogger(level) });
  runtimeInstalled = true;
}

export async function makeWorker(conn: TemporalConn, deps: ActivityDeps = {}, opts: WorkerOpts = {}): Promise<WorkerHandle> {
  ensureQuietRuntime();
  const connection = await NativeConnection.connect({ address: conn.address });
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
    maxCachedWorkflows: num(process.env.KARMAX_MAX_CACHED_WORKFLOWS, 20),
    maxConcurrentWorkflowTaskExecutions: num(process.env.KARMAX_MAX_WFT, 8),
    maxConcurrentActivityTaskExecutions: num(process.env.KARMAX_MAX_ACT, 8),
    // Prompt shutdown: stop polling at once and, after a short grace, CANCEL
    // in-flight activities (the agent adapters kill their subprocess on abort),
    // so the drain completes in ~1-2s instead of waiting out a 45-minute agent
    // turn. tsx-watch SIGKILLs the process 5s after a reload — and karmax
    // landing on its own repo triggers exactly such a reload — so an unbounded
    // drain gets force-killed mid-activity, orphaning agent subprocesses.
    // NOTE: no shutdownForceTime — force-resolving run() skips native worker
    // finalization, which pins the Runtime singleton and breaks every later
    // harness boot in the test suite (main.ts has its own exit backstop for a
    // truly wedged drain).
    shutdownGraceTime: '1 second',
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
  };
}
