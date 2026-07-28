import {
  proxyActivities,
  defineSignal,
  defineUpdate,
  defineQuery,
  setHandler,
  condition,
  workflowInfo,
  ApplicationFailure,
  isCancellation,
  log,
} from '@temporalio/workflow';
import { ActivityCancellationType } from '@temporalio/common';
import type { coreActivities } from '../activities/core.js';
import type { coordinatorActivities } from '../activities/coordinator.js';
import { SIG_MERGE_GRANTED } from '../coordinators/names.js';
import { editableInFlight } from '../platform/mutability.js';
import { renderConfirmPrompt } from '../domain/confirm-prompt.js';
import { confirmLayersOf } from '../domain/confirm.js';
import { TaskInput, TaskView, Stage, Message, ReviewInfo, DeclaredAction, WorldHandleLike, ConfirmConfig, ConfirmDecision, ConfirmLayer,
  TaskPullRequest, mergeQueueDomains, releaseWorldOnCompletion, remotePolicyOf, remoteWorldProvider } from './contract.js';
import { createAgentTurnLeaser } from './agent-turn-lease.js';

const core = proxyActivities<coreActivities>({ startToCloseTimeout: '5 minutes', retry: { maximumAttempts: 3 } });
const long = proxyActivities<coreActivities>({ startToCloseTimeout: '45 minutes', retry: { maximumAttempts: 1 } });
// Agent turns heartbeat (~1s); a 2-minute gap = dead worker → Temporal retries.
const turns = proxyActivities<coreActivities>({
  startToCloseTimeout: '45 minutes',
  heartbeatTimeout: '2 minutes',
  retry: { maximumAttempts: 3, initialInterval: '10s', backoffCoefficient: 2 },
});
const cancellationAwareTurns = proxyActivities<coreActivities>({
  startToCloseTimeout: '45 minutes',
  heartbeatTimeout: '2 minutes',
  retry: { maximumAttempts: 3, initialInterval: '10s', backoffCoefficient: 2 },
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});
const coord = proxyActivities<coordinatorActivities>({ startToCloseTimeout: '30s' });
// Coordinator calls with a BOUNDED retry budget (mirrors software-dev's
// `boundedCoord`). Temporal's default is `maximumAttempts: 0` = UNLIMITED, so a
// deterministically-failing enqueueMerge / requestAgentSlot retried forever froze
// the task in place with no route to a human. Failing after a few attempts turns
// it into an ordinary stage error the platform can surface and recover.
// Pinned to its own behavior version: activity retry options are part of the
// recorded ScheduleActivityTask command, so an in-flight execution must keep
// scheduling with the proxy its history was written against.
const boundedCoord = proxyActivities<coordinatorActivities>({
  startToCloseTimeout: '30s',
  retry: { maximumAttempts: 5, initialInterval: '1s', backoffCoefficient: 2 },
});

export const confirmSignal = defineSignal('confirm');
export const followUpSignal = defineSignal<[Message]>('followUp');
export const cancelSignal = defineSignal('cancel');
export const mergeGrantedSignal = defineSignal(SIG_MERGE_GRANTED);
/** In-flight param edit (SPEC §4.5/§5.5). merge-only exposes only `target` as
 *  editable — until it's committed to the merge queue. */
export const updateParamsUpdate = defineUpdate<{ applied: string[] }, [Record<string, unknown>]>('updateParams');
export const viewQuery = defineQuery<TaskView>('view');
/** Live follow-up feed for in-flight injection (SPEC §5.6): a running turn polls
 *  this to inject messages queued at/after `fromIndex` without waiting a full turn. */
export const pendingMessagesQuery = defineQuery<Message[], [string, number]>('pendingMessages');

export interface MergeOnlyInput extends TaskInput {
  /** Run workflow-repo edit checks (tests + replay-compat) before merge (SPEC §4.4). */
  workflowEdit?: boolean;
  autoConfirm?: boolean;
}

/**
 * merge-only (SPEC §4.7): the review-and-merge half of software-dev (no Do
 * stage). Starts at the Review gate, then optional PR, then merge under the
 * queue. Used to review agents' PRs, including edits to workflow repos — so the
 * PR-test-approve gate (§4.4) is dogfooded, not separate machinery.
 */
export async function mergeOnly(input: MergeOnlyInput): Promise<{ stage: Stage; sha?: string }> {
  return mergeOnlyImpl(input, true);
}

/** Durable non-blocking host admission. */
export async function mergeOnlyV1_2(input: MergeOnlyInput): Promise<{ stage: Stage; sha?: string }> {
  return mergeOnlyImpl(input, true, true);
}

/** Cancellation waits for the live provider turn to stop. */
export async function mergeOnlyV1_3(input: MergeOnlyInput): Promise<{ stage: Stage; sha?: string }> {
  return mergeOnlyImpl(input, true, true, true);
}

/** Full GitHub pull-request lifecycle under remote policy 'pr'. */
export async function mergeOnlyV1_4(input: MergeOnlyInput): Promise<{ stage: Stage; sha?: string }> {
  return mergeOnlyImpl(input, true, true, true, true);
}

/**
 * Per-repo merge-queue serialization (the same `mergeQueueDomains` keys
 * software-dev uses) plus a bounded coordinator retry budget. Both change the
 * recorded command stream — the domain strings a merge enqueues under, and the
 * retry options on every coordinator activity — so they need their own pinned
 * version rather than silently rewriting in-flight histories.
 */
export async function mergeOnlyV1_5(input: MergeOnlyInput): Promise<{ stage: Stage; sha?: string }> {
  return mergeOnlyImpl(input, true, true, true, true, true);
}

/** Immutable replay entry for executions pinned to mergeOnly@1.0.0. */
export async function mergeOnlyV1(input: MergeOnlyInput): Promise<{ stage: Stage; sha?: string }> {
  return mergeOnlyImpl(input, false);
}

async function mergeOnlyImpl(
  input: MergeOnlyInput,
  managedTurns: boolean,
  durableAdmission = false,
  awaitTurnCancellation = false,
  // New activity calls inside an existing stage break replay for executions
  // recorded before them, so the PR lifecycle is pinned to its own version.
  githubPrLifecycle = false,
  // Per-repo merge-queue domains (mergeQueueDomains) + bounded coordinator
  // retries. Both alter recorded commands (domain strings; activity retry
  // options), so they are pinned to their own version.
  serializedMergeDomains = false,
): Promise<{ stage: Stage; sha?: string }> {
  const agentTurns = awaitTurnCancellation ? cancellationAwareTurns : turns;
  const coordinator = serializedMergeDomains ? boundedCoord : coord;
  // These two ride the same 1.5.0 pin, because each changes the commands a workflow
  // task emits at a point older executions have already recorded:
  //  - clearing `confirmed` at the Review gate: an execution confirmed before the
  //    gate opened recorded that gate returning INSTANTLY, so clearing on replay
  //    parks where history says it proceeded.
  //  - routing the cancel exits through `finishCancelled`: that publishes and calls
  //    `destroyWorld`, commands the older recordings simply do not contain.
  // Replaying either against an older pin is a NonDeterminismError that wedges the
  // execution, so older versions deliberately keep the old (buggier) behavior.
  const clearsConfirmOnGate = serializedMergeDomains;
  const cancelReleasesWorld = serializedMergeDomains;
  const taskId = input.taskId;
  let stage: Stage = 'setup';
  let status: TaskView['status'] = 'active';
  const msgs: Message[] = input.prompt || input.images?.length
    ? [{ id: 'm0', role: 'user', text: input.prompt ?? '', ts: input.createdAt ?? 0, ...(input.images?.length ? { images: input.images } : {}) }]
    : [];
  const base = input.base ?? input.project.defaultBase ?? 'main';
  let target = input.target ?? input.project.defaultTarget ?? base;
  let confirmed = false;
  let cancelled = false;
  let world: WorldHandleLike | undefined;
  // Who confirms at the Review gate (SPEC §5.2): the ordered confirm layers, played
  // sequentially — every layer must approve; [] ⇒ auto-confirm. Legacy {mode} shapes
  // and the `autoConfirm` flag normalize to their layer equivalents. The route is
  // `untilUsed` (SPEC §4.5/§5.5), so an in-flight edit replaces these layers and the
  // gate re-reads them on every iteration; `confirmEpoch` bumps on each accepted edit
  // so a gate parked on a stale route replays from its first layer.
  let confirmLayers = confirmLayersOf(input.confirm, !!input.autoConfirm);
  let confirmEpoch = 0;
  // Set once the Review gate has fully passed — the route is load-bearing no longer.
  let confirmConsumed = false;
  let reviewInfo: ReviewInfo | undefined;
  let mergeGranted = false;
  let checks: { passed: boolean; detail?: string } | undefined;
  let waitingFor: TaskView['waitingFor'];
  let agentTurn: TaskView['agentTurn'];
  let mergeQueue: { position: number; total: number; current?: string } | undefined;
  let pointOfNoReturnPassed = false;
  let pr: TaskPullRequest | undefined;
  let prs: TaskPullRequest[] = [];
  // `target` is editable in-flight until committed to the merge queue / a PR opens.
  let targetLocked = false;
  const isConsumed = (name: string): boolean =>
    name === 'target' ? targetLocked : name === 'confirm' ? confirmConsumed : false;
  const paramEditable = (name: string): boolean =>
    !cancelled && editableInFlight(input.paramWindows?.[name], { consumed: isConsumed(name), pointOfNoReturnPassed });
  const editableParamsNow = (): string[] => Object.keys(input.paramWindows ?? {}).filter(paramEditable);
  function validateParamPatch(patch: Record<string, unknown>): void {
    const names = Object.keys(patch);
    if (!names.length) throw ApplicationFailure.nonRetryable('no params to edit', 'ParamEditEmpty');
    for (const name of names) {
      if (!paramEditable(name))
        throw ApplicationFailure.nonRetryable(
          name === 'confirm'
            ? `the Review route can't be changed now — this task's Review gate has already passed`
            : `"${name}" can't be edited now — frozen after queue, in use, or past the point of no return`,
          'ParamLocked', name);
      // Shape only; whether a human audience resolves is asserted platform-side.
      if (name === 'confirm' && (!patch.confirm || typeof patch.confirm !== 'object'))
        throw ApplicationFailure.nonRetryable('the Review route must be a confirm config', 'ParamLocked', name);
    }
  }
  function applyParamPatch(patch: Record<string, unknown>): { applied: string[] } {
    const applied: string[] = [];
    if (typeof patch.target === 'string' && patch.target) {
      target = patch.target;
      applied.push('target');
    }
    if (patch.confirm && typeof patch.confirm === 'object') {
      confirmLayers = confirmLayersOf(patch.confirm as ConfirmConfig);
      confirmEpoch++;
      applied.push('confirm');
    }
    return { applied };
  }

  function actions(): DeclaredAction[] {
    const cancel: DeclaredAction = { name: 'cancel', kind: 'signal', label: 'Cancel', enabled: !pointOfNoReturnPassed, danger: true };
    // INTENDED: merge-only has no Do stage, so there is nothing to send work back
    // to. It used to advertise a "Request changes" follow-up here, but nothing
    // reacted to it — the signal only appended to `msgs` and neither the layer
    // gate nor the final `condition` watched the transcript, so clicking it left
    // the task parked exactly as before. The honest affordances at this gate are
    // Approve (merge it) and Cancel (don't). Feedback belongs on the branch's
    // originating task. `followUpSignal` itself is kept: the transcript is still
    // the record of what was said, and the platform delivers messages here.
    if (stage === 'review') return [{ name: 'confirm', kind: 'signal', label: 'Approve & merge', enabled: true }, cancel];
    if (stage === 'merge' || stage === 'pr') return [cancel];
    return [cancel];
  }
  function view(): TaskView {
    return {
      taskId, title: input.title, workflow: 'merge-only', stage, status, messages: msgs, reviewInfo,
      actions: actions(),
      state: { checks, mergeGranted, targetLocked,
        // The serialization keys this task merges under, so the UI (and tests)
        // can see it locks the same domains software-dev would for these repos.
        ...(serializedMergeDomains && world ? { mergeDomains: mergeQueueDomains(world, target, input.projectId) } : {}) },
      branch: world?.branch, base, targetBranch: target,
      world, worldPath: world?.workdir ?? world?.root, parentTaskId: input.parentTaskId, pointOfNoReturnPassed,
      editableParams: editableParamsNow(), waitingFor, agentTurn, mergeQueue,
      pr, ...(prs.length ? { prs } : {}),
      updatedAt: workflowInfo().historyLength,
    };
  }
  const publish = async () => core.publishView(taskId, view());
  const leaser = managedTurns
    ? createAgentTurnLeaser(core, coordinator, {
        taskId,
        projectId: input.projectId,
        task: () => input,
        world: () => world,
        status: () => status,
        setStatus: (next) => { status = next; },
        setWaitingFor: (next) => { waitingFor = next; },
        setAgentTurn: (next) => { agentTurn = next; },
        cancelled: () => cancelled,
        publish,
      }, durableAdmission)
    : undefined;

  /** Run one Confirm-agent turn (SPEC §5.2): review the branch, return a verdict, or
   *  undefined on failure so the caller leaves the gate to a human. */
  async function runConfirm(layer: ConfirmLayer): Promise<ConfirmDecision | undefined> {
    try {
      // The layer's own agent spec drives this turn (each agent layer can run a
      // different reviewer); a spec-less layer falls back to the confirm profile.
      const { kind: _kind, prompt: _prompt, ...layerSpec } = layer;
      const task = layerSpec.provider ? { ...input, agents: { ...(input.agents ?? {}), confirm: { ...layerSpec, provider: layerSpec.provider } } } : input;
      // Fresh turn each Review so the reviewer judges the current branch; a mid-turn
      // retry still resumes via runAgentTurn heartbeat details. The review request
      // (task prompt + what's under review, template user-editable via the confirmer
      // field) is delivered as the conversation message, like software-dev's.
      const request = renderConfirmPrompt(layer.prompt ?? input.confirm?.prompt, {
        title: input.title,
        prompt: input.prompt,
        response: reviewInfo?.summary ?? '(no summary)',
        reviewInfo: reviewInfo?.summary ?? '',
        changedFiles: (reviewInfo?.changedFiles ?? []).join('\n'),
        transcript: msgs.slice(-6).map((m) => `${m.role}: ${m.text}`).join('\n'),
      });
      const invoke = (lease?: {
        accountConfigHome?: string;
        accountApiKeyHandle?: string;
        accountCredentialKind?: 'login' | 'ambient' | 'key';
        accountCredentialProvider?: string;
        agentTurnId: string;
        agentAdmissionManaged?: true;
        agentSlotGranted?: true;
      }) =>
        agentTurns.runAgentTurn({
          taskId,
          role: 'confirm',
          worldHandle: world as any,
          messages: [{ id: 'c-in-0', role: 'user', text: request, ts: 0 }],
          task,
          bindings: {
            reviewInfo: reviewInfo?.summary ?? '',
            changedFiles: (reviewInfo?.changedFiles ?? []).join('\n'),
            transcript: msgs.slice(-6).map((m) => `${m.role}: ${m.text}`).join('\n'),
          },
          ...(lease ? lease : {}),
        });
      const ct = leaser ? await leaser.run('confirm', invoke) : await invoke();
      return ct.confirmDecision;
    } catch (err) {
      // A mid-turn cancel (SPEC §5.6) aborts this turn's activity. Swallowing that
      // as "no verdict" quietly degraded a cancelled gate to "waiting for a human";
      // rethrow it (as just-do does) so the caller can route to the graceful cancel
      // exit that also releases the world. Every other failure still degrades to the
      // human gate — a reviewer agent that blows up must not auto-approve.
      if (isCancellation(err) && cancelReleasesWorld) throw err;
      return undefined;
    }
  }

  /**
   * The single cancel exit. EVERY path that ends the task as `cancelled` must go
   * through here: publish the terminal state, then release the world.
   *
   * Why it is shared: the cancel-while-queued exit used to `return { stage:
   * 'cancelled' }` straight after `cancelMerge`, skipping `destroyWorld`
   * entirely. For a worktree world that strands a checkout; for a cloud world it
   * is a leaked, still-billed sandbox whose runner lease is only ever released by
   * `destroyWorld` (activities/core.ts). Local worlds are left in place for
   * inspection only when the workflow ends successfully — a cancelled task's
   * world is always released, exactly as just-do and software-dev do.
   */
  async function finishCancelled(): Promise<{ stage: Stage }> {
    stage = 'cancelled';
    status = 'cancelled';
    await publish();
    if (world) {
      const remoteWorld = releaseWorldOnCompletion(world);
      await core.destroyWorld(world as any);
      if (remoteWorld) {
        world = undefined;
        await publish();
      }
    }
    return { stage };
  }

  setHandler(viewQuery, view);
  setHandler(pendingMessagesQuery, (_role, fromIndex) => msgs.slice(Math.max(0, fromIndex)));
  setHandler(confirmSignal, () => {
    confirmed = true;
  });
  setHandler(followUpSignal, (m) => {
    if (!msgs.some((candidate) => candidate.id === m.id))
      msgs.push({ ...m, ts: m.ts || msgs.length });
  });
  setHandler(cancelSignal, () => {
    if (!pointOfNoReturnPassed) {
      cancelled = true;
      leaser?.cancelActive();
    }
  });
  setHandler(mergeGrantedSignal, () => {
    mergeGranted = true;
  });
  setHandler(updateParamsUpdate, (patch) => applyParamPatch(patch), { validator: validateParamPatch });

  await publish();
  // Open a world on the EXISTING branch under review.
  const worldKind = input.project.worldProvider ?? 'worktree';
  world = (await core.createWorld({ taskId, ...(remoteWorldProvider(worldKind) ? { projectId: input.projectId } : {}), repo: input.project.repos?.[0], base: target, branch: input.branch, gitProfile: input.project.gitProfile, kind: worldKind })) as WorldHandleLike;
  if (leaser) await leaser.init();

  // Workflow-repo edits must pass tests + replay-compat before they can merge.
  if (input.workflowEdit) {
    stage = 'review';
    checks = await long.runWorkflowChecks({ taskId, worldHandle: world as any });
    reviewInfo = { summary: `Checks ${checks.passed ? 'passed' : 'FAILED'}.${checks.detail ? ' ' + checks.detail : ''}` };
    if (!checks.passed) {
      log.warn('workflow-edit checks failed; blocking merge');
    }
  }

  stage = 'review';
  status = 'waiting';
  // `confirmed` is a GATE token, not a latch. Clear it on entry to the Review
  // gate, before any await, so nothing that arrives from here on is lost.
  //
  // Why: `confirmSignal` sets the flag at ANY stage, and merge-only never cleared
  // it — a confirm that landed during Setup, or while the workflow-edit checks
  // were still running, pre-approved this gate: the layer loop and the
  // `condition()` below both returned instantly and the branch merged completely
  // unreviewed. A confirm now only counts for a gate that was already open when
  // it arrived. The legitimate race (someone clicking Approve between our
  // `publish()` and the `condition()` park) is preserved, because the clear
  // happens strictly BEFORE the publish that advertises the gate. Same fix, same
  // reasoning as software-dev.ts and just-do.ts.
  if (clearsConfirmOnGate) confirmed = false;
  // Never confirm a workflow-edit whose checks failed, whatever the confirmer says.
  const mayConfirm = !input.workflowEdit || (checks?.passed ?? true);
  if (mayConfirm) {
    // Play the confirm layers in order (SPEC §5.2); every layer must approve.
    // [] ⇒ auto-confirm. There is no Do stage to send a `revise` back to, so a
    // revise / no-verdict agent layer leaves the rest of the gate to a human.
    // `confirmLayers` is re-read every iteration, never captured — an edit that lands
    // while the gate is parked replays it from the first layer (see `confirmEpoch`).
    let leftToHuman = false;
    let li = 0;
    while (!cancelled && !leftToHuman) {
      const epoch = confirmEpoch;
      if (li >= confirmLayers.length) break;
      const layer = confirmLayers[li]!;
      if (layer.kind === 'agent') {
        await publish();
        let decision: ConfirmDecision | undefined;
        try {
          decision = await runConfirm(layer);
        } catch (err) {
          // Cancelled mid-review (runConfirm rethrows cancellation). Take the
          // graceful exit rather than letting the CancelledFailure escape the
          // workflow — an escaped failure would terminate the execution with the
          // world (and, remotely, its billed sandbox) still allocated.
          if (isCancellation(err)) return await finishCancelled();
          throw err;
        }
        if (confirmEpoch !== epoch) { li = 0; continue; } // verdict was about a route since replaced
        if (decision?.action === 'confirm') { li++; continue; }
        if (decision?.action === 'reject') {
          if (decision.text) msgs.push({ id: `cr${msgs.length}`, role: 'system', text: `Confirm agent rejected: ${decision.text}`, ts: msgs.length });
          cancelled = true;
        } else {
          leftToHuman = true;
        }
      } else {
        // A human layer: one Approve click passes ONE layer.
        waitingFor = { kind: 'human', audience: layer.audience?.length ? layer.audience : ['@creator'] };
        await publish();
        await condition(() => confirmed || cancelled || confirmEpoch !== epoch);
        waitingFor = undefined;
        if (confirmEpoch !== epoch) { li = 0; confirmed = false; continue; }
        confirmed = false; // consumed by this layer
        li++;
      }
    }
    if (!cancelled && !leftToHuman) confirmed = true;
    if (leftToHuman) waitingFor = { kind: 'human', audience: ['@creator'] };
  }
  // The gate has played (or was blocked by failing checks); the route is load-bearing
  // no longer, so it freezes here rather than at queue time (SPEC §4.5/§5.5).
  confirmConsumed = true;
  await publish();
  await condition(() => confirmed || cancelled);
  waitingFor = undefined;
  if (cancelled || (input.workflowEdit && !checks?.passed && !confirmed)) return await finishCancelled();

  if (remotePolicyOf(input.project) === 'pr') {
    targetLocked = true; // opening a PR binds it to `target` (SPEC §2)
    prs = await core.openPr(world as any, target, { title: input.title, summary: reviewInfo?.summary }) ?? [];
    pr = prs[0];
    if (prs.length) reviewInfo = { ...reviewInfo,
      links: [...(reviewInfo?.links ?? []), ...prs.map((p) => ({ label: prs.length > 1 ? `PR (${p.repo})` : 'PR', url: p.url }))] };
    // No publish here: the merge stage below opens with one, and adding an
    // activity call inside a stage older pinned versions also run would break
    // their replay.
  }

  stage = 'merge';
  if (managedTurns) status = 'active';
  await publish();
  // Commit `target` to the merge-queue domain — no await between locking and
  // reading it, so a queued edit can't desync the domain (SPEC §5.5).
  targetLocked = true;
  // One merge-queue domain per repo this task actually merges, computed by the
  // SAME pure function software-dev uses (mergeQueueDomains, domain/types.ts).
  //
  // The old ad-hoc key `${world.repos[0].localPath ?? world.repo ?? projectId}:
  // ${target}` was wrong twice over: it locked only repo[0] (a merge-only world
  // routinely carries the project-wiki companion repo alongside the development
  // one, and every other repo merged unserialized), and when a repo pins its own
  // `target` — or when `localPath` is unset and `repo.repo !== world.repo` — it
  // produced a DIFFERENT string from the one software-dev computes for the same
  // repo+branch, so the two workflows silently never serialized against each
  // other at all.
  //
  // Acquisition is sequential and in the sorted order mergeQueueDomains returns.
  // That global ordering is what makes concurrent multi-repo merges deadlock-free
  // (SPEC §6.1): every task requests shared repos in the same sequence, so the
  // wait-for graph cannot form a cycle. Do NOT reorder or parallelize it — and
  // acquiring one at a time also keeps the payload-less grant signal unambiguous.
  const domains = serializedMergeDomains
    ? mergeQueueDomains(world, target, input.projectId)
    : [`${world!.repos?.[0]?.localPath ?? world!.repo ?? input.projectId}:${target}`];
  const held: string[] = [];
  let acquireCancelled = false;
  let result: Awaited<ReturnType<typeof long.finalizeMergeActivity>> | undefined;
  // Every acquired slot MUST be released — including when the merge (which runs
  // with `maximumAttempts: 1`) throws. The old bare `releaseMerge` statement after
  // `finalizeMergeActivity` was skipped entirely on a throw, so the domain stayed
  // leased until the coordinator's 5-minute lease timeout and every other task on
  // that repo stalled behind a task that had already failed. Paths that release
  // explicitly empty `held` first, so this never double-releases.
  try {
    for (const domain of domains) {
      mergeGranted = false;
      await coordinator.enqueueMerge(domain, taskId);
      if (managedTurns) {
        status = 'waiting';
        waitingFor = { kind: 'mergeSlot', detail: `Waiting to merge into ${target}` };
      }
      while (!mergeGranted && !cancelled) {
        if (managedTurns) {
          mergeQueue = await coordinator.mergeQueuePosition(domain, taskId);
          await publish();
        }
        await condition(() => mergeGranted || cancelled, '5s');
      }
      if (cancelled && !mergeGranted) {
        await coordinator.cancelMerge(domain, taskId); // drop the slot we're still waiting on
        acquireCancelled = true;
        break;
      }
      held.push(domain);
    }
    if (acquireCancelled) {
      for (const d of held) await coordinator.releaseMerge(d, taskId); // and every slot already held
      held.length = 0; // released here → the finally below is a no-op (command order preserved)
      // Older pins recorded this exit as cancelMerge → publish → return, with no
      // `destroyWorld`; emitting one on replay is a new command at a recorded point.
      // They keep the (leaky) old shape — see `cancelReleasesWorld` above.
      if (!cancelReleasesWorld) {
        stage = 'cancelled';
        status = 'cancelled';
        await publish();
        return { stage };
      }
      return await finishCancelled();
    }
    if (managedTurns) {
      waitingFor = undefined;
      status = 'active';
      mergeQueue = { position: 0, total: mergeQueue?.total ?? 1, current: taskId };
      await publish();
    }
    result = await long.finalizeMergeActivity(world as any, target);
  } finally {
    // Swallow per-domain — see the matching note in software-dev.ts: a bounded
    // release that exhausts its retries must not abort the loop (leaking the
    // remaining slots) nor mask the real merge failure.
    for (const d of held) await coordinator.releaseMerge(d, taskId).catch(() => undefined);
    held.length = 0;
  }
  if (!result?.merged) {
    stage = 'failed';
    status = 'failed';
    reviewInfo = { ...reviewInfo, summary: `Merge failed: ${result?.dirty ? `uncommitted changes in the worktree:\n${result.dirty}` : (result?.conflict ?? result?.note)}` };
    await publish();
    return { stage };
  }
  pointOfNoReturnPassed = true;
  // Remote policy 'push'/'pr' (PLAN-git-config.md §5): best-effort push of the
  // landed target — the merge is the deliverable, a failed push is not fatal.
  if (remotePolicyOf(input.project) !== 'none') {
    const pushed = await core.pushTarget(world as any, target).catch(() => undefined);
    if (githubPrLifecycle && prs.length) {
      prs = await core.finalizePrs(world as any, prs, { target, sha: result.sha, pushed: pushed?.pushed ?? [] })
        .catch(() => prs);
      pr = prs[0];
    }
  }
  stage = 'done';
  status = 'done';
  reviewInfo = { ...reviewInfo, summary: `Merged into ${target} as ${result.sha?.slice(0, 8)}.` };
  await publish();
  const remoteWorld = world ? releaseWorldOnCompletion(world) : false;
  await core.destroyWorld(world as any);
  if (remoteWorld) {
    world = undefined;
    await publish();
  }
  return { stage, sha: result.sha };
}
