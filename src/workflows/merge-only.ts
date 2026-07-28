import {
  proxyActivities,
  defineSignal,
  defineUpdate,
  defineQuery,
  setHandler,
  condition,
  workflowInfo,
  ApplicationFailure,
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
  TaskPullRequest, releaseWorldOnCompletion, remotePolicyOf, remoteWorldProvider,
  samePosition, MERGE_POLL } from './contract.js';
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

/** A task parked in the merge queue no longer republishes its whole view every
 *  five seconds — see `boundedMergeWait`. */
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
  // Poll the merge queue coarsely and republish only on change: the view carries
  // every message and transcript, and Temporal hard-caps history at 50MB, so the
  // old 5s unconditional publish turned a long queue wait into a TERMINATE.
  boundedMergeWait = false,
): Promise<{ stage: Stage; sha?: string }> {
  const agentTurns = awaitTurnCancellation ? cancellationAwareTurns : turns;
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
    if (stage === 'review') return [{ name: 'confirm', kind: 'signal', label: 'Approve & merge', enabled: true }, { name: 'followUp', kind: 'signal', label: 'Request changes', enabled: true, args: [{ name: 'text', type: 'text', required: true }] }, cancel];
    if (stage === 'merge' || stage === 'pr') return [cancel];
    return [cancel];
  }
  function view(): TaskView {
    return {
      taskId, title: input.title, workflow: 'merge-only', stage, status, messages: msgs, reviewInfo,
      actions: actions(), state: { checks, mergeGranted, targetLocked }, branch: world?.branch, base, targetBranch: target,
      world, worldPath: world?.workdir ?? world?.root, parentTaskId: input.parentTaskId, pointOfNoReturnPassed,
      editableParams: editableParamsNow(), waitingFor, agentTurn, mergeQueue,
      pr, ...(prs.length ? { prs } : {}),
      updatedAt: workflowInfo().historyLength,
    };
  }
  const publish = async () => core.publishView(taskId, view());
  const leaser = managedTurns
    ? createAgentTurnLeaser(core, coord, {
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
    } catch {
      return undefined;
    }
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
        const decision = await runConfirm(layer);
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
  if (cancelled || (input.workflowEdit && !checks?.passed && !confirmed)) {
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
  // The authoritative repo keys the domain (see mergeDomains in software-dev):
  // a cloud world from a local checkout serializes with worktree worlds of it.
  const domain = `${world!.repos?.[0]?.localPath ?? world!.repo ?? input.projectId}:${target}`;
  await coord.enqueueMerge(domain, taskId);
  if (managedTurns) {
    status = 'waiting';
    waitingFor = { kind: 'mergeSlot', detail: `Waiting to merge into ${target}` };
  }
  while (!mergeGranted && !cancelled) {
    if (managedTurns) {
      const pos = await coord.mergeQueuePosition(domain, taskId);
      if (!boundedMergeWait || !samePosition(pos, mergeQueue)) {
        mergeQueue = pos;
        await publish();
      }
    }
    await condition(() => mergeGranted || cancelled, boundedMergeWait ? MERGE_POLL : '5s');
  }
  if (cancelled && !mergeGranted) {
    await coord.cancelMerge(domain, taskId);
    stage = 'cancelled';
    status = 'cancelled';
    await publish();
    return { stage };
  }
  if (managedTurns) {
    waitingFor = undefined;
    status = 'active';
    mergeQueue = { position: 0, total: mergeQueue?.total ?? 1, current: taskId };
    await publish();
  }
  const result = await long.finalizeMergeActivity(world as any, target);
  await coord.releaseMerge(domain, taskId);
  if (!result.merged) {
    stage = 'failed';
    status = 'failed';
    reviewInfo = { ...reviewInfo, summary: `Merge failed: ${result.dirty ? `uncommitted changes in the worktree:\n${result.dirty}` : (result.conflict ?? result.note)}` };
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
