import { proxyActivities } from '@temporalio/workflow';

const activities = proxyActivities<{
  recordEvent(taskId: string, type: string, payload: Record<string, unknown>): Promise<void>;
}>({ startToCloseTimeout: '10s', retry: { maximumAttempts: 1 } });

export default async function record(taskId: string): Promise<void> {
  await activities.recordEvent(taskId, 'fixture.supervised-activity', { persisted: true });
}
