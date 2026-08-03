import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Client } from '@temporalio/client';
import { startDevServer, DevServer } from '../../src/temporal/dev-server.js';
import { makeClient } from '../../src/temporal/client.js';
import { makeWorker, WorkerHandle } from '../../src/temporal/worker.js';
import { TASK_QUEUE } from '../../src/temporal/config.js';
import { Store } from '../../src/store/db.js';
import { WorldRegistry } from '../../src/world/registry.js';
import { buildAdapters } from '../../src/agent/adapters.js';
import { ProfileResolver, seedProfiles } from '../../src/agent/profiles.js';
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
import { MockPaymentProvider, VaultCardProvider, StripeIssuingProvider, PaymentRegistry } from '../../src/autonomy/payments.js';
import { ConfigHomeManager } from '../../src/autonomy/config-homes.js';
import { LoginManager } from '../../src/autonomy/login.js';
import { LocalObjectStore } from '../../src/store/objects.js';
import { ObjectSnapshotEngine, ProjectResourceService } from '../../src/world/resources.js';
import { WorldHandoffService } from '../../src/world/handoff.js';

/** How long a teardown step may run before it is worth saying so out loud. Well
 *  clear of the ~1s a healthy teardown takes, so a normal run stays silent. */
const SLOW_PHASE_MS = 20_000;

/** Run one teardown step, announcing it on stderr if it outlives
 *  {@link SLOW_PHASE_MS}. Purely diagnostic: the step is still awaited to
 *  completion, because abandoning a worker drain leaves the Temporal Runtime
 *  installed and breaks every later harness boot in the same process. */
async function stopPhase(name: string, run: () => Promise<unknown>): Promise<void> {
  const started = Date.now();
  const warn = setInterval(
    () => process.stderr.write(`[harness.stop] "${name}" still running after ${Math.round((Date.now() - started) / 1000)}s\n`),
    SLOW_PHASE_MS,
  );
  try { await run(); } finally { clearInterval(warn); }
}

export interface Harness {
  server: DevServer;
  client: Client;
  store: Store;
  bus: KarmaxBus;
  worlds: WorldRegistry;
  worldsHome: string;
  tokens: TokenAuthority;
  api: KarmaxApi;
  resources: ProjectResourceService;
  broker: CredentialBroker;
  restartWorker(): Promise<void>;
  stop(): Promise<void>;
  makeRepo(name: string): Promise<string>;
  startGateway(opts?: { password?: string }): Promise<{ url: string; internalUrl: string; close: () => Promise<void> }>;
}

/** Boots a full karmax backend (Temporal + worker + deps) for integration tests. */
export async function bootHarness(
  provider: Provider = 'mock',
  adapterOverride?: import('../../src/agent/types.js').AgentAdapter,
  /** Activity-dep overrides a test needs the worker to run with (e.g. a stub
   *  GitHub endpoint for the pull-request integration). */
  overrides: {
    githubPr?: import('../../src/integrations/github-pr.js').GithubPrApiOptions;
    githubApp?: import('../../src/integrations/github-app.js').GitHubAppService;
  } = {},
): Promise<Harness> {
  const server = await startDevServer({ headless: true, logLevel: 'never' });
  const conn = { address: server.address, namespace: server.namespace };
  const c = await makeClient(conn);
  const client = c.client;

  const store = new Store(':memory:');
  // Direct API tests use this stable human principal. Production establishes
  // the same membership during first-account setup or invitation acceptance.
  store.claimPersonalOrganization('a');
  // Production seeds role profiles before constructing the API. Do the same in
  // the harness so API-created tasks honor the requested hermetic provider and
  // never auto-detect a developer's real Claude/Codex login.
  seedProfiles(store, provider);
  const worldsHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-worlds-'));
  const worlds = new WorldRegistry();
  // Point the worktree provider at a temp worlds home.
  const { WorktreeProvider } = await import('../../src/world/worktree.js');
  worlds.register(new WorktreeProvider(worldsHome));
  const adapters = buildAdapters();
  if (adapterOverride) adapters.set(provider, adapterOverride);
  const profiles = new ProfileResolver(store, provider);
  const bus = new KarmaxBus();
  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-content-'));
  const vaultHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-vault-'));
  const objectHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-objects-'));
  const broker = new CredentialBroker(new Vault(vaultHome));
  const objects = new LocalObjectStore(objectHome);
  const resources = new ProjectResourceService(store, worlds, new ObjectSnapshotEngine(objects, broker), broker,
    { client, taskQueue: TASK_QUEUE });

  const tokens = new TokenAuthority(store);
  const payments = new MockPaymentProvider(store);
  const paymentRegistry = new PaymentRegistry(store);
  paymentRegistry.register(payments);
  paymentRegistry.register(new VaultCardProvider(store, broker));
  paymentRegistry.register(new StripeIssuingProvider(store, fetch, process.env, broker));
  const activityDeps = {
    store,
    worlds,
    adapters,
    profiles,
    bus,
    client,
    tokens,
    payments,
    paymentRegistry,
    contentDir,
    taskQueue: TASK_QUEUE,
    broker,
    resources,
    ...overrides,
  };
  let worker: WorkerHandle = await makeWorker(conn, activityDeps);
  let runPromise = worker.run();

  const api = new KarmaxApi({ store, client, taskQueue: TASK_QUEUE, tokens, contentDir, defaultAgentProvider: provider, bus, worlds });
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
    resources,
    broker,
    async restartWorker() {
      worker.shutdown();
      await runPromise.catch(() => {});
      worker = await makeWorker(conn, activityDeps);
      runPromise = worker.run();
    },
    async startGateway(opts) {
      const configHomes = new ConfigHomeManager(fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-homes-')));
      // fake login command (no real CLI / OAuth): print a device URL then exit
      const login = new LoginManager(configHomes, () => ({
        cmd: 'bash',
        args: ['-c', 'echo "open https://example.com/dev?code=TEST"; exit 0'],
        env: {} as Record<string, string>,
      }));
      // Production always wires the host↔world handoff service. Keep the HTTP
      // harness at parity so checkout/materialization routes exercise their
      // actual behavior instead of returning the optional-dependency 503.
      const handoffs = new WorldHandoffService(store, worlds, {} as any, undefined, undefined,
        path.join(worldsHome, 'local-checkouts'), resources);
      const gw = new Gateway({
        api,
        store,
        bus,
        tokens,
        contributions: new ContributionRegistry(),
        overlays: new Overlays(),
        client,
        taskQueue: TASK_QUEUE,
        // The real web/ directory, exactly as src/main.ts wires it, so tests see
        // the shipped static assets (the brand icons are served from here).
        staticDir: fileURLToPath(new URL('../../web', import.meta.url)),
        agentInfo: { provider: 'mock', reason: 'test' },
        broker,
        payments,
        paymentRegistry,
        configHomes,
        login,
        password: opts?.password,
        worlds,
        objects,
        resources,
        handoffs,
      });
      const started = await gw.listen();
      gateways.push(started.close);
      return started;
    },
    async stop() {
      // Teardown is five blocking steps against real infrastructure. When one of
      // them wedges, Vitest reports only "Hook timed out in Nms" against the
      // describe block — which step, and therefore what to look at, is exactly
      // the information missing (it cost a bisect across three CI runs). Name
      // each step while it is still running, so a hang identifies itself.
      await stopPhase('gateways', async () => { for (const close of gateways) await close().catch(() => {}); });
      await stopPhase('workerDrain', async () => { worker.shutdown(); await runPromise.catch(() => {}); });
      await stopPhase('clientClose', () => c.close());
      await stopPhase('serverStop', () => server.stop());
      await stopPhase('rmTempDirs', async () => {
        fs.rmSync(worldsHome, { recursive: true, force: true });
        fs.rmSync(vaultHome, { recursive: true, force: true });
        fs.rmSync(objectHome, { recursive: true, force: true });
        fs.rmSync(contentDir, { recursive: true, force: true });
      });
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
