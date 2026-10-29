import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { ensurePaths } from '../src/config/paths.js';
import { registerAppInstance, claimWorkerOwnership } from '../src/util/instance.js';
import { Store } from '../src/store/db.js';
import { openSecretVault } from '../src/autonomy/vault-backend.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { ModelLogins } from '../src/autonomy/model-logins.js';
import { startDevServer } from '../src/temporal/dev-server.js';
import { makeClient } from '../src/temporal/client.js';
import { WorkerProcessManager } from '../src/temporal/worker-process.js';
import { ForeignEventRelay } from '../src/contrib/foreign-event-relay.js';
import { NativeConnection, Worker, bundleWorkflowCode } from '@temporalio/worker';
import { KarmaxBus } from '../src/contrib/bus.js';

const postgres = process.env.KARMAX_TEST_POSTGRES_URL;
const test = postgres && process.platform === 'linux' ? it : it.skip;

test('runs real application activities in an admitted child and relays its persisted events', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-activity-worker-'));
  const schema = `worker_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: postgres });
  const target = new URL(postgres!);
  target.searchParams.set('options', `-csearch_path=${schema}`);
  vi.stubEnv('KARMAX_HOME', home);
  ensurePaths(home);
  const registration = registerAppInstance();
  const workers: WorkerProcessManager[] = [];
  let store: Store | undefined;
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  let connection: Awaited<ReturnType<typeof makeClient>> | undefined;
  let relay: ForeignEventRelay | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    store = await Store.create(target.href);
    // What the primary does on its boot before it starts a worker: the child only attaches to the vault.
    const vault = await openSecretVault(path.join(home, 'vault'), store.db, { resolveScopes: async () => new Map(), audit: async () => undefined });
    // ...and the model logins into it (data epoch 6).
    await new ModelLogins(path.join(home, 'config-homes'), new CredentialBroker(vault), store.db).moveIntoVault(store.db, { audit: async () => undefined });
    const project = await store.createProject('Isolated supervised activity');
    const task = await store.createTask({ projectId: project.id, title: 'Record an event',
      workflow: 'fixture', workflowVersion: '1', params: { prompt: 'Record an isolated test event' } });
    server = await startDevServer({ headless: true, logLevel: 'never' });
    connection = await makeClient({ address: server.address, namespace: server.namespace });
    const queue = `isolated-activity-${crypto.randomUUID()}`;
    const create = (extra: NodeJS.ProcessEnv = {}) => {
      const worker = new WorkerProcessManager({
        entrypoint: fileURLToPath(new URL('../src/temporal/activity-worker-main.ts', import.meta.url)),
        execArgv: ['--import', 'tsx', '--max-old-space-size=512'],
        env: { PATH: process.env.PATH, HOME: process.env.HOME, KARMAX_HOME: home,
          KARMAX_TASK_QUEUE: queue, KARMAX_DATABASE_URL: target.href,
          KARMAX_TEMPORAL_ADDRESS: server!.address, KARMAX_TEMPORAL_NAMESPACE: server!.namespace,
          KARMAX_GATEWAY_URL: 'http://127.0.0.1:1', KARMAX_AGENT_PROVIDER: 'mock', ...extra },
      });
      workers.push(worker);
      return worker;
    };
    // Fail after Store/client initialization; a replacement must still be able
    // to obtain ownership and attach successfully.
    const failed = create({ KARMAX_OBJECT_STORE: 's3' });
    await expect(failed.start()).rejects.toThrow('KARMAX_S3_ENDPOINT');
    await failed.stop();
    const release = await claimWorkerOwnership(home);
    release();
    const bus = new KarmaxBus();
    const delivered: string[] = [];
    bus.onTask(task.id, event => { delivered.push(event.type); });
    relay = await ForeignEventRelay.create(store, bus);
    const worker = create();
    await worker.start([{ type: 'fixture-record@1',
      entryFile: fileURLToPath(new URL('./fixtures/activity-worker-workflow.ts', import.meta.url)) }]);
    await connection.client.workflow.execute('fixture-record@1', {
      workflowId: crypto.randomUUID(), taskQueue: queue, args: [task.id], workflowExecutionTimeout: '30s',
    });
    await relay.wake();
    expect(delivered.filter(type => type === 'fixture.supervised-activity')).toHaveLength(1);
    expect((await store.eventsSince(task.id, 0)).find(event => event.type === 'fixture.supervised-activity')?.payload)
      .toEqual({ persisted: true });
    expect(await store.listProfiles()).toEqual([]); // No primary-only profile bootstrap.
    await worker.stop();
    expect(worker.failure).toBeUndefined();
    const releaseAfterStop = await claimWorkerOwnership(home);
    releaseAfterStop();
  } finally {
    for (const worker of workers) await worker.stop();
    await relay?.stop();
    await connection?.close();
    await server?.stop();
    await store?.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    registration.release();
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 90_000);

// Production runs activities in this child (KARMAX_WORKER_MODE=process). Its
// store must be hosted like the primary's, or every hosted limit an activity
// checks reads as a private installation's: compute holds and credit were off
// on tavya.io until 2026-10-29 (wiki features/managed-compute).
test('gives a hosted cell\'s activities a hosted store', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-activity-worker-hosted-'));
  const schema = `worker_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: postgres });
  const target = new URL(postgres!);
  target.searchParams.set('options', `-csearch_path=${schema}`);
  const vaultKey = crypto.randomBytes(48).toString('hex');
  vi.stubEnv('KARMAX_HOME', home);
  vi.stubEnv('KARMAX_VAULT_KEY', vaultKey);
  ensurePaths(home);
  const registration = registerAppInstance();
  const workers: WorkerProcessManager[] = [];
  let store: Store | undefined;
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  let connection: Awaited<ReturnType<typeof makeClient>> | undefined;
  let stopRunner: (() => Promise<void>) | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    store = await Store.create(target.href, { hosted: true });
    const vault = await openSecretVault(path.join(home, 'vault'), store.db, { resolveScopes: async () => new Map(), audit: async () => undefined });
    await new ModelLogins(path.join(home, 'config-homes'), new CredentialBroker(vault), store.db).moveIntoVault(store.db, { audit: async () => undefined });
    const project = await store.createProject('Hosted supervised activity');
    const task = await store.createTask({ projectId: project.id, title: 'Probe the deployment',
      workflow: 'fixture', workflowVersion: '1', params: { prompt: 'Probe the deployment' } });
    server = await startDevServer({ headless: true, logLevel: 'never' });
    connection = await makeClient({ address: server.address, namespace: server.namespace });
    // The probe workflow runs on a worker in this process (a hosted worker
    // loads no external workflows); its activities run on the child under test.
    const native = await NativeConnection.connect({ address: server.address });
    const runnerQueue = `hosted-probe-${crypto.randomUUID()}`;
    const runner = await Worker.create({ connection: native, namespace: server.namespace, taskQueue: runnerQueue,
      workflowBundle: await bundleWorkflowCode({
        workflowsPath: fileURLToPath(new URL('./fixtures/activity-worker-hosted-workflow.ts', import.meta.url)) }) });
    const running = runner.run();
    stopRunner = async () => { runner.shutdown(); await running; await native.close(); };
    const start = async (deployment: NodeJS.ProcessEnv) => {
      const queue = `hosted-activity-${crypto.randomUUID()}`;
      const worker = new WorkerProcessManager({
        entrypoint: fileURLToPath(new URL('../src/temporal/activity-worker-main.ts', import.meta.url)),
        execArgv: ['--import', 'tsx', '--max-old-space-size=512'],
        env: { PATH: process.env.PATH, HOME: process.env.HOME, KARMAX_HOME: home,
          KARMAX_TASK_QUEUE: queue, KARMAX_DATABASE_URL: target.href, KARMAX_VAULT_KEY: vaultKey,
          KARMAX_TEMPORAL_ADDRESS: server!.address, KARMAX_TEMPORAL_NAMESPACE: server!.namespace,
          KARMAX_GATEWAY_URL: 'http://127.0.0.1:1', KARMAX_AGENT_PROVIDER: 'mock', ...deployment },
      });
      workers.push(worker);
      await worker.start([]);
      return { worker, queue };
    };
    const probe = async (deployment: NodeJS.ProcessEnv) => {
      const { worker, queue } = await start(deployment);
      try {
        await connection!.client.workflow.execute('hostedProbe', {
          workflowId: crypto.randomUUID(), taskQueue: runnerQueue, args: [task.id, queue], workflowExecutionTimeout: '30s',
        });
      } finally { await worker.stop(); }
      expect(worker.failure).toBeUndefined();
      const events = (await store!.eventsSince(task.id, 0)).filter(event => event.type === 'fixture.hosted-probe');
      return events.at(-1)?.payload;
    };
    expect(await probe({ KARMAX_DEPLOYMENT: 'hosted', KARMAX_SINGLE_NODE: '1',
      KARMAX_PUBLIC_URL: 'https://karmax.example.test', KARMAX_PREVIEW_ORIGIN: 'https://preview.karmax.example.test',
      KARMAX_AUTH_SECRET: crypto.randomBytes(48).toString('hex'),
      KARMAX_WORLD_REF_KEY: crypto.randomBytes(48).toString('hex'),
      KARMAX_OBJECT_STORE: 'local', KARMAX_CLOUD_WORLD_PROVIDER: 'e2b' })).toEqual({ hosted: true });
    // A private installation's child stays private.
    expect(await probe({})).toEqual({ hosted: false });
  } finally {
    for (const worker of workers) await worker.stop();
    await stopRunner?.();
    await connection?.close();
    await server?.stop();
    await store?.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    registration.release();
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 90_000);
