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
  store: { kvGet(k: string): string | undefined; kvSet(k: string, v: string): void },
  broker: CredentialBroker | undefined,
  handle: WorldHandle,
  taskId?: string,
): Record<string, string> {
  const serviceEnv = serviceEnvManifest(handle.meta);
  const projectId = typeof handle.meta?.projectId === 'string' ? handle.meta.projectId : undefined;
  if (!projectId || !broker) return serviceEnv;
  try {
    return { ...serviceEnv, ...new ProjectSecrets(store, broker).env(projectId, { taskId }) };
  } catch {
    return serviceEnv;
  }
}
