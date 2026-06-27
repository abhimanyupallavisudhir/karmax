import type { Client } from '@temporalio/client';
import {
  MERGE_QUEUE_WORKFLOW,
  SIG_ENQUEUE,
  SIG_RELEASE,
  SIG_PRIORITIZE,
  SIG_CANCEL_MERGE,
  QRY_QUEUE,
  mergeQueueId,
} from '../coordinators/names.js';

export interface CoordinatorActivityDeps {
  client: Client;
  taskQueue: string;
}

/**
 * Client-side activities for the merge-queue coordinator. signal-with-start is a
 * client primitive (SPEC §3.2: create-or-signal atomically), so it lives in an
 * activity, not in workflow code. The coordinator is referenced by string name
 * to avoid importing its (sandbox-only) workflow module into Node.
 */
export function makeCoordinatorActivities(deps: CoordinatorActivityDeps) {
  const { client, taskQueue } = deps;
  return {
    /** Enqueue a task for the merge slot, creating the coordinator if needed. */
    async enqueueMerge(domain: string, taskId: string): Promise<void> {
      await client.workflow.signalWithStart(MERGE_QUEUE_WORKFLOW, {
        workflowId: mergeQueueId(domain),
        taskQueue,
        args: [{ domain }],
        signal: SIG_ENQUEUE,
        signalArgs: [{ taskId }],
      });
    },
    async releaseMerge(domain: string, taskId: string): Promise<void> {
      await client.workflow.signalWithStart(MERGE_QUEUE_WORKFLOW, {
        workflowId: mergeQueueId(domain),
        taskQueue,
        args: [{ domain }],
        signal: SIG_RELEASE,
        signalArgs: [{ taskId }],
      });
    },
    async prioritizeMerge(domain: string, taskId: string): Promise<void> {
      await client.workflow.signalWithStart(MERGE_QUEUE_WORKFLOW, {
        workflowId: mergeQueueId(domain),
        taskQueue,
        args: [{ domain }],
        signal: SIG_PRIORITIZE,
        signalArgs: [{ taskId }],
      });
    },
    async cancelMerge(domain: string, taskId: string): Promise<void> {
      await client.workflow.signalWithStart(MERGE_QUEUE_WORKFLOW, {
        workflowId: mergeQueueId(domain),
        taskQueue,
        args: [{ domain }],
        signal: SIG_CANCEL_MERGE,
        signalArgs: [{ taskId }],
      });
    },
    async mergeQueuePosition(
      domain: string,
      taskId: string,
    ): Promise<{ position: number; total: number; current?: string }> {
      try {
        const view = (await client.workflow
          .getHandle(mergeQueueId(domain))
          .query(QRY_QUEUE)) as { queue: string[]; current?: string };
        const total = view.queue.length + (view.current ? 1 : 0);
        if (view.current === taskId) return { position: 0, total, current: view.current };
        const idx = view.queue.indexOf(taskId);
        return { position: idx < 0 ? -1 : idx + 1, total, current: view.current };
      } catch {
        return { position: -1, total: 0 };
      }
    },
    /** Crash-safety check: is the grantee workflow still running? */
    async isTaskAlive(taskId: string): Promise<boolean> {
      try {
        const desc = await client.workflow.getHandle(taskId).describe();
        return desc.status.name === 'RUNNING';
      } catch {
        return false;
      }
    },
  };
}

export type coordinatorActivities = ReturnType<typeof makeCoordinatorActivities>;
