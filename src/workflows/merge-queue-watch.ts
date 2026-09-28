import { continueAsNew, proxyActivities, sleep, workflowInfo } from '@temporalio/workflow';
import type { coordinatorActivities } from '../activities/coordinator.js';
import { samePosition, type TaskView } from './contract.js';

const coordinator = proxyActivities<Pick<coordinatorActivities, 'mergeQueuePosition'>>({
  startToCloseTimeout: '30s',
  retry: { maximumAttempts: 5, initialInterval: '1s', backoffCoefficient: 2 },
});
interface MergeQueueWatchInput {
  domain: string;
  taskId: string;
  previous: TaskView['mergeQueue'];
  pollMs: number | string;
}

/** Waits until a task's merge-queue position changes, so the task records
 * nothing while it only waits (its grant still arrives by signal). Only
 * unchanged polls rotate history here. */
export async function mergeQueueWatch(input: MergeQueueWatchInput): Promise<TaskView['mergeQueue']> {
  for (let polls = 0; polls < 100; polls++) {
    await sleep(input.pollMs);
    const position = await coordinator.mergeQueuePosition(input.domain, input.taskId);
    if (!samePosition(position, input.previous)) return position;
    if (workflowInfo().continueAsNewSuggested || workflowInfo().historySize >= 10_000_000) break;
  }
  return continueAsNew<typeof mergeQueueWatch>(input);
}
