import { createTaskWorld } from './world-setup.js';
import { publishTaskView } from './view-publication.js';
import { conversationPublisher } from '../domain/view-publication.js';
import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  isCancellation,
  workflowInfo,
  patched,
} from '@temporalio/workflow';
import { ActivityCancellationType, ApplicationFailure } from '@temporalio/common';
import type { coreActivities } from '../activities/core.js';
import type { coordinatorActivities } from '../activities/coordinator.js';
import { isInfraFailure, INFRA_BACKOFF_MS } from './failures.js';
import { confirmLayersOf } from '../domain/confirm.js';
import { TaskInput, TaskView, Stage, Message, ReviewInfo, DeclaredAction, WorldHandleLike, ConfirmDecision, ConfirmLayer,
  releaseWorldOnCompletion, remoteWorldProvider } from './contract.js';
import { AgentTurnCancelled, CredentialUnavailable, createAgentTurnLeaser } from './agent-turn-lease.js';
import { SIG } from './names.js';

const resourceActivities = proxyActivities<coreActivities>({
  startToCloseTimeout: '45 minutes', heartbeatTimeout: '2 minutes', retry: { maximumAttempts: 3 },
});
const core = proxyActivities<coreActivities>({ startToCloseTimeout: '5 minutes', retry: { maximumAttempts: 3 } });
// Agent turns heartbeat every ~1s; a 2-minute gap = dead/slept worker → Temporal
// retries the turn and the next attempt resumes the interrupted session (see
// software-dev.ts / failures.ts for the full taxonomy).
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
// Bounded-retry coordinator proxy. Temporal's default is `maximumAttempts: 0` =
// UNLIMITED, so a deterministically failing requestAgentSlot / leaseAccount would
// retry every ~100 s forever and freeze the task with no path to a human. Retry
// options are recorded with the ScheduleActivityTask command, so this is pinned to
// its own behavior version (see justDoV1_4).
const boundedCoord = proxyActivities<coordinatorActivities>({
  startToCloseTimeout: '30s',
  retry: { maximumAttempts: 5, initialInterval: '1s', backoffCoefficient: 2 },
});

export const followUpSignal = defineSignal<[Message]>('followUp');
export const collaborationRequestedSignal = defineSignal<[string]>('collaborationRequested');
export const collaborationSettledSignal = defineSignal<[string, Message]>('collaborationSettled');
export const resourceResolvedSignal = defineSignal(SIG.resourceResolved);
export const confirmSignal = defineSignal('confirm');
export const cancelSignal = defineSignal('cancel');
export const viewQuery = defineQuery<TaskView>('view');
/** Live follow-up feed for in-flight injection (SPEC §5.6): a running turn polls
 *  this to inject messages queued at/after `fromIndex` without waiting a full turn. */
export const pendingMessagesQuery = defineQuery<Message[], [string, number]>('pendingMessages');

/**
 * just-do (SPEC §4.7): a single straightforward agent call, no merge machinery.
 * The work stays on the task's branch; it is not merged anywhere.
 */
export async function justDo(input: TaskInput): Promise<{ stage: Stage }> {
  return justDoImpl(input, true);
}

/** Durable non-blocking host admission. */
export async function justDoV1_2(input: TaskInput): Promise<{ stage: Stage }> {
  return justDoImpl(input, true, true);
}

/** Cancellation waits for the live provider turn to stop. */
export async function justDoV1_3(input: TaskInput): Promise<{ stage: Stage }> {
  return justDoImpl(input, true, true, true);
}

/** Bounded coordinator-activity retries, and `confirmed` cleared at the Review gate. */
export async function justDoV1_4(input: TaskInput): Promise<{ stage: Stage }> {
  return justDoImpl(input, true, true, true, true, true);
}

/** Review-gated adoption of task-created durable project resources. */
export async function justDoV1_5(input: TaskInput): Promise<{ stage: Stage }> {
  return justDoImpl(input, true, true, true, true, true, true);
}

/** Publish finalization progress before saving the approved work. */
export async function justDoV1_6(input: TaskInput): Promise<{ stage: Stage }> {
  return justDoImpl(input, true, true, true, true, true, true, true);
}

/** Resource-only output is checkpointed; configured Git failures remain fatal. */
export async function justDoV1_7(input: TaskInput): Promise<{ stage: Stage }> {
  return justDoImpl(input, true, true, true, true, true, true, true, true);
}

/** Immutable replay entry for executions pinned to justDo@1.0.0. */
export async function justDoV1(input: TaskInput): Promise<{ stage: Stage }> {
  return justDoImpl(input, false);
}

async function justDoImpl(
  input: TaskInput,
  managedTurns: boolean,
  durableAdmission = false,
  awaitTurnCancellation = false,
  boundedCoordinatorRetries = false,
  // See the note at the `confirmed` clear below: an execution confirmed before its
  // Review gate opened recorded that gate returning instantly, so clearing the token
  // on replay would park where history says it proceeded. Pinned to justDo@1.4.0.
  clearsConfirmOnGate = false,
  resourceCandidateReview = false,
  publishesFinalization = false,
  resourceOnlyFinalization = false,
): Promise<{ stage: Stage }> {
  const agentTurns = awaitTurnCancellation ? cancellationAwareTurns : turns;
  const coordinator = boundedCoordinatorRetries ? boundedCoord : coord;
  const taskId = input.taskId;
  let stage: Stage = 'setup';
  let status: TaskView['status'] = 'active';
  const msgs: Message[] = input.prompt || input.images?.length || input.files?.length
    ? [{ id: 'm0', role: 'user', text: input.prompt ?? '', ts: input.createdAt ?? 0, ...(input.images?.length ? { images: input.images } : {}), ...(input.files?.length ? { files: input.files } : {}) }]
    : [];
  let finalizing = false;
  let confirmed = false;
  let cancelled = false;
  let resourceResolutionEpoch = 0;
  let awaitingResourceDecision = false;
  let resourceReviewSequence = 0;
  let applyingResources = false;
  let world: WorldHandleLike | undefined;
  let session: string | undefined;
  let reviewInfo: ReviewInfo | undefined;
  let waitingFor: TaskView['waitingFor'];
  let agentTurn: TaskView['agentTurn'];
  let seen = 0;
  const pendingCollaborations = new Set<string>();
  /** Requests already settled — guards against a settle that beats its request. */
  const settledCollaborations = new Set<string>();
  const base = input.base ?? input.project.defaultBase ?? 'main';
  // Who confirms at the Review gate (SPEC §5.2): the ordered confirm layers, played
  // sequentially — every layer must approve; [] ⇒ auto-confirm. Legacy {mode} shapes
  // normalize to their layer equivalents. A child routes to its parent (handled by
  // the confirm signal from the parent), so this drives top-level tasks.
  const confirmLayers = confirmLayersOf(input.confirm);

  function actions(): DeclaredAction[] {
    if (finalizing || applyingResources) return [];
    const followUp: DeclaredAction = { name: 'followUp', kind: 'signal', label: 'Send follow-up', enabled: true, args: [{ name: 'text', type: 'text', required: true }] };
    const cancel: DeclaredAction = { name: 'cancel', kind: 'signal', label: 'Cancel', enabled: true, danger: true };
    const confirm: DeclaredAction = { name: 'confirm', kind: 'signal', label: 'Done', enabled: true };
    if (stage === 'review') return [...(awaitingResourceDecision ? [] : [confirm]), followUp, cancel];
    if (stage === 'do' || stage === 'setup') return [followUp, cancel];
    return [];
  }
  function view(): TaskView {
    return {
      taskId, title: input.title, workflow: 'just-do', stage, status, messages: msgs, reviewInfo,
      actions: actions(), state: { worldReady: !!world, ...(applyingResources ? { applyingResources: true } : {}), ...(finalizing ? { finalizing: true } : {}) }, branch: world?.branch, base,
      world, worldPath: world?.workdir ?? world?.root, parentTaskId: input.parentTaskId, waitingFor, agentTurn, updatedAt: workflowInfo().historyLength,
    };
  }
  const publishConversation = conversationPublisher(workflowInfo().runId,
    (snapshot, reference) => publishTaskView(core, taskId, snapshot, reference));
  const publish = async () => patched('just-do-conversation-reference-v1')
    ? publishConversation(view()) : publishTaskView(core, taskId, view());
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

  /** Run one Confirm-agent turn (SPEC §5.2): review the work, return a verdict, or
   *  undefined on failure so the caller falls back to the human gate. */
  async function runConfirm(layer: ConfirmLayer): Promise<ConfirmDecision | undefined> {
    try {
      // The layer's own agent spec drives this turn (each agent layer can run a
      // different reviewer); a spec-less layer falls back to the confirm profile.
      const { kind: _kind, prompt: _prompt, ...layerSpec } = layer;
      const task = layerSpec.provider ? { ...input, agents: { ...(input.agents ?? {}), confirm: { ...layerSpec, provider: layerSpec.provider } } } : input;
      // A fresh turn each Review so the reviewer judges the current work (up-to-date
      // system prompt); a mid-turn retry still resumes via runAgentTurn heartbeat details.
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
          messages: [],
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
      if (isCancellation(err)) throw err;
      return undefined;
    }
  }

  setHandler(viewQuery, view);
  setHandler(pendingMessagesQuery, (_role, fromIndex) => msgs.slice(Math.max(0, fromIndex)));
  setHandler(followUpSignal, (m) => {
    if (!msgs.some((candidate) => candidate.id === m.id))
      msgs.push({ ...m, ts: m.ts || msgs.length });
  });
  // Order-tolerant join set — see the matching handler in software-dev.ts: the
  // settle can beat the request, and a bare delete-then-add would park the task
  // on an id that nothing ever removes.
  setHandler(collaborationRequestedSignal, (requestId) => {
    if (!settledCollaborations.has(requestId)) pendingCollaborations.add(requestId);
  });
  setHandler(collaborationSettledSignal, (requestId, message) => {
    settledCollaborations.add(requestId);
    pendingCollaborations.delete(requestId);
    if (!msgs.some((candidate) => candidate.id === message.id))
      msgs.push({ ...message, ts: message.ts || msgs.length });
  });
  setHandler(resourceResolvedSignal, () => {
    resourceResolutionEpoch++;
  });
  setHandler(confirmSignal, () => {
    if (awaitingResourceDecision) return;
    confirmed = true;
  });
  setHandler(cancelSignal, () => {
    cancelled = true;
    leaser?.cancelActive();
  });

  await publish();
  const worldKind = input.project.worldProvider ?? 'worktree';
  world = (await createTaskWorld(core, { taskId, ...(remoteWorldProvider(worldKind) ? { projectId: input.projectId } : {}), repos: input.project.repos, base, copyGlobs: input.project.copyGlobs, gitProfile: input.project.gitProfile, kind: worldKind })) as WorldHandleLike;
  if (leaser) await leaser.init();

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
      const invoke = (lease?: {
        accountConfigHome?: string;
        accountApiKeyHandle?: string;
        accountCredentialKind?: 'login' | 'ambient' | 'key';
        accountCredentialProvider?: string;
        agentTurnId: string;
        agentAdmissionManaged?: true;
        agentSlotGranted?: true;
      }) =>
        agentTurns.runAgentTurn({ taskId, role: 'do', worldHandle: world as any, messages: msgs, session, deliveredMessages: session ? seen : 0, task: input, ...(lease ? lease : {}) });
      turn = leaser ? await leaser.run('do', invoke) : await invoke();
    } catch (err) {
      if (managedTurns && cancelled && (err instanceof AgentTurnCancelled || isCancellation(err))) break;
      if (err instanceof CredentialUnavailable && patched('just-do-credential-denial-v1')) {
        status = 'waiting';
        waitingFor = { kind: 'human', audience: ['@creator'], detail: err.message };
        await publish();
        await condition(() => cancelled || msgs.length > deliveredNow);
        if (cancelled) break;
        status = 'active';
        waitingFor = undefined;
        continue;
      }
      // Infrastructure outage that outlived the activity retries: park with
      // backoff and re-run the turn (which resumes its session) rather than
      // failing the task. Anything else propagates as before.
      if (cancelled || isCancellation(err) || !isInfraFailure(err) || infraRetries >= INFRA_BACKOFF_MS.length) throw err;
      await condition(() => cancelled, INFRA_BACKOFF_MS[infraRetries++]!);
      continue;
    }
    infraRetries = 0;
    session = turn.session ?? session;
    // Advance past exactly what the turn delivered — the schedule snapshot plus any
    // follow-ups it injected in-flight (SPEC §5.6). Follow-ups that landed after the
    // turn's last poll stay after `seen` → delivered on the next turn.
    seen = Math.min(Math.max(turn.delivered ?? deliveredNow, deliveredNow), msgs.length);
    if (turn.reviewInfo) reviewInfo = turn.reviewInfo;
    if (pendingCollaborations.size > 0) {
      status = 'waiting';
      waitingFor = {
        kind: 'collaboration',
        detail: `Waiting for ${pendingCollaborations.size} background collaboration request(s)`,
      };
      await publish();
      await condition(() => cancelled || pendingCollaborations.size === 0 || msgs.length > seen);
      if (cancelled) break;
      status = 'active';
      waitingFor = undefined;
      continue;
    }
    if (msgs.length > seen) continue;
    if (patched('service-connections-wait-v1')) {
      while (await core.pendingServiceConnections(taskId) && !cancelled && msgs.length === seen) {
        status = 'waiting';
        waitingFor = { kind: 'human', detail: 'Connect the requested app in Approval Requests to continue.' };
        await publish();
        if (patched('service-connections-signal-wait-v1')) await condition(() => cancelled || msgs.length > seen);
        else await condition(() => cancelled || msgs.length > seen, '30 seconds');
      }
      if (cancelled) break;
      if (msgs.length > seen) { status = 'active'; waitingFor = undefined; continue; }
    }
    stage = 'review';
    status = 'waiting';
    // `confirmed` is a GATE token, not a latch — clear it on entry to Review, before
    // any await. `confirmSignal` sets the flag at ANY stage, so without this a
    // confirm that arrived during Do (or Setup) pre-approved the next Review gate
    // and the work was accepted unseen. Clearing here, strictly before the
    // `publish()` that advertises the gate, still preserves the legitimate race: a
    // confirmer cannot see the gate until after we have cleared, so anything they
    // click from that point on counts. See the matching note in software-dev.ts.
    if (clearsConfirmOnGate) confirmed = false;
    // Play the confirm layers in order (SPEC §5.2): every layer must approve; a
    // revise/follow-up returns to Do and the next Review replays from the first.
    let backToDo = false;
    const automaticResources = resourceCandidateReview && patched('automatic-resource-review-v1');
    if (automaticResources) await core.beginResourceReview(taskId, `${workflowInfo().runId}:${++resourceReviewSequence}`);
    if (resourceCandidateReview && !automaticResources) {
      let resolutionAtWait = resourceResolutionEpoch;
      let pending = await core.pendingResourceCandidates(taskId);
      while (pending && !cancelled && msgs.length === seen) {
        if (resourceResolutionEpoch !== resolutionAtWait) {
          resolutionAtWait = resourceResolutionEpoch;
          pending = await core.pendingResourceCandidates(taskId);
          continue;
        }
        awaitingResourceDecision = true;
        waitingFor = { kind: 'human', audience: ['@creator'],
          detail: `${pending} staged project resource candidate${pending === 1 ? '' : 's'} must be Adopted or Discarded before this proposal can continue.` };
        await publish();
        await condition(() => cancelled || msgs.length > seen
          || resourceResolutionEpoch !== resolutionAtWait);
        if (cancelled || msgs.length > seen) break;
        resolutionAtWait = resourceResolutionEpoch;
        pending = await core.pendingResourceCandidates(taskId);
      }
      awaitingResourceDecision = false;
      waitingFor = undefined;
      if (msgs.length > seen) backToDo = true;
    }
    for (let li = 0; li < confirmLayers.length && !backToDo && !cancelled; li++) {
      const layer = confirmLayers[li]!;
      if (layer.kind === 'agent') {
        await publish();
        const decision = await runConfirm(layer);
        if (cancelled) break;
        if (decision?.action === 'confirm') continue; // this layer approves → the next
        if (decision?.action === 'reject') {
          if (decision.text) msgs.push({ id: `cr${msgs.length}`, role: 'system', text: `Confirm agent rejected: ${decision.text}`, ts: msgs.length });
          cancelled = true;
          break;
        }
        if (decision?.action === 'revise') {
          msgs.push({ id: `cv${msgs.length}`, role: 'user', text: decision.text || 'Please revise per the reviewer feedback.', ts: msgs.length });
          backToDo = true;
          continue;
        }
        // no verdict → degrade this layer to the human gate below
      }
      // A human layer: one Confirm click passes ONE layer; a follow-up → back to Do.
      if (patched('human-confirm-waiting-status-v1')) status = 'waiting';
      waitingFor = { kind: 'human', audience: layer.kind === 'human' && layer.audience?.length ? layer.audience : ['@creator'] };
      await publish();
      await condition(() => confirmed || cancelled || msgs.length > seen);
      waitingFor = undefined;
      if (cancelled) break;
      if (!confirmed) backToDo = true;
      confirmed = false; // consumed by this layer
    }
    if (cancelled) break;
    if (!backToDo) {
      if (automaticResources) {
        applyingResources = true;
        status = 'active';
        await publish();
        try { await resourceActivities.settleResourceReview(taskId); }
        finally { applyingResources = false; }
      }
      break; // every layer approved (or none configured) → done
    }
    stage = 'do';
    status = 'active';
  }

  // No merge machinery: the world IS the deliverable. Persist approved output
  // before releasing compute; retained local worktrees remain inspectable.
  if (!cancelled && world) {
    if (publishesFinalization) {
      finalizing = true;
      status = 'active';
      waitingFor = undefined;
      await publish();
    }
    // Old version pins retain their exact activity sequence and result handling.
    const resourceOnly = resourceOnlyFinalization
      && await core.checkpointResourceOnlyWork(world as any, input.project.repos ?? []);
    if (!resourceOnly) {
      const result = await core.commitWork(world as any, `tavya: ${input.title}`);
      if (resourceOnlyFinalization && !result.committed)
        throw ApplicationFailure.nonRetryable('task work was not committed; retaining the world for recovery');
      if (remoteWorldProvider(world.provider ?? world.kind)) await core.publishTaskBranch(world as any);
    }
  }
  finalizing = false;
  stage = cancelled ? 'cancelled' : 'done';
  status = cancelled ? 'cancelled' : 'done';
  await publish();
  if (world && (cancelled || releaseWorldOnCompletion(world))) {
    const remote = remoteWorldProvider(world.provider ?? world.kind);
    await core.destroyWorld(world as any);
    if (remote) {
      world = undefined;
      await publish();
    }
  }
  return { stage };
}
