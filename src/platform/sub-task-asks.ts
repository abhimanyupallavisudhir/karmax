import type { TaskRecord } from '../domain/types.js';
import { untrustedBlock } from '../domain/untrusted.js';

/**
 * A sub-task asks people through its parent (SPEC §8.2). People usually do not
 * know why a sub-task exists; they know its parent. So what a sub-task asks for
 * that its parent cannot give it — a permission the parent lacks, a credential,
 * an app sign-in — goes to people at once, shown as coming via the parent, and
 * the parent's agent is told: it may add the context they lack, or name whom to
 * ask (`escalate(to, note, task_id)`), or decline it. A permission the parent
 * holds stays its agent's to grant. Only while the parent is at work: a
 * sub-task whose parent has finished asks people as any task does.
 */

/** The parent a sub-task's request came through, and the note its agent added. */
export interface Via {
  taskId: string;
  note?: string;
  at: number;
}

const FINISHED = ['done', 'cancelled', 'failed'];

/** The parent a sub-task's requests go through: the task it is a sub-task of,
 * while that task is still at work in the same organization. */
export async function parentAtWork(
  store: { getTask(id: string): Promise<TaskRecord | undefined>; getProject(id: string): Promise<{ organizationId?: string } | undefined> },
  task: Pick<TaskRecord, 'parentTaskId' | 'projectId'> | undefined,
): Promise<TaskRecord | undefined> {
  if (!task?.parentTaskId) return undefined;
  const parent = await store.getTask(task.parentTaskId);
  if (!parent || FINISHED.includes(parent.lastView?.status ?? '')) return undefined;
  if (parent.projectId !== task.projectId
    && (await store.getProject(parent.projectId))?.organizationId !== (await store.getProject(task.projectId))?.organizationId) return undefined;
  return parent;
}

/** A new request of `task` through its parent at work, if it has one. */
export async function viaParent(store: Parameters<typeof parentAtWork>[0], task: Parameters<typeof parentAtWork>[1]): Promise<Via | undefined> {
  const parent = await parentAtWork(store, task);
  return parent ? { taskId: parent.id, at: Date.now() } : undefined;
}

/** What a parent's agent reads when its sub-task asks people for something through it. */
export function throughYouText(child: Pick<TaskRecord, 'id' | 'num' | 'title'>, ask: { what: string; decline: string; why?: string }): string {
  return `Task #${child.num ?? child.id} "${child.title}" (${child.id}) asks people ${ask.what}, through you: they see it as your sub-task's. `
    + `To give them the context they lack, or ask someone else, use escalate(to, note, task_id: "${child.id}"). `
    + `If its work does not need it, decline it: ${ask.decline}.`
    + (ask.why ? `\n${untrustedBlock('its reason', ask.why)}` : '');
}
