import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startDevServer, DevServer } from '../src/temporal/dev-server.js';
import { makeClient } from '../src/temporal/client.js';
import { makeWorker, WorkerHandle } from '../src/temporal/worker.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { pingWorkflow, bump, finish, countQuery } from '../src/workflows/ping.js';
import type { Client } from '@temporalio/client';

describe('Temporal durable substrate (real dev server)', () => {
  let server: DevServer;
  let worker: WorkerHandle;
  let workerRun: Promise<void>;
  let client: Client;
  let closeClient: () => Promise<void>;

  beforeAll(async () => {
    server = await startDevServer({ headless: true, logLevel: 'never' });
    const conn = { address: server.address, namespace: server.namespace };
    worker = await makeWorker(conn);
    workerRun = worker.run();
    const c = await makeClient(conn);
    client = c.client;
    closeClient = c.close;
  }, 60_000);

  afterAll(async () => {
    worker?.shutdown();
    await workerRun?.catch(() => {});
    await closeClient?.();
    await server?.stop();
  });

  it('runs a workflow exercising activity + signal + query + durable wait', async () => {
    const handle = await client.workflow.start(pingWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId: `ping-${Date.now()}`,
      args: ['hello'],
    });

    // query (read-only re-run) before any signal
    expect(await handle.query(countQuery)).toBe(0);

    // signals (async events delivered into the running workflow)
    await handle.signal(bump, 3);
    await handle.signal(bump, 4);

    // query reflects accumulated signal state
    await expect.poll(async () => handle.query(countQuery), { timeout: 5000 }).toBe(7);

    // release the durable wait and collect the result
    await handle.signal(finish);
    const result = await handle.result();
    expect(result.started).toBe('hello');
    expect(result.count).toBe(7);
    expect(typeof result.at).toBe('number');
  });
});
