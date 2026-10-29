import { proxyActivities } from '@temporalio/workflow';

interface ProbeActivities {
  agentUsesHostCapacity(args: Record<string, unknown>): Promise<boolean>;
  recordEvent(taskId: string, type: string, payload: Record<string, unknown>): Promise<void>;
}

/** Reports whether the activities on `activityQueue` see a hosted
 * installation: a subscription login in a remote world takes no host capacity
 * on a private one, but every hosted agent run counts against its plan. A
 * hosted worker loads no external workflows, so this one runs elsewhere and
 * sends its activities there. */
export async function hostedProbe(taskId: string, activityQueue: string): Promise<void> {
  const activities = proxyActivities<ProbeActivities>({ taskQueue: activityQueue,
    startToCloseTimeout: '10s', retry: { maximumAttempts: 1 } });
  const usesHostCapacity = await activities.agentUsesHostCapacity({ role: 'do', task: { taskId },
    worldHandle: { version: 2, kind: 'e2b', provider: 'e2b', id: taskId }, accountCredentialKind: 'login' });
  await activities.recordEvent(taskId, 'fixture.hosted-probe', { hosted: usesHostCapacity });
}
