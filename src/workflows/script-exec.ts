import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  workflowInfo,
} from '@temporalio/workflow';
import type { coreActivities } from '../activities/core.js';
import { TaskInput, TaskView, Stage, Message, DeclaredAction, WorldHandleLike } from './contract.js';

const core = proxyActivities<coreActivities>({ startToCloseTimeout: '5 minutes', retry: { maximumAttempts: 3 } });
const long = proxyActivities<coreActivities>({ startToCloseTimeout: '45 minutes', retry: { maximumAttempts: 1 } });

export const cancelSignal = defineSignal('cancel');
export const ackSignal = defineSignal('confirm');
export const viewQuery = defineQuery<TaskView>('view');

/**
 * script-exec (SPEC §4.7): run a script/command as a task. No agent, no merge —
 * a world is created, the command runs, output is captured for review.
 */
export async function scriptExec(input: TaskInput): Promise<{ stage: Stage; code?: number }> {
  const taskId = input.taskId;
  let stage: Stage = 'setup';
  let status: TaskView['status'] = 'active';
  const msgs: Message[] = [{ id: 'm0', role: 'user', text: input.command ?? input.prompt, ts: 0 }];
  let world: WorldHandleLike | undefined;
  let code: number | undefined;
  let acked = false;
  let cancelled = false;
  const base = input.base ?? input.project.defaultBase ?? 'main';

  function actions(): DeclaredAction[] {
    if (stage === 'review') return [{ name: 'confirm', kind: 'signal', label: 'Done', enabled: true }];
    return [{ name: 'cancel', kind: 'signal', label: 'Cancel', enabled: true, danger: true }];
  }
  function view(): TaskView {
    return {
      taskId, title: input.title, workflow: 'script-exec', stage, status, messages: msgs, actions: actions(),
      state: { code }, branch: world?.branch, base, worldPath: world?.root,
      parentTaskId: input.parentTaskId, updatedAt: workflowInfo().historyLength,
    };
  }
  const publish = async () => core.publishView(taskId, view());

  setHandler(viewQuery, view);
  setHandler(ackSignal, () => {
    acked = true;
  });
  setHandler(cancelSignal, () => {
    cancelled = true;
  });

  await publish();
  world = (await core.createWorld({ taskId, repos: input.project.repos, base, kind: 'worktree' })) as WorldHandleLike;

  stage = 'do';
  await publish();
  const command = input.command ?? input.prompt;
  const result = await long.runScript({ taskId, worldHandle: world as any, command });
  code = result.code;
  msgs.push({ id: 'out', role: 'system', text: `exit ${result.code}\n${result.output}`.slice(0, 8000), ts: 1 });

  stage = 'review';
  status = 'waiting';
  await publish();
  await condition(() => acked || cancelled);
  stage = cancelled ? 'cancelled' : 'done';
  status = cancelled ? 'cancelled' : 'done';
  await publish();
  return { stage, code };
}
