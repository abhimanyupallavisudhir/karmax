import type { CredentialBroker } from '../autonomy/broker.js';
import { ProjectSecrets } from '../autonomy/project-secrets.js';
import { serviceEnvManifest } from './services.js';
import type { WorldHandle } from './types.js';

/**
 * The project runtime env every process in a world should see (PLAN-state):
 * per-world service connections from the handle, then vault-resolved env
 * secrets — secrets win a name clash. One resolver shared by agent turns, the
 * interactive terminal, and review-action runs, so a human clicking "run
 * tests" sees exactly the world the agent saw. Resolution is JIT per call;
 * failures degrade to the non-secret half rather than blocking the process.
 */
export function worldRuntimeEnv(
  store: { kvGet(k: string): string | undefined; kvSet(k: string, v: string): void;
    listResourceAttachments?(projectId: string): import('../domain/types.js').ResourceAttachment[] },
  broker: CredentialBroker | undefined,
  handle: WorldHandle,
  taskId?: string,
): Record<string, string> {
  const env = serviceEnvManifest(handle.meta);
  const projectId = typeof handle.meta?.projectId === 'string' ? handle.meta.projectId : undefined;
  if (!projectId || !broker) return env;
  try {
    Object.assign(env, new ProjectSecrets(store, broker).env(projectId, { taskId }));
  } catch { /* legacy layer is best-effort */ }
  // env-shaped secret resources (the canonical model) win name clashes: this is
  // the agent-subprocess counterpart of resources.withEnvironment, which can
  // only wrap world.exec — spawned agent/terminal/run processes come through
  // here instead.
  try {
    for (const attachment of store.listResourceAttachments?.(projectId) ?? []) {
      if (attachment.driver !== 'secret@1' || attachment.target.kind !== 'environment') continue;
      const credential = attachment.credentialHandles[0];
      if (!credential) continue;
      try {
        env[attachment.target.name] = broker.resolve(credential, { taskId, caps: [`use-credential:${credential}`] });
      } catch { /* missing value surfaces at first use */ }
    }
  } catch { /* stores without resource tables (older kv-only) */ }
  return env;
}
