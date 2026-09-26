import { WorkflowNotFoundError, type Client } from '@temporalio/client';
import type { Store } from '../store/db.js';
import type { TaskView } from '../domain/types.js';

/** Detached children outlive a lifecycle replacement of their parent. */
export function makeChildActivities(store: Store) {
  return {
    async restoreChildTasks(parentTaskId: string) {
      const children = await store.childTasks(parentTaskId);
      return children.filter((child) => child.lastView?.state?.lifecycleReplacement
        || !['done', 'cancelled', 'failed'].includes(child.lastView?.status ?? ''))
        .map((child) => ({ taskId: child.id, title: child.title,
          waiting: child.lastView?.waitingFor?.kind === 'parent',
          detail: child.lastView?.waitingFor?.detail }));
    },
  };
}
export type childActivities = ReturnType<typeof makeChildActivities>;

/** Publish after the durable view write so replacement parents can reconstruct
 * settlements that raced their restart. Repeated notifications are harmless. */
export async function notifyChildSettlement(store: Store, client: Client | undefined, view: TaskView) {
  if (!client || view.state?.lifecycleReplacement || !['done', 'cancelled', 'failed'].includes(view.status)) return;
  const task = await store.taskMetadata(view.taskId);
  if (task?.parentTaskId) await client.workflow.getHandle(task.parentTaskId)
    .signal('childSettled', { childTaskId: task.id, stage: view.stage }).catch(error => {
      if (!(error instanceof WorkflowNotFoundError)) throw error;
    });
}
