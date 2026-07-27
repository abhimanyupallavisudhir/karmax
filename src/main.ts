import path from 'node:path';
import fs from 'node:fs';
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
import { EmailService, type OutboundEmailConfig } from './autonomy/email.js';
import { GitProfiles } from './autonomy/git-profiles.js';
import { KarmaxApi } from './platform/api.js';
import { ContributionRegistry } from './contrib/registry.js';
import { Overlays } from './store/overlays.js';
import { Gateway } from './gateway/server.js';
import { RemoteAccessController, remoteAccessPlan } from './remote/access.js';
import { withTimeout } from './util/timeout.js';
import { registerAppInstance } from './util/instance.js';
import { AuthorizationService } from './platform/authorization.js';
import { IdentityService } from './auth/identity.js';
import { GitHubAppService, GITHUB_APP_PRIVATE_KEY_HANDLE, GITHUB_APP_WEBHOOK_SECRET_HANDLE,
  GITHUB_APP_CLIENT_SECRET_HANDLE } from './integrations/github-app.js';
import { LocalObjectStore, S3ObjectStore } from './store/objects.js';
import { WorldCheckpointService } from './world/checkpoint.js';
import { RunnerPoolService, WorldLifecycleManager } from './world/runners.js';
import { BrowserDeliveryAdapter, DeliveryDispatcher, WebhookDeliveryAdapter } from './collaboration/delivery.js';
import { hydrateSecretFiles, validateDeployment } from './config/deployment.js';
import { WorldProviderConnectionService } from './world/connections.js';
import { E2BWorldProvider } from './world/e2b.js';
import { DaytonaWorldProvider } from './world/daytona.js';
import { WorldHandoffService } from './world/handoff.js';
import { WorldAccessService } from './world/access.js';
import { ObjectSnapshotEngine, ProjectResourceService } from './world/resources.js';
import { sweepOrphanedServiceContainers } from './world/services.js';

const VERSION = '1.0.0';

async function main() {
  hydrateSecretFiles(process.env, (filename) => fs.readFileSync(filename, 'utf8'));
  const deployment = validateDeployment();
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
  });
  const installationOwner = identity.listUsers()[0];
  if (installationOwner) store.claimPersonalOrganization(installationOwner.id, installationOwner.name);
  const worlds = new WorldRegistry();
  worlds.register(new WorktreeProvider(p.worlds));
  const adapters = buildAdapters();
  const profiles = new ProfileResolver(store, provider);
  seedProfiles(store, provider);
  const bus = new KarmaxBus();
  const tokens = new TokenAuthority(store);
  const broker = new CredentialBroker(new Vault(p.vault));
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
  if (process.env.KARMAX_GITHUB_APP_PRIVATE_KEY && !broker.hasHandle(GITHUB_APP_PRIVATE_KEY_HANDLE))
    broker.registerHandle(GITHUB_APP_PRIVATE_KEY_HANDLE, process.env.KARMAX_GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n'));
  if (process.env.KARMAX_GITHUB_WEBHOOK_SECRET && !broker.hasHandle(GITHUB_APP_WEBHOOK_SECRET_HANDLE))
    broker.registerHandle(GITHUB_APP_WEBHOOK_SECRET_HANDLE, process.env.KARMAX_GITHUB_WEBHOOK_SECRET);
  if (process.env.KARMAX_GITHUB_CLIENT_SECRET && !broker.hasHandle(GITHUB_APP_CLIENT_SECRET_HANDLE))
    broker.registerHandle(GITHUB_APP_CLIENT_SECRET_HANDLE, process.env.KARMAX_GITHUB_CLIENT_SECRET);
  // The service is always present. A fresh hosted instance configures it from
  // the browser through GitHub's App Manifest flow; environment values are only
  // an upgrade/enterprise bootstrap path.
  const githubApp = new GitHubAppService(store, broker, { appId: process.env.KARMAX_GITHUB_APP_ID,
    appSlug: process.env.KARMAX_GITHUB_APP_SLUG, clientId: process.env.KARMAX_GITHUB_CLIENT_ID });
  const objectStore = process.env.KARMAX_OBJECT_STORE === 's3'
    ? new S3ObjectStore({
        endpoint: requiredEnv('KARMAX_S3_ENDPOINT'), bucket: requiredEnv('KARMAX_S3_BUCKET'),
        region: process.env.KARMAX_S3_REGION ?? 'us-east-1', accessKeyId: requiredEnv('KARMAX_S3_ACCESS_KEY_ID'),
        secretAccessKey: requiredEnv('KARMAX_S3_SECRET_ACCESS_KEY'), sessionToken: process.env.KARMAX_S3_SESSION_TOKEN,
      })
    : new LocalObjectStore(p.objects);
  const snapshotEngine = new ObjectSnapshotEngine(objectStore, broker);
  const resources = new ProjectResourceService(store, worlds, snapshotEngine, broker, { client, taskQueue: TASK_QUEUE });
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
  worlds.setRecoveryHandler(async (handle) => {
    if (store.worldState(handle.id) === 'released') return undefined;
    const checkpoint = store.latestWorldCheckpoint(handle.id);
    if (!checkpoint) return undefined;
    store.setWorldState((store.currentWorld(handle.id) ?? handle) as import('./world/types.js').WorldHandle, 'degraded');
    return checkpoints.restore(checkpoint.id, handle.kind);
  });
  const { MockPaymentProvider, StripeIssuingProvider, PaymentRegistry } = await import('./autonomy/payments.js');
  const payments = new MockPaymentProvider(store);
  const paymentRegistry = new PaymentRegistry(store);
  paymentRegistry.register(payments);
  paymentRegistry.register(new StripeIssuingProvider(store, fetch, process.env, broker));
  const { ConfigHomeManager } = await import('./autonomy/config-homes.js');
  const { LoginManager } = await import('./autonomy/login.js');
  const configHomes = new ConfigHomeManager();
  const login = new LoginManager(configHomes);
  // Upgrade durable MCP launch/auth configuration before the worker starts
  // polling and can resume an agent. The gateway refresh below replaces this
  // provisional address with the actual bound control-plane URL.
  configHomes.refreshPlatformMcp(
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
  if (orphans.skipped) console.log(`  • Left ${orphans.skipped} agent(s) owned by another live karmax instance untouched`);
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
    worldAccess, githubApp, bus });

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
    const spec = reloadSpecForWorkflowEdit(store.getTask(ev.taskId) ?? {}, 'done');
    if (!spec) return;
    const task = store.getTask(ev.taskId);
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
  const remoteAccess = new RemoteAccessController({
    port: () => gatewayPort,
    hosted: deployment.hosted,
    publicUrl,
  });
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
    remoteAccess,
  });
  const preferred = process.env.KARMAX_PORT ? Number(process.env.KARMAX_PORT) : undefined;
  const { url, internalUrl, port, close: closeGateway } = await gateway.listen(preferred);
  gatewayPort = port;
  // Activities read this lazily when an agent invokes the complete platform API.
  // Keep service-to-service agent/MCP traffic on the control plane's loopback,
  // even when browsers use a public TLS URL through a reverse proxy.
  process.env.KARMAX_GATEWAY_URL = internalUrl;
  // Config homes are durable and may contain an MCP command written by an older
  // karmax version. Refresh only the platform entry on every boot so existing
  // accounts receive transport/auth fixes without reconnecting or losing their
  // browser/user-defined MCP servers.
  configHomes.refreshPlatformMcp(internalUrl);

  console.log(`\n  ✓ karmax is running:  ${url}\n`);
  if (!identity.hasUsers()) console.log('  (first run — create the initial administrator in the browser)');
  try {
    if (!deployment.hosted) {
      const remote = await remoteAccessPlan(port, { hasPassword: true });
      console.log(`\n  ${remote.guidance.replace(/\n/g, '\n  ')}\n`);
    }
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
    clearInterval(orphanSweep);
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
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('karmax failed to start:', e);
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
