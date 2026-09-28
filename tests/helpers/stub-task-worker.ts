import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker, bundleWorkflowCode } from '@temporalio/worker';
import type { Client } from '@temporalio/client';
import { startDevServer } from '../../src/temporal/dev-server.js';
import { makeClient } from '../../src/temporal/client.js';

const { temporal } = createRequire(import.meta.url)('@temporalio/proto');

export type StubActivities = Record<string, (...args: any[]) => unknown>;

/** A real Temporal server and worker running the bundled task workflows over
 * stub activities: real command histories, no provider, world or model. */
export async function startStubTaskWorker(activities: StubActivities, taskQueue = 'stub-task') {
  const server = await startDevServer({ headless: true, logLevel: 'never' });
  const native = await NativeConnection.connect({ address: server.address });
  const { client, close } = await makeClient({ address: server.address, namespace: server.namespace });
  const workflowBundle = await bundleWorkflowCode({
    workflowsPath: fileURLToPath(new URL('../../src/workflows/index.ts', import.meta.url)),
  });
  const worker = await Worker.create({ connection: native, namespace: server.namespace, taskQueue, workflowBundle,
    maxCachedWorkflows: 4, maxConcurrentWorkflowTaskExecutions: 2, maxConcurrentActivityTaskExecutions: 4,
    reuseV8Context: true, activities });
  const run = worker.run();
  return {
    client, taskQueue, workflowBundle,
    async stop() {
      worker.shutdown();
      await run;
      await close();
      await native.close();
      await server.stop();
    },
  };
}

export interface RunHistory { runId: string; events: number; bytes: number; history: any }

/** Every run of one workflow id, oldest first, following continue-as-new. */
export async function historyChain(client: Client, workflowId: string): Promise<RunHistory[]> {
  const first = await client.workflow.getHandle(workflowId).describe();
  let runId: string | undefined = first.raw.workflowExecutionInfo?.firstRunId || first.runId;
  const runs: RunHistory[] = [];
  while (runId) {
    // Small pages: one default page of a large history exceeds gRPC's 4 MB cap.
    const events: any[] = [];
    let nextPageToken: Uint8Array | undefined;
    do {
      const page = await client.workflowService.getWorkflowExecutionHistory({ namespace: client.options.namespace,
        execution: { workflowId, runId }, maximumPageSize: 50, nextPageToken });
      events.push(...page.history?.events ?? []);
      nextPageToken = page.nextPageToken?.length ? page.nextPageToken : undefined;
    } while (nextPageToken);
    const history = temporal.api.history.v1.History.create({ events });
    runs.push({ runId, events: history.events!.length,
      bytes: temporal.api.history.v1.History.encode(history).finish().length, history });
    const last = history.events!.at(-1);
    runId = last?.workflowExecutionContinuedAsNewEventAttributes?.newExecutionRunId ?? undefined;
  }
  return runs;
}

export function historyFromJson(json: unknown) {
  return temporal.api.history.v1.History.fromObject(json);
}
