import path from 'node:path';
import { paths } from '../config/paths.js';
import { validateDeployment } from '../config/deployment.js';
import { admitWorkerProcess } from '../util/instance.js';
import { Store } from '../store/db.js';
import { makeClient } from '../temporal/client.js';
import { temporalConnectionFromEnv } from '../temporal/connection-env.js';
import { WorkerManager } from '../temporal/worker-pool.js';
import { announceEventsAppended, type WorkerProcessRuntime } from '../temporal/worker-process-server.js';
import { TASK_QUEUE } from '../temporal/config.js';
import { defaultProvider } from '../agent/adapters.js';
import { KarmaxBus } from '../contrib/bus.js';
import { openSecretVault } from '../autonomy/vault-backend.js';
import { sweepTurnKeys } from '../autonomy/vault-items.js';
import { CredentialBroker } from '../autonomy/broker.js';
import { AuthorizationService } from '../platform/authorization.js';
import { GitHubAppService } from '../integrations/github-app.js';
import { createExecutionServices } from './execution-services.js';
import { assertDataEpoch } from '../config/data-epoch.js';
import type { ExternalWorkflowRef } from '../packages/bundle.js';

/** Attach to the primary's already-initialized installation. The parent passes
 * its hydrated environment, resolved Temporal address and bound gateway URL;
 * the child never starts Temporal, migrates SQLite, or imports operator secrets.
 * serveWorkerProcess must install its lifetime guardian before calling this.
 */
export async function createActivityWorkerRuntime(): Promise<WorkerProcessRuntime> {
  const database = process.env.KARMAX_DATABASE_URL?.trim();
  if (!database || !/^postgres(?:ql)?:\/\//.test(database))
    throw new Error('supervised activity workers require PostgreSQL');
  const conn = temporalConnectionFromEnv();
  if (!conn) throw new Error('supervised activity workers require a resolved Temporal address');
  const gateway = process.env.KARMAX_GATEWAY_URL;
  if (!gateway || !['http:', 'https:'].includes(new URL(gateway).protocol))
    throw new Error('supervised activity workers require the bound gateway URL');
  const deployment = validateDeployment();
  const p = paths();
  const release = await admitWorkerProcess(p.home);
  let store: Store | undefined;
  let closeClient: (() => Promise<void>) | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    // Close both independent resources even if either fails. Retain ownership
    // until cleanup completes; the outer supervisor bounds a stuck shutdown.
    try {
      const results = await Promise.allSettled([closeClient?.(), store?.close()]);
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    } finally { release(); }
  };
  try {
    store = await Store.create(database);
    await assertDataEpoch(store.db);
    // The primary relays this process's events to browsers; wake it on every
    // commit rather than leaving delivery to its poll (LT-15).
    const append = store.appendEvent.bind(store);
    store.appendEvent = async (event) => { const seq = await append(event); announceEventsAppended(); return seq; };
    const connection = await makeClient(conn);
    closeClient = connection.close;
    const client = connection.client;
    // Attaches only: the primary process ran the vault's migrations on its boot.
    const broker = new CredentialBroker(await openSecretVault(p.vault, store.db));
    sweepTurnKeys(); // key files a crashed turn of an earlier worker left behind
    const authorization = await AuthorizationService.create(store);
    const githubApp = await GitHubAppService.create(store, broker, {
      appId: process.env.KARMAX_GITHUB_APP_ID, appSlug: process.env.KARMAX_GITHUB_APP_SLUG,
      clientId: process.env.KARMAX_GITHUB_CLIENT_ID, publicApp: deployment.hosted,
    });
    const services = await createExecutionServices({ store, client, broker, githubApp, p, deployment,
      provider: defaultProvider().provider, coordinationDirectory: path.join(p.state, 'world-coordination') });
    const { worlds, adapters, profiles, tokens, checkpoints, runners, payments,
      paymentRegistry, configHomes, resources, objectStore } = services;
    const worker = new WorkerManager(conn, { store, client, broker, authorization, githubApp,
      worlds, adapters, profiles, tokens, checkpoints, runners, payments, paymentRegistry,
      configHomes, resources, objects: objectStore, bus: new KarmaxBus(),
      contentDir: p.content, hostLocal: deployment.hostLocal, taskQueue: TASK_QUEUE,
    }, error => {
      console.error('[activity-worker] stopped unexpectedly:', error);
      process.exit(1); // The primary must observe loss of polling, not stale readiness.
    });
    const validatePackages = (packages: ExternalWorkflowRef[] = []) => {
      if (deployment.hosted && packages.length)
        throw new Error('hosted workers cannot load external workflow packages');
    };
    return { worker: {
      async start(packages) { validatePackages(packages); await worker.start(packages); },
      async refresh(packages) { validatePackages(packages); await worker.refresh(packages); },
      async stop() { await worker.stop(); },
    }, close };
  } catch (error) {
    await close();
    throw error;
  }
}
