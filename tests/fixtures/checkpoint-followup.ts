import { defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type { coreActivities } from '../../src/activities/core.js';
import type { TaskView, Message } from '../../src/domain/types.js';
import { publishTaskView } from '../../src/workflows/view-publication.js';
const core = proxyActivities<coreActivities>({ startToCloseTimeout: '5 minutes', retry: { maximumAttempts: 3 } });
export async function checkpointFollowUp(view: TaskView, separate: boolean): Promise<Message[]> {
  const messages: Message[] = [];
  setHandler(defineSignal<[Message]>('followUp'), message => { messages.push(message); });
  if (separate) await publishTaskView(core, view.taskId, view);
  else await core.publishView(view.taskId, view);
  return messages;
}
