import { patched, proxyActivities, isCancellation } from '@temporalio/workflow';
import { ActivityCancellationType } from '@temporalio/common';
import type { coreActivities } from '../activities/core.js';
import { hasLiveWorldWork, lifecyclePublication, type PublishedView } from '../domain/view-publication.js';

const lifecycle = proxyActivities<Pick<coreActivities, 'parkWaitingWorld'>>({
  startToCloseTimeout: '30 minutes', heartbeatTimeout: '30 seconds',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 3 },
});

/** Await maintenance before advancing the workflow, but persist status in a
 * short activity. Old histories retain their exact publishView commands. */
export async function publishTaskView(
  core: Pick<coreActivities, 'publishView' | 'recordEvent'>,
  taskId: string, view: PublishedView, reference?: string,
): Promise<void> {
  if (!patched('waiting-world-lifecycle-v1')) {
    if (reference === undefined) await core.publishView(taskId, view);
    else await core.publishView(taskId, view, reference);
    return;
  }
  const fence = await core.publishView(taskId, view, reference, { separateLifecycle: true });
  const startingAgent = patched('non-idle-world-waits-v1') ? hasLiveWorldWork(view)
    : view.waitingFor?.kind === 'agentSlot' && view.waitingFor.detail === 'Starting agent';
  if (!fence || startingAgent || (view.status !== 'waiting' && view.status !== 'blocked')
    || !(view.world ?? view.state?.recoveryWorld)) return;
  try { await lifecycle.parkWaitingWorld(taskId, lifecyclePublication(view), fence); }
  catch (error) {
    if (isCancellation(error)) throw error;
    // The authoritative status is already saved. Provider auto-pause remains
    // the cost backstop if independent maintenance exhausts its retries.
    await core.recordEvent(taskId, 'world.warning', { warning: 'Waiting-world maintenance exhausted its retries' });
  }
}
