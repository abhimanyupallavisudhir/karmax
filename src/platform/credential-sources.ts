import { ClaudeAdapter } from '../agent/claude.js';
import { CodexAdapter } from '../agent/codex.js';
import { apiKeyEnv, hasAcpAmbientLogin, LOGIN_PROVIDERS, MODEL_PROVIDERS } from '../agent/provider-registry.js';
import type { ConfigHomeManager } from '../autonomy/config-homes.js';
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
export function gatherCredentialSources(deps: { configHomes?: ConfigHomeManager; broker?: CredentialBroker }): CredentialSources {
  const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  return {
    logins: deps.configHomes?.list() ?? [],
    ambient: {
      claude: ClaudeAdapter.hasAmbientLogin(),
      codex: CodexAdapter.hasAmbientSubscription(),
      opencode: hasAcpAmbientLogin('opencode'),
    },
    ambientHomes: { claude: claudeHome, codex: codexHome },
    envKeys: {
      // Keep the historical harness namespaces for existing policies/profiles,
      // and expose model-provider namespaces for model-agnostic harnesses.
      claude: !!process.env.ANTHROPIC_API_KEY,
      codex: !!process.env.OPENAI_API_KEY,
      ...Object.fromEntries(
        MODEL_PROVIDERS
          .filter((provider) => provider !== 'anthropic' && provider !== 'openai')
          .map((provider) => [provider, !!process.env[apiKeyEnv(provider)]]),
      ),
    },
    handles: agentAccountHandles(deps.broker?.listHandles() ?? []),
  };
}

/** The vault also contains infrastructure secrets (checkpoint encryption,
 * provider keys, GitHub App keys). Only model-provider account handles belong
 * in agent account selection. */
export function agentAccountHandles(handles: string[]): string[] {
  const providers = new Set<string>([...LOGIN_PROVIDERS, ...MODEL_PROVIDERS, 'grok']);
  return handles.filter((handle) => {
    const [provider, account, extra] = handle.split(':');
    return !!provider && !!account && !extra && providers.has(provider);
  });
}

// ── credential-policy persistence (kv, overlay-resolved global→project→task) ──
export const credPolicyKey = {
  global: () => 'credpolicy:global',
  project: (id: string) => `credpolicy:project:${id}`,
  task: (id: string) => `credpolicy:task:${id}`,
};

/** kv key for a credential's user-set concurrency cap (how many turns may run on it at
 *  once). */
export const concurrencyKey = (credKey: string) => `concurrency:${credKey}`;

/** The user-set concurrency cap for a credential, or undefined to use the coordinator's
 *  default. A stored value of `UNLIMITED_CONCURRENCY` means unbounded. */
export function concurrencyFor(get: (k: string) => string | undefined, credKey: string): number | undefined {
  const n = Number(get(concurrencyKey(credKey)));
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

/** Read the resolved policy layers for a task from a kv getter. */
export function readPolicyLayers(
  get: (k: string) => string | undefined,
  scope: { projectId?: string; taskId?: string },
): { global?: CredPolicy; project?: CredPolicy; task?: CredPolicy } {
  return {
    global: parsePolicy(get(credPolicyKey.global())),
    project: scope.projectId ? parsePolicy(get(credPolicyKey.project(scope.projectId))) : undefined,
    task: scope.taskId ? parsePolicy(get(credPolicyKey.task(scope.taskId))) : undefined,
  };
}
