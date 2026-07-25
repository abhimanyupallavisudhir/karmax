import type { CredentialBroker } from '../autonomy/broker.js';
import type { ResourceAttachment } from '../domain/types.js';
import type { WorldHandle } from './types.js';

/**
 * The project runtime env every SPAWNED process in a world should see: the
 * per-world service connections (broker handles registered on the handle by
 * `registerServiceEnvironment`) plus env-shaped secret resources. This is the
 * agent-subprocess counterpart of `resources.withEnvironment`, which can only
 * wrap `world.exec` — agent turns, terminal PTYs, and review-action runs spawn
 * their own processes and come through here instead. Resolution is JIT per
 * call; failures degrade to fewer variables rather than a blocked process, and
 * no value ever lands in a handle, event, or checkpoint.
 */
export function worldRuntimeEnv(
  store: { listResourceAttachments?(projectId: string): ResourceAttachment[] },
  broker: CredentialBroker | undefined,
  handle: WorldHandle,
  taskId?: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (!broker) return env;
  // Per-world service connections: opaque handles on the world handle.
  const serviceHandles = handle.meta?.serviceEnvironmentHandles;
  if (serviceHandles && typeof serviceHandles === 'object') {
    for (const [name, credential] of Object.entries(serviceHandles as Record<string, unknown>)) {
      if (typeof credential !== 'string') continue;
      try {
        env[name] = broker.resolve(credential, { taskId, caps: [`use-credential:${credential}`] });
      } catch { /* released or rotated — surfaces at first use */ }
    }
  }
  // Env-shaped secret attachments (the canonical secret model).
  const projectId = typeof handle.meta?.projectId === 'string' ? handle.meta.projectId : undefined;
  if (!projectId) return env;
  try {
    for (const attachment of store.listResourceAttachments?.(projectId) ?? []) {
      if (attachment.driver !== 'secret@1' || attachment.target.kind !== 'environment') continue;
      const credential = attachment.credentialHandles[0];
      if (!credential) continue;
      try {
        env[attachment.target.name] = broker.resolve(credential, { taskId, caps: [`use-credential:${credential}`] });
      } catch { /* missing value surfaces at first use */ }
    }
  } catch { /* stores without resource tables */ }
  return env;
}
