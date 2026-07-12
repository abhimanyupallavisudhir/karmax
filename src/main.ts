import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePaths, paths } from './config/paths.js';
import { startDevServer, watchDevServer } from './temporal/dev-server.js';
import { makeClient } from './temporal/client.js';
import { WorkerManager } from './temporal/worker-pool.js';
import { TASK_QUEUE } from './temporal/config.js';
import { WorkflowManager, reloadSpecForWorkflowEdit } from './packages/manager.js';
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
import { withTimeout } from './util/timeout.js';
import { registerAppInstance } from './util/instance.js';

const VERSION = '1.0.0';

async function main() {
  const p = ensurePaths();
  const { provider, reason } = defaultProvider();

  console.log('\n  karmax ' + VERSION + '  — an AI-era todo list on a durable substrate\n');

  // Duplicate app-instance guard (karmax#4): the July-5 OOM had 14 `src/main.ts`
  // running against one KARMAX_HOME — each with its own worker fanning out agent
  // turns, multiplying RAM pressure for no gain (one app serves the whole list).
  // Advisory, not a lock: a fast Ctrl-C→restart is intentional, so we warn loudly
  // and let the operator decide rather than refusing to boot.
  const instance = registerAppInstance();
  if (instance.others.length) {
    console.warn(
      `\n  ⚠  ${instance.others.length} other karmax app instance(s) already running against ${p.home}` +
        ` (pids ${instance.others.join(', ')}).\n` +
        `     Each runs its own worker + agent fan-out and competes for the same RAM —\n` +
        `     the exact condition behind the July-5 OOM (karmax#4). Stop the extras unless this is deliberate.\n`,
    );
  }
  if (provider === 'mock') {
    console.log('  ⚠  NO AGENT CREDENTIALS DETECTED — running with the MOCK agent (no real work).');
    console.log('     Set OPENAI_API_KEY or ANTHROPIC_API_KEY, or log in to Claude Code, then restart.\n');
  } else {
    console.log(`  • Agent provider: ${provider} (${reason})`);
  }

  // ── Temporal dev server (SQLite-backed, dynamic ports) ──
  // One long-lived server, reused across restarts/reloads (see dev-server.ts):
  // spawning a fresh one per reload against the same SQLite file is what wedges
  // Temporal. A wedged/dead server is auto-replaced here.
  console.log('  • Connecting to Temporal…');
  const temporalDb = path.join(p.temporal, 'temporal.db');
  const server = await startDevServer({ dbFilename: temporalDb, logLevel: 'error' });
  const conn = { address: server.address, namespace: server.namespace };
  console.log(`  • Temporal ${server.reused ? 'reused (already running)' : 'started'} at ${server.address}`);
  if (server.uiUrl) console.log(`    Temporal UI: ${server.uiUrl}`);
  // If the shared server dies mid-run (terminal scope stopped, pkill, crash),
  // respawn it at the same address so the worker/client pollers reconnect on
  // their own — otherwise the app spins on gRPC retries while serving nothing.
  const serverWatch = watchDevServer(server, { dbFilename: temporalDb, logLevel: 'error' });

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

  // Process-tree custody (src/agent/custody.ts): reap any agent subprocess
  // groups a prior incarnation left running after a SIGKILL/crash (systemd-oomd
  // was the July-5 OOM killer — no graceful teardown ran, so its orphaned
  // agents outlived the host). Only records whose owner process is dead are
  // orphans — agents owned by a live concurrent instance (see the duplicate-
  // instance warning above) are left untouched (2026-07-12: a world-rooted
  // dogfooding boot's sweep SIGKILLed prod's in-flight agents, including the
  // very agent that booted it).
  const { reapOrphans } = await import('./agent/custody.js');
  const orphans = reapOrphans();
  if (orphans.reaped) console.log(`  • Reaped ${orphans.reaped} orphaned agent process group(s) from a prior run`);
  if (orphans.skipped) console.log(`  • Left ${orphans.skipped} agent(s) owned by another live karmax instance untouched`);

  // Reconcile the task index against live workflows (settle anything lost on restart).
  const { reconcileTasks } = await import('./platform/reconcile.js');
  const recon = await reconcileTasks(store, client).catch(() => ({ checked: 0, settled: 0 }));
  if (recon.settled) console.log(`  • Reconciled ${recon.settled} task(s) lost/finished while offline`);

  // Register connected logins into the account/token coordinator (SPEC §6.2).
  // Empty pool ⇒ per-turn leasing stays off (zero behavior change).
  const { makeCoordinatorActivities } = await import('./activities/coordinator.js');
  const coordClient = makeCoordinatorActivities({ client, taskQueue: TASK_QUEUE });
  // Register EVERY credential (logins, ambient, API keys) under its stable policy key
  // so the coordinator can lease/track any of them (SPEC §6.2/§7).
  const { gatherCredentialSources, concurrencyFor } = await import('./platform/credential-sources.js');
  const { enumerateCredentials } = await import('./platform/credentials.js');
  const creds = enumerateCredentials(gatherCredentialSources({ configHomes, broker }));
  const pool = creds.map((c) => {
    const maxConcurrent = concurrencyFor((k) => store.kvGet(k), c.key);
    return { id: c.key, configHome: c.configHome ?? '', provider: c.provider, kind: c.kind, ...(c.apiKeyHandle ? { apiKeyHandle: c.apiKeyHandle } : {}), ...(maxConcurrent != null ? { maxConcurrent } : {}) };
  });
  if (pool.length) {
    await coordClient.registerAccounts(pool).catch((e) => console.warn('  • credential pool register failed', String(e)));
    console.log(`  • Registered ${pool.length} credential(s) into the account pool`);
  }

  const workflows = new WorkflowManager(workerManager, new WorkflowRepoLoader(p.workflows), undefined, p.workflows);
  // Reload workflows installed in previous sessions (SPEC §4.2) and roll the
  // worker once so their tasks — new and in-flight — can run after a restart.
  const restored = await workflows.restore((m) => console.warn('  •', m)).catch(() => 0);
  if (restored) console.log(`  • Restored ${restored} installed workflow(s)`);
  const api = new KarmaxApi({ store, client, taskQueue: TASK_QUEUE, tokens, contentDir: p.content, workflows });

  // Trigger dispatcher (SPEC §3.3): starts armed triggered tasks when a
  // dependency completes, a schedule fires, or a matching event occurs. Runs
  // in-process off the same bus as the self-heal loop; the store is the durable
  // source of truth, so it re-arms every armed task on boot.
  const { TriggerScheduler } = await import('./platform/trigger-scheduler.js');
  const triggerToken = tokens.mintPrincipal('system:triggers', ['*']).token;
  const triggerScheduler = new TriggerScheduler({
    store,
    bus,
    fire: (taskId, mode) => api.fireTriggeredTask(triggerToken, taskId, mode),
    log: (m) => console.log('  • ' + m),
  });
  api.setTriggerArmer(triggerScheduler);
  triggerScheduler.start();

  // Self-healing loop (SPEC §4.4): when a workflow-edit PR merges (its merge-only
  // task reaches done), reload the edited workflow from its repo so new tasks pick
  // up the published version. Runs in this process (not inside a workflow), so
  // rolling the worker is safe; deduped per task. A merge that forgot to bump the
  // version fails the reload loudly (version-bump guard) rather than swapping code.
  const healed = new Set<string>();
  bus.onAny((ev) => {
    if (ev.type !== 'view.updated' || (ev.payload as { status?: string })?.status !== 'done' || healed.has(ev.taskId)) return;
    const spec = reloadSpecForWorkflowEdit(store.getTask(ev.taskId) ?? {}, 'done');
    if (!spec) return;
    healed.add(ev.taskId);
    workflows
      .install(spec)
      .then((r) => console.log(`  • Self-healed: reloaded ${r.name}@${r.version} after a workflow edit`))
      .catch((e) => console.warn(`  • Workflow reload after edit failed: ${e instanceof Error ? e.message : e}`));
  });
  const contributions = new ContributionRegistry();
  const overlays = new Overlays();

  // Ensure a default project exists for first-run UX. Seed it with an EMPTY
  // config so branches inherit from global settings (or the repo's real default
  // branch) instead of baking a project-scope "main" override that would shadow
  // a global default like "master".
  if (store.listProjects().length === 0) {
    store.createProject('My project', {});
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

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n  shutting down…');
    // Backstop: never let a hung dependency (e.g. a slow worker drain) block exit.
    // Must beat tsx-watch's 5s force-kill: a SIGKILLed worker dies mid-activity,
    // orphaning agent subprocesses (and karmax's own merges trigger tsx reloads).
    setTimeout(() => process.exit(0), 4500).unref();
    // Bound every step so one wedged call can't strand the whole shutdown. The
    // worker itself resolves within ~3s (shutdownGraceTime/shutdownForceTime).
    const step = (p: Promise<unknown>) => withTimeout(Promise.resolve(p), 3500).catch(() => {});
    serverWatch.stop(); // don't respawn Temporal out from under a shutdown
    instance.release(); // drop our live-instance pidfile
    triggerScheduler.stop();
    await step(closeGateway());
    await step(workerManager.stop());
    await step(closeClient());
    await step(server.stop()); // no-op for the shared server — it persists for a fast restart
    console.log('  (Temporal left running for a fast restart — `npm run reset` stops it)');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('karmax failed to start:', e);
  process.exit(1);
});
