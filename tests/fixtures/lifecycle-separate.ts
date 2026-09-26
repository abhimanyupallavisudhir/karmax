import { patched, proxyActivities } from '@temporalio/workflow';
import { ActivityCancellationType } from '@temporalio/common';
import type { coreActivities } from '../../src/activities/core.js';
import { lifecyclePublication, type PublishedView } from '../../src/domain/view-publication.js';

const core = proxyActivities<coreActivities>({ startToCloseTimeout: '5 minutes', retry: { maximumAttempts: 3 } });
const lifecycle = proxyActivities<Pick<coreActivities, 'parkWaitingWorld'>>({
  startToCloseTimeout: '30 minutes', heartbeatTimeout: '30 seconds',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 3 },
});

// Historical helper after lifecycle separation but before non-idle wait guards.
export async function lifecycleReplay(view: PublishedView, reference?: string): Promise<void> {
  if (!patched('waiting-world-lifecycle-v1')) {
    if (reference === undefined) await core.publishView('fixture', view);
    else await core.publishView('fixture', view, reference);
    return;
  }
  const fence = await core.publishView('fixture', view, reference, { separateLifecycle: true });
  if (fence) await lifecycle.parkWaitingWorld('fixture', lifecyclePublication(view), fence);
}
