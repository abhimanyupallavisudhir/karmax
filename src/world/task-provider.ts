import type { Store } from '../store/db.js';
import { isAnyProvider, normalizeComputer } from '../domain/computer.js';

/**
 * The provider a task's own Computer names, if any (wiki features/computers).
 * A running world moves to it at its next idle park; an inherited organization
 * or project default never moves a world that is already running, and neither
 * does "Any" (it routes only a new or restored world: compute-router.ts).
 */
export async function taskProvider(store: Store, taskId: string): Promise<string | undefined> {
  const task = await store.taskMetadataAsync(taskId);
  let provider: string | undefined;
  try { provider = normalizeComputer(task?.params?.computer)?.provider; } catch { return undefined; }
  return isAnyProvider(provider) ? undefined : provider;
}
