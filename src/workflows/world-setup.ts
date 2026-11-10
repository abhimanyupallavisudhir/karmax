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
// Setup keeps its own time (src/world/setup-clock.ts): 30 minutes for
// everything but restoring the project's data, which takes as long as it keeps
// moving. pramana #191: a 31 GB restore needed the whole 30 minutes this limit
// once was, and every attempt started over in a new machine. Temporal's limit
// is only a backstop now; the heartbeat still finds a dead worker in a minute.
const progressSetup = proxyActivities<Pick<coreActivities, 'createWorld'>>({
  startToCloseTimeout: '12 hours',
  heartbeatTimeout: '60 seconds',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 3 },
});

export function createTaskWorld(core: Pick<coreActivities, 'createWorld'>,
  args: Parameters<coreActivities['createWorld']>[0]) {
  // This marker exists in production histories from before the release. Keep
  // it replayable: removing it strands existing tasks even at later Review gates.
  if (!patched('resource-aware-world-setup-v1')) return core.createWorld(args);
  return (patched('world-setup-restores-by-progress-v1') ? progressSetup : setup).createWorld(args);
}
