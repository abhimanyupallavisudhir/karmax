import { Worker, NativeConnection, Runtime, DefaultLogger } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import { TASK_QUEUE, TemporalConn } from './config.js';
import { buildActivities, ActivityDeps } from '../activities/index.js';

export interface WorkerHandle {
  run(): Promise<void>;
  shutdown(): void;
}

let runtimeInstalled = false;
function ensureQuietRuntime() {
  if (runtimeInstalled) return;
  // Keep worker logs quiet by default; KARMAX_TEMPORAL_LOG=debug to see them.
  const level = (process.env.KARMAX_TEMPORAL_LOG ?? 'WARN').toUpperCase() as any;
  Runtime.install({ logger: new DefaultLogger(level) });
  runtimeInstalled = true;
}

export async function makeWorker(conn: TemporalConn, deps: ActivityDeps = {}): Promise<WorkerHandle> {
  ensureQuietRuntime();
  const connection = await NativeConnection.connect({ address: conn.address });
  // Resource caps. The Worker's reusable-VM cache and task-execution pools
  // default to sizes that scale with CPU cores; on a multi-core box several of
  // these (one per test file, plus the dev server) can exhaust RAM. These caps
  // keep one worker small without affecting correctness. Tune via env for prod.
  const num = (v: string | undefined, d: number) => (v ? Number(v) : d);
  const worker = await Worker.create({
    connection,
    namespace: conn.namespace,
    taskQueue: TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL('../workflows/index.ts', import.meta.url)),
    activities: buildActivities(deps),
    maxCachedWorkflows: num(process.env.KARMAX_MAX_CACHED_WORKFLOWS, 20),
    maxConcurrentWorkflowTaskExecutions: num(process.env.KARMAX_MAX_WFT, 8),
    maxConcurrentActivityTaskExecutions: num(process.env.KARMAX_MAX_ACT, 8),
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
