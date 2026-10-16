import type { TaskRecord } from '../domain/types.js';

/**
 * A sub-task acts with its parent's authority (SPEC §8.2): it is delegated it,
 * not given a copy. Whatever the parent holds now — its grant, what was
 * approved for it later (permission requests, vault credentials), its project
 * scope, its vault policy overrides, its app connections and its payment
 * policy — the sub-task holds too, so it never asks anyone for what its parent
 * has. Its own record keeps the grant it started with; it is used only when
 * the parent is gone.
 */
export const DELEGATED_PROFILE = 'inherited-child';

type TaskLike = Pick<TaskRecord, 'parentTaskId'> & { params?: Record<string, unknown> };

/** Whether this task acts with its parent's authority (a sub-task). */
export function delegatedFromParent(task: TaskLike | undefined): task is TaskLike & { parentTaskId: string } {
  const stored = task?.params?._authorization as { profileId?: string } | undefined;
  return !!task?.parentTaskId && stored?.profileId === DELEGATED_PROFILE;
}

/** The tasks whose authority this one acts with, nearest first: its parent,
 * then that parent's own parent while it is a sub-task too. */
export async function delegatingAncestors(
  store: { getTask(id: string): Promise<TaskRecord | undefined> }, taskId: string,
): Promise<TaskRecord[]> {
  const out: TaskRecord[] = [];
  const seen = new Set([taskId]);
  let task = await store.getTask(taskId);
  while (delegatedFromParent(task) && !seen.has(task.parentTaskId)) {
    seen.add(task.parentTaskId);
    const parent = await store.getTask(task.parentTaskId);
    if (!parent) break;
    out.push(parent);
    task = parent;
  }
  return out;
}
