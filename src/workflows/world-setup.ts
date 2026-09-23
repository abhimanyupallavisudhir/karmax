import { patched, proxyActivities } from '@temporalio/workflow';
import { ActivityCancellationType } from '@temporalio/common';
import type { coreActivities } from '../activities/core.js';

const setup = proxyActivities<Pick<coreActivities, 'createWorld'>>({
  // Includes cloning and verified project-resource restoration, not just VM boot.
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '60 seconds',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 3 },
});

export function createTaskWorld(core: Pick<coreActivities, 'createWorld'>,
  args: Parameters<coreActivities['createWorld']>[0]) {
  return (patched('resource-aware-world-setup-v1') ? setup : core).createWorld(args);
}
