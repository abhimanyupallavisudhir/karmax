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
  const worker = await Worker.create({
    connection,
    namespace: conn.namespace,
    taskQueue: TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL('../workflows/index.ts', import.meta.url)),
    activities: buildActivities(deps),
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
