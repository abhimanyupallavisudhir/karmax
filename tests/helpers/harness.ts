import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { Client } from '@temporalio/client';
import { startDevServer, DevServer } from '../../src/temporal/dev-server.js';
import { makeClient } from '../../src/temporal/client.js';
import { makeWorker, WorkerHandle } from '../../src/temporal/worker.js';
import { TASK_QUEUE } from '../../src/temporal/config.js';
import { Store } from '../../src/store/db.js';
import { WorldRegistry } from '../../src/world/registry.js';
import { buildAdapters } from '../../src/agent/adapters.js';
import { ProfileResolver } from '../../src/agent/profiles.js';
import { KarmaxBus } from '../../src/contrib/bus.js';
import { git, gitOrThrow, ensureIdentity } from '../../src/world/git.js';
import { Provider } from '../../src/domain/types.js';
import { TokenAuthority } from '../../src/platform/tokens.js';
import { KarmaxApi } from '../../src/platform/api.js';
import { ContributionRegistry } from '../../src/contrib/registry.js';
import { Overlays } from '../../src/store/overlays.js';
import { Gateway } from '../../src/gateway/server.js';
import { CredentialBroker } from '../../src/autonomy/broker.js';
import { Vault } from '../../src/autonomy/vault.js';
import { MockPaymentProvider, StripeIssuingProvider, PaymentRegistry } from '../../src/autonomy/payments.js';
import { ConfigHomeManager } from '../../src/autonomy/config-homes.js';
import { LoginManager } from '../../src/autonomy/login.js';

export interface Harness {
  server: DevServer;
  client: Client;
  store: Store;
  bus: KarmaxBus;
  worlds: WorldRegistry;
  worldsHome: string;
  tokens: TokenAuthority;
  api: KarmaxApi;
  stop(): Promise<void>;
  makeRepo(name: string): Promise<string>;
  startGateway(opts?: { password?: string }): Promise<{ url: string; close: () => Promise<void> }>;
}

/** Boots a full karmax backend (Temporal + worker + deps) for integration tests. */
export async function bootHarness(provider: Provider = 'mock'): Promise<Harness> {
  const server = await startDevServer({ headless: true, logLevel: 'never' });
  const conn = { address: server.address, namespace: server.namespace };
  const c = await makeClient(conn);
  const client = c.client;

  const store = new Store(':memory:');
  const worldsHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-worlds-'));
  const worlds = new WorldRegistry();
  // Point the worktree provider at a temp worlds home.
  const { WorktreeProvider } = await import('../../src/world/worktree.js');
  worlds.register(new WorktreeProvider(worldsHome));
  const adapters = buildAdapters();
  const profiles = new ProfileResolver(store, provider);
  const bus = new KarmaxBus();

  const tokens = new TokenAuthority();
  const payments = new MockPaymentProvider(store);
  const paymentRegistry = new PaymentRegistry();
  paymentRegistry.register(payments);
  paymentRegistry.register(new StripeIssuingProvider());
  const worker: WorkerHandle = await makeWorker(conn, {
    store,
    worlds,
    adapters,
    profiles,
    bus,
    client,
    tokens,
    payments,
    taskQueue: TASK_QUEUE,
  });
  const runPromise = worker.run();

  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-content-'));
  const api = new KarmaxApi({ store, client, taskQueue: TASK_QUEUE, tokens, contentDir, defaultAgentProvider: provider });
  const gateways: Array<() => Promise<void>> = [];

  return {
    server,
    client,
    store,
    bus,
    worlds,
    worldsHome,
    tokens,
    api,
    async startGateway(opts) {
      const configHomes = new ConfigHomeManager(fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-homes-')));
      // fake login command (no real CLI / OAuth): print a device URL then exit
      const login = new LoginManager(configHomes, () => ({
        cmd: 'bash',
        args: ['-c', 'echo "open https://example.com/dev?code=TEST"; exit 0'],
        env: {} as Record<string, string>,
      }));
      const gw = new Gateway({
        api,
        store,
        bus,
        tokens,
        contributions: new ContributionRegistry(),
        overlays: new Overlays(),
        client,
        taskQueue: TASK_QUEUE,
        staticDir: fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-static-')),
        agentInfo: { provider: 'mock', reason: 'test' },
        broker: new CredentialBroker(new Vault(fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-vault-')))),
        payments,
        paymentRegistry,
        configHomes,
        login,
        password: opts?.password,
      });
      const started = await gw.listen();
      gateways.push(started.close);
      return started;
    },
    async stop() {
      for (const close of gateways) await close().catch(() => {});
      worker.shutdown();
      await runPromise.catch(() => {});
      await c.close();
      await server.stop();
      fs.rmSync(worldsHome, { recursive: true, force: true });
    },
    async makeRepo(name: string) {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), `karmax-repo-${name}-`));
      await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
      await ensureIdentity(repo);
      fs.writeFileSync(path.join(repo, 'README.md'), `# ${name}\n`);
      await git(repo, ['add', '-A']);
      await git(repo, ['commit', '-q', '-m', 'init']);
      return repo;
    },
  };
}
