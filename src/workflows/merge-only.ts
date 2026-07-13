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
import type { coreActivities } from '../activities/core.js';
import type { coordinatorActivities } from '../activities/coordinator.js';
import { SIG_MERGE_GRANTED } from '../coordinators/names.js';
import { editableInFlight } from '../platform/mutability.js';
import { renderConfirmPrompt } from '../domain/confirm-prompt.js';
import { confirmLayersOf } from '../domain/confirm.js';
import { TaskInput, TaskView, Stage, Message, ReviewInfo, DeclaredAction, WorldHandleLike, ConfirmDecision, ConfirmLayer, remotePolicyOf } from './contract.js';
import { createAgentTurnLeaser } from './agent-turn-lease.js';

const core = proxyActivities<coreActivities>({ startToCloseTimeout: '5 minutes', retry: { maximumAttempts: 3 } });
const long = proxyActivities<coreActivities>({ startToCloseTimeout: '45 minutes', retry: { maximumAttempts: 1 } });
// Agent turns heartbeat (~10s); a 2-minute gap = dead worker → Temporal retries.
const turns = proxyActivities<coreActivities>({
  startToCloseTimeout: '45 minutes',
  heartbeatTimeout: '2 minutes',
  retry: { maximumAttempts: 3, initialInterval: '10s', backoffCoefficient: 2 },
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

/** Immutable replay entry for executions pinned to mergeOnly@1.0.0. */
export async function mergeOnlyV1(input: MergeOnlyInput): Promise<{ stage: Stage; sha?: string }> {
  return mergeOnlyImpl(input, false);
}

async function mergeOnlyImpl(input: MergeOnlyInput, managedTurns: boolean): Promise<{ stage: Stage; sha?: string }> {
  const taskId = input.taskId;
  let stage: Stage = 'setup';
  let status: TaskView['status'] = 'active';
  const msgs: Message[] = input.prompt || input.images?.length
    ? [{ id: 'm0', role: 'user', text: input.prompt ?? '', ts: 0, ...(input.images?.length ? { images: input.images } : {}) }]
    : [];
  const base = input.base ?? input.project.defaultBase ?? 'main';
  let target = input.target ?? input.project.defaultTarget ?? base;
  let confirmed = false;
  let cancelled = false;
  let world: WorldHandleLike | undefined;
  // Who confirms at the Review gate (SPEC §5.2): the ordered confirm layers, played
  // sequentially — every layer must approve; [] ⇒ auto-confirm. Legacy {mode} shapes
  // and the `autoConfirm` flag normalize to their layer equivalents.
  const confirmLayers = confirmLayersOf(input.confirm, !!input.autoConfirm);
  let reviewInfo: ReviewInfo | undefined;
  let mergeGranted = false;
  let checks: { passed: boolean; detail?: string } | undefined;
  let waitingFor: TaskView['waitingFor'];
  let agentTurn: TaskView['agentTurn'];
  let mergeQueue: { position: number; total: number; current?: string } | undefined;
  let pointOfNoReturnPassed = false;
  // `target` is editable in-flight until committed to the merge queue / a PR opens.
  let targetLocked = false;
  const paramEditable = (name: string): boolean =>
    !cancelled && editableInFlight(input.paramWindows?.[name], { consumed: name === 'target' ? targetLocked : false, pointOfNoReturnPassed });
  const editableParamsNow = (): string[] => Object.keys(input.paramWindows ?? {}).filter(paramEditable);
  function validateParamPatch(patch: Record<string, unknown>): void {
    const names = Object.keys(patch);
    if (!names.length) throw ApplicationFailure.nonRetryable('no params to edit', 'ParamEditEmpty');
    for (const name of names)
      if (!paramEditable(name))
        throw ApplicationFailure.nonRetryable(`"${name}" can't be edited now — frozen after queue, in use, or past the point of no return`, 'ParamLocked', name);
  }
  function applyParamPatch(patch: Record<string, unknown>): { applied: string[] } {
    const applied: string[] = [];
    if (typeof patch.target === 'string' && patch.target) {
      target = patch.target;
      applied.push('target');
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
      worldPath: world?.root, parentTaskId: input.parentTaskId, pointOfNoReturnPassed,
      editableParams: editableParamsNow(), waitingFor, agentTurn, mergeQueue,
      updatedAt: workflowInfo().historyLength,
    };
  }
  const publish = async () => core.publishView(taskId, view());
  const leaser = managedTurns
    ? createAgentTurnLeaser(core, coord, {
        taskId,
        projectId: input.projectId,
        task: () => input,
        status: () => status,
        setStatus: (next) => { status = next; },
        setWaitingFor: (next) => { waitingFor = next; },
        setAgentTurn: (next) => { agentTurn = next; },
        cancelled: () => cancelled,
        publish,
      })
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
      const invoke = (lease?: { accountConfigHome?: string; accountApiKeyHandle?: string; agentTurnId: string }) =>
        turns.runAgentTurn({
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
    msgs.push({ ...m, ts: msgs.length });
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
  world = (await core.createWorld({ taskId, repo: input.project.repos?.[0], base: target, branch: input.branch, gitProfile: input.project.gitProfile, kind: 'worktree' })) as WorldHandleLike;
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
    let leftToHuman = false;
    for (const layer of confirmLayers) {
      if (cancelled || leftToHuman) break;
      if (layer.kind === 'agent') {
        await publish();
        const decision = await runConfirm(layer);
        if (decision?.action === 'confirm') continue;
        if (decision?.action === 'reject') {
          if (decision.text) msgs.push({ id: `cr${msgs.length}`, role: 'system', text: `Confirm agent rejected: ${decision.text}`, ts: msgs.length });
          cancelled = true;
        } else {
          leftToHuman = true;
        }
      } else {
        // A human layer: one Approve click passes ONE layer.
        await publish();
        await condition(() => confirmed || cancelled);
        confirmed = false; // consumed by this layer
      }
    }
    if (!cancelled && !leftToHuman) confirmed = true;
  }
  await publish();
  await condition(() => confirmed || cancelled);
  if (cancelled || (input.workflowEdit && !checks?.passed && !confirmed)) {
    stage = 'cancelled';
    status = 'cancelled';
    await publish();
    if (world) await core.destroyWorld(world as any);
    return { stage };
  }

  if (remotePolicyOf(input.project) === 'pr') {
    targetLocked = true; // opening a PR binds it to `target` (SPEC §2)
    const opened = await core.openPr(world as any, target);
    if (opened) reviewInfo = { ...reviewInfo, links: [...(reviewInfo?.links ?? []), { label: 'PR', url: opened.url }] };
  }

  stage = 'merge';
  if (managedTurns) status = 'active';
  await publish();
  // Commit `target` to the merge-queue domain — no await between locking and
  // reading it, so a queued edit can't desync the domain (SPEC §5.5).
  targetLocked = true;
  const domain = `${world!.repo ?? input.projectId}:${target}`;
  await coord.enqueueMerge(domain, taskId);
  if (managedTurns) {
    status = 'waiting';
    waitingFor = { kind: 'mergeSlot', detail: `Waiting to merge into ${target}` };
  }
  while (!mergeGranted && !cancelled) {
    if (managedTurns) {
      mergeQueue = await coord.mergeQueuePosition(domain, taskId);
      await publish();
    }
    await condition(() => mergeGranted || cancelled, '5s');
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
    await core.pushTarget(world as any, target).catch(() => undefined);
  }
  stage = 'done';
  status = 'done';
  reviewInfo = { ...reviewInfo, summary: `Merged into ${target} as ${result.sha?.slice(0, 8)}.` };
  await publish();
  await core.destroyWorld(world as any);
  return { stage, sha: result.sha };
}
