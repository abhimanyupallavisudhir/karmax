import { WorkflowNotFoundError, type Client } from '@temporalio/client';
import type { Store } from '../store/db.js';
import type { TaskView } from '../domain/types.js';

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
