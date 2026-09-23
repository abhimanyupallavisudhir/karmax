import { deprecatePatch } from '@temporalio/workflow';
import type { coreActivities } from '../activities/core.js';

/** Resource-aware setup ran in production before it reached the release image.
 * Those histories must still consume its marker after an image rebuild. Keep
 * the caller's activity policy; retiring a patch must not strand existing tasks
 * or silently enable the unreleased heartbeat-dependent provisioning policy. */
export function createTaskWorld(core: Pick<coreActivities, 'createWorld'>,
  args: Parameters<coreActivities['createWorld']>[0]) {
  deprecatePatch('resource-aware-world-setup-v1');
  return core.createWorld(args);
}
