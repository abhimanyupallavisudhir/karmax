import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startDevServer, DevServer } from '../src/temporal/dev-server.js';
import { makeClient } from '../src/temporal/client.js';
import { makeWorker, WorkerHandle } from '../src/temporal/worker.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { qualifiedType } from '../src/workflows/names.js';
import type { Client } from '@temporalio/client';

/**
 * PLAN-dynamic-repos §21b — the determinism guarantee. Two code versions of one
 * workflow type register under distinct `type@version` names in a single worker;
 * each execution pins to the version it was started with; an execution held open
 * keeps its pinned code even while a newer version runs alongside it.
 */
describe('version-qualified workflow types (real dev server)', () => {
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

  it('helper qualifies a workflow type with its version', () => {
    expect(qualifiedType('softwareDev', '1.0.0')).toBe('softwareDev@1.0.0');
  });

  it('two versions of one type coexist; each execution pins to its version', async () => {
    const stamp = Date.now();
    // Start the OLD version and hold it open (no release signal yet).
    const v1 = await client.workflow.start(qualifiedType('versionedProbe', '1.0.0'), {
      taskQueue: TASK_QUEUE,
      workflowId: `probe-v1-${stamp}`,
    });

    // While v1 is in-flight, start and complete the NEW version.
    const v2 = await client.workflow.start(qualifiedType('versionedProbe', '2.0.0'), {
      taskQueue: TASK_QUEUE,
      workflowId: `probe-v2-${stamp}`,
    });
    await v2.signal('release');
    expect((await v2.result()).version).toBe('2.0.0');

    // v1, started before v2 and still running, is unaffected: it returns its
    // own pinned version, not the newer one.
    await v1.signal('release');
    expect((await v1.result()).version).toBe('1.0.0');
  });
});
