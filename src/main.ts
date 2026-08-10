import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ensurePaths, paths } from './config/paths.js';
import { startDevServer, watchDevServer } from './temporal/dev-server.js';
import { makeClient } from './temporal/client.js';
import { WorkerManager } from './temporal/worker-pool.js';
import { TASK_QUEUE } from './temporal/config.js';
import { WorkflowManager, reloadSpecForWorkflowEdit, proposerMayInstall } from './packages/manager.js';
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
import { EmailService, type OutboundEmailConfig } from './autonomy/email.js';
import { GitProfiles, inheritPersonalGithubProfile, userGitScope } from './autonomy/git-profiles.js';
import { KarmaxApi } from './platform/api.js';
import { ContributionRegistry } from './contrib/registry.js';
import { Overlays } from './store/overlays.js';
import { Gateway } from './gateway/server.js';
import { RemoteAccessController, remoteAccessPlan } from './remote/access.js';
import { withTimeout } from './util/timeout.js';
import { duplicateInstanceMessage, registerAppInstance } from './util/instance.js';
import { AuthorizationService } from './platform/authorization.js';
import { IdentityService, type GitHubAuthorization } from './auth/identity.js';
import { GitHubAppService, GITHUB_APP_PRIVATE_KEY_HANDLE, GITHUB_APP_WEBHOOK_SECRET_HANDLE,
  GITHUB_APP_CLIENT_SECRET_HANDLE } from './integrations/github-app.js';
import { LocalObjectStore, S3ObjectStore } from './store/objects.js';
import { StorageLocationService } from './store/storage-locations.js';
import { WorldCheckpointService } from './world/checkpoint.js';
import { RunnerPoolService, WorldLifecycleManager } from './world/runners.js';
import { BrowserDeliveryAdapter, DeliveryDispatcher, WebhookDeliveryAdapter } from './collaboration/delivery.js';
import { hydrateEnvFile, hydrateSecretFiles, validateDeployment } from './config/deployment.js';
import { WorldProviderConnectionService } from './world/connections.js';
import { E2BWorldProvider } from './world/e2b.js';
import { DaytonaWorldProvider } from './world/daytona.js';
import { WorldHandoffService } from './world/handoff.js';
import { WorldAccessService } from './world/access.js';
import { ObjectSnapshotEngine, ProjectResourceService } from './world/resources.js';
import { sweepOrphanedServiceContainers } from './world/services.js';
import { spawnReplacementProcess, worldLandedInCheckout } from './util/live-restart.js';
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
  const p = ensurePaths();
  const { provider, reason } = defaultProvider();

  console.log('\n  krmax ' + VERSION + '  — an AI-era todo list on a durable substrate\n');
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
  const store = new Store(path.join(p.state, 'karmax.db'));
  const authorization = new AuthorizationService(store);
  const broker = new CredentialBroker(new Vault(p.vault));
  if (process.env.KARMAX_GITHUB_APP_PRIVATE_KEY && !broker.hasHandle(GITHUB_APP_PRIVATE_KEY_HANDLE))
    broker.registerHandle(GITHUB_APP_PRIVATE_KEY_HANDLE, process.env.KARMAX_GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n'));
  if (process.env.KARMAX_GITHUB_WEBHOOK_SECRET && !broker.hasHandle(GITHUB_APP_WEBHOOK_SECRET_HANDLE))
    broker.registerHandle(GITHUB_APP_WEBHOOK_SECRET_HANDLE, process.env.KARMAX_GITHUB_WEBHOOK_SECRET);
  if (process.env.KARMAX_GITHUB_CLIENT_SECRET && !broker.hasHandle(GITHUB_APP_CLIENT_SECRET_HANDLE))
    broker.registerHandle(GITHUB_APP_CLIENT_SECRET_HANDLE, process.env.KARMAX_GITHUB_CLIENT_SECRET);
  // One deployment App owns repository installations and user OAuth. Environment
  // values remain an upgrade/enterprise bootstrap path; the normal path is the
  // browser manifest, whose converted client credentials persist in Store/Vault.
  const githubApp = new GitHubAppService(store, broker, { appId: process.env.KARMAX_GITHUB_APP_ID,
    appSlug: process.env.KARMAX_GITHUB_APP_SLUG, clientId: process.env.KARMAX_GITHUB_CLIENT_ID,
    publicApp: deployment.hosted });
  const sharedGithubOauth = githubApp.oauthCredentials();
  // A separately managed OAuth App remains a compatibility fallback only. Once
  // the deployment GitHub App exists, it is the single OAuth client.
  const legacyGithubOauth = process.env.KARMAX_GITHUB_OAUTH_CLIENT_ID?.trim()
    && process.env.KARMAX_GITHUB_OAUTH_CLIENT_SECRET?.trim()
    ? { clientId: process.env.KARMAX_GITHUB_OAUTH_CLIENT_ID.trim(),
        clientSecret: process.env.KARMAX_GITHUB_OAUTH_CLIENT_SECRET.trim() }
    : undefined;
  const publicUrl = process.env.KARMAX_PUBLIC_URL?.trim().replace(/\/$/, '');
  const publicHost = (() => { try { return publicUrl ? new URL(publicUrl).hostname : undefined; } catch { return undefined; } })();
  const configuredAuthHosts = [
    ...(process.env.KARMAX_AUTH_HOSTS ?? '127.0.0.1,localhost,*.ts.net').split(',').map((x) => x.trim()).filter(Boolean),
    ...(publicHost ? [publicHost] : []),
  ];
  // Better Auth matches the request's Host header WITH its port against each
  // allowedHosts pattern, so a bare host (`localhost`) never matches a dev server
  // on a non-standard port (`localhost:4506`) — it silently fell back to the
  // hardcoded fallback URL, which made verification/reset links point at the
  // wrong port and made the password-reset origin check reject the redirect. Add
  // a scheme-qualified port-wildcard per host: Better Auth trusts those origins
  // verbatim AND (after stripping the scheme) matches them for base-URL
  // resolution, so links and origin checks track whatever host:port the user is
  // actually on. Loopback hosts get http; everything else https.
  const isLoopbackHost = (h: string) => /^(localhost|127\.|\[?::1\]?)/.test(h) || h.endsWith('.localhost');
  const authHosts = [...new Set([
    ...configuredAuthHosts,
    ...configuredAuthHosts
      .filter((h) => !h.includes('://') && !/:\d/.test(h))
      .map((h) => `${isLoopbackHost(h) ? 'http' : 'https'}://${h}:*`),
  ])];
  const identity = await IdentityService.open(path.join(p.state, 'auth.db'), {
    secret: process.env.KARMAX_AUTH_SECRET,
    baseURL: {
      allowedHosts: authHosts,
      fallback: publicUrl ?? `http://127.0.0.1:${process.env.KARMAX_PORT ?? 4505}`,
    },
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
        new GitProfiles(store, broker, p.state, userGitScope(authorization.userId)).saveGithubIdentity(githubIdentity);
        inheritPersonalGithubProfile(store, broker, authorization.userId);
      } } } : legacyGithubOauth ? { github: legacyGithubOauth } : {}),
  });
  identity.connectOrganizationNames(() => store.organizationNameReservations());
  store.connectUserNames(() => identity.listUsers());
  const installationOwner = identity.listUsers()[0];
  if (installationOwner) store.claimPersonalOrganization(installationOwner.id, installationOwner.name);
  store.migratePersonalOrganizationNames(identity.listUsers());
  const worlds = new WorldRegistry();
  worlds.register(new WorktreeProvider(p.worlds));
  const adapters = buildAdapters();
  const profiles = new ProfileResolver(store, provider);
  seedProfiles(store, provider);
  const bus = new KarmaxBus();
  const tokens = new TokenAuthority(store);
  // Installation-wide outbound email (account confirmation, password reset, org
  // invites). Reads its live config + vaulted secret on each send, so connecting
  // a provider in Settings takes effect without a restart. Handed to identity so
  // Better Auth's reset/verify hooks can send.
  const emailConfig = (): OutboundEmailConfig => {
    try { return JSON.parse(store.kvGet('email:outbound') ?? '{}'); } catch { return {}; }
  };
  const emailService = new EmailService(emailConfig,
    (handle) => (broker.hasHandle(handle) ? broker.resolve(handle, { caps: ['use-credential:*'] }) : undefined));
  identity.mailer = emailService;
  const providerConnections = new WorldProviderConnectionService(store, broker);
  providerConnections.importEnvironment();
  worlds.register(new E2BWorldProvider(undefined, undefined, undefined,
    (organizationId, kind) => providerConnections.resolve(organizationId, kind)));
  worlds.register(new DaytonaWorldProvider(undefined, undefined, undefined, undefined,
    (organizationId, kind) => providerConnections.resolve(organizationId, kind)));
  const objectStore = process.env.KARMAX_OBJECT_STORE === 's3'
    ? new S3ObjectStore({
        endpoint: requiredEnv('KARMAX_S3_ENDPOINT'), bucket: requiredEnv('KARMAX_S3_BUCKET'),
        region: process.env.KARMAX_S3_REGION ?? 'us-east-1', accessKeyId: requiredEnv('KARMAX_S3_ACCESS_KEY_ID'),
        secretAccessKey: requiredEnv('KARMAX_S3_SECRET_ACCESS_KEY'), sessionToken: process.env.KARMAX_S3_SESSION_TOKEN,
      })
    : new LocalObjectStore(p.objects);
  const configuredStorageQuota = process.env.KARMAX_MANAGED_STORAGE_QUOTA_BYTES;
  const managedStorageQuotaBytes = configuredStorageQuota == null
    ? (deployment.hosted ? 5 * 1024 * 1024 * 1024 : undefined)
    : Number(configuredStorageQuota) > 0 ? Math.floor(Number(configuredStorageQuota)) : undefined;
  const storageLocations = new StorageLocationService(store, objectStore, broker, managedStorageQuotaBytes,
    !deployment.hosted);
  for (const organization of store.listOrganizations()) storageLocations.ensureManaged(organization.id);
  const snapshotEngine = new ObjectSnapshotEngine(objectStore, broker, storageLocations);
  const resources = new ProjectResourceService(store, worlds, snapshotEngine, broker,
    { client, taskQueue: TASK_QUEUE }, storageLocations);
  const checkpoints = new WorldCheckpointService(store, worlds, objectStore, broker, githubApp, resources);
  const runners = new RunnerPoolService(store);
  const worldAccess = new WorldAccessService(store, worlds, runners, resources);
  const handoffs = new WorldHandoffService(store, worlds, githubApp, runners, worldAccess, p.localCheckouts, resources);
  const worldLifecycle = new WorldLifecycleManager(store, worlds, checkpoints, 60_000, objectStore, runners, worldAccess);
  const delivery = new DeliveryDispatcher(store, {
    browser: new BrowserDeliveryAdapter(),
    ...(process.env.KARMAX_EMAIL_DELIVERY_URL ? { email: new WebhookDeliveryAdapter(process.env.KARMAX_EMAIL_DELIVERY_URL, 'email') } : {}),
    ...(process.env.KARMAX_SLACK_DELIVERY_URL ? { slack: new WebhookDeliveryAdapter(process.env.KARMAX_SLACK_DELIVERY_URL, 'slack') } : {}),
  }, (id) => {
    const user = identity.listUsers().find((candidate) => candidate.id === id);
    return user ? { id: user.id, name: user.name, email: user.email } : undefined;
  });
  worlds.setHandleResolver((handle) => store.currentWorld(handle.id) as import('./world/types.js').WorldHandle | undefined);
  // Rebuild a world from its last checkpoint ONLY when the provider has genuinely
  // lost the sandbox. Restoring replays just the dirty delta captured at the last
  // park, so doing it after a *transient* control-plane error (a 5xx, a rate limit,
  // a socket timeout) would silently discard everything the agent has done since
  // then. The probe gate is the whole safety property — see the matching gate in
  // activities/core.ts (recoverVanishedWorld). Providers with no probe (the local
  // worktree) return undefined and are therefore never rolled back.
  worlds.setRecoveryHandler(async (handle) => {
    if (store.worldState(handle.id) === 'released') return undefined;
    const checkpoint = store.latestWorldCheckpoint(handle.id);
    if (!checkpoint) return undefined;
    const state = await worlds.probe(handle).catch(() => undefined);
    if (state !== 'missing') return undefined; // transient/parked → keep the original error
    store.setWorldState((store.currentWorld(handle.id) ?? handle) as import('./world/types.js').WorldHandle, 'degraded');
    return checkpoints.restore(checkpoint.id, handle.kind);
  });
  const { MockPaymentProvider, VaultCardProvider, StripeIssuingProvider, PaymentRegistry } = await import('./autonomy/payments.js');
  const payments = new MockPaymentProvider(store);
  const paymentRegistry = new PaymentRegistry(store);
  paymentRegistry.register(payments);
  // The universal rail: a card the human already holds, limit enforced by their
  // own issuer. Registered before Stripe Issuing, which needs a business account.
  paymentRegistry.register(new VaultCardProvider(store, broker));
  paymentRegistry.register(new StripeIssuingProvider(store, fetch, process.env, broker));
  const { ConfigHomeManager } = await import('./autonomy/config-homes.js');
  const { LoginManager } = await import('./autonomy/login.js');
  const configHomes = new ConfigHomeManager();
  const login = new LoginManager(configHomes);
  // Upgrade durable MCP launch/auth configuration before the worker starts
  // polling and can resume an agent. The gateway refresh below replaces this
  // provisional address with the actual bound control-plane URL.
  configHomes.refreshManagedMcp(
    process.env.KARMAX_GATEWAY_URL ?? `http://127.0.0.1:${process.env.KARMAX_PORT ?? 4505}`,
  );

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
    githubApp,
    checkpoints,
    runners,
    payments,
    paymentRegistry,
    configHomes,
    resources,
    contentDir: p.content,
    taskQueue: TASK_QUEUE,
  });
  await workerManager.start();
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
  if (orphans.skipped) console.log(`  • Left ${orphans.skipped} agent(s) owned by another live krmax instance untouched`);
  const serviceOrphans = await sweepOrphanedServiceContainers((taskId) => store.worldState(taskId)).catch(() => 0);
  if (serviceOrphans) console.log(`  • Reaped ${serviceOrphans} orphaned per-world service container(s)`);
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
  const sweepRetention = () => {
    const swept = store.retentionSweep();
    if (swept.scopedTokens || swept.githubDeliveries)
      console.log(`  • Purged ${swept.scopedTokens} expired token(s) and ${swept.githubDeliveries} aged webhook delivery id(s)`);
  };
  sweepRetention();
  const retentionTimer = setInterval(sweepRetention, 3600_000);
  retentionTimer.unref();

  // Repair coordinator singletons whose history this build can no longer replay.
  // Runs before task reconciliation so a merge queue that self-heals here is
  // already answering by the time tasks waiting on it are examined.
  const { healCoordinators } = await import('./platform/coordinator-health.js');
  const health = await healCoordinators(client, TASK_QUEUE)
    .catch(() => ({ checked: 0, wedged: [], rebuilt: [], reported: [] }));
  if (health.rebuilt.length)
    console.log(`  • Rebuilt ${health.rebuilt.length} unreplayable coordinator(s)`);
  for (const { workflowId, reason } of health.reported)
    console.warn(`  ! Coordinator ${workflowId} is wedged; left alone: ${reason}`);

  // Reconcile the task index against live workflows (settle anything lost on restart).
  const { reconcileTasks } = await import('./platform/reconcile.js');
  const recon = await reconcileTasks(store, client).catch(() => ({ checked: 0, settled: 0 }));
  if (recon.settled) console.log(`  • Reconciled ${recon.settled} task(s) lost/finished while offline`);

  // …and keep reconciling while we run. A workflow can die *without* karmax
  // hearing about it — Temporal terminates one that exceeds its history limit,
  // and termination runs no catch block, so the last view the task published
  // stands forever. Reconciling only at boot left such a task rendering as
  // active-and-progressing (and hid the recovery affordance, which requires a
  // failed status) until the next restart, which for a long-lived host is never.
  const reconcileSweep = setInterval(() => {
    void reconcileTasks(store, client)
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
  const creds = store.listOrganizations().flatMap((organization) =>
    enumerateCredentials(gatherCredentialSources({ configHomes, broker, organizationId: organization.id })),
  );
  const pool = creds.map((c) => {
    const maxConcurrent = concurrencyFor((k) => store.kvGet(k), c.key);
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
  });
  if (pool.length) {
    await coordClient.registerAccounts(pool).catch((e) => console.warn('  • credential pool register failed', String(e)));
    console.log(`  • Registered ${pool.length} credential(s) into the account pool`);
  }

  const workflows = new WorkflowManager(
    workerManager,
    new WorkflowRepoLoader(p.workflows),
    undefined,
    p.workflows,
    (organizationId) => {
      const profiles = new GitProfiles(store, broker, p.state, organizationId);
      const profile = profiles.resolve(undefined);
      return profile ? profiles.env(profile, {}) : {};
    },
  );
  // Reload workflows installed in previous sessions (SPEC §4.2) and roll the
  // worker once so their tasks — new and in-flight — can run after a restart.
  const restored = await workflows.restore((m) => console.warn('  •', m)).catch(() => 0);
  if (restored) console.log(`  • Restored ${restored} installed workflow(s)`);
  const api = new KarmaxApi({ store, client, taskQueue: TASK_QUEUE, tokens, contentDir: p.content, workflows,
    authorization, defaultAgentProvider: provider, hosted: deployment.hosted, providerConnections, worlds,
    worldAccess, resources, broker, githubApp, bus });

  // Trigger dispatcher (SPEC §3.3): starts armed triggered tasks when a
  // dependency prerequisites are met and a schedule/event activates it. Runs
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
  worldLifecycle.start();
  delivery.start();

  // Agent-mail poll loop (PLAN-passwords.md §8): when a PULL provider (IMAP /
  // AgentMail) is connected, karmax reaches OUT to fetch mail — so it works on a
  // locally-hosted install with no public URL. Inert until a pull provider is set.
  const { MailPoller } = await import('./autonomy/mail-pull.js');
  const { AgentMail } = await import('./autonomy/agent-mail.js');
  const readMailboxConfig = (organizationId: string) => {
    try { return JSON.parse(store.kvGet(`agent-mail:provider:${organizationId}`) ?? '{}'); }
    catch { return {}; }
  };
  const mailPoller = new MailPoller({
    store,
    readConfigs: () => store.listOrganizations().map(({ id: organizationId }) => ({
      organizationId,
      config: readMailboxConfig(organizationId),
    })),
    resolveSecret: (handle) => (broker.hasHandle(handle) ? broker.resolve(handle, { caps: ['use-credential:*'] }) : undefined),
    makeIngest: (_organizationId, config) => {
      const domain = config.domain || config.hostedDomain || config.agentmailDomain || config.fixedAddress?.split('@')[1];
      const fixedLocal = config.fixedAddress?.split('@')[0];
      const mail = new AgentMail(store, domain, fixedLocal, config.agentmailAddress);
      return (msg) => mail.ingest(msg);
    },
  });
  mailPoller.start();

  // Self-healing loop (SPEC §4.4): when a workflow-edit PR merges (its merge-only
  // task reaches done), reload the edited workflow from its repo so new tasks pick
  // up the published version. Runs in this process (not inside a workflow), so
  // rolling the worker is safe; deduped per task. A merge that forgot to bump the
  // version fails the reload loudly (version-bump guard) rather than swapping code.
  const healed = new Set<string>();
  bus.onAny((ev) => {
    if (ev.type !== 'view.updated' || (ev.payload as { status?: string })?.status !== 'done' || healed.has(ev.taskId)) return;
    const task = store.getTask(ev.taskId);
    const spec = reloadSpecForWorkflowEdit(task ?? {}, 'done');
    if (!spec) {
      // Distinguish "not a workflow edit" (the common case, silent) from
      // "was one, but the proposer may not install" — see proposerMayInstall.
      if ((task?.params as { workflowEdit?: unknown } | undefined)?.workflowEdit && !proposerMayInstall(task ?? {})) {
        healed.add(ev.taskId);
        console.warn(`  • Workflow reload after edit skipped: the proposer of task ${ev.taskId} lacks workflow:install`);
      }
      return;
    }
    const organizationId = task ? store.getProject(task.projectId)?.organizationId : undefined;
    healed.add(ev.taskId);
    workflows
      .install(spec, organizationId ?? 'org_personal')
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
    store.createProject('My project');
  }
  if (installationOwner) {
    for (const project of store.listProjects().filter((candidate) => candidate.organizationId === 'org_personal')) {
      if (!store.userIsProjectMember(project.id, installationOwner.id))
        store.setProjectMembership(project.id, { kind: 'user', userId: installationOwner.id }, 'owner');
    }
  }

  const staticDir = fileURLToPath(new URL('../web', import.meta.url));
  let gatewayPort = process.env.KARMAX_PORT ? Number(process.env.KARMAX_PORT) : 4505;
  const remoteAccess = new RemoteAccessController({ port: () => gatewayPort });
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
  });
  const preferred = process.env.KARMAX_PORT ? Number(process.env.KARMAX_PORT) : undefined;
  const { url, internalUrl, port, close: closeGateway } = await gateway.listen(preferred);
  gatewayPort = port;
  // Activities read this lazily when an agent invokes the complete platform API.
  // Keep service-to-service agent/MCP traffic on the control plane's loopback,
  // even when browsers use a public TLS URL through a reverse proxy.
  process.env.KARMAX_GATEWAY_URL = internalUrl;
  // Config homes are durable and may contain MCP commands written by an older
  // karmax version. Refresh managed entries on every boot so existing accounts
  // receive transport/auth/browser-fill fixes without reconnecting or losing
  // user-defined MCP servers.
  configHomes.refreshManagedMcp(internalUrl);

  console.log(`\n  ✓ krmax is running:  ${url}\n`);
  if (!identity.hasUsers()) console.log('  (first run — create the initial administrator in the browser)');
  try {
    if (deployment.hostLocal) {
      const remote = await remoteAccessPlan(port, { hasPassword: true });
      console.log(`\n  ${remote.guidance.replace(/\n/g, '\n  ')}\n`);
    }
  } catch {
    /* ignore */
  }

  let shuttingDown = false;
  let replacementStarted = false;
  const shutdown = async (restart = false) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(restart ? '\n  merged source changed; restarting…' : '\n  shutting down…');
    const exit = () => {
      if (restart && !replacementStarted) {
        replacementStarted = true;
        try { spawnReplacementProcess(); }
        catch (error) {
          console.error('  ! Could not start the replacement process:', error instanceof Error ? error.message : error);
        }
      }
      process.exit(0);
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
    clearInterval(reconcileSweep);
    instance.release(); // drop our live-instance pidfile
    triggerScheduler.stop();
    mailPoller.stop();
    worldLifecycle.stop();
    delivery.stop();
    await step(closeGateway());
    await step(workerManager.stop());
    await step(closeClient());
    if (server) {
      await step(server.stop()); // no-op for the shared server — it persists for a fast restart
      console.log('  (Temporal left running for a fast restart — `npm run reset` stops it)');
    }
    exit();
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });

  // `npm start` intentionally has no source watcher. When Karmax merges a task
  // into the very checkout this process loaded, hand off to an identical fresh
  // Node invocation after the task has had time to settle in Temporal. Dev mode
  // already has tsx's watcher and must not spawn a second successor.
  let sourceRestartScheduled = false;
  bus.onAny((event) => {
    if (sourceRestartScheduled || process.env.npm_lifecycle_event === 'dev'
      || event.type !== 'view.updated'
      || (event.payload as { status?: string } | undefined)?.status !== 'done') return;
    const landed = store.eventsSince(event.taskId, 0).some((candidate) => candidate.type === 'merge.result'
      && (candidate.payload as { merged?: boolean } | undefined)?.merged === true);
    if (!landed) return; // manual Done and no-merge workflows changed no live source
    const task = store.getTask(event.taskId);
    const handle = (store.currentWorld(event.taskId) ?? task?.lastView?.world) as WorldHandle | undefined;
    if (!worldLandedInCheckout(handle, process.cwd())) return;
    sourceRestartScheduled = true;
    console.log(`  • Task ${event.taskId} updated the live checkout; scheduling a graceful restart`);
    setTimeout(() => { void shutdown(true); }, 1500).unref();
  });
}

main().catch((e) => {
  console.error('krmax failed to start:', e);
  process.exit(1);
});

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function temporalConnectionFromEnv(): import('./temporal/config.js').TemporalConn | undefined {
  const address = process.env.KARMAX_TEMPORAL_ADDRESS?.trim();
  if (!address) return undefined;
  const read = (name: string) => process.env[name]?.trim() ? fs.readFileSync(process.env[name]!.trim()) : undefined;
  const ca = read('KARMAX_TEMPORAL_TLS_CA');
  const crt = read('KARMAX_TEMPORAL_TLS_CERT');
  const key = read('KARMAX_TEMPORAL_TLS_KEY');
  if (Boolean(crt) !== Boolean(key)) throw new Error('KARMAX_TEMPORAL_TLS_CERT and KARMAX_TEMPORAL_TLS_KEY must be set together');
  const tls = ca || crt || process.env.KARMAX_TEMPORAL_TLS_SERVER_NAME
    ? { ...(ca ? { serverRootCACertificate: ca } : {}), ...(crt && key ? { clientCertPair: { crt, key } } : {}),
        ...(process.env.KARMAX_TEMPORAL_TLS_SERVER_NAME ? { serverNameOverride: process.env.KARMAX_TEMPORAL_TLS_SERVER_NAME } : {}) }
    : process.env.KARMAX_TEMPORAL_API_KEY ? {} : undefined;
  return { address, namespace: process.env.KARMAX_TEMPORAL_NAMESPACE?.trim() || 'default',
    ...(process.env.KARMAX_TEMPORAL_API_KEY ? { apiKey: process.env.KARMAX_TEMPORAL_API_KEY } : {}), ...(tls ? { tls } : {}) };
}
