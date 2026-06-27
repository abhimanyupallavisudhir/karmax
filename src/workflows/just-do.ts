import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  workflowInfo,
} from '@temporalio/workflow';
import type { coreActivities } from '../activities/core.js';
import { TaskInput, TaskView, Stage, Message, ReviewInfo, DeclaredAction, WorldHandleLike } from './contract.js';

const core = proxyActivities<coreActivities>({ startToCloseTimeout: '5 minutes', retry: { maximumAttempts: 3 } });
const long = proxyActivities<coreActivities>({ startToCloseTimeout: '45 minutes', retry: { maximumAttempts: 1 } });

export const followUpSignal = defineSignal<[Message]>('followUp');
export const confirmSignal = defineSignal('confirm');
export const cancelSignal = defineSignal('cancel');
export const viewQuery = defineQuery<TaskView>('view');

/**
 * just-do (SPEC §4.7): a single straightforward agent call, no merge machinery.
 * The work stays on the task's branch; it is not merged anywhere.
 */
export async function justDo(input: TaskInput): Promise<{ stage: Stage }> {
  const taskId = input.taskId;
  let stage: Stage = 'setup';
  let status: TaskView['status'] = 'active';
  const msgs: Message[] = input.prompt ? [{ id: 'm0', role: 'user', text: input.prompt, ts: 0 }] : [];
  let confirmed = false;
  let cancelled = false;
  let world: WorldHandleLike | undefined;
  let session: string | undefined;
  let reviewInfo: ReviewInfo | undefined;
  let seen = 0;
  const base = input.base ?? input.project.defaultBase ?? 'main';

  function actions(): DeclaredAction[] {
    const followUp: DeclaredAction = { name: 'followUp', kind: 'signal', label: 'Send follow-up', enabled: true, args: [{ name: 'text', type: 'text', required: true }] };
    const cancel: DeclaredAction = { name: 'cancel', kind: 'signal', label: 'Cancel', enabled: true, danger: true };
    const confirm: DeclaredAction = { name: 'confirm', kind: 'signal', label: 'Done', enabled: true };
    if (stage === 'review') return [confirm, followUp, cancel];
    if (stage === 'do' || stage === 'setup') return [followUp, cancel];
    return [];
  }
  function view(): TaskView {
    return {
      taskId, title: input.title, workflow: 'just-do', stage, status, messages: msgs, reviewInfo,
      actions: actions(), state: { worldReady: !!world }, branch: world?.branch, base,
      worldPath: world?.root, parentTaskId: input.parentTaskId, updatedAt: workflowInfo().historyLength,
    };
  }
  const publish = async () => core.publishView(taskId, view());

  setHandler(viewQuery, view);
  setHandler(followUpSignal, (m) => {
    msgs.push({ ...m, ts: msgs.length });
  });
  setHandler(confirmSignal, () => {
    confirmed = true;
  });
  setHandler(cancelSignal, () => {
    cancelled = true;
  });

  await publish();
  world = (await core.createWorld({ taskId, repo: input.project.repos?.[0], base, copyGlobs: input.project.copyGlobs, kind: 'worktree' })) as WorldHandleLike;

  for (stage = 'do'; ; ) {
    await publish();
    if (cancelled) break;
    const turn = await long.runAgentTurn({ taskId, role: 'do', worldHandle: world as any, messages: msgs, session, task: input });
    session = turn.session ?? session;
    seen = msgs.length;
    if (turn.reviewInfo) reviewInfo = turn.reviewInfo;
    stage = 'review';
    status = 'waiting';
    await publish();
    await condition(() => confirmed || cancelled || msgs.length > seen);
    if (confirmed || cancelled) break;
    stage = 'do';
    status = 'active';
  }

  // No merge machinery: the world IS the deliverable. Commit the work to the
  // task branch so it persists, and keep the worktree for inspection.
  if (!cancelled && world) await core.commitWork(world as any, `karmax: ${input.title}`);
  stage = cancelled ? 'cancelled' : 'done';
  status = cancelled ? 'cancelled' : 'done';
  await publish();
  if (cancelled && world) await core.destroyWorld(world as any);
  return { stage };
}
