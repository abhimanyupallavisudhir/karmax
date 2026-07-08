import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  isCancellation,
  workflowInfo,
} from '@temporalio/workflow';
import type { coreActivities } from '../activities/core.js';
import { isInfraFailure, INFRA_BACKOFF_MS } from './failures.js';
import { TaskInput, TaskView, Stage, Message, ReviewInfo, DeclaredAction, WorldHandleLike, ConfirmDecision } from './contract.js';

const core = proxyActivities<coreActivities>({ startToCloseTimeout: '5 minutes', retry: { maximumAttempts: 3 } });
// Agent turns heartbeat every ~10s; a 2-minute gap = dead/slept worker → Temporal
// retries the turn and the next attempt resumes the interrupted session (see
// software-dev.ts / failures.ts for the full taxonomy).
const turns = proxyActivities<coreActivities>({
  startToCloseTimeout: '45 minutes',
  heartbeatTimeout: '2 minutes',
  retry: { maximumAttempts: 3, initialInterval: '10s', backoffCoefficient: 2 },
});

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
  const msgs: Message[] = input.prompt || input.images?.length
    ? [{ id: 'm0', role: 'user', text: input.prompt ?? '', ts: 0, ...(input.images?.length ? { images: input.images } : {}) }]
    : [];
  let confirmed = false;
  let cancelled = false;
  let world: WorldHandleLike | undefined;
  let session: string | undefined;
  let reviewInfo: ReviewInfo | undefined;
  let seen = 0;
  const base = input.base ?? input.project.defaultBase ?? 'main';
  // Who confirms at the Review gate (SPEC §5.2): human / auto / a Confirm agent. A child
  // routes to its parent (handled by the confirm signal from the parent), so this drives
  // top-level tasks; back-compat with the legacy autoConfirm-less just-do → human.
  const confirmMode: 'human' | 'auto' | 'agent' = input.confirm?.mode ?? 'human';

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

  /** Run one Confirm-agent turn (SPEC §5.2): review the work, return a verdict, or
   *  undefined on failure so the caller falls back to the human gate. */
  async function runConfirm(): Promise<ConfirmDecision | undefined> {
    try {
      // A fresh turn each Review so the reviewer judges the current work (up-to-date
      // system prompt); a mid-turn retry still resumes via runAgentTurn heartbeat details.
      const ct = await turns.runAgentTurn({
        taskId,
        role: 'confirm',
        worldHandle: world as any,
        messages: [],
        task: input,
        bindings: {
          reviewInfo: reviewInfo?.summary ?? '',
          changedFiles: (reviewInfo?.changedFiles ?? []).join('\n'),
          transcript: msgs.slice(-6).map((m) => `${m.role}: ${m.text}`).join('\n'),
        },
      });
      return ct.confirmDecision;
    } catch (err) {
      if (isCancellation(err)) throw err;
      return undefined;
    }
  }

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
  world = (await core.createWorld({ taskId, repos: input.project.repos, base, copyGlobs: input.project.copyGlobs, kind: 'worktree' })) as WorldHandleLike;

  let infraRetries = 0;
  for (stage = 'do'; ; ) {
    await publish();
    if (cancelled) break;
    let turn;
    // How many leading `msgs` are actually delivered this turn — captured at
    // schedule time, NOT after. A follow-up that arrives WHILE the turn runs lands
    // in `msgs` at a higher index; advancing `seen` to `msgs.length` afterwards would
    // mark it consumed and it would silently never reach the agent (SPEC §5.6).
    const deliveredNow = msgs.length;
    try {
      // On resume the session already holds the first `seen` messages, so send only
      // the delta after them (a follow-up), not the whole conversation again.
      turn = await turns.runAgentTurn({ taskId, role: 'do', worldHandle: world as any, messages: msgs, session, deliveredMessages: session ? seen : 0, task: input });
    } catch (err) {
      // Infrastructure outage that outlived the activity retries: park with
      // backoff and re-run the turn (which resumes its session) rather than
      // failing the task. Anything else propagates as before.
      if (cancelled || isCancellation(err) || !isInfraFailure(err) || infraRetries >= INFRA_BACKOFF_MS.length) throw err;
      await condition(() => cancelled, INFRA_BACKOFF_MS[infraRetries++]!);
      continue;
    }
    infraRetries = 0;
    session = turn.session ?? session;
    seen = deliveredNow;
    if (turn.reviewInfo) reviewInfo = turn.reviewInfo;
    stage = 'review';
    status = 'waiting';
    if (confirmMode === 'auto') {
      confirmed = true;
    } else if (confirmMode === 'agent') {
      await publish();
      const decision = await runConfirm();
      if (cancelled) break;
      if (decision?.action === 'confirm') {
        confirmed = true;
      } else if (decision?.action === 'reject') {
        if (decision.text) msgs.push({ id: `cr${msgs.length}`, role: 'system', text: `Confirm agent rejected: ${decision.text}`, ts: msgs.length });
        cancelled = true;
        break;
      } else if (decision?.action === 'revise') {
        msgs.push({ id: `cv${msgs.length}`, role: 'user', text: decision.text || 'Please revise per the reviewer feedback.', ts: msgs.length });
        stage = 'do';
        status = 'active';
        continue;
      }
      // no verdict → fall through to the human gate
    }
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
