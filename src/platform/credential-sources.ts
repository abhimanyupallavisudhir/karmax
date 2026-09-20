import { ClaudeAdapter } from '../agent/claude.js';
import { CodexAdapter } from '../agent/codex.js';
import { apiKeyEnv, hasAcpAmbientLogin, LOGIN_PROVIDERS, MODEL_PROVIDERS } from '../agent/provider-registry.js';
import { openCodeAuthProvider, type ConfigHomeManager } from '../autonomy/config-homes.js';
import { deploymentConfig } from '../config/deployment.js';
import type { CredentialBroker } from '../autonomy/broker.js';
import type { CredentialSources, CredPolicy } from './credentials.js';
import os from 'node:os';
import path from 'node:path';

/**
 * Gather the live credential sources (config-home logins, ambient logins, env keys,
 * broker handles) for {@link enumerateCredentials}. Impure (reads fs/env), so it
 * lives outside the pure credentials module; used by both the gateway (listing) and
 * the core activity (resolution).
 */
export function gatherCredentialSources(deps: {
  configHomes?: ConfigHomeManager;
  broker?: CredentialBroker;
  organizationId?: string;
}): CredentialSources {
  const organizationId = deps.organizationId ?? 'org_personal';
  // The operator's own machine credentials — the `claude login` in karmax's config
  // home, the API keys in its environment. `org_personal` is bootstrapped into every
  // install and is the fallback organization id throughout the store, so membership
  // alone must not be what stands between a tenant and them: a managed cell has many
  // tenants and one control plane, and its environment belongs to the platform, not
  // to whoever is browsing. A self-host stays as it was — there the operator IS the
  // user, and running on the box's own login is the point.
  const hostCredentials = !deploymentConfig().hosted && organizationId === 'org_personal';
  const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const openCodeDataHome = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
  return {
    organizationId,
    logins: deps.configHomes?.list(organizationId) ?? [],
    ambient: {
      claude: hostCredentials && ClaudeAdapter.hasAmbientLogin(),
      codex: hostCredentials && CodexAdapter.hasAmbientSubscription(),
      opencode: hostCredentials && hasAcpAmbientLogin('opencode'),
    },
    ambientHomes: { claude: claudeHome, codex: codexHome },
    ambientModelProviders: {
      opencode: openCodeAuthProvider(path.join(openCodeDataHome, 'opencode', 'auth.json')),
    },
    envKeys: {
      // Keep the historical harness namespaces for existing policies/profiles,
      // and expose model-provider namespaces for model-agnostic harnesses.
      claude: hostCredentials && !!process.env.ANTHROPIC_API_KEY,
      codex: hostCredentials && !!process.env.OPENAI_API_KEY,
      ...Object.fromEntries(
        MODEL_PROVIDERS
          .filter((provider) => provider !== 'anthropic' && provider !== 'openai')
          .map((provider) => [provider, hostCredentials && !!process.env[apiKeyEnv(provider)]]),
      ),
    },
    handles: agentAccountHandles(deps.broker?.listHandles() ?? [], organizationId),
  };
}

/** The vault also contains infrastructure secrets (checkpoint encryption,
 * provider keys, GitHub App keys). Only model-provider account handles belong
 * in agent account selection. */
export function agentAccountHandles(handles: string[], organizationId = 'org_personal'): string[] {
  const providers = new Set<string>([...LOGIN_PROVIDERS, ...MODEL_PROVIDERS, 'grok']);
  return handles.filter((handle) => {
    const [provider, scopeOrAccount, account, extra] = handle.split(':');
    if (!provider || !scopeOrAccount || !providers.has(provider) || extra) return false;
    if (organizationId === 'org_personal') {
      // Flat handles are legacy personal resources; newly-written personal
      // handles may also carry the explicit org id.
      return !account || (scopeOrAccount === organizationId && !!account);
    }
    return scopeOrAccount === organizationId && !!account;
  });
}

// ── credential-policy persistence (kv, overlay-resolved global→project→task) ──
export const credPolicyKey = {
  organization: (id: string) => `credpolicy:organization:${id}`,
  /** Historical personal-organization policy key. */
  global: () => 'credpolicy:global',
  project: (id: string) => `credpolicy:project:${id}`,
  task: (id: string) => `credpolicy:task:${id}`,
};

/** kv key for a credential's user-set concurrency cap (how many turns may run on it at
 *  once). */
export const concurrencyKey = (credKey: string) => `concurrency:${credKey}`;

/** The user-set concurrency cap for a credential, or undefined to use the coordinator's
 *  default. A stored value of `UNLIMITED_CONCURRENCY` means unbounded. */
export async function concurrencyFor(get: (k: string) => string | undefined | Promise<string | undefined>, credKey: string): Promise<number | undefined> {
  const n = Number((await get(concurrencyKey(credKey))));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Parse a stored policy blob (kv), or undefined. */
export function parsePolicy(raw: string | undefined): CredPolicy | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as CredPolicy;
  } catch {
    return undefined;
  }
}

/** Rename or remove a credential id without leaving stale policy entries behind.
 * Lists are deduplicated because a renamed key may already be present. */
export function remapCredentialPolicy(
  policy: CredPolicy,
  from: string,
  to?: string,
): CredPolicy {
  const remap = (values: string[] | undefined) => {
    if (!Array.isArray(values)) return undefined;
    return [...new Set(values.flatMap((value) => typeof value !== 'string' ? [] : value === from ? (to ? [to] : []) : [value]))];
  };
  return {
    ...policy,
    ...(policy.order ? { order: remap(policy.order) } : {}),
    ...(policy.on ? { on: remap(policy.on) } : {}),
    ...(policy.off ? { off: remap(policy.off) } : {}),
    ...(policy.explainerOnly ? { explainerOnly: remap(policy.explainerOnly) } : {}),
  };
}

/** Read the resolved policy layers for a task from a kv getter. */
export async function readPolicyLayers(
  get: (k: string) => string | undefined | Promise<string | undefined>,
  scope: { organizationId?: string; projectId?: string; taskId?: string },
): Promise<{ global?: CredPolicy; project?: CredPolicy; task?: CredPolicy }> {
  const organizationId = scope.organizationId ?? 'org_personal';
  return {
    global: parsePolicy((await get(credPolicyKey.organization(organizationId))))
      ?? (organizationId === 'org_personal' ? parsePolicy((await get(credPolicyKey.global()))) : undefined),
    project: scope.projectId ? parsePolicy((await get(credPolicyKey.project(scope.projectId)))) : undefined,
    task: scope.taskId ? parsePolicy((await get(credPolicyKey.task(scope.taskId)))) : undefined,
  };
}
