import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePaths, paths } from './config/paths.js';
import { startDevServer } from './temporal/dev-server.js';
import { makeClient } from './temporal/client.js';
import { WorkerManager } from './temporal/worker-pool.js';
import { TASK_QUEUE } from './temporal/config.js';
import { WorkflowManager } from './packages/manager.js';
import { WorkflowRepoLoader } from './packages/repo.js';
import { Store } from './store/db.js';
import { WorldRegistry } from './world/registry.js';
import { WorktreeProvider } from './world/worktree.js';
import { buildAdapters, defaultProvider } from './agent/adapters.js';
import { ProfileResolver, seedProfiles } from './agent/profiles.js';
import { KarmaxBus } from './contrib/bus.js';
import { TokenAuthority } from './platform/tokens.js';
import { CredentialBroker } from './autonomy/broker.js';
import { Vault } from './autonomy/vault.js';
import { KarmaxApi } from './platform/api.js';
import { ContributionRegistry } from './contrib/registry.js';
import { Overlays } from './store/overlays.js';
import { Gateway } from './gateway/server.js';
import { remoteAccessPlan } from './remote/access.js';

const VERSION = '1.0.0';

async function main() {
  const p = ensurePaths();
  const { provider, reason } = defaultProvider();

  console.log('\n  karmax ' + VERSION + '  — an AI-era todo list on a durable substrate\n');
  if (provider === 'mock') {
    console.log('  ⚠  NO AGENT CREDENTIALS DETECTED — running with the MOCK agent (no real work).');
    console.log('     Set OPENAI_API_KEY or ANTHROPIC_API_KEY, or log in to Claude Code, then restart.\n');
  } else {
    console.log(`  • Agent provider: ${provider} (${reason})`);
  }

  // ── Temporal dev server (SQLite-backed, dynamic ports) ──
  console.log('  • Starting Temporal…');
  const server = await startDevServer({
    dbFilename: path.join(p.temporal, 'temporal.db'),
    logLevel: 'error',
  });
  const conn = { address: server.address, namespace: server.namespace };
  if (server.uiUrl) console.log(`    Temporal UI: ${server.uiUrl}`);

  const { client, close: closeClient } = await makeClient(conn);

  // ── Core services ──
  const store = new Store(path.join(p.state, 'karmax.db'));
  const worlds = new WorldRegistry();
  worlds.register(new WorktreeProvider(p.worlds));
  const adapters = buildAdapters();
  const profiles = new ProfileResolver(store, provider);
  seedProfiles(store, provider);
  const bus = new KarmaxBus();
  const tokens = new TokenAuthority();
  const broker = new CredentialBroker(new Vault(p.vault));
  const { MockPaymentProvider, StripeIssuingProvider, PaymentRegistry } = await import('./autonomy/payments.js');
  const payments = new MockPaymentProvider(store);
  const paymentRegistry = new PaymentRegistry();
  paymentRegistry.register(payments);
  paymentRegistry.register(new StripeIssuingProvider());
  const { ConfigHomeManager } = await import('./autonomy/config-homes.js');
  const { LoginManager } = await import('./autonomy/login.js');
  const configHomes = new ConfigHomeManager();
  const login = new LoginManager(configHomes);

  // A managed worker so newly-installed workflow packages can be picked up by
  // rolling the worker without a restart (§21d/§21e).
  const workerManager = new WorkerManager(conn, {
    store,
    worlds,
    adapters,
    profiles,
    bus,
    client,
    tokens,
    broker,
    payments,
    configHomes,
    taskQueue: TASK_QUEUE,
  });
  await workerManager.start();
  console.log('  • Worker started');

  // Reconcile the task index against live workflows (settle anything lost on restart).
  const { reconcileTasks } = await import('./platform/reconcile.js');
  const recon = await reconcileTasks(store, client).catch(() => ({ checked: 0, settled: 0 }));
  if (recon.settled) console.log(`  • Reconciled ${recon.settled} task(s) lost/finished while offline`);

  // Register connected logins into the account/token coordinator (SPEC §6.2).
  // Empty pool ⇒ per-turn leasing stays off (zero behavior change).
  const { makeCoordinatorActivities } = await import('./activities/coordinator.js');
  const coordClient = makeCoordinatorActivities({ client, taskQueue: TASK_QUEUE });
  const pool = configHomes.list().filter((a) => a.loggedIn).map((a) => ({ id: `${a.provider}:${a.account}`, configHome: a.path }));
  if (pool.length) {
    await coordClient.registerAccounts(pool).catch((e) => console.warn('  • account pool register failed', String(e)));
    console.log(`  • Registered ${pool.length} login(s) into the account pool`);
  }

  const workflows = new WorkflowManager(workerManager, new WorkflowRepoLoader(p.workflows), undefined, p.workflows);
  // Reload workflows installed in previous sessions (SPEC §4.2) and roll the
  // worker once so their tasks — new and in-flight — can run after a restart.
  const restored = await workflows.restore((m) => console.warn('  •', m)).catch(() => 0);
  if (restored) console.log(`  • Restored ${restored} installed workflow(s)`);
  const api = new KarmaxApi({ store, client, taskQueue: TASK_QUEUE, tokens, contentDir: p.content, workflows });
  const contributions = new ContributionRegistry();
  const overlays = new Overlays();

  // Ensure a default project exists for first-run UX.
  if (store.listProjects().length === 0) {
    store.createProject('My project', { defaultBase: 'main', defaultTarget: 'main' });
  }

  const staticDir = fileURLToPath(new URL('../web', import.meta.url));
  const gateway = new Gateway({
    api,
    store,
    bus,
    tokens,
    contributions,
    overlays,
    client,
    taskQueue: TASK_QUEUE,
    staticDir,
    agentInfo: { provider, reason },
    broker,
    payments,
    paymentRegistry,
    login,
    configHomes,
    password: process.env.KARMAX_PASSWORD,
    version: VERSION,
  });
  const preferred = process.env.KARMAX_PORT ? Number(process.env.KARMAX_PORT) : undefined;
  const { url, port, close: closeGateway } = await gateway.listen(preferred);

  console.log(`\n  ✓ karmax is running:  ${url}\n`);
  if (!process.env.KARMAX_PASSWORD) console.log('  (single-user localhost mode — set KARMAX_PASSWORD to require login)');
  try {
    const remote = await remoteAccessPlan(port, { hasPassword: !!process.env.KARMAX_PASSWORD });
    console.log(`\n  Remote access (${remote.method}):\n  ${remote.guidance.replace(/\n/g, '\n  ')}\n`);
  } catch {
    /* ignore */
  }

  const shutdown = async () => {
    console.log('\n  shutting down…');
    await closeGateway().catch(() => {});
    await workerManager.stop().catch(() => {});
    await closeClient().catch(() => {});
    await server.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('karmax failed to start:', e);
  process.exit(1);
});
