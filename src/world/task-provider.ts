import type { Store } from '../store/db.js';
import { normalizeComputer } from '../domain/computer.js';

/**
 * The provider a task's own Computer names, if any (wiki features/computers).
 * A running world moves to it at its next idle park; an inherited organization
 * or project default never moves a world that is already running.
 */
export async function taskProvider(store: Store, taskId: string): Promise<string | undefined> {
  const task = await store.taskMetadataAsync(taskId);
  try { return normalizeComputer(task?.params?.computer)?.provider; } catch { return undefined; }
}
