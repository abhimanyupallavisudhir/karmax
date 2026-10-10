import type { Store } from '../store/db.js';
import { TERMINAL_STATUSES } from '../domain/triggers.js';

/** Whether a world's task has finished: its world is never reopened or rebuilt. */
export async function taskEnded(store: Pick<Store, 'taskMetadata'>, taskId: string): Promise<boolean> {
  const status = (await store.taskMetadata(taskId))?.lastView?.status;
  return !!status && (TERMINAL_STATUSES as readonly string[]).includes(status);
}
