import type { Client } from '@temporalio/client';
import type { Store } from '../store/db.js';
import { claudeSignIn, type ConfigHomeManager } from '../autonomy/config-homes.js';
import type { CredentialNotice } from '../domain/types.js';
import type { CredentialBroker } from '../autonomy/broker.js';
import { makeCoordinatorActivities } from '../activities/coordinator.js';
import { enumerateCredentials, resolveCredentials } from '../platform/credentials.js';
import { gatherCredentialSources, readPolicyLayers } from '../platform/credential-sources.js';
import { credentialAliases } from './provider-registry.js';
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

/** Explicit Retry grants another attempt to automatically quarantined credentials.
 * A usage probe cannot be the gate: setup tokens and API keys have no usage API,
 * and an expired access-only probe cannot refresh the login it is checking.
 * Only enabled credentials in this task's policy are eligible. The coordinator's
 * atomic guard preserves manual disables and, unless the person retrying a
 * quota wait asks for it (`includeExhausted`), known quota-reset waits.
 */
export async function retryCredentials(
  deps: CredentialHealthDeps,
  task: { id: string; projectId: string },
  provider: string,
  options: { includeExhausted?: boolean } = {},
): Promise<void> {
  const organizationId = (await deps.store.getProject(task.projectId))?.organizationId ?? 'org_personal';
  const all = enumerateCredentials(gatherCredentialSources({ ...deps, organizationId }));
  const layers = (await readPolicyLayers(async (key) => (await deps.store.kvGet(key)), {
    organizationId, projectId: task.projectId, taskId: task.id,
  }));
  const aliases = credentialAliases(provider);
  const eligible = resolveCredentials(all, layers).filter((credential) =>
    aliases.includes(credential.provider)
    || (credential.provider === 'opencode' && !!credential.modelProvider && aliases.includes(credential.modelProvider)));
  const coordinator = makeCoordinatorActivities(deps);
  const statuses = options.includeExhausted ? ['needs-attention', 'exhausted'] as const : ['needs-attention'] as const;
  for (const credential of eligible) {
    for (const onlyIfStatus of statuses) await coordinator.setAccountAvailability({
      accountId: credential.key, status: 'available', onlyIfStatus,
    });
  }
  // A turn parked because its policy could not be read waits on an allow-list
  // no credential matches: only reading the policy again frees it (WF-35).
  await coordinator.relistAccountLeases();
}

/**
 * Refresh native subscription health and reconcile stale automatic quarantines.
 * The module-level in-flight map coalesces concurrent Dashboard refreshes into
 * one provider process. Explicit task Retry uses retryCredentials instead.
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
          (await deps.store.kvSet(`usage:${credential.key}`, JSON.stringify(snapshot)));
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

/** How early a person is warned that a Claude sign-in will lapse. Claude Code
 * itself starts telling interactive users to `/login` at the same point. */
export const SIGN_IN_WARNING_MS = 3 * 86_400_000;

/** Logins in an organization that only a person can restore. A Claude sign-in
 * lapses about four weeks after it was made regardless of refreshes (its
 * `refreshTokenExpiresAt` never moves), and then Anthropic signs it out. */
export function credentialNotices(configHomes: ConfigHomeManager, organizationId: string, now = Date.now()): CredentialNotice[] {
  return configHomes.list(organizationId).flatMap((login): CredentialNotice[] => {
    if (login.provider !== 'claude' || !login.account) return [];
    const state = claudeSignIn(login.path);
    if (!state) return [];
    const reason = state.signedOut ? 'signed-out' : state.expiresAt - now < SIGN_IN_WARNING_MS ? 'expiring' : undefined;
    if (!reason) return [];
    const credentialKey = organizationId === 'org_personal'
      ? `login:${login.provider}:${login.account}` : `login:${organizationId}:${login.provider}:${login.account}`;
    return [{ kind: 'credential', credentialKey, provider: login.provider, account: login.account, reason, expiresAt: state.expiresAt }];
  });
}

/** Tell every organization's owners, critically, about logins they must sign in
 * to again; withdraw notices that no longer apply. Runs hourly and after logins. */
export async function notifyCredentialAttention(
  deps: { store: Store; configHomes?: ConfigHomeManager },
  now = Date.now(),
  organizationIds?: string[],
): Promise<void> {
  if (!deps.configHomes) return;
  const ids = organizationIds ?? (await deps.store.listOrganizations()).map((organization) => organization.id);
  for (const organizationId of ids) {
    const owners = (await deps.store.listOrganizationMemberships(organizationId))
      .filter((membership) => membership.role === 'owner').map((membership) => membership.userId);
    await deps.store.syncCredentialInbox(organizationId, owners, credentialNotices(deps.configHomes, organizationId, now), now);
  }
}
