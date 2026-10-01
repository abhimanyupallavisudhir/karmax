import { buildVersionedBundle } from './packages/bundle.js';
import { authHosts } from './auth/origins.js';
import { temporalConnectionFromEnv } from './temporal/connection-env.js';
import { createExecutionServices } from './runtime/execution-services.js';
import { AsyncInterval } from './util/async-interval.js';
import * as __asyncCollections from './util/async-collections.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ensurePaths, paths } from './config/paths.js';
import { startDevServer, watchDevServer } from './temporal/dev-server.js';
import { makeClient } from './temporal/client.js';
import { WorkerManager, terminateOnWorkerFailure } from './temporal/worker-pool.js';
import { WorkerProcessManager } from './temporal/worker-process.js';
import { ForeignEventRelay } from './contrib/foreign-event-relay.js';
import { TASK_QUEUE } from './temporal/config.js';
import { WorkflowManager } from './packages/manager.js';
import { WorkflowRepoLoader } from './packages/repo.js';
import { openStore } from './store/db.js';
import { defaultProvider } from './agent/adapters.js';
import { KarmaxBus } from './contrib/bus.js';
import { CredentialBroker } from './autonomy/broker.js';
import { Vault, recordQuarantine } from './autonomy/vault.js';
import { EmailService, type OutboundEmailConfig } from './autonomy/email.js';
import { GitProfiles, inheritPersonalGithubProfile, userGitScope } from './autonomy/git-profiles.js';
import { KarmaxApi } from './platform/api.js';
import { ContributionRegistry } from './contrib/registry.js';
import { Overlays } from './store/overlays.js';
import { Gateway } from './gateway/server.js';
import { RemoteAccessController, remoteAccessPlan } from './remote/access.js';
import { withTimeout } from './util/timeout.js';
import { claimWorkerOwnership, duplicateInstanceMessage, registerAppInstance } from './util/instance.js';
import { AuthorizationService } from './platform/authorization.js';
import { IdentityService, type GitHubAuthorization } from './auth/identity.js';
import { siteNameOf, BRAND } from './domain/brand.js';
import { GitHubAppService, GITHUB_APP_PRIVATE_KEY_HANDLE, GITHUB_APP_WEBHOOK_SECRET_HANDLE,
  GITHUB_APP_CLIENT_SECRET_HANDLE } from './integrations/github-app.js';
import { GitHubDeploymentMonitor } from './integrations/github-deployment-monitor.js';
import { WorldLifecycleManager } from './world/runners.js';
import { BrowserDeliveryAdapter, DeliveryDispatcher, WebhookDeliveryAdapter } from './collaboration/delivery.js';
import { hydrateEnvFile, hydrateSecretFiles, validateDeployment } from './config/deployment.js';
import { WorldHandoffService } from './world/handoff.js';
import { sweepOrphanedServiceContainers } from './world/services.js';
import { spawnReplacementProcess, worldLandedInCheckout } from './util/live-restart.js';
import { EntitlementQueueReconciler } from './platform/entitlement-queue-reconciler.js';
import { beginRuntimeLifecycle, endRuntimeLifecycle } from './util/runtime-lifecycle.js';
import type { WorldHandle } from './world/types.js';

const VERSION = '1.0.0';

/**
 * Keep a stray rejection from taking the whole app down.
 *
 * Node ≥22 exits the process on an unhandled rejection. karmax is a long-lived
 * server whose background loops are fire-and-forget by design (the delivery
 * dispatcher, the mail poller, the trigger scheduler, the lifecycle sweep), so a
 * single transient SQLITE_BUSY or a provider timeout in any one of them would
 * otherwise kill the gateway, the worker, and every in-flight agent turn with it.
 *
 * This deliberately logs rather than swallows: the stack still reaches the
 * operator, and each loop remains responsible for its own error handling. It is a
 * backstop against total loss, not a licence to skip `.catch`.
 *
 * INTENDED: `uncaughtException` is NOT handled here. A synchronous throw that
 * escaped every frame leaves state unknown, and Node's default (crash) is the
 * right answer — the supervisor restarts into a clean process. Only the
 * rejection case, where the failure is confined to one awaited chain, is caught.
 */
function installProcessGuards(): void {
  process.on('unhandledRejection', (reason) => {
    console.error('  ⚠ unhandled rejection (app kept running):', reason instanceof Error ? reason.stack ?? reason.message : reason);
  });
}

/** How often to re-check the task index against live workflows. Each pass is one
 *  bounded `describe` per non-terminal task, so it stays cheap at list scale. */
const RECONCILE_INTERVAL_MS = 60_000;

async function main() {
  installProcessGuards();
  // Both before anything reads process.env, and in this order: the env file may
  // itself name a NAME_FILE secret.
  const envFile = hydrateEnvFile(process.env, (filename) => fs.readFileSync(filename, 'utf8'));
  hydrateSecretFiles(process.env, (filename) => fs.readFileSync(filename, 'utf8'));
  const deployment = validateDeployment();
  const workerMode = process.env.KARMAX_WORKER_MODE ?? 'combined';
  if (!['combined', 'process'].includes(workerMode)) throw new Error('invalid KARMAX_WORKER_MODE');
  const separateWorker = workerMode === 'process';
  if (separateWorker && (process.platform !== 'linux' || !/^postgres(?:ql)?:\/\//i.test(process.env.KARMAX_DATABASE_URL ?? '')))
    throw new Error('process worker mode requires Linux and PostgreSQL');
  let startupReady = false;
  const startupJobs: Array<() => Promise<unknown>> = [];
  let startupMaintenance: Promise<unknown> | undefined;
  let eventRelay: ForeignEventRelay | undefined;
  const p = ensurePaths();
  const { provider, reason } = defaultProvider();

  console.log(`\n  ${BRAND} ` + VERSION + '  — an AI-era todo list on a durable substrate\n');
  if (envFile) console.log(`  • Operator settings from ${envFile}`);

  // Duplicate app-instance guard (karmax#4): more than one worker against the
  // same Temporal queue is a correctness bug, not just excess RAM. A duplicate
  // can claim an activity and disappear or run it under divergent code while the
  // UI is served by another process. Graceful restart releases before spawning
  // its successor, so refusing a genuinely live duplicate is safe.
  const instance = registerAppInstance();
  if (instance.others.length) {
    instance.release();
    throw new Error(duplicateInstanceMessage(p.home, instance.others));
  }
  // The combined runtime participates in worker ownership too. A future split
  // primary may have exited while its child is still being terminated; acquiring
  // only app.lock would allow overlapping pollers during that transition.
  const releaseWorker = !separateWorker && process.platform === 'linux' ? await claimWorkerOwnership(p.home) : () => {};
  const workflows = new WorkflowManager(
    { refresh: (packages) => workerManager.refresh(packages) },
    new WorkflowRepoLoader(p.workflows),
    undefined,
    p.workflows,
    async (organizationId) => {
      const profiles = new GitProfiles(store, broker, p.state, organizationId);
      const profile = (await profiles.resolve(undefined));
      return profile ? (await profiles.env(profile, {})) : {};
    },
    deployment.hosted,
  );
  // Restore the exact external set before compiling, while Temporal/database
  // boot proceeds independently. The child process uses the same disk cache.
  const bootBundle = workflows.restore((m) => console.warn('  •', m), false)
    .then(() => buildVersionedBundle(workflows.workflowRefs));
  void bootBundle.catch(() => {}); // observed below even if another boot step fails
  // ── Temporal dev server (SQLite-backed, dynamic ports) ──
  // One long-lived server, reused across restarts/reloads (see dev-server.ts):
  // spawning a fresh one per reload against the same SQLite file is what wedges
  // Temporal. A wedged/dead server is auto-replaced here.
  console.log('  • Connecting to Temporal…');
  const externalTemporal = temporalConnectionFromEnv();
  const temporalDb = path.join(p.temporal, 'temporal.db');
  const server = externalTemporal ? undefined : await startDevServer({ dbFilename: temporalDb, logLevel: 'error' });
  const conn = externalTemporal ?? { address: server!.address, namespace: server!.namespace };
  if (externalTemporal) console.log(`  • Temporal production service at ${conn.address} (${conn.namespace})`);
  else {
    console.log(`  • Temporal ${server!.reused ? 'reused (already running)' : 'started'} at ${server!.address}`);
    if (server!.uiUrl) console.log(`    Temporal UI: ${server!.uiUrl}`);
  }
  // External Temporal is supervised by its operator. The embedded local server
  // retains karmax's same-address health watcher and restart behavior.
  const serverWatch = server ? watchDevServer(server, { dbFilename: temporalDb, logLevel: 'error' }) : { stop() {} };

  const { client, close: closeClient } = await makeClient(conn);

  // ── Core services ──
  const openedStore = (await openStore(path.join(p.state, 'karmax.db'), process.env.KARMAX_DATABASE_URL,
    { hosted: deployment.hosted }));
  const store = openedStore.store;
  await (await import('./ops/backup.js')).recordRestores(store, p.home); // DB-10
  if (process.env.KARMAX_DATABASE_URL) {
    const migrated = openedStore.migration?.imported
      ? `; imported ${openedStore.migration.rows} rows from SQLite`
      : '';
    console.log(`  • PostgreSQL application database${migrated}`);
  }
  const authorization = (await AuthorizationService.create(store));
  const runtime = (await beginRuntimeLifecycle(store, {
    runtimeId: `runtime-${Date.now()}-${process.pid}`,
    startedAt: Date.now(),
    pid: process.pid,
    version: VERSION,
    node: process.version,
    ...([process.env.KARMAX_BUILD_REVISION, process.env.GITHUB_SHA, process.env.SOURCE_VERSION]
      .map((value) => value?.trim()).find(Boolean)
      ? { buildRevision: [process.env.KARMAX_BUILD_REVISION, process.env.GITHUB_SHA, process.env.SOURCE_VERSION]
        .map((value) => value?.trim()).find(Boolean)! }
      : {}),
  }));
  const vault = new Vault(p.vault);
  // Binds ciphertext written before AU-27 to its handle; what will not open is quarantined, loudly.
  // Reported until audited, so a crash between quarantine and audit still reaches the log.
  await recordQuarantine(vault, (entry) => store.appendAudit({ principalId: 'system:vault', action: 'vault.entry.quarantined', detail: { ...entry } }));
  const broker = new CredentialBroker(vault);
  await (await import('./autonomy/payments.js')).separateStoredCardCvcs(broker); // AU-31
  (await import('./autonomy/vault-items.js')).removeLegacyKeyCopies(p.state); // AU-33
  (await import('./autonomy/vault-items.js')).sweepTurnKeys(); // key files a crashed turn left behind
  const { PaidLaunchSettingsService } = await import('./launch/settings.js');
  const paidLaunchSettings = new PaidLaunchSettingsService(store, broker, process.env);
  if (process.env.KARMAX_GITHUB_APP_PRIVATE_KEY && !broker.hasHandle(GITHUB_APP_PRIVATE_KEY_HANDLE))
    (await broker.ensureHandle(GITHUB_APP_PRIVATE_KEY_HANDLE, process.env.KARMAX_GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n')));
  if (process.env.KARMAX_GITHUB_WEBHOOK_SECRET && !broker.hasHandle(GITHUB_APP_WEBHOOK_SECRET_HANDLE))
    (await broker.ensureHandle(GITHUB_APP_WEBHOOK_SECRET_HANDLE, process.env.KARMAX_GITHUB_WEBHOOK_SECRET));
  if (process.env.KARMAX_GITHUB_CLIENT_SECRET && !broker.hasHandle(GITHUB_APP_CLIENT_SECRET_HANDLE))
    (await broker.ensureHandle(GITHUB_APP_CLIENT_SECRET_HANDLE, process.env.KARMAX_GITHUB_CLIENT_SECRET));
  // One deployment App owns repository installations and user OAuth. Environment
  // values remain an upgrade/enterprise bootstrap path; the normal path is the
  // browser manifest, whose converted client credentials persist in Store/Vault.
  const githubApp = (await GitHubAppService.create(store, broker, { appId: process.env.KARMAX_GITHUB_APP_ID,
    appSlug: process.env.KARMAX_GITHUB_APP_SLUG, clientId: process.env.KARMAX_GITHUB_CLIENT_ID,
    publicApp: deployment.hosted }));
  const sharedGithubOauth = githubApp.oauthCredentials();
  // A separately managed OAuth App remains a compatibility fallback only. Once
  // the deployment GitHub App exists, it is the single OAuth client.
  const legacyGithubOauth = process.env.KARMAX_GITHUB_OAUTH_CLIENT_ID?.trim()
    && process.env.KARMAX_GITHUB_OAUTH_CLIENT_SECRET?.trim()
    ? { clientId: process.env.KARMAX_GITHUB_OAUTH_CLIENT_ID.trim(),
        clientSecret: process.env.KARMAX_GITHUB_OAUTH_CLIENT_SECRET.trim() }
    : undefined;
  const publicUrl = process.env.KARMAX_PUBLIC_URL?.trim().replace(/\/$/, '');
  const identity = await IdentityService.open(path.join(p.state, 'auth.db'), {
    ...(process.env.KARMAX_DATABASE_URL ? { databaseUrl: process.env.KARMAX_DATABASE_URL } : {}),
    secret: process.env.KARMAX_AUTH_SECRET,
    baseURL: {
      allowedHosts: authHosts(),
      fallback: publicUrl ?? `http://127.0.0.1:${process.env.KARMAX_PORT ?? 4505}`,
    },
    siteName: async () => siteNameOf((await store.getSettings('global', 'appearance'))),
    ...(process.env.KARMAX_OIDC_DISCOVERY_URL && process.env.KARMAX_OIDC_CLIENT_ID && process.env.KARMAX_OIDC_CLIENT_SECRET
      ? { oidc: { providerId: process.env.KARMAX_OIDC_PROVIDER_ID ?? 'enterprise',
          discoveryUrl: process.env.KARMAX_OIDC_DISCOVERY_URL, issuer: process.env.KARMAX_OIDC_ISSUER,
          clientId: process.env.KARMAX_OIDC_CLIENT_ID, clientSecret: process.env.KARMAX_OIDC_CLIENT_SECRET,
          scopes: process.env.KARMAX_OIDC_SCOPES?.split(',').map((value) => value.trim()).filter(Boolean) } }
      : {}),
    ...(process.env.KARMAX_GOOGLE_CLIENT_ID?.trim() && process.env.KARMAX_GOOGLE_CLIENT_SECRET?.trim()
      ? { google: { clientId: process.env.KARMAX_GOOGLE_CLIENT_ID.trim(),
          clientSecret: process.env.KARMAX_GOOGLE_CLIENT_SECRET.trim() } }
      : {}),
    ...(sharedGithubOauth ? { github: { ...sharedGithubOauth, app: true,
      onAuthorization: async (authorization: GitHubAuthorization) => {
        const githubIdentity = await githubApp.adoptUserAuthorization(authorization.userId, authorization.accountId, authorization);
        (await new GitProfiles(store, broker, p.state, userGitScope(authorization.userId)).saveGithubIdentity(githubIdentity));
        (await inheritPersonalGithubProfile(store, broker, authorization.userId));
      } } } : legacyGithubOauth ? { github: legacyGithubOauth } : {}),
  });
  if (identity.migration?.imported)
    console.log(`  • Imported ${identity.migration.rows} identity rows from SQLite`);
  identity.connectOrganizationNames(async () => (await store.organizationNameReservations()));
  store.connectUserNames(async () => (await identity.listUsers()));
  (await store.migrateLegacyAccountNameCollisions((await identity.listUsers())));
  const installationOwner = (await identity.listUsers())[0];
  if (installationOwner) (await store.claimPersonalOrganization(installationOwner.id, installationOwner.name));
  (await store.migratePersonalOrganizationNames((await identity.listUsers())));
  const { worlds, adapters, profiles, tokens, providerConnections, objectStore, storageLocations,
    resources, checkpoints, runners, worldAccess, payments, paymentRegistry, configHomes } =
    await createExecutionServices({ store, client, broker, githubApp, p, deployment, provider, bootstrap: true,
      ...(separateWorker ? { coordinationDirectory: path.join(p.state, 'world-coordination') } : {}) });
  const bus = new KarmaxBus();
  // Every event this process records reaches its subscribers once committed —
  // including a manual Done's lifecycle change, which no writer emitted (#367).
  // Other processes' rows arrive through the event relay below.
  store.onEventRecorded((event) => bus.emit(event));
  const relayCursor = separateWorker ? await store.latestEventSeq() : undefined;
  // Installation-wide outbound email (account confirmation, password reset, org
  // invites). Reads its live config + vaulted secret on each send, so connecting
  // a provider in Settings takes effect without a restart. Handed to identity so
  // Better Auth's reset/verify hooks can send.
  const emailConfig = async (): Promise<OutboundEmailConfig> => {
    try { return JSON.parse((await store.kvGet('email:outbound')) ?? '{}'); } catch { return {}; }
  };
  const emailService = new EmailService(emailConfig,
    (handle) => (broker.hasHandle(handle) ? broker.resolve(handle, { caps: ['use-credential:*'] }) : undefined));
  identity.mailer = emailService;
  const handoffs = new WorldHandoffService(store, worlds, githubApp, runners, worldAccess, p.localCheckouts, resources);
  const worldLifecycle = new WorldLifecycleManager(store, worlds, checkpoints, 60_000, objectStore, runners, worldAccess);
  const delivery = new DeliveryDispatcher(store, {
    browser: new BrowserDeliveryAdapter(),
    ...(process.env.KARMAX_EMAIL_DELIVERY_URL ? { email: new WebhookDeliveryAdapter(process.env.KARMAX_EMAIL_DELIVERY_URL, 'email') } : {}),
    ...(process.env.KARMAX_SLACK_DELIVERY_URL ? { slack: new WebhookDeliveryAdapter(process.env.KARMAX_SLACK_DELIVERY_URL, 'slack') } : {}),
  }, async (id) => {
    const user = await identity.userById(id);
    return user ? { id: user.id, name: user.name, email: user.email } : undefined;
  });
  // Hosted-plan billing is deliberately a different provider and ledger from
  // the agent card registry above. Self-hosted installs construct the service so
  // status calls can report "unmetered", but it never contacts Stripe there.
  const { StripeSubscriptionProvider, SubscriptionBillingService } = await import('./billing/subscriptions.js');
  const { PaddleSubscriptionProvider } = await import('./billing/paddle.js');
  const subscriptionBilling = new SubscriptionBillingService(store, async (name) => {
    const selected = name ?? `${await paidLaunchSettings.billingProvider()}-billing`;
    if (selected === 'paddle-billing') return new PaddleSubscriptionProvider(() => paidLaunchSettings.paddleConfig());
    if (selected === 'stripe-billing') return new StripeSubscriptionProvider(() => paidLaunchSettings.subscriptionConfig());
    throw new Error(`unsupported subscription provider ${selected}`);
  }, deployment.hosted);
  const { LoginManager } = await import('./autonomy/login.js');
  const login = new LoginManager(configHomes);
  // A managed worker so newly-installed workflow packages can be picked up by
  // rolling the worker without a restart (§21d/§21e).
  const workerEnvironment: NodeJS.ProcessEnv = { ...process.env, KARMAX_TEMPORAL_ADDRESS: conn.address,
    KARMAX_TEMPORAL_NAMESPACE: conn.namespace };
  const workerManager = separateWorker ? new WorkerProcessManager({
    entrypoint: fileURLToPath(new URL('./temporal/activity-worker-main.ts', import.meta.url)),
    env: workerEnvironment,
    onFailure: terminateOnWorkerFailure,
    // Deliver the child's events to browsers now, not on the relay's next poll (LT-15).
    onEvents: () => { void eventRelay?.wake(); },
  }) : new WorkerManager(conn, {
    store,
    worlds,
    adapters,
    profiles,
    bus,
    client,
    tokens,
    authorization,
    broker,
    githubApp,
    checkpoints,
    runners,
    payments,
    paymentRegistry,
    configHomes,
    resources,
    objects: objectStore,
    contentDir: p.content,
    hostLocal: deployment.hostLocal,
    taskQueue: TASK_QUEUE,
  }, terminateOnWorkerFailure);
  const api = new KarmaxApi({ store, client, taskQueue: TASK_QUEUE, tokens, contentDir: p.content, workflows,
    authorization, defaultAgentProvider: provider, hosted: deployment.hosted, hostLocal: deployment.hostLocal,
    providerConnections, worlds,
    worldAccess, runners, resources, broker, githubApp, bus,
    refreshCredentialHealth: async (task, credentialProvider, options) => {
      if (!credentialProvider) return;
      const { retryCredentials } = await import('./agent/credential-health.js');
      await retryCredentials({ store, client, taskQueue: TASK_QUEUE, configHomes, broker }, task, credentialProvider, options);
    },
  });

  // Workflow code activation is an explicit install operation with current
  // authorization. A completed edit must never activate a moving branch tip.
  const contributions = new ContributionRegistry();
  const overlays = new Overlays();

  const staticDir = fileURLToPath(new URL('../web', import.meta.url));
  let gatewayPort = process.env.KARMAX_PORT ? Number(process.env.KARMAX_PORT) : 4505;
  const remoteAccess = new RemoteAccessController({ port: () => gatewayPort });
  const gateway = (await Gateway.create({
    runtimeReady: () => startupReady && !workerManager.failure,
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
    email: emailService,
    payments,
    paymentRegistry,
    login,
    configHomes,
    password: process.env.KARMAX_PASSWORD,
    version: VERSION,
    identity,
    authorization,
    worlds,
    githubApp,
    providerConnections,
    workflows,
    handoffs,
    runners,
    worldAccess,
    objects: objectStore,
    resources,
    checkpoints,
    subscriptions: subscriptionBilling,
    paidLaunchSettings,
    cellId: deployment.cellId,
    hosted: deployment.hosted,
    hostLocal: deployment.hostLocal,
    // Exactly the channels wired into the DeliveryDispatcher above, so the console
    // can disable a switch it cannot honour instead of reporting a false "saved".
    deliveryChannels: [
      'browser',
      ...(process.env.KARMAX_EMAIL_DELIVERY_URL ? ['email'] : []),
      ...(process.env.KARMAX_SLACK_DELIVERY_URL ? ['slack'] : []),
    ],
    remoteAccess,
  }));
  const preferred = process.env.KARMAX_PORT ? Number(process.env.KARMAX_PORT) : undefined;
  const { url, internalUrl, port, close: closeGateway } = await gateway.listen(preferred);
  gatewayPort = port;

  // Activities read this lazily when an agent invokes the complete platform API.
  // Keep service-to-service agent/MCP traffic on the control plane's loopback,
  // even when browsers use a public TLS URL through a reverse proxy.
  process.env.KARMAX_GATEWAY_URL = internalUrl;
  workerEnvironment.KARMAX_GATEWAY_URL = internalUrl;
  // Config homes are durable and may contain MCP commands written by an older
  // karmax version. Refresh managed entries on every boot so existing accounts
  // receive transport/auth/browser-fill fixes without reconnecting or losing
  // user-defined MCP servers.
  configHomes.refreshManagedMcp(internalUrl);

  const workflowBundle = await bootBundle;
  if (workerManager instanceof WorkerManager) await workerManager.start(workflows.workflowRefs, workflowBundle);
  else await workerManager.start(workflows.workflowRefs);
  console.log('  • Worker started');

  // Process-tree custody (src/agent/custody.ts): reap any agent process scopes
  // a prior incarnation left running after a SIGKILL/crash (systemd-oomd
  // was the July-5 OOM killer — no graceful teardown ran, so its orphaned
  // agents outlived the host). Only records whose owner process is dead are
  // orphans — agents owned by a live concurrent instance (see the duplicate-
  // instance warning above) are left untouched (2026-07-12: a world-rooted
  // dogfooding boot's sweep SIGKILLed prod's in-flight agents, including the
  // very agent that booted it).
  const { reapOrphans } = await import('./agent/custody.js');
  const orphans = reapOrphans();
  if (orphans.reaped) console.log(`  • Reaped ${orphans.reaped} orphaned agent process tree(s) from a prior run`);
  if (orphans.skipped) console.log(`  • Left ${orphans.skipped} agent(s) owned by another live ${BRAND} instance untouched`);
  startupJobs.push(async () => {
    const serviceOrphans = await sweepOrphanedServiceContainers(async (taskId) => (await store.worldState(taskId))).catch(() => 0);
    if (serviceOrphans) console.log(`  • Reaped ${serviceOrphans} orphaned per-world service container(s)`);
  });
  // Codex work profiles hold a turn's secrets; a turn that died with its
  // process left one behind in a home that may never run another turn.
  startupJobs.push(async () => {
    const { sweepWorkProfiles } = await import('./agent/work-environment.js');
    const profiles = sweepWorkProfiles(configHomes);
    if (profiles) console.log(`  • Removed ${profiles} Codex work profile(s) left by ended turns`);
  });
  // A concurrently running dogfooding instance can die after this app has
  // already booted. Sweep periodically so its detached agent/tool descendants
  // do not wait until the next host restart to be reaped.
  const orphanSweep = setInterval(() => {
    const swept = reapOrphans();
    if (swept.reaped) console.log(`  • Reaped ${swept.reaped} newly orphaned agent process tree(s)`);
  }, 10_000);
  orphanSweep.unref();

  // Retention: expired scoped tokens and aged-out GitHub webhook delivery ids grow
  // without bound otherwise. `Store.retentionSweep` existed and was tested but had
  // no caller, so neither table was ever purged on a running install. Hourly, and
  // once at boot so a long-stopped install catches up immediately.
  const sweepRetention = async () => {
    const swept = (await store.retentionSweep());
    if (swept.scopedTokens || swept.githubDeliveries)
      console.log(`  • Purged ${swept.scopedTokens} expired token(s) and ${swept.githubDeliveries} aged webhook delivery id(s)`);
  };
  const retentionTimer = new AsyncInterval(sweepRetention, 3600_000);
  retentionTimer.unref();
  startupJobs.push(() => retentionTimer.run());
  // Reconcile missed notification close events without delaying the first API response.
  const inboxCleanup = new AsyncInterval(() => store.pruneStaleInbox().then(() => undefined), 3600_000);
  inboxCleanup.unref();
  startupJobs.push(() => inboxCleanup.run());

  // Claude sign-ins lapse about four weeks after sign-in and only a person can
  // renew them: warn owners critically three days ahead, and when one lapses.
  const { notifyCredentialAttention } = await import('./agent/credential-health.js');
  const credentialAttentionTimer = new AsyncInterval(() => notifyCredentialAttention({ store, configHomes }), 3600_000);
  credentialAttentionTimer.unref();
  void credentialAttentionTimer.run();

  // Re-derive effective plans from the last signed provider state at boot and
  // throughout the process lifetime. In particular, this closes past-due grace
  // even when Stripe sends no later event.
  const reconcileSubscriptionEntitlements = async () => {
    try { (await subscriptionBilling.reconcileEntitlements()); }
    catch (error) {
      console.warn('  • Subscription entitlement reconciliation failed:',
        error instanceof Error ? error.message : String(error));
    }
  };
  const subscriptionEntitlementTimer = new AsyncInterval(reconcileSubscriptionEntitlements, 60_000);
  subscriptionEntitlementTimer.unref();
  startupJobs.push(() => subscriptionEntitlementTimer.run());

  // Membership hooks submit seat changes immediately; this bounded sweep makes
  // provider quantity reconciliation eventual after an outage or process crash.
  const syncSubscriptionSeats = async () => {
    const organizations = await store.listOrganizations();
    for (let offset = 0; offset < organizations.length; offset += 4) {
      await Promise.all(organizations.slice(offset, offset + 4).map(organization =>
        subscriptionBilling.syncSeats(organization.id).catch(error =>
          console.warn(`  • Subscription seat sync failed for ${organization.id}:`,
            error instanceof Error ? error.message : error))));
    }
  };
  const subscriptionSeatTimer = new AsyncInterval(syncSubscriptionSeats, 5 * 60_000);
  void subscriptionSeatTimer.run();
  subscriptionSeatTimer.unref();

  // Repair coordinator singletons whose history this build can no longer replay.
  // Runs before task reconciliation so a merge queue that self-heals here is
  // already answering by the time tasks waiting on it are examined.
  const { healCoordinators } = await import('./platform/coordinator-health.js');

  // Hosted plan/member writes are synchronous database boundaries, while the
  // organization agent queue is durable Temporal state. Reconcile immediately
  // after each write, at boot, and periodically so queued work recovers without
  // waiting for another admission/release/cancel side effect.
  const entitlementQueues = new EntitlementQueueReconciler({
    store,
    client,
    intervalMs: RECONCILE_INTERVAL_MS,
    log: (message) => console.warn(`  • ${message}`),
  });
  (await entitlementQueues.start());

  // Reconcile the task index against live workflows (settle anything lost on restart).
  const { reconcileTasks } = await import('./platform/reconcile.js');
  startupJobs.push(async () => {
    const health = await healCoordinators(client, TASK_QUEUE)
      .catch(() => ({ checked: 0, wedged: [], rebuilt: [], reported: [] }));
    if (health.rebuilt.length)
      console.log(`  • Rebuilt ${health.rebuilt.length} unreplayable coordinator(s)`);
    for (const { workflowId, reason } of health.reported)
      console.warn(`  ! Coordinator ${workflowId} is wedged; left alone: ${reason}`);

    const recon = await reconcileTasks(store, client).catch(() => ({ checked: 0, settled: 0 }));
    if (recon.settled) console.log(`  • Reconciled ${recon.settled} task(s) lost/finished while offline`);
  });

  // …and keep reconciling while we run. A workflow can die *without* karmax
  // hearing about it — Temporal terminates one that exceeds its history limit,
  // and termination runs no catch block, so the last view the task published
  // stands forever. Reconciling only at boot left such a task rendering as
  // active-and-progressing (and hid the recovery affordance, which requires a
  // failed status) until the next restart, which for a long-lived host is never.
  const reconcileSweep = new AsyncInterval(() => {
    return reconcileTasks(store, client)
      .then((r) => {
        if (r.settled) console.log(`  • Reconciled ${r.settled} task(s) whose workflow ended without publishing`);
      })
      .catch(() => undefined);
  }, RECONCILE_INTERVAL_MS);
  reconcileSweep.unref();

  // Register connected logins into the account/token coordinator (SPEC §6.2).
  // Empty pool ⇒ per-turn leasing stays off (zero behavior change).
  const { makeCoordinatorActivities } = await import('./activities/coordinator.js');
  const coordClient = makeCoordinatorActivities({ client, taskQueue: TASK_QUEUE });
  // Register EVERY credential (logins, ambient, API keys) under its stable policy key
  // so the coordinator can lease/track any of them (SPEC §6.2/§7).
  const { gatherCredentialSources, concurrencyFor } = await import('./platform/credential-sources.js');
  const { enumerateCredentials } = await import('./platform/credentials.js');
  const creds = (await store.listOrganizations()).flatMap((organization) =>
    enumerateCredentials(gatherCredentialSources({ configHomes, broker, organizationId: organization.id })),
  );
  const pool = (await __asyncCollections.map(creds, async (c) => {
    const maxConcurrent = (await concurrencyFor(async (k) => (await store.kvGet(k)), c.key));
    const credentialProvider = c.kind === 'key' ? c.provider : c.modelProvider;
    return {
      id: c.key,
      configHome: c.configHome ?? '',
      provider: c.provider,
      kind: c.kind,
      ...(c.apiKeyHandle ? { apiKeyHandle: c.apiKeyHandle } : {}),
      ...(credentialProvider ? { credentialProvider } : {}),
      ...(maxConcurrent != null ? { maxConcurrent } : {}),
    };
  }));
  if (pool.length) {
    await coordClient.registerAccounts(pool).catch((e) => console.warn('  • credential pool register failed', String(e)));
    console.log(`  • Registered ${pool.length} credential(s) into the account pool`);
  }

  // Reload workflows installed in previous sessions (SPEC §4.2) and roll the
  // worker once so their tasks — new and in-flight — can run after a restart.
  // Trigger dispatcher (SPEC §3.3): starts armed triggered tasks when a
  // dependency prerequisites are met and a schedule/event activates it. Runs
  // in-process off the same bus as the self-heal loop; the store is the durable
  // source of truth, so it re-arms every armed task on boot.
  const { TriggerScheduler, createTriggerFire } = await import('./platform/trigger-scheduler.js');
  const triggerScheduler = new TriggerScheduler({
    store,
    bus,
    fire: createTriggerFire(api, tokens),
    log: (m) => console.log('  • ' + m),
  });
  api.setTriggerArmer(triggerScheduler);
  startupJobs.push(async () => {
    if (!shuttingDown) await triggerScheduler.start();
  });
  worldLifecycle.start();
  delivery.start();

  // Agent-mail poll loop (wiki plans/PLAN-passwords §8): when a PULL provider (IMAP /
  // AgentMail) is connected, karmax reaches OUT to fetch mail — so it works on a
  // locally-hosted install with no public URL. Inert until a pull provider is set.
  const { MailPoller } = await import('./autonomy/mail-pull.js');
  const { AgentMail } = await import('./autonomy/agent-mail.js');
  const readMailboxConfig = async (organizationId: string) => {
    try { return JSON.parse((await store.kvGet(`agent-mail:provider:${organizationId}`)) ?? '{}'); }
    catch { return {}; }
  };
  const mailPoller = new MailPoller({
    store,
    readConfigs: async () => (await __asyncCollections.map((await store.listOrganizations()), async ({ id: organizationId }) => ({
      organizationId,
      config: (await readMailboxConfig(organizationId)),
    }))),
    resolveSecret: (handle) => (broker.hasHandle(handle) ? broker.resolve(handle, { caps: ['use-credential:*'] }) : undefined),
    makeIngest: (organizationId, config) => {
      const domain = config.domain || config.hostedDomain || config.agentmailDomain || config.fixedAddress?.split('@')[1];
      const fixedLocal = config.fixedAddress?.split('@')[0];
      const mail = new AgentMail(store, domain, fixedLocal, config.agentmailAddress);
      return async (msg) => (await mail.ingest(msg, organizationId));
    },
  });
  mailPoller.start();

  // Ensure a default project exists for first-run UX. Seed it with an EMPTY
  // config so branches inherit from global settings (or the repo's real default
  // branch) instead of baking a project-scope "main" override that would shadow
  // a global default like "master".
  if ((await store.listProjects()).length === 0) {
    (await store.createProject('My project'));
  }
  if (installationOwner) {
    for (const project of (await store.listProjects()).filter((candidate) => candidate.organizationId === 'org_personal')) {
      if (!(await store.userIsProjectMember(project.id, installationOwner.id)))
        (await store.setProjectMembership(project.id, { kind: 'user', userId: installationOwner.id }, 'owner'));
    }
  }

  // A successful CI webhook creates a durable CI→Deploy expectation. Polling is
  // intentionally independent of webhook delivery: if GitHub rejects deploy.yml
  // before creating a run, no deployment webhook exists to wake us. One sweep at
  // boot makes crash/restart recovery immediate; the KV expectation and gateway
  // incident claim make every repeat safe.
  const deploymentMonitor = new GitHubDeploymentMonitor(store, githubApp);
  let deploymentSweepRunning = false;
  const reconcileDeployments = async () => {
    if (deploymentSweepRunning) return;
    deploymentSweepRunning = true;
    try {
      for (const finding of await deploymentMonitor.reconcile()) {
        await gateway.dispatchGithubRecoveryEvents(finding.events);
        (await deploymentMonitor.markReported(finding));
      }
    } catch (error) {
      console.warn('  • GitHub deployment monitor failed:', error instanceof Error ? error.message : error);
    } finally {
      deploymentSweepRunning = false;
    }
  };
  const deploymentSweep = new AsyncInterval(reconcileDeployments, RECONCILE_INTERVAL_MS);
  void deploymentSweep.run();
  deploymentSweep.unref();

  console.log(`\n  ✓ ${BRAND} is running:  ${url}\n`);
  if (!(await identity.hasUsers())) console.log('  (first run — create the initial administrator in the browser)');
  startupJobs.push(async () => {
    try {
      if (deployment.hostLocal) {
        const remote = await remoteAccessPlan(port, { hasPassword: !!process.env.KARMAX_PASSWORD || (await identity.hasUsers()) });
        console.log(`\n  ${remote.guidance.replace(/\n/g, '\n  ')}\n`);
      }
    } catch {
      /* ignore */
    }
  });

  let shuttingDown = false;
  let replacementStarted = false;
  const shutdown = async (restart = false, reason = 'shutdown') => {
    if (shuttingDown) return;
    shuttingDown = true;
    startupReady = false;
    console.log(restart ? '\n  merged source changed; restarting…' : '\n  shutting down…');
    const exit = () => {
      releaseWorker();
      instance.release(); // hold exclusive admission through worker shutdown
      if (restart && !replacementStarted) {
        replacementStarted = true;
        try { spawnReplacementProcess(); }
        catch (error) {
          console.error('  ! Could not start the replacement process:', error instanceof Error ? error.message : error);
        }
      }
      process.exit(workerManager.failure ? 1 : 0);
    };
    // Backstop: never let a hung dependency (e.g. a slow worker drain) block exit.
    // Must beat tsx-watch's 5s force-kill: a SIGKILLed worker dies mid-activity,
    // orphaning agent subprocesses (and karmax's own merges trigger tsx reloads).
    setTimeout(exit, 4500).unref();
    // Bound every step so one wedged call can't strand the whole shutdown. The
    // worker itself resolves within ~3s (shutdownGraceTime/shutdownForceTime).
    const step = (p: Promise<unknown>) => withTimeout(Promise.resolve(p), 3500).catch(() => {});
    serverWatch.stop(); // don't respawn Temporal out from under a shutdown
    clearInterval(orphanSweep);
    // Stop admission immediately. Drain alongside the worker so a slow external
    // service cannot consume the worker's shutdown grace period. The existing
    // process-exit backstop bounds shutdown; do not close Store under these jobs.
    const maintenanceDrain = Promise.allSettled([
      startupMaintenance,
      retentionTimer.stop(), inboxCleanup.stop(), credentialAttentionTimer.stop(), subscriptionEntitlementTimer.stop(),
      subscriptionSeatTimer.stop(),
      reconcileSweep.stop(), deploymentSweep.stop(),
      triggerScheduler.stop(), mailPoller.stop(), worldLifecycle.stop(), delivery.stop(),
    ]);
    await step(entitlementQueues.stop());
    await step(closeGateway());
    await step(workerManager.stop());
    await eventRelay?.stop();
    await maintenanceDrain;
    await step(closeClient());
    await step(identity.close());
    (await endRuntimeLifecycle(store, runtime, { stoppedAt: Date.now(), reason, restart }));
    (await store.close());
    if (server) {
      await step(server.stop()); // no-op for the shared server — it persists for a fast restart
      console.log('  (Temporal left running for a fast restart — `npm run reset` stops it)');
    }
    exit();
  };
  process.on('SIGINT', () => { void shutdown(false, 'SIGINT'); });
  process.on('SIGTERM', () => { void shutdown(false, 'SIGTERM'); });

  // `npm start` intentionally has no source watcher. When Karmax merges a task
  // into the very checkout this process loaded, hand off to an identical fresh
  // Node invocation after the task has had time to settle in Temporal. Dev mode
  // already has tsx's watcher and must not spawn a second successor.
  let sourceRestartScheduled = false;
  bus.onAny(async (event) => {
    if (sourceRestartScheduled || process.env.npm_lifecycle_event === 'dev'
      || event.type !== 'view.updated'
      || (event.payload as { status?: string } | undefined)?.status !== 'done') return;
    const landed = await store.hasMergedTaskEvent(event.taskId);
    if (!landed) return; // manual Done and no-merge workflows changed no live source
    const task = (await store.getTask(event.taskId));
    const handle = ((await store.currentWorld(event.taskId)) ?? task?.lastView?.world) as WorldHandle | undefined;
    if (!worldLandedInCheckout(handle, process.cwd())) return;
    sourceRestartScheduled = true;
    console.log(`  • Task ${event.taskId} updated the live checkout; scheduling a graceful restart`);
    setTimeout(() => { void shutdown(true, `live-source-merge:${event.taskId}`); }, 1500).unref();
  });
  // Capture precedes worker startup, but polling follows every subscriber.
  // Durable rows retain events emitted during coordinator/bootstrap recovery.
  if (separateWorker) eventRelay = await ForeignEventRelay.create(store, bus, {
    cursor: relayCursor, onError: error => console.warn('  • Worker event relay failed:', error),
  });
  startupReady = true;
  // Independent maintenance must not gate the console. Limit boot fan-out and
  // drain already-started work before closing its store/client dependencies.
  let nextStartupJob = 0;
  startupMaintenance = Promise.allSettled(Array.from({ length: 2 }, async () => {
    while (!shuttingDown && nextStartupJob < startupJobs.length) {
      const job = startupJobs[nextStartupJob++]!;
      try { await job(); }
      catch (error) { console.warn('  • Startup maintenance failed:', error); }
    }
  }));
}

main().catch((e) => {
  console.error(`${BRAND} failed to start:`, e);
  process.exit(1);
});
