import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { startDevServer } from '../src/temporal/dev-server.js';
import { makeClient } from '../src/temporal/client.js';
import { WorkerProcessManager } from '../src/temporal/worker-process.js';
import { bump, finish, countQuery, pingWorkflow } from '../src/workflows/ping.js';

const test = process.platform === 'linux' ? it : it.skip;
test('resumes durable workflow history in a replacement supervised worker process', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-worker-process-home-'));
  const server = await startDevServer({ headless: true, logLevel: 'never' });
  const { client, close } = await makeClient({ address: server.address, namespace: server.namespace });
  const queue = `isolated-worker-${crypto.randomUUID()}`;
  const workers: WorkerProcessManager[] = [];
  const create = () => {
    const worker = new WorkerProcessManager({
      entrypoint: fileURLToPath(new URL('./fixtures/temporal-worker-process.ts', import.meta.url)),
      execArgv: ['--import', 'tsx', '--max-old-space-size=512'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, KARMAX_HOME: home,
        KARMAX_TASK_QUEUE: queue, WORKER_FIXTURE_TEMPORAL_ADDRESS: server.address },
    });
    workers.push(worker);
    return worker;
  };
  try {
    const first = create();
    await first.start();
    const handle = await client.workflow.start(pingWorkflow, {
      taskQueue: queue, workflowId: crypto.randomUUID(), args: ['isolated'],
    });
    expect(await handle.query(countQuery)).toBe(0);
    await handle.signal(bump, 3);
    await expect.poll(() => handle.query(countQuery), { timeout: 5_000 }).toBe(3);
    await first.stop();
    expect(first.failure).toBeUndefined();
    const second = create();
    await second.start();
    expect(await handle.query(countQuery)).toBe(3);
    await handle.signal(bump, 4);
    await handle.signal(finish);
    expect(await handle.result()).toMatchObject({ started: 'isolated', count: 7 });
    await second.stop();
    expect(second.failure).toBeUndefined();
  } finally {
    for (const worker of workers) await worker.stop();
    await close();
    await server.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 90_000);
