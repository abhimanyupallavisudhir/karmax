import { proxyActivities } from '@temporalio/workflow';
import type { coreActivities } from '../../src/activities/core.js';
import type { PublishedView } from '../../src/domain/view-publication.js';
import { publishTaskView } from '../../src/workflows/view-publication.js';
const core = proxyActivities<coreActivities>({ startToCloseTimeout: '5 minutes', retry: { maximumAttempts: 3 } });
export async function lifecycleReplay(view: PublishedView, reference?: string): Promise<void> {
  await publishTaskView(core, 'fixture', view, reference);
}
