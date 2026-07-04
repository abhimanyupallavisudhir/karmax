import { ClaudeAdapter } from '../agent/claude.js';
import { CodexAdapter } from '../agent/codex.js';
import type { ConfigHomeManager } from '../autonomy/config-homes.js';
import type { CredentialBroker } from '../autonomy/broker.js';
import type { CredentialSources, CredPolicy } from './credentials.js';

/**
 * Gather the live credential sources (config-home logins, ambient logins, env keys,
 * broker handles) for {@link enumerateCredentials}. Impure (reads fs/env), so it
 * lives outside the pure credentials module; used by both the gateway (listing) and
 * the core activity (resolution).
 */
export function gatherCredentialSources(deps: { configHomes?: ConfigHomeManager; broker?: CredentialBroker }): CredentialSources {
  return {
    logins: deps.configHomes?.list() ?? [],
    ambient: { claude: ClaudeAdapter.hasAmbientLogin(), codex: CodexAdapter.hasAmbientSubscription() },
    envKeys: { claude: !!process.env.ANTHROPIC_API_KEY, codex: !!process.env.OPENAI_API_KEY },
    handles: deps.broker?.listHandles() ?? [],
  };
}

// ── credential-policy persistence (kv, overlay-resolved global→project→task) ──
export const credPolicyKey = {
  global: () => 'credpolicy:global',
  project: (id: string) => `credpolicy:project:${id}`,
  task: (id: string) => `credpolicy:task:${id}`,
};

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
