import { WorldReferenceKeys, unreadableReferenceWarning } from '../world/reference-keys.js';
import type { Client } from '@temporalio/client';
import type { Store } from '../store/db.js';
import type { CredentialBroker } from '../autonomy/broker.js';
import type { GitHubAppService } from '../integrations/github-app.js';
import type { KarmaxPaths } from '../config/paths.js';
import type { DeploymentConfig } from '../config/deployment.js';
import type { Provider } from '../domain/types.js';
import { WorldRegistry } from '../world/registry.js';
import { WorktreeProvider } from '../world/worktree.js';
import { buildAdapters } from '../agent/adapters.js';
import { ProfileResolver, seedProfiles } from '../agent/profiles.js';
import { TokenAuthority } from '../platform/tokens.js';
import { WorldProviderConnectionService } from '../world/connections.js';
import { E2BWorldProvider } from '../world/e2b.js';
import { DaytonaWorldProvider } from '../world/daytona.js';
import { LocalObjectStore, S3ObjectStore, managedS3Options } from '../store/objects.js';
import { DeferredDeleteObjectStore, objectDeleteDelayMs } from '../store/deferred-delete.js';
import { StorageLocationService } from '../store/storage-locations.js';
import { WorldCheckpointService } from '../world/checkpoint.js';
import { RunnerPoolService } from '../world/runners.js';
import { WorldAccessService } from '../world/access.js';
import { ObjectSnapshotEngine, ProjectResourceService } from '../world/resources.js';
import { ConfigHomeManager } from '../autonomy/config-homes.js';
import { TASK_QUEUE } from '../temporal/config.js';

/** Shared service construction for the gateway and a supervised activity process.
 * Only the installation bootstrap seeds profiles, imports environment credentials,
 * and creates default storage. A secondary process attaches to existing state.
 * The caller owns Store/client lifecycle; this factory starts no periodic jobs.
 */
export async function createExecutionServices(input: {
  store: Store; client: Client; broker: CredentialBroker; githubApp: GitHubAppService;
  p: KarmaxPaths; deployment: Pick<DeploymentConfig, 'hosted' | 'hostLocal'>;
  provider: Provider; bootstrap?: boolean; coordinationDirectory?: string;
}) {
  const { store, client, broker, githubApp, p, deployment, provider, bootstrap = false, coordinationDirectory } = input;
  const worlds = new WorldRegistry({ coordinationDirectory });
  worlds.register(new WorktreeProvider(p.worlds));
  const adapters = buildAdapters();
  const profiles = new ProfileResolver(store, provider);
  if (bootstrap) await seedProfiles(store, provider);
  const tokens = new TokenAuthority(store);
  const providerConnections = new WorldProviderConnectionService(store, broker);
  if (bootstrap) await providerConnections.importEnvironment();
  const referenceKeys = await WorldReferenceKeys.create(broker, bootstrap);
  worlds.register(new E2BWorldProvider(undefined, undefined, undefined,
    async (organizationId, kind) => (await providerConnections.resolve(organizationId, kind)), undefined, referenceKeys));
  worlds.register(new DaytonaWorldProvider(undefined, undefined, undefined, undefined,
    async (organizationId, kind) => (await providerConnections.resolve(organizationId, kind)), undefined, undefined, referenceKeys));
  if (bootstrap) {
    const unreadable: (string | undefined)[] = [];
    for (const state of ['ready', 'parked', 'hibernated', 'degraded'] as const) {
      for (const { handle } of await store.listWorldInstances(state)) {
        if (!['e2b', 'daytona'].includes(handle.kind)) continue;
        try { await worlds.get(handle.kind).status?.(handle as import('../world/types.js').WorldHandle); }
        catch { unreadable.push(handle.sealedProviderRef); }
      }
    }
    const warning = unreadableReferenceWarning(unreadable);
    if (warning) console.warn(warning);
  }
  // Every consumer of the managed store shares this wrapper, so every delete
  // is delayed alike; the lifecycle sweep purges (src/world/runners.ts).
  const objectStore = new DeferredDeleteObjectStore(process.env.KARMAX_OBJECT_STORE === 's3'
    ? new S3ObjectStore(managedS3Options()) : new LocalObjectStore(p.objects),
  store, { delayMs: objectDeleteDelayMs() });
  // Hosted managed storage follows each organization's plan; this cap is for
  // private installations only.
  const configuredStorageQuota = deployment.hosted ? undefined : process.env.KARMAX_MANAGED_STORAGE_QUOTA_BYTES;
  const managedStorageQuotaBytes = configuredStorageQuota != null && Number(configuredStorageQuota) > 0
    ? Math.floor(Number(configuredStorageQuota)) : undefined;
  const storageLocations = new StorageLocationService(store, objectStore, broker, managedStorageQuotaBytes,
    !deployment.hosted);
  if (bootstrap) for (const organization of (await store.listOrganizations())) (await storageLocations.ensureManaged(organization.id));
  const snapshotEngine = new ObjectSnapshotEngine(objectStore, broker, storageLocations);
  const resources = new ProjectResourceService(store, worlds, snapshotEngine, broker,
    { client, taskQueue: TASK_QUEUE }, storageLocations);
  const checkpoints = new WorldCheckpointService(store, worlds, objectStore, broker, githubApp, resources);
  const runners = new RunnerPoolService(store);
  const worldAccess = new WorldAccessService(store, worlds, runners, resources);
  worlds.setHandleResolver(async (handle) => (await store.currentWorld(handle.id)) as import('../world/types.js').WorldHandle | undefined);
  // Rebuild a world from its last checkpoint ONLY when the provider has genuinely
  // lost the sandbox. Restoring replays just the dirty delta captured at the last
  // park, so doing it after a *transient* control-plane error (a 5xx, a rate limit,
  // a socket timeout) would silently discard everything the agent has done since
  // then. The probe gate is the whole safety property — see the matching gate in
  // activities/core.ts (recoverVanishedWorld). Providers with no probe (the local
  // worktree) return undefined and are therefore never rolled back.
  worlds.setRecoveryHandler(async (handle) => {
    if ((await store.worldState(handle.id)) === 'released') return undefined;
    const checkpoint = (await store.latestWorldCheckpoint(handle.id));
    if (!checkpoint) return undefined;
    const state = await worlds.probe(handle).catch(() => undefined);
    if (state !== 'missing') return undefined; // transient/parked → keep the original error
    (await store.setWorldState(((await store.currentWorld(handle.id)) ?? handle) as import('../world/types.js').WorldHandle, 'degraded'));
    return checkpoints.restore(checkpoint.id, handle.kind);
  });
  const { MockPaymentProvider, VaultCardProvider, StripeIssuingProvider, PaymentRegistry } = await import('../autonomy/payments.js');
  const payments = new MockPaymentProvider(store);
  const paymentRegistry = new PaymentRegistry(store);
  paymentRegistry.register(payments);
  // The universal rail: a card the human already holds, limit enforced by their
  // own issuer. Registered before Stripe Issuing, which needs a business account.
  paymentRegistry.register(new VaultCardProvider(store, broker));
  paymentRegistry.register(new StripeIssuingProvider(store, fetch, process.env, broker));
  const configHomes = new ConfigHomeManager(p.configHomes);
  return { worlds, adapters, profiles, tokens, providerConnections, objectStore, storageLocations,
    resources, checkpoints, runners, worldAccess, payments, paymentRegistry, configHomes };
}
