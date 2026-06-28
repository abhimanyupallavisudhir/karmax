import {
  proxyActivities,
  defineSignal,
  defineUpdate,
  defineQuery,
  setHandler,
  condition,
  executeChild,
  workflowInfo,
  log,
} from '@temporalio/workflow';
import type { coreActivities } from '../activities/core.js';
import type { coordinatorActivities } from '../activities/coordinator.js';
import { SIG_MERGE_GRANTED } from '../coordinators/names.js';
import {
  TaskInput,
  TaskView,
  Stage,
  Message,
  ReviewInfo,
  DeclaredAction,
  WorldHandleLike,
} from './contract.js';

const core = proxyActivities<coreActivities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 3 },
});
// Agent turns + merges can be long-running (real models, test suites).
const long = proxyActivities<coreActivities>({
  startToCloseTimeout: '45 minutes',
  retry: { maximumAttempts: 1 },
});
const coord = proxyActivities<coordinatorActivities>({ startToCloseTimeout: '30s' });

// ─── Signals / updates / query (SPEC §5.6) ───────────────────────────────────
export const followUpSignal = defineSignal<[Message]>('followUp');
export const confirmSignal = defineSignal('confirm');
export const cancelSignal = defineSignal('cancel');
export const retrySignal = defineSignal('retry');
export const mergeGrantedSignal = defineSignal(SIG_MERGE_GRANTED);
export const setTargetUpdate = defineUpdate<boolean, [string]>('setTarget');
export const viewQuery = defineQuery<TaskView>('view');

export interface SoftwareDevInput extends TaskInput {
  /** Sub-tasks run with the parent as confirmer; v1 auto-confirms to avoid deadlock. */
  autoConfirm?: boolean;
  /** Goal workflow (SPEC §4.7): auto-send "keep going" until structured completion. */
  goalMode?: boolean;
}

const MAX_RESOLVE_ATTEMPTS = 2;

/**
 * Internal sentinel for cancellation. Throwing a plain Error out of workflow
 * code triggers a workflow-TASK failure that Temporal retries forever; we never
 * do that. Cancellation is caught and routed to a graceful `abort()`.
 */
class Cancelled extends Error {}

/**
 * The software-development workflow (SPEC §5): Setup → Do ⇄ Review → PR → Merge
 * → End, with cross-cutting Resolve and awaited sub-tasks. Merge is the point of
 * no return.
 */
export async function softwareDev(input: SoftwareDevInput): Promise<{ stage: Stage; sha?: string }> {
  const taskId = input.taskId;
  let stage: Stage = 'setup';
  let status: TaskView['status'] = 'active';
  const msgs: Message[] = input.prompt ? [{ id: 'm0', role: 'user', text: input.prompt, ts: 0 }] : [];
  let target = input.target ?? input.project.defaultTarget ?? input.base ?? input.project.defaultBase ?? 'main';
  const base = input.base ?? input.project.defaultBase ?? 'main';
  let confirmed = false;
  let cancelled = false;
  let retryRequested = false;
  let world: WorldHandleLike | undefined;
  let session: string | undefined;
  let reviewInfo: ReviewInfo | undefined;
  let error: string | undefined;
  let pr: { url: string; number: number } | undefined;
  let mergeQueuePos: { position: number; total: number } | undefined;
  const subTaskIds: string[] = [];
  let pointOfNoReturnPassed = false;
  let mergeGranted = false;
  let seen = 0; // messages the Do agent has already processed

  const kind = input.project.worldProvider === 'container' ? 'container' : 'worktree';

  // ── view-model ──
  function allowed(): DeclaredAction[] {
    const followUp: DeclaredAction = {
      name: 'followUp',
      kind: 'signal',
      label: 'Send follow-up',
      enabled: true,
      args: [{ name: 'text', type: 'text', label: 'Message', required: true }],
    };
    const cancel: DeclaredAction = { name: 'cancel', kind: 'signal', label: 'Cancel', enabled: !pointOfNoReturnPassed, danger: true };
    const confirm: DeclaredAction = { name: 'confirm', kind: 'signal', label: 'Confirm', enabled: true };
    const setTarget: DeclaredAction = {
      name: 'setTarget',
      kind: 'update',
      label: 'Change target branch',
      enabled: stage === 'do' || stage === 'review',
      args: [{ name: 'branch', type: 'string', label: 'Target branch', default: target }],
    };
    const retry: DeclaredAction = { name: 'retry', kind: 'signal', label: 'Retry', enabled: true };
    switch (stage) {
      case 'setup':
        return [cancel];
      case 'do':
        return [followUp, setTarget, cancel];
      case 'review':
        return [confirm, followUp, setTarget, cancel];
      case 'pr':
        return [cancel];
      case 'merge':
        return [cancel];
      case 'resolve':
        return [cancel];
      case 'escalated':
        return [retry, followUp, cancel];
      default:
        return [];
    }
  }

  function buildView(): TaskView {
    return {
      taskId,
      title: input.title,
      workflow: 'software-dev',
      stage,
      status,
      messages: msgs,
      reviewInfo,
      actions: allowed(),
      state: {
        confirmed,
        cancelled,
        turnsSeen: seen,
        worldReady: !!world,
        mergeGranted,
        mergeDomain: world ? `${world.repo ?? input.projectId}:${target}` : undefined,
      },
      branch: world?.branch,
      base,
      targetBranch: target,
      worldPath: world?.root,
      pr,
      mergeQueue: mergeQueuePos,
      subTasks: subTaskIds.length ? subTaskIds : undefined,
      parentTaskId: input.parentTaskId,
      error,
      pointOfNoReturnPassed,
      updatedAt: workflowInfo().historyLength,
    };
  }

  async function publish() {
    await core.publishView(taskId, buildView());
  }

  // ── handlers ──
  setHandler(viewQuery, buildView);
  setHandler(followUpSignal, (m) => {
    msgs.push({ ...m, ts: msgs.length });
  });
  setHandler(confirmSignal, () => {
    confirmed = true;
  });
  setHandler(cancelSignal, () => {
    if (!pointOfNoReturnPassed) cancelled = true;
  });
  setHandler(retrySignal, () => {
    retryRequested = true;
  });
  setHandler(mergeGrantedSignal, () => {
    mergeGranted = true;
  });
  setHandler(setTargetUpdate, (b) => {
    if (stage === 'do' || stage === 'review') {
      target = b;
      return true;
    }
    return false;
  });

  // ── Resolve wrapper (SPEC §5.2) ──
  async function withResolve<T>(stageName: string, fn: () => Promise<T>): Promise<T> {
    let lastError = '';
    for (;;) {
      let attempt = 0;
      for (; attempt <= MAX_RESOLVE_ATTEMPTS; attempt++) {
        try {
          return await fn();
        } catch (err) {
          if (cancelled) throw err;
          lastError = describeError(err);
          error = lastError;
          const prevStage = stage;
          stage = 'resolve';
          await publish();
          const auto = await core.autoResolve({ taskId, stage: stageName, error });
          if (!auto.resolved && world) {
            // Escalate to the Resolve agent with a context bundle.
            const r = await long.runAgentTurn({
              taskId,
              role: 'resolve',
              worldHandle: world as any,
              messages: [{ id: `r${attempt}`, role: 'user', text: `Fix the ${stageName} failure.`, ts: 0 }],
              task: input,
              bindings: { stage: stageName, error, transcript: lastOutputs(msgs), skills: '' },
            });
            log.info('resolve agent ran', { completed: r.completed });
          }
          stage = prevStage as Stage;
          error = undefined; // clear for the retry display
          await publish();
        }
      }
      // Attempts exhausted → escalate to a human, preserving the failure cause.
      stage = 'escalated';
      status = 'blocked';
      error = lastError;
      retryRequested = false;
      await publish();
      await condition(() => retryRequested || cancelled);
      if (cancelled) throw new Cancelled();
      status = 'active';
      error = undefined;
    }
  }

  try {
  // ── Setup ──
  await publish();
  world = (await withResolve('setup', () =>
    core.createWorld({ taskId, repo: input.project.repos?.[0], base, target, copyGlobs: input.project.copyGlobs, kind }),
  )) as WorldHandleLike;

  // ── Do ⇄ Review ──
  for (stage = 'do', status = 'active'; ; ) {
    await publish();
    if (cancelled) return await abort();

    const turn = await withResolve('do', () =>
      long.runAgentTurn({
        taskId,
        role: 'do',
        worldHandle: world as any,
        messages: msgs,
        session,
        task: input,
      }),
    );
    session = turn.session ?? session;
    if (turn.output?.trim()) msgs.push({ id: `a${msgs.length}`, role: 'agent', text: turn.output, ts: msgs.length });
    seen = msgs.length;
    if (turn.reviewInfo) reviewInfo = turn.reviewInfo;

    // Sub-tasks: spawn child workflows and await them (SPEC §5.3 Do→Do).
    if (turn.subTasks?.length) {
      const children = await Promise.all(
        turn.subTasks.map(async (s) => {
          const childInput = await core.prepareChildTask({
            parentTaskId: taskId,
            projectId: input.projectId,
            title: s.title,
            prompt: s.prompt,
            base,
            target,
            project: input.project,
            profiles: input.profiles,
          });
          subTaskIds.push(childInput.taskId);
          await publish();
          const res = await executeChild(softwareDev, {
            workflowId: childInput.taskId,
            args: [{ ...childInput, autoConfirm: true } as SoftwareDevInput],
          });
          return { title: s.title, res };
        }),
      );
      for (const c of children) {
        msgs.push({ id: `st-${msgs.length}`, role: 'system', text: `Sub-task "${c.title}" finished: ${c.res.stage}.`, ts: msgs.length });
      }
      continue; // resume Do so the agent sees results
    }

    if (turn.completed || turn.needsInput) {
      // Goal mode: keep nudging the agent until it signals structured completion.
      if (input.goalMode && !turn.completed) {
        msgs.push({
          id: `kg-${msgs.length}`,
          role: 'user',
          text: 'Keep going until the goal is fully complete, then call signal_completion.',
          ts: msgs.length,
        });
        stage = 'do';
        continue;
      }
      // Always attach a git-derived review (diff + changed files); the agent's own
      // review info (summary/links/html) takes precedence where present (§5.5).
      const auto = await core.buildReview(world as any, base).catch(() => undefined);
      if (auto) {
        reviewInfo = {
          summary: reviewInfo?.summary ?? auto.summary,
          diff: reviewInfo?.diff ?? auto.diff,
          changedFiles: auto.changedFiles,
          ...(reviewInfo?.links ? { links: reviewInfo.links } : {}),
          ...(reviewInfo?.html ? { html: reviewInfo.html } : {}),
        };
      }
      stage = 'review';
      status = 'waiting';
      if (input.autoConfirm) confirmed = true;
      await publish();
      await condition(() => confirmed || cancelled || msgs.length > seen);
      if (cancelled) return await abort();
      if (confirmed) break;
      // follow-up arrived → back to Do
      stage = 'do';
      status = 'active';
      continue;
    }
  }

  // ── PR (optional) ──
  stage = 'pr';
  status = 'active';
  await publish();
  if (cancelled) return await abort();
  if (input.project.openGithubPr) {
    const opened = await withResolve('pr', () => core.openPr(world as any, target));
    if (opened) pr = opened;
  }

  // ── Merge (point of no return) ──
  const domain = `${world!.repo ?? input.projectId}:${target}`;
  let sha: string | undefined;
  for (;;) {
    stage = 'merge';
    status = 'active';
    mergeGranted = false;
    await publish();
    if (cancelled) return await abort();

    await coord.enqueueMerge(domain, taskId);
    // Wait for the grant; allow cancel only before it.
    while (!mergeGranted && !cancelled) {
      mergeQueuePos = await coord.mergeQueuePosition(domain, taskId);
      await publish();
      await condition(() => mergeGranted || cancelled, '5s');
    }
    if (cancelled && !mergeGranted) {
      await coord.cancelMerge(domain, taskId);
      return await abort();
    }
    mergeQueuePos = { position: 0, total: mergeQueuePos?.total ?? 1 };
    await publish();

    let result;
    try {
      // Best-effort merge agent turn (resolve conflicts / ensure tests pass)…
      await long
        .runAgentTurn({
          taskId,
          role: 'merge',
          worldHandle: world as any,
          messages: [{ id: 'merge', role: 'user', text: `Prepare branch for merge into ${target}.`, ts: 0 }],
          session,
          task: input,
          bindings: { reviewInfo: reviewInfo?.summary ?? '' },
        })
        .catch((e) => log.warn('merge agent turn failed; proceeding to authoritative merge', { e: String(e) }));
      // …then the authoritative, deterministic merge that guarantees work lands.
      result = await long.finalizeMergeActivity(world as any, target);
    } catch (err) {
      result = { merged: false, landedFiles: [], note: String(err) };
    }
    await coord.releaseMerge(domain, taskId);

    if (result.merged) {
      sha = result.sha;
      pointOfNoReturnPassed = true;
      break;
    }
    // Merge problem → escalate to a human, who can retry (loop) or cancel.
    error = `merge failed: ${result.conflict ?? result.note ?? 'unknown'}`;
    reviewInfo = { ...reviewInfo, summary: error };
    stage = 'escalated';
    status = 'blocked';
    retryRequested = false;
    await publish();
    await condition(() => retryRequested || cancelled);
    if (cancelled) return await abort();
    error = undefined;
  }

  stage = 'done';
  status = 'done';
  reviewInfo = { ...reviewInfo, summary: `Merged into ${target} at ${world!.repo ?? '(scratch repo)'} as ${sha?.slice(0, 8)}.` };
  await publish();
  await core.destroyWorld(world as any);
  return { stage, sha };
  } catch (e) {
    if (e instanceof Cancelled) return await abort();
    throw e;
  }

  // ── helpers ──
  async function abort() {
    stage = 'cancelled';
    status = 'cancelled';
    await publish();
    if (world) await core.destroyWorld(world as any);
    return { stage } as { stage: Stage };
  }
}

function lastOutputs(msgs: Message[]): string {
  return msgs.slice(-6).map((m) => `${m.role}: ${m.text}`).join('\n');
}

/** Extract a meaningful message, following Temporal's wrapped `.cause` chain. */
function describeError(err: any): string {
  const parts: string[] = [];
  let e: any = err;
  for (let depth = 0; e && depth < 6; depth++) {
    if (e.message && !parts.includes(e.message)) parts.push(e.message);
    e = e.cause;
  }
  return parts.join(' → ') || String(err);
}
