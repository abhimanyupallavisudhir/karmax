import {
  proxyActivities,
  defineSignal,
  defineUpdate,
  defineQuery,
  setHandler,
  condition,
  executeChild,
  workflowInfo,
  CancellationScope,
  isCancellation,
  ApplicationFailure,
  log,
} from '@temporalio/workflow';
import type { coreActivities } from '../activities/core.js';
import type { coordinatorActivities } from '../activities/coordinator.js';
import { SIG_MERGE_GRANTED, SIG_ACCOUNT_GRANTED } from '../coordinators/names.js';
import { editableInFlight } from '../platform/mutability.js';
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
export const accountGrantedSignal = defineSignal<[{ turnId: string; accountId: string; configHome: string }]>(SIG_ACCOUNT_GRANTED);
export const setTargetUpdate = defineUpdate<boolean, [string]>('setTarget');
/**
 * Generic in-flight param edit (SPEC §4.5/§5.5). Validated: the validator rejects
 * (before admission, SPEC §2) any field not currently editable per its declared
 * `mutable` window; the handler applies the accepted fields to live state and
 * returns what it applied. `setTarget` above is the back-compat shim for `target`.
 */
export const updateParamsUpdate = defineUpdate<{ applied: string[] }, [Record<string, unknown>]>('updateParams');
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
  // Flips true when `target` becomes load-bearing — a PR opened against it, or the
  // merge enqueue keyed by it — closing the in-flight target-edit window (SPEC §5.5).
  let targetLocked = false;
  let mergeGranted = false;
  let seen = 0; // messages the Do agent has already processed
  // Account/token leasing (SPEC §6.2): per-turn lease of a connected login.
  const accountGrants = new Map<string, { accountId: string; configHome: string }>();
  let turnSeq = 0;
  let accountPool = 0; // populated after setup; 0 ⇒ no leasing (zero behavior change)
  // Mid-turn cancel (SPEC §5.6): the running turn's cancellation scope, so a cancel
  // signal aborts the in-flight agent turn instead of waiting for it to finish.
  let activeTurn: CancellationScope | undefined;

  const kind = input.project.worldProvider === 'container' ? 'container' : 'worktree';

  // ── in-flight param edits (SPEC §4.5/§5.5) ──
  // A working copy of the per-role agent overrides that later turns re-read, so a
  // merge/resolve agent swapped mid-flight actually takes effect. The Do agent runs
  // from the first turn holding a live session, so it stays frozen (use a follow-up).
  const liveInput: SoftwareDevInput = { ...input, agents: { ...(input.agents ?? {}) } };
  // Params the workflow has already consumed (value now load-bearing). `target` is
  // consumed once locked (PR open / merge enqueue); merge/resolve agents when their
  // turn runs.
  const consumed = new Set<string>();
  const isConsumed = (name: string): boolean => (name === 'target' ? targetLocked : consumed.has(name));
  const paramEditable = (name: string): boolean =>
    !cancelled && editableInFlight(input.paramWindows?.[name], { consumed: isConsumed(name), pointOfNoReturnPassed });
  const editableParamsNow = (): string[] => Object.keys(input.paramWindows ?? {}).filter(paramEditable);
  /** Update validator: reject (before admission, SPEC §2) any field not editable now. */
  function validateParamPatch(patch: Record<string, unknown>): void {
    const names = Object.keys(patch);
    if (!names.length) throw ApplicationFailure.nonRetryable('no params to edit', 'ParamEditEmpty');
    for (const name of names)
      if (!paramEditable(name))
        throw ApplicationFailure.nonRetryable(
          `"${name}" can't be edited now — it's frozen after queue, already in use, or past the point of no return`,
          'ParamLocked',
          name,
        );
  }
  /** Apply an already-validated patch to live state. `target` is re-read at PR/merge;
   *  `agent:<role>` overrides are re-read when that role's turn runs. */
  function applyParamPatch(patch: Record<string, unknown>): { applied: string[] } {
    const applied: string[] = [];
    if (typeof patch.target === 'string' && patch.target) {
      target = patch.target;
      applied.push('target');
    }
    for (const role of ['merge', 'resolve']) {
      const key = `agent:${role}`;
      const spec = patch[key];
      if (spec && typeof spec === 'object' && (spec as { provider?: string }).provider) {
        liveInput.agents = { ...(liveInput.agents ?? {}), [role]: spec as NonNullable<SoftwareDevInput['agents']>[string] };
        applied.push(key);
      }
    }
    return { applied };
  }

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
      enabled: paramEditable('target'),
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
        targetLocked,
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
      // The task-scope params the UI may edit right now (SPEC §5.5): declared
      // `untilUsed` fields not yet consumed. `queue` fields never appear here.
      editableParams: editableParamsNow(),
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
    if (!pointOfNoReturnPassed) {
      cancelled = true;
      activeTurn?.cancel(); // abort an in-flight agent turn immediately (SPEC §5.6)
    }
  });
  setHandler(retrySignal, () => {
    retryRequested = true;
  });
  setHandler(mergeGrantedSignal, () => {
    mergeGranted = true;
  });
  setHandler(accountGrantedSignal, (g) => {
    accountGrants.set(g.turnId, { accountId: g.accountId, configHome: g.configHome });
  });
  setHandler(setTargetUpdate, (b) => {
    // Back-compat shim over the same window as updateParams({ target }), but
    // keeps the legacy boolean contract (returns false rather than rejecting).
    if (!paramEditable('target')) return false;
    target = b;
    return true;
  });
  setHandler(updateParamsUpdate, (patch) => applyParamPatch(patch), { validator: validateParamPatch });

  // ── Resolve wrapper (SPEC §5.2) ──
  async function withResolve<T>(stageName: string, fn: () => Promise<T>): Promise<T> {
    let lastError = '';
    for (;;) {
      let attempt = 0;
      for (; attempt <= MAX_RESOLVE_ATTEMPTS; attempt++) {
        try {
          return await fn();
        } catch (err) {
          if (cancelled || isCancellation(err)) throw err; // mid-turn cancel: don't resolve/retry
          lastError = describeError(err);
          error = lastError;
          const prevStage = stage;
          stage = 'resolve';
          await publish();
          const auto = await core.autoResolve({ taskId, stage: stageName, error });
          if (!auto.resolved && world) {
            // The resolve agent is about to run — freeze `agent:resolve` (SPEC §5.5).
            consumed.add('agent:resolve');
            // Escalate to the Resolve agent with a context bundle.
            const r = await leasedTurn((accountConfigHome) =>
              long.runAgentTurn({
                taskId,
                role: 'resolve',
                worldHandle: world as any,
                messages: [{ id: `r${attempt}`, role: 'user', text: `Fix the ${stageName} failure.`, ts: 0 }],
                task: liveInput,
                bindings: { stage: stageName, error: error ?? '', transcript: lastOutputs(msgs), skills: '' },
                accountConfigHome,
              }),
            );
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

  /**
   * Lease a connected login for one turn (SPEC §6.2), then return it. Activates
   * only when the account pool is non-empty — otherwise the turn runs exactly as
   * before with the profile's own home. Never hangs: if no grant arrives within
   * the park window, it falls back to the profile default.
   */
  async function leasedTurn<T>(fn: (accountConfigHome?: string) => Promise<T>): Promise<T> {
    if (accountPool <= 0) return await runCancellable(() => fn(undefined));
    const turnId = `${taskId}#${turnSeq++}`;
    await coord.leaseAccount(taskId, turnId);
    await condition(() => accountGrants.has(turnId) || cancelled, '6 hours');
    const grant = accountGrants.get(turnId);
    accountGrants.delete(turnId);
    try {
      return await runCancellable(() => fn(grant?.configHome));
    } finally {
      // returnAccount runs in the parent (uncancelled) scope so the lease is freed.
      if (grant) await coord.returnAccount(grant.accountId).catch(() => undefined);
    }
  }

  // Run one agent turn in a cancellable scope; a cancel signal aborts it at once.
  async function runCancellable<T>(fn: () => Promise<T>): Promise<T> {
    const scope = new CancellationScope({ cancellable: true });
    activeTurn = scope;
    try {
      return await scope.run(fn);
    } finally {
      activeTurn = undefined;
    }
  }

  try {
  // ── Setup ──
  await publish();
  world = (await withResolve('setup', () =>
    core.createWorld({ taskId, repo: input.project.repos?.[0], base, target, copyGlobs: input.project.copyGlobs, kind }),
  )) as WorldHandleLike;
  // One-shot probe: does the account pool exist? (self-configuring; 0 = off)
  accountPool = await coord.accountPoolSize().catch(() => 0);

  // ── Do ⇄ Review ──
  for (stage = 'do', status = 'active'; ; ) {
    await publish();
    if (cancelled) return await abort();

    const turn = await withResolve('do', () =>
      leasedTurn((accountConfigHome) =>
        long.runAgentTurn({
          taskId,
          role: 'do',
          worldHandle: world as any,
          messages: msgs,
          session,
          task: liveInput,
          accountConfigHome,
        }),
      ),
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
    // Opening a PR binds it to `target`; close the edit window before we do (SPEC §2).
    targetLocked = true;
    await publish();
    const opened = await withResolve('pr', () => core.openPr(world as any, target));
    if (opened) pr = opened;
  }

  // ── Merge (point of no return) ──
  // Lock the target before committing it to a merge-queue domain: the queue is
  // keyed by target, so from here it's load-bearing and no longer editable (SPEC §5.5).
  // Set before any await so no queued edit can slip in and desync the domain.
  targetLocked = true;
  let sha: string | undefined;
  for (;;) {
    stage = 'merge';
    status = 'active';
    mergeGranted = false;
    await publish();
    if (cancelled) return await abort();

    const domain = `${world!.repo ?? input.projectId}:${target}`;
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

    // The merge agent is about to run — freeze `agent:merge` (SPEC §5.5).
    consumed.add('agent:merge');
    let result;
    try {
      // Best-effort merge agent turn (resolve conflicts / ensure tests pass)…
      await leasedTurn((accountConfigHome) =>
        long.runAgentTurn({
          taskId,
          role: 'merge',
          worldHandle: world as any,
          messages: [{ id: 'merge', role: 'user', text: `Prepare branch for merge into ${target}.`, ts: 0 }],
          session,
          task: liveInput,
          bindings: { reviewInfo: reviewInfo?.summary ?? '' },
          accountConfigHome,
        }),
      ).catch((e) => {
        if (isCancellation(e)) throw e; // pre-merge cancel → abort, don't merge
        log.warn('merge agent turn failed; proceeding to authoritative merge', { e: String(e) });
      });
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
    if (e instanceof Cancelled || (isCancellation(e) && cancelled)) return await abort();
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
