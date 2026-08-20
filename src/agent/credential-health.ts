import type { Client } from '@temporalio/client';
import type { Store } from '../store/db.js';
import type { ConfigHomeManager } from '../autonomy/config-homes.js';
import type { CredentialBroker } from '../autonomy/broker.js';
import { makeCoordinatorActivities } from '../activities/coordinator.js';
import { enumerateCredentials } from '../platform/credentials.js';
import { gatherCredentialSources } from '../platform/credential-sources.js';
import {
  isUsagePollable,
  probeClaudeUsage,
  probeCodexUsage,
  usageProvesAvailable,
  type UsageResult,
} from './usage.js';

export interface CredentialHealthDeps {
  store: Store;
  client: Client;
  taskQueue: string;
  configHomes?: ConfigHomeManager;
  broker?: CredentialBroker;
}

const usageProbes = new Map<string, Promise<UsageResult>>();

/**
 * Refresh native subscription health and reconcile stale automatic quarantines.
 * The module-level in-flight map makes Dashboard refreshes and task Retry share a
 * single provider process instead of racing duplicate probes for the same login.
 */
export async function refreshCredentialHealth(
  deps: CredentialHealthDeps,
  options: { organizationId?: string; only?: string; provider?: string } = {},
): Promise<Record<string, UsageResult>> {
  const organizationId = options.organizationId ?? 'org_personal';
  const credentials = enumerateCredentials(gatherCredentialSources({
    configHomes: deps.configHomes,
    broker: deps.broker,
    organizationId,
  })).filter((credential) =>
    isUsagePollable(credential)
    && (!options.only || credential.key === options.only)
    && (!options.provider || credential.provider === options.provider));
  const out: Record<string, UsageResult> = {};

  await Promise.all(credentials.map(async (credential) => {
    const probeKey = `${organizationId}:${credential.key}`;
    let probe = usageProbes.get(probeKey);
    if (!probe) {
      const configHome = credential.kind === 'ambient' ? undefined : credential.configHome;
      probe = (credential.provider === 'codex'
        ? probeCodexUsage({ configHome })
        : probeClaudeUsage({ configHome }))
        .then(async (snapshot) => {
          deps.store.kvSet(`usage:${credential.key}`, JSON.stringify(snapshot));
          if (usageProvesAvailable(snapshot)) {
            // Clear only an automatic quarantine. The compare guard runs inside
            // the coordinator, so a racing user disable cannot be overwritten.
            await makeCoordinatorActivities({ client: deps.client, taskQueue: deps.taskQueue })
              .setAccountAvailability({
                accountId: credential.key,
                status: 'available',
                onlyIfStatus: 'needs-attention',
              })
              .catch(() => undefined);
          }
          return snapshot;
        })
        .finally(() => usageProbes.delete(probeKey));
      usageProbes.set(probeKey, probe);
    }
    out[credential.key] = await probe;
  }));
  return out;
}
