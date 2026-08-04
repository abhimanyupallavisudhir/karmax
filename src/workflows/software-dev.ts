import {
  proxyActivities,
  defineSignal,
  defineUpdate,
  defineQuery,
  setHandler,
  condition,
  startChild,
  getExternalWorkflowHandle,
  workflowInfo,
  CancellationScope,
  isCancellation,
  ApplicationFailure,
  log,
  type ChildWorkflowHandle,
} from '@temporalio/workflow';
import { ActivityCancellationType } from '@temporalio/common';
import type { coreActivities } from '../activities/core.js';
import type { coordinatorActivities } from '../activities/coordinator.js';
import { SIG_MERGE_GRANTED, SIG_ACCOUNT_GRANTED, SIG_AGENT_SLOT_GRANTED } from '../coordinators/names.js';
import { editableInFlight } from '../platform/mutability.js';
import { renderConfirmPrompt } from '../domain/confirm-prompt.js';
import { confirmLayersOf } from '../domain/confirm.js';
import { isInfraFailure, limitFailureClassification, INFRA_BACKOFF_MS } from './failures.js';
import {
  TaskInput,
  TaskView,
  Stage,
  AgentRole,
  AgentSpec,
  ConfirmConfig,
  ConfirmLayer,
  Message,
  ReviewInfo,
  DeclaredAction,
  WorldHandleLike,
  ChildRaise,
  ParentResponse,
  SubTaskResponse,
  TaskPullRequest,
  GitHubMergeAuthorization,
} from './contract.js';
import { mergeQueueDomains, releaseWorldOnCompletion, remotePolicyOf, remoteWorldProvider,
  samePosition, MERGE_POLL, reviewCheckouts, approveAll, worldRepos } from './contract.js';
import type { CheckoutApprovals } from './contract.js';
import { SIG_AGENT_TURN_STATE } from './names.js';

const core = proxyActivities<coreActivities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 3 },
});
// Merges + checks can be long-running (test suites) but don't heartbeat.
const long = proxyActivities<coreActivities>({
  startToCloseTimeout: '45 minutes',
  retry: { maximumAttempts: 1 },
});
// Agent turns heartbeat every ~1s (runtime.ts), so a 2-minute gap means the
// worker/host died or slept. Temporal then retries the turn, and the next
// attempt RESUMES the interrupted session from heartbeat details (runAgentTurn)
// — a retry is "continue where you left off", not a full re-run. Only
// 'agent-infra' failures and timeouts retry here; limits and agent errors are
// tagged non-retryable by the activity and flow to account rotation / Resolve
// exactly as before (see failures.ts).
const turns = proxyActivities<coreActivities>({
  startToCloseTimeout: '45 minutes',
  heartbeatTimeout: '2 minutes',
  retry: { maximumAttempts: 3, initialInterval: '10s', backoffCoefficient: 2 },
});
// A cancelled task is not settled until its activity has acknowledged cancellation.
// TRY_CANCEL/unspecified behavior lets the workflow destroy the world and complete
// while the provider subprocess is still running — exactly the task-296 failure.
// Keep the old proxy for replay-pinned histories; v1.6+ schedules turns with this one.
const cancellationAwareTurns = proxyActivities<coreActivities>({
  startToCloseTimeout: '45 minutes',
  heartbeatTimeout: '2 minutes',
  retry: { maximumAttempts: 3, initialInterval: '10s', backoffCoefficient: 2 },
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});
const coord = proxyActivities<coordinatorActivities>({ startToCloseTimeout: '30s' });
// Coordinator calls with a BOUNDED retry budget. With Temporal's default
// (`maximumAttempts: 0` = unlimited) a deterministically-failing enqueueMerge /
// requestAgentSlot retries every ~100 s forever: the task freezes in place and
// never reaches `withResolve` or a human. Failing after a few attempts turns it
// into an ordinary stage error that auto-resolve, then escalation, can act on.
// Pinned to its own behavior version — activity retry options are part of the
// recorded command, so an in-flight execution must keep scheduling with the proxy
// its history was written against.
const boundedCoord = proxyActivities<coordinatorActivities>({
  startToCloseTimeout: '30s',
  retry: { maximumAttempts: 5, initialInterval: '1s', backoffCoefficient: 2 },
});

// ─── Signals / updates / query (SPEC §5.6) ───────────────────────────────────
// The optional second arg is the agent the follow-up addresses (`do` | `merge` |
// `resolve`); omitted / unknown routes to the Do agent, so old single-arg signals
// (and the other single-agent workflows) keep working unchanged.
export const followUpSignal = defineSignal<[Message, string?]>('followUp');
export const collaborationRequestedSignal = defineSignal<[string]>('collaborationRequested');
export const collaborationSettledSignal = defineSignal<[string, Message]>('collaborationSettled');
export const confirmSignal = defineSignal('confirm');
/** Explicit transition from Do/waiting-for-input into PR preparation. */
export const openPrSignal = defineSignal('openPr');
/** Approve ONE branch of a multi-PR task at the head it has right now (SPEC §11.1).
 *  Lets a human confirm the finished branches and send a follow-up about the rest;
 *  the approval lapses by itself if the Do agent moves that branch afterwards. */
export const approveCheckoutSignal = defineSignal<[{ name: string }]>('approveCheckout');
export const cancelSignal = defineSignal('cancel');
export const retrySignal = defineSignal('retry');
export const mergeGrantedSignal = defineSignal(SIG_MERGE_GRANTED);
type CredentialKind = 'login' | 'ambient' | 'key';
export const accountGrantedSignal = defineSignal<[{
  turnId: string;
  accountId: string;
  configHome?: string;
  apiKeyHandle?: string;
  credentialKind?: CredentialKind;
  credentialProvider?: string;
}]>(SIG_ACCOUNT_GRANTED);
export const agentSlotGrantedSignal = defineSignal<[{ turnId: string }]>(SIG_AGENT_SLOT_GRANTED);
export const agentTurnStateSignal = defineSignal<[{
  turnId: string;
  role: AgentRole;
  provider?: 'claude' | 'codex' | 'opencode' | 'kimi' | 'grok' | 'mock';
  state: 'running' | 'waiting-host';
  detail?: string;
}]>(SIG_AGENT_TURN_STATE);
/** A child raises UP to its parent when it reaches a decision point (SPEC §5.3). */
export const raiseFromChildSignal = defineSignal<[ChildRaise]>('raiseFromChild');
/** A parent answers a child that raised to it — maps onto the same confirm/retry/
 *  cancel/follow-up transitions a human would drive (SPEC §5.3). */
export const parentResponseSignal = defineSignal<[ParentResponse]>('parentResponse');
export const setTargetUpdate = defineUpdate<boolean, [string]>('setTarget');
/**
 * Generic in-flight param edit (SPEC §4.5/§5.5). Validated: the validator rejects
 * (before admission, SPEC §2) any field not currently editable per its declared
 * `mutable` window; the handler applies the accepted fields to live state and
 * returns what it applied. `setTarget` above is the back-compat shim for `target`.
 */
export const updateParamsUpdate = defineUpdate<{ applied: string[] }, [Record<string, unknown>]>('updateParams');
/**
 * In-flight authorization edit (SPEC §5.5, PLAN-authorization). Re-points the
 * task's live grant so later turns mint their scoped credential from the newly
 * selected authorization profile + per-task vault-item grants. The gateway
 * computes the attenuated capability package (it needs the authorization service
 * and the editing principal); the workflow just swaps it into live state.
 * Rejected once cancelled or past the point of no return, like every other edit.
 */
export const updateAuthorizationUpdate = defineUpdate<
  { applied: boolean },
  [{ grant: string[]; grantPrincipal: string; authorizationProfile: string }]
>('updateAuthorization');
/** Switch between the two compatible policies sharing this execution. This is a
 * mode update, not a Temporal workflow-type hot swap; the execution stays pinned. */
export const changeWorkflowUpdate = defineUpdate<{ workflow: 'software-dev' | 'goal' }, ['software-dev' | 'goal']>('changeWorkflow');
export const viewQuery = defineQuery<TaskView>('view');
/**
 * Live follow-up feed for in-flight injection (SPEC §5.6). A running agent turn
 * (the activity) polls this to pull messages queued in the addressed role's
 * transcript AT OR AFTER `fromIndex`, and injects them into the live session
 * WITHOUT waiting for the next turn. Returns the raw `msgs` slice (indices stay
 * aligned with the workflow's array); the adapter skips the agent's own replies.
 */
export const pendingMessagesQuery = defineQuery<Message[], [string, number]>('pendingMessages');

export interface SoftwareDevInput extends TaskInput {
  /** Sub-tasks run with the parent as confirmer. Only top-level goal tasks (no parent)
   *  auto-confirm; a child with a `parentTaskId` always routes its Review to the parent. */
  autoConfirm?: boolean;
  /** Goal workflow (SPEC §4.7): auto-confirm a verified successful provider turn. */
  goalMode?: boolean;
  /** How often (ms) a parent re-enters Do to re-prompt itself while a child is still
   *  awaiting its response, so an unanswered raise never dead-parks the parent (SPEC
   *  §5.3 "keep prompting"). Overridable so tests don't wait the full interval. */
  subtaskNagMs?: number;
  /** Backoff (ms) the task waits in Do before re-prompting an agent whose own in-harness
   *  sub-agents were still running when its turn returned — interruptible by a human
   *  follow-up. Overridable so tests don't wait the full interval. */
  subagentWaitMs?: number;
}

const MAX_RESOLVE_ATTEMPTS = 2;
/** Historical workflow pins loop rejected merges through their Merge agent this
 * many times. Current explicit-PR runs return to Do and replay PR + Review. */
const MAX_MERGE_ATTEMPTS = 3;
/** Sub-task fan-out bounds (SPEC §5.3): concurrent children, and children over the
 *  task's whole life. Non-blocking spawn makes runaway delegation cheap without these. */
const MAX_CONCURRENT_SUBTASKS = 8;
const MAX_TOTAL_SUBTASKS = 50;
/** Default re-prompt cadence for a parent holding an unanswered child raise (SPEC §5.3).
 *  Bounds the subtask-wait so an ignored raise re-enters Do instead of parking forever. */
const DEFAULT_SUBTASK_NAG_MS = 60_000;
/** A turn can return while the agent's own in-harness sub-agents (Claude Agent SDK
 *  Task tool) are still running. We hold in Do and re-prompt so it waits for them,
 *  but bound the re-prompts so a wedged sub-agent can't park the task forever. */
const MAX_SUBAGENT_NUDGES = 5;
/** Backoff before re-prompting an agent still waiting on its in-harness sub-agents.
 *  Avoids a hot re-prompt loop and gives the waiting state a visible dwell; a human
 *  follow-up wakes it early. Overridable via `input.subagentWaitMs`. */
const DEFAULT_SUBAGENT_WAIT_MS = 10_000;
/** A turn can also return while a `run_in_background` shell (e.g. `npm test &`) is
 *  still running — the agent ends its turn meaning to fold in the result later (task
 *  130). We nudge it to wait, but with a SMALLER budget than sub-agents: a shell may
 *  be a dev server the task deliberately left running, so we must not park on it long.
 *  After the budget we proceed to Review with a note. */
const MAX_SHELL_NUDGES = 3;

/**
 * Internal sentinel for cancellation. Throwing a plain Error out of workflow
 * code triggers a workflow-TASK failure that Temporal retries forever; we never
 * do that. Cancellation is caught and routed to a graceful `abort()`.
 */
class Cancelled extends Error {}

/** No usable credential for a turn — every allowed login/key needs human action
 *  (funding, re-auth, or re-enable). Escalates straight to a human (SPEC §5.2, #5). */
class CredentialDenied extends Error {}

/**
 * The software-development workflow (SPEC §5): Setup → Do/wait → explicit PR
 * → Review → Merge → End. Ordinary input waits never publish a proposal;
 * landing repair returns to the same Do agent. Merge is the point of no return.
 */
export async function softwareDev(input: SoftwareDevInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevImpl(input, '1.1.0');
}

/** Current provider-terminal semantics. Kept separate from the bare/back-compat
 * export so executions recorded as `softwareDev` continue replaying v1.1. */
export async function softwareDevV1_2(input: SoftwareDevInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevImpl(input, '1.2.0');
}

/** Compatible software-dev/goal mode switching. */
export async function softwareDevV1_3(input: SoftwareDevInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevImpl(input, '1.3.0');
}

/** Durable non-blocking agent admission and bounded coordinator history. */
export async function softwareDevV1_4(input: SoftwareDevInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevImpl(input, '1.4.0');
}

/** Resumable platform lifecycle transitions (human hold / terminal restoration). */
export async function softwareDevV1_5(input: SoftwareDevInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevImpl(input, '1.5.0');
}

/** Resumable lifecycle transitions plus acknowledged provider cancellation. */
export async function softwareDevV1_6(input: SoftwareDevInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevImpl(input, '1.6.0');
}

/** Human holds wake on the action that supplies their input. */
export async function softwareDevV1_7(input: SoftwareDevInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevImpl(input, '1.7.0');
}

/** Full GitHub pull-request lifecycle under remote policy 'pr': the PR is
 *  reconciled with the merge outcome and closed when the task is cancelled. */
export async function softwareDevV1_8(input: SoftwareDevInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevImpl(input, '1.8.0');
}

/** Multi-PR: a task may partition its change across several branches, each landing
 *  as its own pull request, and Review tracks approval per branch (SPEC §11.1).
 *  A task parked in a merge queue also no longer republishes its whole view every
 *  five seconds — see `boundedMergeWait`. */
export async function softwareDevV1_9(input: SoftwareDevInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevImpl(input, '1.9.0');
}

/**
 * Bounded coordinator-activity retries (a deterministically failing merge-queue /
 * agent-slot call surfaces as a stage error instead of freezing the task forever),
 * every merge-queue domain published in the view, the confirm latch cleared on
 * entry to each Review gate, and an escalation that wakes on a follow-up.
 *
 * These landed on a branch that had also numbered them 1.9.0, concurrently with
 * master publishing a DIFFERENT 1.9.0 (multi-PR + the bounded merge wait). Two
 * behaviour sets cannot share one version number: an execution records its type
 * at start and replays it forever, so folding both into 1.9.0 would have replayed
 * master's in-flight 1.9.0 executions against commands they never recorded. They
 * are therefore 1.10.0, and 1.9.0 above means exactly what master shipped.
 */
export async function softwareDevV1_10(input: SoftwareDevInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevImpl(input, '1.10.0');
}

/** Prepare a branch with the Merge agent before the PR activity needs committed
 * history. The protected-target merge remains after PR creation. */
export async function softwareDevV1_11(input: SoftwareDevInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevImpl(input, '1.11.0');
}

/** Human Review sees the GitHub proposal, and GitHub applies repository policy
 * under the consenting human's own authorization. */
export async function softwareDevV1_12(input: SoftwareDevInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevImpl(input, '1.12.0');
}

/** Explicit Open PR lifecycle; ordinary Do turns wait for input, and the Do
 * agent owns proposal preparation plus any landing repair. */
export async function softwareDevV1_13(input: SoftwareDevInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevImpl(input, '1.13.0');
}

/** Repository-less projects use the ordinary Do and Review lifecycle without
 * inventing a Git branch, pull request, merge queue lease, or merge activity. */
export async function softwareDevV1_14(input: SoftwareDevInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevImpl(input, '1.14.0');
}

/** Replay-compatible entry for executions already recorded as
 * `softwareDev@1.0.0`. v1 published Resolve before invoking autoResolve. */
export async function softwareDevV1(input: SoftwareDevInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevImpl(input, '1.0.0');
}

type BehaviorVersion = '1.0.0' | '1.1.0' | '1.2.0' | '1.3.0' | '1.4.0' | '1.5.0' | '1.6.0' | '1.7.0' | '1.8.0' | '1.9.0' | '1.10.0' | '1.11.0' | '1.12.0' | '1.13.0' | '1.14.0';


/** The minor of a behavior version. Every feature gate below is a `>=` test on
 * this rather than a list of versions to remember to extend, for the same
 * reason `childWorkflowType` is: a newly bundled version is then correct by
 * construction instead of needing an edit nobody would notice was missing. */
function behaviorMinor(behaviorVersion: BehaviorVersion): number {
  return Number(behaviorVersion.split('.')[1] ?? 0);
}

/**
 * The workflow type a sub-task child is started as. From 1.5.0 on a child
 * inherits its parent's behavior version, so it gets the same cancellation
 * semantics (and everything since) rather than silently dropping to the bare
 * type. Parents older than that keep the bare v1.1 child type, because their
 * recorded StartChildWorkflow command has to stay replay-compatible.
 *
 * Expressed as a comparison, not a list of versions: a new bundled version is
 * then correct here by construction instead of needing an edit nobody would
 * notice was missing.
 *
 * The comparison is on (major, minor) NUMERICALLY. Comparing the minor alone —
 * `split('.')[1] >= 5` — is only accidentally right inside the 1.x line: a future
 * `2.0.0` has minor 0 and would have silently dropped its children back to the
 * bare (v1.1) type, quietly losing every semantic gained since 1.5.
 */
export function childWorkflowType(behaviorVersion: BehaviorVersion): string {
  const parts = behaviorVersion.split('.').map((p) => Number(p) || 0);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const inheritsVersion = major > 1 || (major === 1 && minor >= 5);
  return inheritsVersion ? `softwareDev@${behaviorVersion}` : 'softwareDev';
}

async function softwareDevImpl(
  input: SoftwareDevInput,
  behaviorVersion: BehaviorVersion,
): Promise<{ stage: Stage; sha?: string }> {
  const minor = behaviorMinor(behaviorVersion);
  const liveAgentStates = behaviorVersion !== '1.0.0';
  const providerTerminalCompletion = minor >= 2;
  const modeSwitching = minor >= 3;
  const durableAgentAdmission = minor >= 4;
  const responsiveHumanHold = minor >= 7;
  // New activity calls in an existing stage would break replay for executions
  // recorded before them, so the PR lifecycle is pinned to its own version.
  const githubPrLifecycle = minor >= 8;
  const repositoryless = minor >= 14
    && !(input.project.repos ?? []).some((repo) => typeof repo === 'string' && repo.trim().length > 0);
  // A PR can only name committed history. Earlier versions allowed Do to leave
  // a dirty tree for Merge, but opened the PR before the Merge agent ran; GitHub
  // therefore rejected exactly that valid workflow state with "no commits".
  // Split Merge into branch preparation before the PR and the protected-target
  // landing afterwards. This adds agent/activity commands and must stay pinned.
  const prepareBranchBeforePr = minor >= 11;
  // GitHub is the authoritative merge surface for PR-policy repositories. The
  // PR is opened before Review so the decision binds to its exact head SHA; the
  // merge itself uses a consenting human's user token and GitHub rules.
  const githubAuthoritativeMerge = !repositoryless && minor >= 12 && remotePolicyOf(input.project) === 'pr';
  const proposalBeforeReview = !repositoryless && minor >= 12;
  const explicitPrCycle = !repositoryless && minor >= 13;
  // Waiting for a merge slot is unbounded in wall-clock time, so the wait loop's
  // cost per tick is load-bearing: before 1.9 it re-ran two activities AND
  // republished the entire TaskView (messages + every agent transcript) every
  // 5s. Temporal caps a workflow's history at 50MB, so a task queued behind a
  // slow or wedged coordinator accumulated its way to a hard TERMINATE in a few
  // hours — the queue stall silently became permanent task death. The grant
  // still arrives by signal, which wakes the condition immediately, so a longer
  // poll costs no latency; it only refreshes the displayed position.
  const boundedMergeWait = minor >= 9;
  // Multi-PR (SPEC §11.1): adopting a branch the Do agent added, and the
  // per-checkout Review gate. Gated from 1.9 on so an execution recorded before
  // it keeps the single-branch Review semantics on replay.
  const multiPrEnabled = !repositoryless && minor >= 9 && !!input.project.multiPr;
  const agentTurns = minor >= 6 ? cancellationAwareTurns : turns;
  // Activity retry options are recorded with the ScheduleActivityTask command, so
  // bounding the coordinator's unlimited default is a versioned behavior change.
  const coordinator = minor >= 10 ? boundedCoord : coord;
  // `publish` is an activity, so its argument is recorded in history — adding a
  // field to the published view is a versioned change too. From 1.10.0 the view
  // carries EVERY merge-queue domain the task holds, not just the first: a
  // multi-repo task takes one slot per repo, and `mergeDomain` (singular) left
  // the console able to show and reorder only the first of them.
  const publishesAllMergeDomains = minor >= 10;
  // Clearing the `confirmed` gate token on entry to Review, and waking the
  // escalation park on a follow-up, both change which commands a workflow task
  // emits at a point older executions have already recorded — an execution that
  // was confirmed mid-Do recorded the Review gate returning INSTANTLY, and one
  // parked at `escalated` recorded a follow-up producing no commands at all.
  // Replaying either against the new code parks (or resumes) where history says
  // otherwise, which is a NonDeterminismError that wedges the execution for good.
  const clearsConfirmOnGate = minor >= 10;
  // A new activity ARGUMENT is a recorded-input change, so it is versioned too.
  const identifiedAccountReturns = minor >= 10;
  const followUpWakesEscalation = minor >= 10;
  const taskId = input.taskId;
  const recovery = input.recovery;
  const recoveryStage = recovery?.resumeStage ?? (recovery ? 'do' : 'setup');
  let stage: Stage = recoveryStage;
  let status: TaskView['status'] = 'active';
  const msgs: Message[] = recovery
    ? recovery.messages.map((m) => ({ ...m }))
    : input.prompt || input.images?.length
      ? [{ id: 'm0', role: 'user', text: input.prompt ?? '', ts: input.createdAt ?? 0, ...(input.images?.length ? { images: input.images } : {}) }]
      : [];
  let target = recovery?.target ?? input.target ?? input.project.defaultTarget ?? input.base ?? input.project.defaultBase ?? 'main';
  const base = input.base ?? input.project.defaultBase ?? 'main';
  let goalMode = !!input.goalMode;
  let confirmed = false;
  let prRequested = recoveryStage === 'pr';
  // checkout name -> head sha it was approved at (multi-PR Review, PLAN-multi-pr.md §3).
  let checkoutApprovals: CheckoutApprovals = recovery?.checkoutApprovals ?? {};
  let checkoutHeads: Record<string, string> = {};
  let cancelled = false;
  let retryRequested = false;
  let humanPauseActive = !!recovery?.pausedForHuman;
  let humanPauseWake: { kind: 'retry' | 'followUp' | 'confirm' | 'openPr' | 'workflowChange'; role?: string } | undefined;
  let world: WorldHandleLike | undefined = recovery?.world;
  let session: string | undefined = recovery?.session;
  // The config home that minted `session`. Provider sessions are login-bound, so a
  // later turn leased a DIFFERENT home must NOT resume this session — we drop it and
  // let the turn start fresh (karmax's own `msgs` carries the conversation). §2.5.
  let sessionHome: string | undefined = recovery?.sessionHome;
  // What a parked turn is waiting on (surfaced in the view; SPEC §6.2).
  let waitingFor: TaskView['waitingFor'];
  let agentTurn: TaskView['agentTurn'];
  let agentTurnResumeStatus: TaskView['status'] = 'active';
  let reviewInfo: ReviewInfo | undefined = recovery?.reviewInfo;
  let error: string | undefined;
  let terminalOrigin: Stage | undefined;
  let prs: TaskPullRequest[] = recovery?.prs?.map((candidate) => ({ ...candidate })) ?? [];
  let pr: TaskPullRequest | undefined = prs[0];
  let branchPreparedForPr = explicitPrCycle && (recoveryStage === 'review' || recoveryStage === 'merge');
  let mergeQueuePos: { position: number; total: number } | undefined;
  // How many times we've re-prompted the agent to wait for its own in-harness
  // sub-agents this Do phase (bounded by MAX_SUBAGENT_NUDGES).
  let subagentNudges = 0;
  // Same, for backgrounded shells the agent left running (bounded by MAX_SHELL_NUDGES).
  let shellNudges = 0;
  const subTaskIds: string[] = [];
  // Sub-task hierarchy (SPEC §5.3). Children are managed, not blindly awaited: their
  // handles let us await completion, raised requests queue in `raises`, settlements in
  // `settled`, `outstanding` is the not-yet-finished set, and `awaitingResponse` is the
  // children currently parked on a reply from us.
  const childHandles = new Map<string, ChildWorkflowHandle<typeof softwareDev>>();
  const raises: ChildRaise[] = [];
  const settled: { childTaskId: string; stage: string; detail?: string }[] = [];
  const outstanding = new Set<string>();
  const awaitingResponse = new Set<string>();
  // Cross-task collaboration is a durable, event-driven join. The requesting
  // agent keeps working for the rest of its current turn; if it finishes before
  // the target publishes, the workflow parks here and wakes on settlement.
  const pendingCollaborations = new Set<string>();
  /** Requests already settled — guards against a settle that beats its request. */
  const settledCollaborations = new Set<string>();
  let pointOfNoReturnPassed = false;
  // Flips true when `target` becomes load-bearing — a PR opened against it, or the
  // merge enqueue keyed by it — closing the in-flight target-edit window (SPEC §5.5).
  let targetLocked = false;
  let mergeGranted = false;
  let seen = recovery?.seen ?? 0; // messages the Do agent has already processed
  // Per-role transcripts surfaced in the view-model (SPEC §5.5): the Do agent's
  // conversation is `msgs`; auxiliary agents run on their own message arrays.
  // `resolveMsgs` remains only for historical executions created before the
  // process-wide Resolve-agent flag was disabled.
  const recoveredTranscript = (role: string): Message[] =>
    recovery?.transcripts?.find((t) => t.role === role)?.messages.map((m) => ({ ...m })) ?? [];
  const mergeMsgs: Message[] = recoveredTranscript('merge');
  const resolveMsgs: Message[] = recoveredTranscript('resolve');
  const confirmMsgs: Message[] = recoveredTranscript('confirm');
  // Who drives the Review gate (SPEC §5.2): the ordered confirm layers, played
  // sequentially at each Review — every layer must approve; [] ⇒ auto-confirm.
  // Legacy shapes ({mode} configs, the goal-task `autoConfirm` flag) normalize to
  // their layer equivalents. A child with a `parentTaskId` always routes Review to
  // its parent regardless (parent-as-confirmer, SPEC §5.3), so this only governs
  // top-level tasks.
  // Goal owns the zero-layer policy dynamically. Keeping the normal Software Dev
  // layers separately means switching back restores the task's original gate.
  // Mutable: the Review route is `untilUsed`, so an in-flight edit replaces these
  // layers and the gate below re-reads them on every iteration (SPEC §4.5/§5.5).
  let softwareDevConfirmLayers = confirmLayersOf(input.confirm, modeSwitching ? false : !!input.autoConfirm);
  // Bumped by every accepted `confirm` edit. The Review gate captures it before it
  // parks; a change while parked means the route it was playing is stale, so the
  // gate replays from its first layer rather than crediting layers approved under
  // the old route.
  let confirmEpoch = 0;
  // Account/token leasing (SPEC §6.2): per-turn lease of a connected login.
  const accountGrants = new Map<string, {
    accountId: string;
    configHome?: string;
    apiKeyHandle?: string;
    credentialKind?: CredentialKind;
    credentialProvider?: string;
  }>();
  const agentSlotGrants = new Set<string>();
  let turnSeq = 0;
  let accountPool = 0; // populated after setup; 0 ⇒ no leasing (zero behavior change)
  // Mid-turn cancel (SPEC §5.6): the running turn's cancellation scope, so a cancel
  // signal aborts the in-flight agent turn instead of waiting for it to finish.
  let activeTurn: CancellationScope | undefined;

  const kind = input.project.worldProvider ?? 'worktree';

  // ── in-flight param edits (SPEC §4.5/§5.5) ──
  // A working copy of the per-role agent overrides that later turns re-read, so a
  // model/effort retune — or, before its turn, a full swap — actually takes effect.
  // Every role re-reads `liveInput.agents[role]` at turn start, so a change lands at
  // the next best convenience in the conversation: the next turn that role runs
  // (e.g. a Do follow-up, a merge retry, or the next resolve attempt).
  const liveInput: SoftwareDevInput = { ...input, agents: { ...(input.agents ?? {}) } };
  // Params the workflow has already consumed (value now load-bearing). `target` is
  // consumed once locked (PR open / merge enqueue); an auxiliary agent's IDENTITY
  // (provider/session) once its turn runs — its model/effort stay retunable after;
  // `confirm` once the Review gate it drives has fully passed (a gate that sends the
  // task back to Do will play again, so the route is not consumed yet).
  const consumed = new Set<string>();
  const isConsumed = (name: string): boolean => (name === 'target' ? targetLocked : consumed.has(name));
  const paramEditable = (name: string): boolean =>
    !cancelled && editableInFlight(input.paramWindows?.[name], { consumed: isConsumed(name), pointOfNoReturnPassed });
  const editableParamsNow = (): string[] => Object.keys(input.paramWindows ?? {}).filter(paramEditable);

  // The role behind an `agent:<role>` param (or undefined for a non-agent field).
  const agentRoleOf = (name: string): string | undefined => (name.startsWith('agent:') ? name.slice('agent:'.length) : undefined);
  /** Whether a role's IDENTITY (provider / resumed session) may still be swapped now.
   *  The Do agent runs on a live resumable session from turn one, so its identity is
   *  frozen in-flight; auxiliary agents can be swapped until their own turn runs. Model
   *  and effort are NOT gated here — they retune whenever `paramEditable` allows. */
  const agentIdentityEditable = (role: string): boolean =>
    role !== 'do' && paramEditable(`agent:${role}`) && !isConsumed(`agent:${role}`);
  type AgentPlan = { ok: false; reason: string } | { ok: true; next: AgentSpec };
  /** Resolve an `agent:<role>` patch against live state (SPEC §5.5). While the role's
   *  identity is still editable, a full swap is accepted; once locked, only its model
   *  and effort may change — overlaid onto the current spec so provider/session stay
   *  pinned. Shared by the validator (reject) and the applier (apply) so they agree. */
  function planAgentPatch(role: string, raw: unknown): AgentPlan {
    if (!raw || typeof raw !== 'object') return { ok: false, reason: `"agent:${role}" must be an agent spec` };
    const spec = raw as AgentSpec;
    const cur = liveInput.agents?.[role];
    // A retune (like any edit) stops at cancel and the point of no return.
    if (!paramEditable(`agent:${role}`))
      return { ok: false, reason: `the ${role} agent can't be changed now — the task is ${cancelled ? 'cancelled' : 'past the point of no return'}` };
    if (agentIdentityEditable(role)) {
      if (!spec.provider) return { ok: false, reason: `the ${role} agent override needs a provider` };
      return { ok: true, next: spec };
    }
    // Identity locked → only model/effort may change. The provider (the agent
    // itself) and the resumed session stay pinned to whatever the running turn
    // used and are NEVER taken from the incoming patch — a provider that clearly
    // differs is rejected outright; when the turn ran on the role's profile default
    // (no explicit override) we simply keep that default, ignoring the patch's
    // provider. So the provider is only editable while the role is un-consumed —
    // exactly as before this change.
    if (spec.resumeFrom || (!!spec.provider && !!cur?.provider && spec.provider !== cur.provider))
      return {
        ok: false,
        reason:
          role === 'do'
            ? `the Do agent's provider/session is frozen in-flight — only its model and effort can change (they apply to the next turn); send a follow-up to redirect it`
            : `the ${role} agent's provider/session is locked once its turn has started — only its model and effort can still change`,
      };
    const modelChanged = spec.model !== undefined && spec.model !== cur?.model;
    const effortChanged = spec.effort !== undefined && spec.effort !== cur?.effort;
    if (!modelChanged && !effortChanged) return { ok: false, reason: `no model/effort change for the ${role} agent` };
    const model = spec.model !== undefined ? spec.model : cur?.model;
    const effort = spec.effort !== undefined ? spec.effort : cur?.effort;
    // `provider` may be absent when the turn ran on the profile default — omit it so
    // the activity keeps falling back to that default (core.ts: spec.provider ?? base).
    return {
      ok: true,
      next: {
        ...(cur?.provider ? { provider: cur.provider } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(effort !== undefined ? { effort } : {}),
        ...(cur?.resumeFrom ? { resumeFrom: cur.resumeFrom } : {}),
      } as AgentSpec,
    };
  }
  /** Update validator: reject (before admission, SPEC §2) any edit not allowed now. */
  function validateParamPatch(patch: Record<string, unknown>): void {
    const names = Object.keys(patch);
    if (!names.length) throw ApplicationFailure.nonRetryable('no params to edit', 'ParamEditEmpty');
    for (const name of names) {
      const role = agentRoleOf(name);
      if (role) {
        const plan = planAgentPatch(role, patch[name]);
        if (!plan.ok) throw ApplicationFailure.nonRetryable(plan.reason, 'ParamLocked', name);
        continue;
      }
      if (!paramEditable(name))
        throw ApplicationFailure.nonRetryable(
          name === 'confirm'
            ? `the Review route can't be changed now — this task's Review gate has already passed`
            : `"${name}" can't be edited now — it's frozen after queue, already in use, or past the point of no return`,
          'ParamLocked',
          name,
        );
      // Shape check only. Whether a human audience resolves to real people is a
      // store question the deterministic sandbox can't answer — the platform
      // asserts that (assertHumanRoutes) before it sends the update.
      if (name === 'confirm' && (!patch.confirm || typeof patch.confirm !== 'object'))
        throw ApplicationFailure.nonRetryable('the Review route must be a confirm config', 'ParamLocked', name);
    }
  }
  /** Apply an already-validated patch to live state. `target` is re-read at PR/merge;
   *  `agent:<role>` overrides are re-read when that role's turn runs; `confirm` is
   *  re-read on every Review-gate iteration. */
  function applyParamPatch(patch: Record<string, unknown>): { applied: string[] } {
    const applied: string[] = [];
    if (typeof patch.target === 'string' && patch.target) {
      target = patch.target;
      applied.push('target');
    }
    if (patch.confirm && typeof patch.confirm === 'object') {
      softwareDevConfirmLayers = confirmLayersOf(patch.confirm as ConfirmConfig);
      confirmEpoch++;
      applied.push('confirm');
    }
    for (const name of Object.keys(patch)) {
      const role = agentRoleOf(name);
      if (!role) continue;
      const plan = planAgentPatch(role, patch[name]);
      if (!plan.ok) continue; // the validator already rejected illegal patches
      liveInput.agents = { ...(liveInput.agents ?? {}), [role]: plan.next };
      applied.push(name);
    }
    return { applied };
  }

  // ── view-model ──
  function allowed(): DeclaredAction[] {
    const pausedRole: AgentRole | undefined =
      stage === 'do' || stage === 'review'
        ? 'do'
        : stage === 'merge' && mergeMsgs.length
          ? 'merge'
        : undefined;
    const followUp: DeclaredAction = {
      name: 'followUp',
      kind: 'signal',
      label: 'Send follow-up',
      enabled: true,
      args: [{ name: 'text', type: 'text', label: 'Message', required: true }],
      ...(responsiveHumanHold && humanPauseActive && pausedRole ? { roles: [pausedRole] } : {}),
    };
    const cancel: DeclaredAction = { name: 'cancel', kind: 'signal', label: 'Cancel', enabled: !pointOfNoReturnPassed, danger: true };
    const confirm: DeclaredAction = { name: 'confirm', kind: 'signal', label: explicitPrCycle ? 'Confirm PR' : 'Confirm', enabled: true };
    const openPr: DeclaredAction = { name: 'openPr', kind: 'signal', label: 'Open PR', enabled: true };
    const setTarget: DeclaredAction = {
      name: 'setTarget',
      kind: 'update',
      label: 'Change target branch',
      enabled: paramEditable('target'),
      args: [{ name: 'branch', type: 'string', label: 'Target branch', default: target }],
    };
    if (responsiveHumanHold && humanPauseActive) {
      return [
        ...(explicitPrCycle && stage === 'do' ? [openPr] : []),
        ...(stage === 'review' ? [confirm] : []),
        ...(pausedRole ? [followUp] : []),
        ...(!repositoryless && (stage === 'do' || stage === 'review') ? [setTarget] : []),
        cancel,
      ];
    }
    const retry: DeclaredAction = { name: 'retry', kind: 'signal', label: 'Retry', enabled: true };
    switch (stage) {
      case 'setup':
        return [cancel];
      case 'do':
        return [...(explicitPrCycle && waitingFor?.kind === 'human' ? [openPr] : []), followUp,
          ...(!repositoryless ? [setTarget] : []), cancel];
      case 'review':
        return [confirm, followUp, ...(!repositoryless ? [setTarget] : []), cancel];
      case 'pr':
        return [cancel];
      case 'merge':
        return waitingFor?.kind === 'human' ? [confirm, cancel] : [cancel];
      case 'resolve':
        return [cancel];
      case 'escalated':
        return [retry, followUp, cancel];
      default:
        return [];
    }
  }

  /** All per-role transcripts, omitting roles that haven't run a turn yet. */
  function buildTranscripts(): { role: string; label: string; messages: Message[] }[] {
    const t = [{ role: 'do', label: 'Do agent', messages: msgs }];
    if (!explicitPrCycle && mergeMsgs.length) t.push({ role: 'merge', label: 'Merge agent', messages: mergeMsgs });
    if (resolveMsgs.length) t.push({ role: 'resolve', label: 'Resolve agent', messages: resolveMsgs });
    if (confirmMsgs.length) t.push({ role: 'confirm', label: 'Confirm agent', messages: confirmMsgs });
    return t;
  }

  function buildView(): TaskView {
    const workflowSwitchable =
      modeSwitching &&
      !confirmed &&
      !cancelled &&
      !pointOfNoReturnPassed &&
      (stage === 'setup' || stage === 'do' || stage === 'review');
    return {
      taskId,
      title: input.title,
      workflow: modeSwitching ? (goalMode ? 'goal' : 'software-dev') : 'software-dev',
      ...(modeSwitching
        ? { workflowOptions: ['software-dev', 'goal'], workflowSwitchable }
        : {}),
      stage,
      status,
      messages: msgs,
      transcripts: buildTranscripts(),
      reviewInfo,
      actions: allowed(),
      state: {
        confirmed,
        cancelled,
        turnsSeen: seen,
        worldReady: !!world,
        mergeGranted,
        targetLocked,
        mergeDomain: world && !repositoryless ? mergeQueueDomains(world, target, input.projectId)[0] : undefined,
        ...(publishesAllMergeDomains && world && !repositoryless
          ? { mergeDomains: mergeQueueDomains(world, target, input.projectId) }
          : {}),
        // A failed Temporal execution is terminal. Persist the full handle needed
        // for a replacement run to OPEN this world; reconstructing it through
        // createWorld would force-remove the dirty worktree and lose work.
        recoveryWorld: world,
        ...(terminalOrigin ? { cancelledFrom: terminalOrigin } : {}),
        ...(humanPauseActive ? { humanPauseOrigin: recoveryStage } : {}),
      },
      ...(!repositoryless ? { branch: world?.branch, base, targetBranch: target } : {}),
      world,
      worldPath: world?.workdir ?? world?.root,
      pr,
      ...(prs.length ? { prs } : {}),
      ...(multiPrEnabled && world ? { checkouts: reviewCheckouts(worldRepos(world as any), checkoutHeads, checkoutApprovals, prs) } : {}),
      mergeQueue: mergeQueuePos,
      subTasks: subTaskIds.length ? subTaskIds : undefined,
      parentTaskId: input.parentTaskId,
      error,
      waitingFor,
      agentTurn,
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
  // Which conversation an addressed role reads/writes (Do is the default).
  const conversationFor = (role?: string): Message[] =>
    role === 'merge' ? mergeMsgs : role === 'resolve' ? resolveMsgs : role === 'confirm' ? confirmMsgs : msgs;
  setHandler(viewQuery, buildView);
  setHandler(agentTurnStateSignal, async (next) => {
    // Ignore a late state signal from an activity that was cancelled/retried after
    // a newer turn took ownership of the view.
    if (!liveAgentStates || !agentTurn || next.turnId !== agentTurn.turnId) return;
    if (next.state === 'waiting-host') {
      agentTurn = { turnId: next.turnId, role: next.role, provider: next.provider, state: 'waiting-slot' };
      waitingFor = {
        kind: 'agentSlot',
        provider: next.provider,
        detail: next.detail ?? 'Starting agent',
      };
      status = 'waiting';
      await publish();
      return;
    }
    agentTurn = { turnId: next.turnId, role: next.role, provider: next.provider, state: 'running' };
    waitingFor = undefined;
    status = agentTurnResumeStatus;
    await publish();
  });
  setHandler(pendingMessagesQuery, (role, fromIndex) => {
    // The raw slice from `fromIndex` (indices align with the array the activity is
    // tracking). A negative/over-range index clamps to a safe empty/whole slice.
    const target = conversationFor(role);
    return target.slice(Math.max(0, fromIndex));
  });
  setHandler(followUpSignal, (m, role) => {
    // Route the follow-up into the addressed agent's transcript (SPEC §5.5/§5.6).
    // Do is the default; merge/resolve queue it so it reaches that agent on its
    // next turn (each turn is fed its own accumulated transcript). A turn currently
    // running polls `pendingMessagesQuery` and injects it live (in-flight).
    const target = conversationFor(role);
    if (!target.some((candidate) => candidate.id === m.id))
      target.push({ ...m, ts: m.ts || target.length });
    if (responsiveHumanHold && humanPauseActive)
      humanPauseWake = { kind: 'followUp', role };
  });
  // The "requested" and "settled" signals are sent by two independent code paths
  // over two concurrent RPCs, so they can arrive in either order: a target that
  // publishes while our request signal is still in flight settles it first. A
  // bare delete-then-add would then leave an id in `pending` that nothing ever
  // removes, and the requester parks on it forever (no timeout, and the durable
  // row is already notified so no recovery path re-delivers it). Remember what
  // has settled so the join-set is order-tolerant.
  setHandler(collaborationRequestedSignal, (requestId) => {
    if (!settledCollaborations.has(requestId)) pendingCollaborations.add(requestId);
  });
  setHandler(collaborationSettledSignal, (requestId, message) => {
    settledCollaborations.add(requestId);
    pendingCollaborations.delete(requestId);
    if (!msgs.some((candidate) => candidate.id === message.id))
      msgs.push({ ...message, ts: message.ts || msgs.length });
  });
  setHandler(confirmSignal, () => {
    confirmed = true;
    if (responsiveHumanHold && humanPauseActive)
      humanPauseWake = { kind: 'confirm' };
  });
  setHandler(openPrSignal, () => {
    if (!explicitPrCycle || stage !== 'do') return;
    prRequested = true;
    if (responsiveHumanHold && humanPauseActive)
      humanPauseWake = { kind: 'openPr' };
  });
  // Approving one branch is the same decision as Confirm, taken for one pull
  // request instead of all of them — so a human can approve what is finished and
  // send a follow-up about the rest. It is recorded against that branch's CURRENT
  // head, which is what makes it lapse by itself if the Do agent moves it.
  setHandler(approveCheckoutSignal, ({ name }) => {
    const head = checkoutHeads[name];
    if (head) checkoutApprovals = { ...checkoutApprovals, [name]: head };
  });
  setHandler(cancelSignal, () => {
    if (!pointOfNoReturnPassed) {
      cancelled = true;
      activeTurn?.cancel(); // abort an in-flight agent turn immediately (SPEC §5.6)
      cancelChildren(); // and tear down any running sub-task agents
    }
  });
  setHandler(retrySignal, () => {
    retryRequested = true;
    if (responsiveHumanHold && humanPauseActive)
      humanPauseWake = { kind: 'retry' };
  });
  // A child raised to us: queue it so the Do agent can answer (SPEC §5.3).
  setHandler(raiseFromChildSignal, (r) => {
    raises.push(r);
    awaitingResponse.add(r.childTaskId);
  });
  // Our parent answered a raise. Map its decision onto the SAME flags a human drives
  // (confirm/retry/cancel/follow-up) so the parent is literally our confirmer.
  setHandler(parentResponseSignal, (resp) => {
    if (resp.action === 'open_pr') {
      prRequested = true;
      if (responsiveHumanHold && humanPauseActive)
        humanPauseWake = { kind: 'openPr' };
    } else if (resp.action === 'confirm') {
      confirmed = true;
      if (responsiveHumanHold && humanPauseActive)
        humanPauseWake = { kind: 'confirm' };
    } else if (resp.action === 'retry') {
      retryRequested = true;
      if (responsiveHumanHold && humanPauseActive)
        humanPauseWake = { kind: 'retry' };
    }
    else if (resp.action === 'cancel') {
      if (!pointOfNoReturnPassed) {
        cancelled = true;
        activeTurn?.cancel();
      }
    } else if (resp.action === 'comment') {
      if (resp.text) msgs.push({ id: `p-${msgs.length}`, role: 'user', text: resp.text, ts: msgs.length });
      retryRequested = true; // unblocks an escalated child; at Review the new msg drives it
      if (responsiveHumanHold && humanPauseActive)
        humanPauseWake = { kind: 'followUp', role: 'do' };
    }
  });
  setHandler(mergeGrantedSignal, () => {
    mergeGranted = true;
  });
  setHandler(accountGrantedSignal, (g) => {
    accountGrants.set(g.turnId, {
      accountId: g.accountId,
      configHome: g.configHome,
      apiKeyHandle: g.apiKeyHandle,
      credentialKind: g.credentialKind,
      credentialProvider: g.credentialProvider,
    });
  });
  setHandler(agentSlotGrantedSignal, ({ turnId }) => {
    agentSlotGrants.add(turnId);
  });
  setHandler(setTargetUpdate, (b) => {
    // Back-compat shim over the same window as updateParams({ target }), but
    // keeps the legacy boolean contract (returns false rather than rejecting).
    if (!paramEditable('target')) return false;
    target = b;
    return true;
  });
  setHandler(updateParamsUpdate, (patch) => applyParamPatch(patch), { validator: validateParamPatch });
  setHandler(
    updateAuthorizationUpdate,
    (next) => {
      // Later turns re-read `liveInput` at turn start (runAgentTurn mints the token
      // from `task.grant`/`grantPrincipal`), so this lands at the next turn any role
      // runs — exactly like the model/effort retune above.
      liveInput.grant = next.grant;
      liveInput.grantPrincipal = next.grantPrincipal;
      liveInput.authorizationProfile = next.authorizationProfile;
      return { applied: true };
    },
    {
      validator: (_next) => {
        if (cancelled || pointOfNoReturnPassed)
          throw ApplicationFailure.nonRetryable(
            `authorization can't be changed now — the task is ${cancelled ? 'cancelled' : 'past the point of no return'}`,
            'AuthorizationLocked',
          );
      },
    },
  );
  setHandler(
    changeWorkflowUpdate,
    async (workflow) => {
      const nextGoalMode = workflow === 'goal';
      if (nextGoalMode === goalMode) return { workflow };
      goalMode = nextGoalMode;
      liveInput.goalMode = goalMode;
      liveInput.workflow = workflow;
      if (goalMode) {
        // This both redirects an in-flight Do turn (the adapter polls follow-ups)
        // and wakes a Software Dev task already waiting at Review. In the latter
        // case the workflow returns to Do instead of auto-approving potentially
        // partial work that pre-dated the mode switch.
        msgs.push({
          id: `mode-${msgs.length}`,
          role: 'user',
          text: 'Workflow switched to Goal. Continue autonomously until the entire task is complete; do not stop after partial progress.',
          ts: msgs.length,
        });
        if (responsiveHumanHold && humanPauseActive)
          humanPauseWake = { kind: 'workflowChange', role: 'do' };
      }
      await publish();
      return { workflow };
    },
    {
      validator: (workflow) => {
        if (workflow !== 'software-dev' && workflow !== 'goal')
          throw ApplicationFailure.nonRetryable(`unsupported workflow mode "${workflow}"`, 'WorkflowModeInvalid');
        if (workflow === (goalMode ? 'goal' : 'software-dev')) return;
        if (
          !modeSwitching ||
          confirmed ||
          cancelled ||
          pointOfNoReturnPassed ||
          (stage !== 'setup' && stage !== 'do' && stage !== 'review')
        )
          throw ApplicationFailure.nonRetryable(
            'the workflow can only switch between Software Dev and Goal before confirmation begins',
            'WorkflowModeLocked',
          );
      },
    },
  );

  // ── Resolve wrapper (SPEC §5.2) ──
  async function withResolve<T>(stageName: string, fn: () => Promise<T>): Promise<T> {
    // Usually identical to stageName, except the Confirm agent runs inside the
    // public Review stage. Preserve the actual UI stage for a later human retry.
    const resumeStage = stage;
    let lastError = '';
    for (;;) {
      let attempt = 0;
      let infraRetries = 0;
      for (; attempt <= MAX_RESOLVE_ATTEMPTS; attempt++) {
        try {
          return await fn();
        } catch (err) {
          if (cancelled || isCancellation(err)) throw err; // mid-turn cancel: don't resolve/retry
          // A credential wall (all logins/keys need a human) won't fix on retry —
          // escalate straight to a human (#5).
          if (err instanceof CredentialDenied) {
            lastError = describeError(err);
            error = lastError;
            break;
          }
          // Infrastructure died under the turn (stream cut, host slept, activity
          // timed out) — no agent can fix that, so don't burn a Resolve turn. The
          // activity already retried quickly with session resume; this handles an
          // outage that outlived those retries: park with backoff and re-run the
          // stage. Doesn't consume resolve attempts. A human Retry or a cancel
          // wakes the park early.
          if (isInfraFailure(err)) {
            if (infraRetries < INFRA_BACKOFF_MS.length) {
              const wait = INFRA_BACKOFF_MS[infraRetries++]!;
              attempt--; // an infra park is not a resolve attempt
              error = `infrastructure: ${describeError(err)} — retrying ${stageName} in ${Math.round(wait / 1000)}s (${infraRetries}/${INFRA_BACKOFF_MS.length})`;
              await publish();
              await condition(() => cancelled || retryRequested, wait);
              if (cancelled) throw new Cancelled();
              retryRequested = false;
              error = undefined;
              continue;
            }
            lastError = `infrastructure: ${describeError(err)} (still failing after ${INFRA_BACKOFF_MS.length} waits)`;
            error = lastError;
            break; // → escalate to a human; Resolve can't fix infrastructure
          }
          lastError = describeError(err);
          error = lastError;
          const providerLimit = limitFailureClassification(err);
          const prevStage = stage;
          // v1 command order is recorded in existing histories: publish Resolve,
          // then invoke autoResolve. The improved no-flicker order belongs to the
          // distinct v1.1 Temporal type and must never rewrite v1 replay.
          let auto;
          if (behaviorVersion === '1.0.0' && input.resolveAgentEnabled !== false) {
            stage = 'resolve';
            await publish();
            auto = await core.autoResolve({ taskId, stage: stageName, error, ...(providerLimit ? { limit: providerLimit } : {}) });
          } else {
            auto = await core.autoResolve({ taskId, stage: stageName, error, ...(providerLimit ? { limit: providerLimit } : {}) });
            if (auto.resolved) {
              log.info('auto-resolve matched', { stage: stageName, action: auto.action, note: auto.note });
              error = undefined;
              continue;
            }
            // Scripted recovery missed. With the process-wide Resolve-agent flag
            // off, go directly to the existing parent/human escalation path.
            if (input.resolveAgentEnabled === false) break;
            stage = 'resolve';
            await publish();
          }
          if (!auto.resolved && world) {
            // The resolve agent is about to run — freeze `agent:resolve` (SPEC §5.5).
            consumed.add('agent:resolve');
            // Escalate to the Resolve agent with a context bundle, accumulating its
            // conversation into resolveMsgs so it's inspectable in the UI (SPEC §5.5).
            const rin: Message = {
              id: `r-in-${resolveMsgs.length}`,
              role: 'user',
              text: `Fix the ${stageName} failure. Error: ${error ?? ''}`,
              ts: resolveMsgs.length,
            };
            resolveMsgs.push(rin);
            let r;
            try {
              r = await leasedTurn('resolve', (
                accountConfigHome,
                accountApiKeyHandle,
                agentTurnId,
                accountCredentialKind,
                accountCredentialProvider,
                admission,
              ) =>
                agentTurns.runAgentTurn({
                  taskId,
                  role: 'resolve',
                  worldHandle: world as any,
                  // Include the resolve agent's full transcript so a human follow-up
                  // addressed to it (SPEC §5.6) reaches it on this turn.
                  messages: resolveMsgs,
                  task: liveInput,
                  bindings: { stage: stageName, error: error ?? '', transcript: lastOutputs(msgs), skills: '' },
                  accountConfigHome,
                  accountApiKeyHandle,
                  accountCredentialKind,
                  accountCredentialProvider,
                  ...(agentTurnId ? { agentTurnId } : {}),
                  ...admission,
                }),
              );
            } catch (resolveErr) {
              // An exception thrown while handling a catch is NOT caught by that
              // same catch. This missing boundary made a quota/error in the Resolve
              // agent escape withResolve and terminally fail the Temporal execution
              // (tasks #130/#133/#150). Resolution machinery exhausting itself is a
              // human escalation, never an unhandled workflow failure.
              lastError = `Resolve agent failed while handling the ${stageName} error: ${describeError(resolveErr)}`;
              error = lastError;
              break;
            }
            if (r.output?.trim()) resolveMsgs.push({ id: `r-out-${resolveMsgs.length}`, role: 'agent', text: r.output, ts: resolveMsgs.length });
            // Consume the agent's structured verdict (SPEC §5.2, RESOLVE-PLAN §3.2)
            // instead of blindly retrying. This is the fix for "the resolve agent's
            // decision is ignored".
            const decision = r.resolution;
            if (decision) {
              const detail =
                decision.do === 'escalate' ? ` — ${decision.reason}` : decision.do === 'gotoStage' ? ` → ${decision.stage}` : '';
              resolveMsgs.push({ id: `r-dec-${resolveMsgs.length}`, role: 'system', text: `Resolve decision: ${decision.do}${detail}`, ts: resolveMsgs.length });
              log.info('resolve decision', { decision: decision.do });
              if (decision.do === 'escalate') {
                lastError = decision.reason || lastError;
                break; // agent gives up → escalate to a human now (don't burn retries)
              }
              if (decision.do !== 'resume' && decision.do !== 'retryStage') {
                // gotoStage / parkUntil need the stage-machine executor (a later phase);
                // until then escalate to a human rather than silently ignore the request.
                lastError = `Resolve agent requested "${decision.do}"${decision.do === 'gotoStage' ? ` → ${decision.stage}` : ''}, which isn't auto-applied yet — escalating to a human.`;
                break;
              }
              // resume / retryStage → fall through and re-run the originating stage.
            } else {
              log.info('resolve agent ran (no explicit decision)', { completed: r.completed });
            }
          }
          stage = prevStage as Stage;
          error = undefined; // clear for the retry display
          await publish();
        }
      }
      // Attempts exhausted → escalate. A child raises `blocked` to its parent (which
      // can retry/answer/cancel it); a top-level task escalates to a human. Either way
      // it stays resolvable — the v1 bug was a child blocking on a hidden human (§5.3).
      stage = 'escalated';
      status = 'blocked';
      error = lastError;
      retryRequested = false;
      if (input.parentTaskId) {
        waitingFor = { kind: 'parent' };
        await notifyParent('blocked', lastError);
      }
      // `escalated` advertises [retry, followUp, cancel] (see `allowed()`), so a
      // follow-up MUST wake this park too. It used to sit invisibly in `msgs` until
      // someone separately clicked Retry — while the parent path already got this
      // right (a `comment` response sets `retryRequested`). Snapshot the transcript
      // length before parking and treat a new message as the retry it plainly is:
      // the resumed stage re-runs with the follow-up already in the conversation.
      const seenAtEscalation = msgs.length;
      await publish();
      await condition(() =>
        retryRequested || cancelled || (followUpWakesEscalation && msgs.length > seenAtEscalation));
      waitingFor = undefined;
      if (cancelled) throw new Cancelled();
      // A human/parent retry resumes the stage that failed. Leaving this as
      // `escalated` made the live view claim the task was still escalated while
      // its replacement agent turn was already running (task #240). This is a
      // pure state correction before the existing next publish/activity, so it
      // does not insert a new Temporal command into historical workflow replay.
      stage = resumeStage;
      status = 'active';
      error = undefined;
    }
  }

  /** May `session` (minted under `sessionHome`) be resumed under `home` now? Only
   *  if the homes match — provider sessions are login-bound (§2.5). Passthrough
   *  (no leased home) is tracked as '(profile)'. */
  const sessionMatchesHome = (home: string | undefined): boolean =>
    sessionHome === undefined || sessionHome === (home ?? '(profile)');

  /**
   * Lease a connected login for one turn (SPEC §6.2), then return it. Leases only
   * an account of the turn's provider (claude logins for claude agents, codex for
   * codex). Activates only when the account pool is non-empty — otherwise the turn
   * runs with the profile's own home (zero behavior change). While parked for a
   * grant the task shows "waiting for a login" (that IS "waiting for quota refresh"
   * when the pool is exhausted). If the leased turn fails on a usage/session limit,
   * the leased account is reported exhausted so the coordinator marks it unavailable
   * and arms a refresh timer, then the error is rethrown so withResolve re-leases a
   * different available login — or parks until one refreshes.
   */
  async function leasedTurn<T>(
    role: AgentRole,
    fn: (
      accountConfigHome?: string,
      accountApiKeyHandle?: string,
      agentTurnId?: string,
      accountCredentialKind?: CredentialKind,
      accountCredentialProvider?: string,
      admission?: { agentAdmissionManaged: true; agentSlotGranted?: true },
    ) => Promise<T>,
  ): Promise<T> {
    /** v1.1 publishes the host-admission state before scheduling the turn. The
     * activity changes it to `running` only after it actually acquires a slot. */
    const admittedTurn = async (
      turnId: string,
      provider: 'claude' | 'codex' | 'opencode' | 'kimi' | 'grok' | 'mock' | undefined,
      resumeStatus: TaskView['status'],
      home?: string,
      key?: string,
      credentialKind?: CredentialKind,
      credentialProvider?: string,
    ): Promise<T> => {
      if (liveAgentStates) {
        agentTurnResumeStatus = resumeStatus === 'waiting' ? 'active' : resumeStatus;
        agentTurn = { turnId, role, provider, state: 'waiting-slot' };
        status = 'waiting';
        waitingFor = {
          kind: 'agentSlot',
          provider,
          detail: durableAgentAdmission ? 'Starting agent' : 'Waiting for host capacity to run the agent',
        };
        await publish();
      }
      let slotHeld = false;
      let slotRequested = false;
      try {
        return await runCancellable(async () => {
          if (durableAgentAdmission) {
            if (!world) throw new Error('agent world is not ready');
            const usesHostCapacity = await core.agentUsesHostCapacity({
              role,
              task: liveInput,
              worldHandle: world as any,
              accountConfigHome: home,
              accountApiKeyHandle: key,
              accountCredentialKind: credentialKind,
              accountCredentialProvider: credentialProvider,
            });
            if (usesHostCapacity) {
              slotRequested = true;
              const admission = await coordinator.requestAgentSlot({
                taskId,
                turnId,
                role,
                provider,
                title: input.title,
                projectId: input.projectId,
              });
              slotHeld = admission.granted || agentSlotGrants.delete(turnId);
              if (!slotHeld) {
                waitingFor = {
                  kind: 'agentSlot',
                  provider,
                  detail: 'Waiting for host capacity to start agent',
                };
                await publish();
                await condition(() => agentSlotGrants.has(turnId) || cancelled);
                slotHeld = agentSlotGrants.delete(turnId);
              }
              if (cancelled && !slotHeld) throw new Cancelled();
              waitingFor = { kind: 'agentSlot', provider, detail: 'Starting agent' };
              await publish();
            }
          }
          return await fn(
            home,
            key,
            liveAgentStates ? turnId : undefined,
            credentialKind,
            credentialProvider,
            durableAgentAdmission
              ? {
                  agentAdmissionManaged: true,
                  ...(slotHeld ? { agentSlotGranted: true } : {}),
                }
              : undefined,
          );
        });
      } finally {
        agentSlotGrants.delete(turnId);
        if (durableAgentAdmission && slotRequested) {
          if (slotHeld) await coordinator.releaseAgentSlot(taskId, turnId).catch(() => undefined);
          else await coordinator.cancelAgentSlot(taskId, turnId).catch(() => undefined);
        }
        if (liveAgentStates && agentTurn?.turnId === turnId) {
          agentTurn = undefined;
          waitingFor = undefined;
          if (status === 'waiting') status = agentTurnResumeStatus;
          await publish();
        }
      }
    };

    // v1 took this exact zero-activity passthrough. v1.1 still exposes host-slot
    // admission even when there is no configured account pool.
    if (accountPool <= 0) {
      if (!liveAgentStates) return await runCancellable(() => fn(undefined, undefined));
      return await admittedTurn(`${taskId}#${turnSeq++}`, undefined, status);
    }
    const prov = await core.resolveProvider({ role, task: liveInput }).catch(() => undefined);
    const credentialProvider = typeof prov === 'string' && prov ? prov : undefined;
    if (!credentialProvider) {
      if (!liveAgentStates) return await runCancellable(() => fn(undefined, undefined));
      return await admittedTurn(`${taskId}#${turnSeq++}`, undefined, status);
    }
    // Credential-policy allow-list for real providers (precedence + enable/disable,
    // resolved global→project→task); mock uses the coordinator's provider fallback.
    const allowed =
      credentialProvider !== 'mock'
        ? await core.resolveCredentialOrder({ taskId, projectId: input.projectId, provider: credentialProvider, role, task: liveInput }).catch(() => undefined)
        : undefined;
    const displayProvider =
      credentialProvider === 'claude' || credentialProvider === 'codex' || credentialProvider === 'opencode'
      || credentialProvider === 'kimi' || credentialProvider === 'grok' || credentialProvider === 'mock'
        ? credentialProvider
        : undefined;
    const turnId = `${taskId}#${turnSeq++}`;
    const lease = await coordinator.leaseAccount(taskId, turnId, credentialProvider, allowed);
    const priorStatus = status;
    status = 'waiting';
    // The existing publication command is retained for replay. New activity
    // results say whether the request really parked; old recorded void results
    // keep the historical account-wait state.
    waitingFor = lease?.waiting === false
      ? { kind: 'agentSlot', provider: displayProvider, detail: 'Starting agent' }
      : { kind: 'account', provider: credentialProvider };
    await publish();
    if (liveAgentStates) {
      // The coordinator owns refresh timers and signals every grant. An arbitrary
      // workflow-side timeout used to fall through with no grant and accidentally
      // run on the profile credential, bypassing the exhausted account policy.
      await condition(() => accountGrants.has(turnId) || cancelled);
    } else {
      // Immutable v1 command history: extant executions recorded this timer.
      await condition(() => accountGrants.has(turnId) || cancelled, '6 hours');
    }
    const grant = accountGrants.get(turnId);
    accountGrants.delete(turnId);
    if (liveAgentStates && cancelled && !grant) await coordinator.cancelAccount(taskId, turnId).catch(() => undefined);
    if (!liveAgentStates) {
      // Preserve v1's in-memory transition. It intentionally did not publish here;
      // changing that command sequence would break every extant v1 history.
      waitingFor = undefined;
      if (status === 'waiting') status = priorStatus === 'waiting' ? 'active' : priorStatus;
    } else if (cancelled || grant?.accountId === '(denied)') {
      // No model turn follows these paths, so explicitly clear the account wait.
      waitingFor = undefined;
      if (status === 'waiting') status = priorStatus === 'waiting' ? 'active' : priorStatus;
      await publish();
    }
    if (liveAgentStates && cancelled) throw new Cancelled();
    // The coordinator denies a turn whose every allowed credential needs human action
    // (#5): escalate rather than run/park.
    if (grant?.accountId === '(denied)') {
      if (cancelled) throw new Cancelled();
      throw new CredentialDenied(`No usable ${credentialProvider} credential — every allowed login/key needs attention (funding, re-auth, or re-enable it in credential settings).`);
    }
    const passthrough = !grant || grant.accountId === '(passthrough)';
    const leasedHome = passthrough ? undefined : grant?.configHome;
    const leasedKey = passthrough ? undefined : grant?.apiKeyHandle;
    const leasedKind = passthrough ? undefined : grant?.credentialKind;
    const leasedProvider = passthrough ? undefined : grant?.credentialProvider;
    try {
      // This publish happens immediately after the lease grant and replaces the
      // stale account-wait view with the distinct host-slot state.
      return await admittedTurn(turnId, displayProvider, priorStatus, leasedHome, leasedKey, leasedKind, leasedProvider);
    } catch (err) {
      // Limit failure → update the coordinator so it re-leases the next allowed
      // credential: a transient window arms a refresh timer; a HARD billing/auth
      // failure is flagged needs-attention (won't self-refresh → a human must act).
      if (grant && !passthrough && !cancelled && !isCancellation(err)) {
        const cls = limitFailureClassification(err);
        if (cls?.hard) {
          await coordinator.setAccountAvailability({ accountId: grant.accountId, status: 'needs-attention' }).catch(() => undefined);
        } else if (cls?.limited) {
          // Must use the same version-selected proxy as `setAccountAvailability`
          // above: on the unbounded `coord` this retries forever, and the activity
          // is a raw `executeUpdate` that does not swallow its own errors — so a
          // coordinator that keeps rejecting freezes the task here with no route to
          // a human. `.catch()` cannot save it; an unlimited-retry activity never
          // rejects, it just never returns.
          await coordinator
            .reportAccountExhausted({ accountId: grant.accountId, window: cls.window ?? '5h', resetHint: cls.resetHint, note: cls.note })
            .catch(() => undefined);
        }
      }
      throw err;
    } finally {
      // returnAccount runs in the parent (uncancelled) scope so the lease is freed.
      // Naming the lease matters: without it the coordinator drops the OLDEST record
      // for the credential, which may belong to another live task, and its dead-lease
      // sweep then over-releases (see coordinators/account.ts).
      //
      // VERSIONED, like every other change here: the identity is a new ARGUMENT, and
      // an activity's input is recorded with its ScheduleActivityTask command. Left
      // ungated it also altered older pins at runtime — the coordinator can only
      // match an identified return against a record carrying the same identity, so
      // on an older execution the return found nothing and quietly released nothing,
      // holding the login's capacity and stalling whatever asked for it next. That
      // showed up as ~20% flakiness in the parent/child cancellation test on 1.6.0.
      if (grant && !passthrough) {
        await (identifiedAccountReturns
          ? coordinator.returnAccount(grant.accountId, { taskId, turnId })
          : coordinator.returnAccount(grant.accountId)).catch(() => undefined);
      }
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

  // ── Do turn + sub-task hierarchy (SPEC §5.2/§5.3) ──
  /** Run one Do-agent turn (leased login, resolve-wrapped) and fold its result into
   *  the running conversation. Shared by the main loop and sub-task management. */
  async function doTurn() {
    let doHome: string | undefined;
    // How many leading `msgs` were actually handed to the agent this turn. Captured
    // at activity-schedule time (the instant Temporal snapshots the args) — NOT after
    // the turn — so a follow-up that arrives WHILE the turn runs is not mistaken for
    // "already delivered". Advancing `seen` to `msgs.length` afterwards was the bug:
    // a mid-turn follow-up landed in `msgs` but got marked consumed, so it silently
    // never reached the agent (SPEC §5.6 — a queued follow-up must reach the agent).
    let deliveredNow = seen;
    const turn = await withResolve('do', () =>
      leasedTurn('do', (
        accountConfigHome,
        accountApiKeyHandle,
        agentTurnId,
        accountCredentialKind,
        accountCredentialProvider,
        admission,
      ) => {
        doHome = accountConfigHome ?? '(profile)';
        // Resume only when the leased login matches the one that minted the session
        // (§2.5). When we do, the session already holds the first `seen` messages
        // (everything delivered on prior turns), so send only the delta after them —
        // a follow-up reaches the agent as a follow-up, not the whole conversation.
        const resume = sessionMatchesHome(accountConfigHome) ? session : undefined;
        deliveredNow = msgs.length; // everything queued up to this instant is delivered
        return agentTurns.runAgentTurn({
          taskId,
          role: 'do',
          worldHandle: world as any,
          messages: msgs,
          session: resume,
          deliveredMessages: resume ? seen : 0,
          task: liveInput,
          accountConfigHome,
          accountApiKeyHandle,
          accountCredentialKind,
          accountCredentialProvider,
          ...(agentTurnId ? { agentTurnId } : {}),
          ...admission,
        });
      }),
    );
    session = turn.session ?? session;
    sessionHome = doHome ?? sessionHome;
    // The turn reports how many `msgs` it actually delivered — the batch captured at
    // schedule PLUS any follow-ups it injected in-flight (SPEC §5.6). Fall back to the
    // schedule snapshot for adapters that don't inject. Clamp within the array in case
    // more follow-ups landed after the turn's final poll (they stay after the boundary
    // → delivered on the next turn, never dropped, never re-sent).
    const delivered = Math.min(Math.max(turn.delivered ?? deliveredNow, deliveredNow), msgs.length);
    // Insert the agent's reply right after exactly the messages it answered — BEFORE
    // any follow-up that arrived after the last poll. This keeps the transcript honest
    // and leaves that follow-up AFTER `seen`, so the NEXT turn delivers it.
    if (turn.output?.trim()) {
      msgs.splice(delivered, 0, { id: `a${delivered}`, role: 'agent', text: turn.output, ts: delivered });
      seen = delivered + 1;
    } else {
      seen = delivered;
    }
    if (turn.reviewInfo) {
      // A proposal-readiness/landing refusal resumes the SAME Do conversation.
      // A later turn may provide only a completion summary; do not erase useful
      // review affordances (caption/actions/links) from the proposal it repaired.
      // Fields the later turn actually supplies remain last-write-wins.
      reviewInfo = { ...reviewInfo, ...turn.reviewInfo };
    }
    // A branch the agent added with `create_branch` already exists in the world;
    // adopt the handle that now names it so the PR and merge stages see it. The
    // handle rides back on the turn RESULT, so this is journaled state, not a
    // second source of truth — and older pinned versions never set it, so their
    // replay is unaffected.
    if (multiPrEnabled && turn.worldHandle) world = turn.worldHandle as WorldHandleLike;
    if (explicitPrCycle && turn.openPrRequested) prRequested = true;
    return turn;
  }

  /** The judgment-bearing half of Merge: decide what belongs in the change,
   * commit it, integrate the target into the task branch, resolve conflicts and
   * test. The deterministic protected-target landing is deliberately separate. */
  async function mergeTurn(text: string) {
    const mergeIn: Message = {
      id: `m-in-${mergeMsgs.length}`,
      role: 'user',
      text,
      ts: mergeMsgs.length,
    };
    mergeMsgs.push(mergeIn);
    const mt = await leasedTurn('merge', (
      accountConfigHome,
      accountApiKeyHandle,
      agentTurnId,
      accountCredentialKind,
      accountCredentialProvider,
      admission,
    ) =>
      agentTurns.runAgentTurn({
        taskId,
        role: 'merge',
        worldHandle: world as any,
        // Feed the Merge agent its full transcript so a retry has the rejection
        // context and role-addressed human follow-ups are not lost.
        messages: mergeMsgs,
        session: sessionMatchesHome(accountConfigHome) ? session : undefined,
        task: liveInput,
        bindings: { reviewInfo: reviewInfo?.summary ?? '' },
        accountConfigHome,
        accountApiKeyHandle,
        accountCredentialKind,
        accountCredentialProvider,
        ...(agentTurnId ? { agentTurnId } : {}),
        ...admission,
      }),
    ).catch((e) => {
      if (isCancellation(e)) throw e;
      log.warn('merge agent turn failed; proceeding to authoritative check', { e: String(e) });
      return undefined;
    });
    if (mt?.output?.trim()) {
      mergeMsgs.push({ id: `m-out-${mergeMsgs.length}`, role: 'agent', text: mt.output, ts: mergeMsgs.length });
    }
    return mt;
  }

  /** Run one Confirm-agent turn at the Review gate (SPEC §5.2): it reviews the work and
   *  returns a structured verdict (confirm / revise / reject) — the same three moves a
   *  human makes. Leased + resolve-wrapped like every other role. Returns the verdict,
   *  or undefined if the agent turn failed or declined to decide (caller falls back to
   *  the human gate so nothing is silently auto-confirmed). */
  async function confirmTurn(layer: ConfirmLayer): Promise<import('./contract.js').ConfirmDecision | undefined> {
    // The layer's own agent spec drives this turn (each agent layer can run a
    // different reviewer): land it on liveInput.agents.confirm so the shared
    // machinery (provider lease + runAgentTurn's per-role override) picks it up;
    // a spec-less layer clears the slot and falls back to the confirm profile.
    const { kind: _kind, prompt: _prompt, ...layerSpec } = layer;
    const { confirm: _prev, ...otherAgents } = liveInput.agents ?? {};
    liveInput.agents = layerSpec.provider ? { ...otherAgents, confirm: { ...layerSpec, provider: layerSpec.provider } } : otherAgents;
    // Each Review appends a fresh review-request to the Confirm transcript — the task
    // prompt + the Do agent's latest response, rendered from the (user-editable)
    // confirm prompt template — so repeated Reviews read as ONE conversation:
    // request, verdict, request with the new response, ad recursum.
    const response =
      [...msgs].reverse().find((m) => m.role === 'agent')?.text ?? reviewInfo?.summary ?? '(the agent produced no final message)';
    const request = renderConfirmPrompt(layer.prompt ?? input.confirm?.prompt, {
      title: input.title,
      prompt: input.prompt,
      response,
      reviewInfo: reviewInfo?.summary ?? '',
      changedFiles: (reviewInfo?.changedFiles ?? []).join('\n'),
      transcript: lastOutputs(msgs),
    });
    confirmMsgs.push({ id: `c-in-${confirmMsgs.length}`, role: 'user', text: request, ts: confirmMsgs.length });
    const ct = await withResolve('confirm', () =>
      leasedTurn('confirm', (
        accountConfigHome,
        accountApiKeyHandle,
        agentTurnId,
        accountCredentialKind,
        accountCredentialProvider,
        admission,
      ) =>
        // Each Review runs a FRESH confirm turn (session left unset) so the reviewer
        // always gets an up-to-date system prompt (fresh reviewInfo / changed files);
        // continuity comes from `confirmMsgs`, replayed to the fresh session — prior
        // requests and verdicts included. A mid-turn activity retry still resumes via
        // heartbeat details inside runAgentTurn.
        agentTurns.runAgentTurn({
          taskId,
          role: 'confirm',
          worldHandle: world as any,
          messages: confirmMsgs,
          task: liveInput,
          bindings: {
            reviewInfo: reviewInfo?.summary ?? '',
            changedFiles: (reviewInfo?.changedFiles ?? []).join('\n'),
            transcript: lastOutputs(msgs),
          },
          accountConfigHome,
          accountApiKeyHandle,
          accountCredentialKind,
          accountCredentialProvider,
          ...(agentTurnId ? { agentTurnId } : {}),
          ...admission,
        }),
      ),
    ).catch((e) => {
      if (isCancellation(e)) throw e;
      log.warn('confirm agent turn failed; falling back to the human gate', { e: String(e) });
      return undefined;
    });
    if (ct?.output?.trim()) confirmMsgs.push({ id: `c-out-${confirmMsgs.length}`, role: 'agent', text: ct.output, ts: confirmMsgs.length });
    // Record the verdict itself in the transcript (the agent's prose may not state
    // it). System role: shown to humans, stripped by adapters on later rounds.
    if (ct?.confirmDecision) {
      const d = ct.confirmDecision;
      confirmMsgs.push({ id: `c-dec-${confirmMsgs.length}`, role: 'system', text: `confirm_decision: ${d.action}${d.text ? ` — ${d.text}` : ''}`, ts: confirmMsgs.length });
    }
    return ct?.confirmDecision;
  }

  /** Record a child's eventual settlement so the management loop can react. */
  function trackChild(childTaskId: string, child: ChildWorkflowHandle<typeof softwareDev>) {
    child.result().then(
      (res) => settled.push({ childTaskId, stage: (res as { stage: Stage }).stage }),
      (err) => settled.push({ childTaskId, stage: 'failed', detail: describeError(err) }),
    );
  }

  /** Spawn sub-tasks as branch-stacked, detached children (SPEC §5.3). Each branches
   *  off — and merges back into — THIS task's world branch, so `main` sees one merge at
   *  the top. Commit-on-spawn snapshots our work first (worktrees share commits, not the
   *  dirty tree) so children fork the current state. */
  async function spawnSubTasks(list: { title: string; prompt: string }[]) {
    await core.commitWork(world as any, `karmax: snapshot before sub-tasks for ${taskId}`);
    for (const s of list) {
      // Bound the fan-out (SPEC §5.3): non-blocking spawn makes runaway delegation
      // cheap, so cap concurrent + lifetime children. Surface drops (never silent).
      if (outstanding.size >= MAX_CONCURRENT_SUBTASKS || subTaskIds.length >= MAX_TOTAL_SUBTASKS) {
        const reason =
          subTaskIds.length >= MAX_TOTAL_SUBTASKS
            ? `this task's sub-task limit (${MAX_TOTAL_SUBTASKS} total) is reached`
            : `too many sub-tasks are running at once (${MAX_CONCURRENT_SUBTASKS} max) — wait for some to finish`;
        msgs.push({ id: `st-${msgs.length}`, role: 'user', text: `Sub-task "${s.title}" was NOT spawned: ${reason}.`, ts: msgs.length });
        continue;
      }
      const childInput = await core.prepareChildTask({
        parentTaskId: taskId,
        projectId: input.projectId,
        title: s.title,
        prompt: s.prompt,
        base: world!.branch,
        target: world!.branch,
        project: input.project,
        profiles: input.profiles,
        resolveAgentEnabled: input.resolveAgentEnabled,
        // Branch-scoped, least-privilege grant for the child (SPEC §8.2).
        parentBranch: world!.branch,
        parentGrant: input.grant,
      });
      subTaskIds.push(childInput.taskId);
      outstanding.add(childInput.taskId);
      const child = await startChild<typeof softwareDev>(
        childWorkflowType(behaviorVersion),
        {
          workflowId: childInput.taskId,
          args: [childInput as SoftwareDevInput],
        },
      );
      childHandles.set(childInput.taskId, child);
      trackChild(childInput.taskId, child);
    }
    await publish();
  }

  /** Send the Do agent's answers down to the children they target (SPEC §5.3). */
  async function applySubTaskResponses(responses: SubTaskResponse[] | undefined) {
    for (const r of responses ?? []) {
      const targets = r.childTaskId ? [r.childTaskId] : [...awaitingResponse];
      const resp: ParentResponse = { action: r.action, text: r.text };
      for (const cid of targets) {
        try {
          await getExternalWorkflowHandle(cid).signal(parentResponseSignal, resp);
        } catch {
          /* child already gone */
        }
        awaitingResponse.delete(cid);
      }
    }
  }

  /** Cancel any still-running children (on our own abort). Best effort. v1.1 can
   * wait briefly for their graceful cancellation so Temporal's parent-close
   * policy does not race the signal and turn a cancelled child into Terminated. */
  async function cancelChildren(waitForSettlement = false) {
    for (const cid of outstanding) {
      try {
        await getExternalWorkflowHandle(cid).signal(cancelSignal);
      } catch {
        /* best effort */
      }
    }
    if (waitForSettlement && outstanding.size) {
      const targets = [...outstanding];
      await condition(() => targets.every((cid) => settled.some((s) => s.childTaskId === cid)), '10 seconds');
    }
  }

  function subtaskRaiseText(r: ChildRaise): string {
    return `Sub-task "${r.childTitle}" (${r.childTaskId}) needs you — ${r.type}${r.detail ? `: ${r.detail}` : ''}. Answer with respond_to_sub_task (confirm | comment | retry | cancel).`;
  }

  /**
   * Fold any pending child events (raises + settlements) into the Do conversation so
   * the agent sees them at the top of its next turn (SPEC §5.3). This is what lets the
   * parent run its own work turn-after-turn WHILE children run in the background —
   * their raises/results interleave as messages rather than blocking the loop.
   *
   * These are injected as `role: 'user'`, NOT `role: 'system'`: the real provider
   * adapters (claude, codex) strip conversation system messages from what the model
   * sees, so a system-role raise would silently never reach the parent agent — the
   * "parent not notified" bug. They are genuine new instructions for the agent, so
   * user-role is also the correct framing.
   */
  function drainChildEvents(): void {
    while (raises.length) {
      const r = raises.shift()!;
      msgs.push({ id: `st-${msgs.length}`, role: 'user', text: subtaskRaiseText(r), ts: msgs.length });
    }
    while (settled.length) {
      const s = settled.shift()!;
      outstanding.delete(s.childTaskId);
      awaitingResponse.delete(s.childTaskId);
      msgs.push({
        id: `st-${msgs.length}`,
        role: 'user',
        text: `Sub-task ${s.childTaskId} finished: ${s.stage}${s.detail ? ` (${s.detail})` : ''}.`,
        ts: msgs.length,
      });
    }
  }

  /** Tell our parent (if any) we need a decision (SPEC §5.3). Best effort — if the
   *  parent is gone the child stays human-resolvable via its own retry/confirm. */
  async function notifyParent(type: ChildRaise['type'], detail?: string) {
    if (!input.parentTaskId) return;
    try {
      await getExternalWorkflowHandle(input.parentTaskId).signal(raiseFromChildSignal, {
        childTaskId: taskId,
        childTitle: input.title,
        type,
        detail: detail ?? '',
      });
    } catch {
      /* parent gone → fall back to the human gate */
    }
  }

  try {
  // ── Setup ──
  await publish();
  if (!world) {
    world = (await withResolve('setup', () =>
      core.createWorld({ taskId, ...(remoteWorldProvider(kind) ? { projectId: input.projectId } : {}), repos: input.project.repos, base, target, copyGlobs: input.project.copyGlobs, gitProfile: input.project.gitProfile, kind, resetBranch: input.discardProgress, ...(input.project.multiPr ? { multiPr: true } : {}) }),
    )) as WorldHandleLike;
  }
  // One-shot probe: does the account pool exist? (self-configuring; 0 = off)
  accountPool = await coordinator.accountPoolSize().catch(() => 0);

  // A platform-requested human hold is deliberately outside the pipeline. Keep
  // the originating stage visible. An explicit Resume always wakes it; v1.7 also
  // treats a follow-up / Review confirmation / autonomous Goal switch as the
  // input the hold was waiting for. The replacement history owns no agent/queue
  // activity while held.
  let pauseWake: typeof humanPauseWake;
  if (recovery?.pausedForHuman) {
    stage = recoveryStage;
    status = 'waiting';
    waitingFor = { kind: 'human', audience: ['@creator'], detail: `Paused during ${recoveryStage}` };
    retryRequested = false;
    await publish();
    if (responsiveHumanHold)
      await condition(() => !!humanPauseWake || cancelled);
    else
      await condition(() => retryRequested || cancelled);
    pauseWake = humanPauseWake;
    waitingFor = undefined;
    if (cancelled) return await abort();
    retryRequested = false;
    humanPauseWake = undefined;
    status = 'active';
    humanPauseActive = false;
  }

  // Restoring a cancelled/manual-done Review returns to the decision gate without
  // rerunning completed Do work. The action that released a Review-origin hold
  // keeps its normal meaning: Confirm advances, feedback returns to Do, while an
  // explicit Resume merely restores the still-pending Review gate.
  let restoredReviewApproved = recoveryStage === 'review' && pauseWake?.kind === 'confirm';
  const restoredReviewBackToDo =
    recoveryStage === 'review'
    && (pauseWake?.kind === 'followUp' || pauseWake?.kind === 'workflowChange');
  if (recoveryStage === 'review' && !restoredReviewApproved && !restoredReviewBackToDo) {
    stage = 'review';
    status = 'waiting';
    waitingFor = { kind: 'human', audience: ['@creator'], detail: 'Restored review' };
    confirmed = false;
    const reviewSeen = msgs.length;
    await publish();
    await condition(() => confirmed || cancelled || msgs.length > reviewSeen);
    waitingFor = undefined;
    if (cancelled) return await abort();
    restoredReviewApproved = confirmed;
    confirmed = restoredReviewApproved;
    status = 'active';
  }

  let sha: string | undefined;
  proposalCycle: for (;;) {
  // ── Do ⇄ Waiting for input ⇒ PR ⇄ Review ──
  if (!restoredReviewApproved && recoveryStage !== 'pr' && recoveryStage !== 'merge') {
  for (;;) {
    // Each iteration starts fresh in Do — clears any park state left by a prior
    // sub-task wait (status 'waiting'/waitingFor 'subtask').
    stage = 'do';
    status = 'active';
    waitingFor = undefined;
    // Fold in anything the children did since our last turn (SPEC §5.3) so the agent
    // sees their raises/results at the top of this turn — this is what lets us keep
    // working while they run, rather than blocking on them.
    drainChildEvents();
    await publish();
    if (cancelled) return await abort();

    // A human/parent may request Open PR while the task is already parked. That
    // transition uses the proposal the Do agent just produced; it must not spend
    // another model turn before publishing it.
    const turn: Awaited<ReturnType<typeof doTurn>> = explicitPrCycle && prRequested
      ? { completed: true, providerCompleted: true, output: '', openPrRequested: true }
      : await doTurn();
    // Sub-tasks run in the BACKGROUND: spawn is non-blocking, and answers go straight
    // down to the children they target (SPEC §5.3).
    if (turn.subTasks?.length) await spawnSubTasks(turn.subTasks);
    if (turn.subTaskResponses?.length) await applySubTaskResponses(turn.subTaskResponses);

    // v1.2 advances only after an adapter observed the provider's successful terminal
    // event. v1.0/v1.1 retain their immutable signal/idle semantics for replay.
    // Software Dev treats a clean provider return as the turn boundary and asks
    // its confirmer to judge the result. Goal has no reviewer, so v1.3 requires
    // the agent's explicit completion marker; a merely clean-but-partial return
    // is re-prompted instead of silently auto-merging.
    const turnFinished = providerTerminalCompletion
      ? modeSwitching && goalMode
        ? !!turn.completed
        : !!turn.providerCompleted
      : turn.completed;
    const finishing = turnFinished || (!providerTerminalCompletion && turn.needsInput) || turn.raise;

    // While children are still running, the parent doesn't leave the Do loop:
    if (outstanding.size > 0) {
      if (turn.waitForSubtasks || finishing) {
        // Explicit wait, or a finish deferred by the end-stage barrier — a completion
        // here is held until the children settle (the agent re-signals once they do),
        // so the parent's own Review/Merge never races ahead of its delegated work.
        // Stay responsive: wake on a child raise/settlement or a human follow-up.
        status = 'waiting';
        waitingFor = { kind: 'subtask' };
        await publish();
        const wake = () => raises.length > 0 || settled.length > 0 || cancelled || msgs.length > seen;
        // If a child is still awaiting OUR reply (it raised a needs_confirmation /
        // needs_info / blocked that we drained but haven't answered), we must not
        // park forever: a child at Review neither re-raises nor settles, so `wake`
        // could never fire — the observed deadlock. Bound the wait so we re-enter Do
        // and re-prompt the agent (the unresolved raise is still in the conversation)
        // until it acts — SPEC §5.3 "keep prompting". With nothing awaiting us, wait
        // indefinitely for the next child event or human follow-up.
        if (awaitingResponse.size > 0) await condition(wake, input.subtaskNagMs ?? DEFAULT_SUBTASK_NAG_MS);
        else await condition(wake);
        if (cancelled) return await abort();
      }
      // Otherwise the agent kept working (spawned/answered this turn) — loop and run
      // another turn; the children's events drain in at the top.
      continue;
    }

    // No children outstanding.
    if (turn.waitForSubtasks) continue; // nothing to wait for → just take another turn

    if (pendingCollaborations.size > 0 && finishing) {
      status = 'waiting';
      waitingFor = {
        kind: 'collaboration',
        detail: `Waiting for ${pendingCollaborations.size} background collaboration request(s)`,
      };
      await publish();
      await condition(() => cancelled || pendingCollaborations.size === 0 || msgs.length > seen);
      if (cancelled) return await abort();
      stage = 'do';
      status = 'active';
      continue;
    }

    // A collaboration may settle after the provider's final live-message poll
    // but before its activity returns. Always deliver that queued result in a
    // fresh turn instead of advancing to Review with an unread notification.
    if (msgs.length > seen) continue;

    // The agent's OWN in-harness sub-agents (Claude Agent SDK Task tool) may still be
    // running when its turn returned — Claude Code auto-backgrounds long sub-agents, so
    // the turn can come back "done" while a sub-agent is still working. Completion is
    // "done AND not waiting on any sub-agents", so don't advance to Review yet: hold in
    // Do and re-prompt so the agent waits for them and folds in their results before
    // finishing. Bounded (MAX_SUBAGENT_NUDGES) so a wedged sub-agent can't park forever.
    if (turn.pendingSubagents && subagentNudges < MAX_SUBAGENT_NUDGES) {
      subagentNudges++;
      status = 'waiting';
      waitingFor = { kind: 'subagent', detail: `${turn.pendingSubagents} sub-agent(s) still running` };
      await publish();
      // Back off before re-prompting (avoids a hot loop of subprocess spawns), but stay
      // redirectable: a human follow-up or a cancel wakes us early.
      await condition(() => cancelled || msgs.length > seen, input.subagentWaitMs ?? DEFAULT_SUBAGENT_WAIT_MS);
      if (cancelled) return await abort();
      // Unless a human already redirected us this wait, nudge the agent to wait for its
      // sub-agents and fold in their results before signalling completion.
      if (msgs.length === seen) {
        msgs.push({
          id: `sa-${msgs.length}`,
          role: 'user',
          text: providerTerminalCompletion
            ? 'Your sub-agents are still running. Wait for all of them to finish, incorporate their results, then finish this turn with the complete result.'
            : 'Your sub-agents are still running. Wait for all of them to finish, incorporate their results, then call signal_completion.',
          ts: msgs.length,
        });
      }
      stage = 'do';
      status = 'active';
      continue;
    }
    // Fell through with sub-agents still reported running ⇒ the nudge budget is spent.
    // We proceed to Review (liveness over parking), but surface it so the reviewer knows
    // the work may be missing a wedged sub-agent's output rather than being truly done.
    const gaveUpOnSubagents = !!turn.pendingSubagents && subagentNudges >= MAX_SUBAGENT_NUDGES;
    subagentNudges = 0; // sub-agents settled (or nudge budget spent) → reset for next Do phase

    // A `run_in_background` shell (e.g. a backgrounded `npm test`) may still be running
    // when the turn returned — the agent ends its turn meaning to fold in the result
    // later, and a returned Do turn otherwise falls straight through to Review (task 130).
    // Hold in Do and re-prompt instead. Bounded SMALL and softer than the sub-agent case:
    // the shell might be a dev server the task deliberately left running, so after the
    // budget we proceed anyway (with the note below).
    if (turn.pendingBackgroundShells && shellNudges < MAX_SHELL_NUDGES) {
      shellNudges++;
      status = 'waiting';
      waitingFor = { kind: 'shell', detail: `${turn.pendingBackgroundShells} background job(s) still running` };
      await publish();
      // Back off before re-prompting, but stay redirectable: a human follow-up or a
      // cancel wakes us early.
      await condition(() => cancelled || msgs.length > seen, input.subagentWaitMs ?? DEFAULT_SUBAGENT_WAIT_MS);
      if (cancelled) return await abort();
      if (msgs.length === seen) {
        msgs.push({
          id: `sh-${msgs.length}`,
          role: 'user',
          text: providerTerminalCompletion
            ? 'A background job you started (a run_in_background shell) is still running. If you need its result — e.g. a test run — wait for it, fold in the result, then finish the turn. If it is deliberately long-lived (e.g. a dev server), finish now and explain that.'
            : 'A background job you started (a run_in_background shell) is still running. If you are waiting on its result — e.g. a test run — wait for it to finish, fold in the result, then call signal_completion. If you are deliberately leaving it running (e.g. a dev server), call signal_completion now to proceed to review.',
          ts: msgs.length,
        });
      }
      stage = 'do';
      status = 'active';
      continue;
    }
    // Fell through with a background shell still running ⇒ the nudge budget is spent
    // (likely a long-lived process the agent means to leave running). Proceed, but note it.
    const gaveUpOnShells = !!turn.pendingBackgroundShells && shellNudges >= MAX_SHELL_NUDGES;
    shellNudges = 0; // shells settled (or nudge budget spent) → reset for next Do phase

    {
      // Legacy goal versions required signal_completion. v1.2 treats the provider's
      // verified successful terminal event as the authoritative turn boundary.
      if (goalMode && !turnFinished && !turn.raise) {
        msgs.push({
          id: `kg-${msgs.length}`,
          role: 'user',
          text: modeSwitching
            ? 'Keep going until the goal is fully complete and verified, then call signal_completion. Do not call it for partial progress.'
            : providerTerminalCompletion
            ? 'Keep going until the goal is fully complete, then finish with the result.'
            : 'Keep going until the goal is fully complete, then call signal_completion.',
          ts: msgs.length,
        });
        stage = 'do';
        continue;
      }
      // Attach a git-derived changed-files summary; the agent's own review info
      // (summary/links/html) takes precedence where present (§5.5). Diffs are
      // intentionally omitted from the review packet — reviewers use the
      // changed-files list plus the in-world terminal / conversation transcripts.
      const auto = await core.buildReview(world as any, base).catch(() => undefined);
      if (auto) {
        reviewInfo = {
          // Prefer the agent's terse caption; fall back to the git-derived summary.
          caption: reviewInfo?.caption,
          summary: reviewInfo?.summary ?? auto.summary,
          changedFiles: auto.changedFiles,
          ...(reviewInfo?.actions ? { actions: reviewInfo.actions } : {}),
          ...(reviewInfo?.links ? { links: reviewInfo.links } : {}),
          ...(reviewInfo?.html ? { html: reviewInfo.html } : {}),
        };
      }
      // An explicit raise carries its own message; show it as the review summary.
      if (turn.raise?.detail) reviewInfo = { ...reviewInfo, summary: turn.raise.detail };
      // Record HOW this turn reached Review so the confirmer can tell an asserted finish
      // from a silent stall. `completed`/`needsInput` only change control flow in auto/goal
      // modes (the zero-layers auto-confirm guard below and the goal keep-going loop above);
      // under a human/agent confirmer every path lands at the same gate, so this marker is
      // the one thing that surfaces the distinction the runtime already computes. A stall
      // means the agent went quiet WITHOUT calling signal_completion — the work may be
      // partial — so the reviewer should scrutinise rather than rubber-stamp.
      reviewInfo = {
        ...reviewInfo,
        completion: providerTerminalCompletion
          ? turn.raise ? 'raised' : turn.completed ? 'signalled' : turnFinished ? 'finished' : 'stalled'
          : turn.completed ? 'signalled' : turn.raise ? 'raised' : 'stalled',
      };
      // We stopped waiting on still-running sub-agents (budget spent) — prepend a note so
      // the reviewer knows this reached Review with delegated work possibly incomplete.
      if (gaveUpOnSubagents) {
        const note = `⚠️ Proceeded to Review with ${turn.pendingSubagents} sub-agent(s) still reported running after ${MAX_SUBAGENT_NUDGES} waits — a sub-agent may be wedged and its output missing.`;
        reviewInfo = { ...reviewInfo, summary: reviewInfo?.summary ? `${note}\n\n${reviewInfo.summary}` : note };
      }
      // Same for a background shell we stopped waiting on (budget spent) — it may be a
      // dev server left running on purpose, or a job whose result never got folded in.
      if (gaveUpOnShells) {
        const note = `⚠️ Proceeded to Review with ${turn.pendingBackgroundShells} background job(s) still running after ${MAX_SHELL_NUDGES} waits — if this was a test/build run, its result may not have been folded in.`;
        reviewInfo = { ...reviewInfo, summary: reviewInfo?.summary ? `${note}\n\n${reviewInfo.summary}` : note };
      }
      if (explicitPrCycle) {
        // Ending a Do turn is not a shipping decision. Unless the agent called
        // open_pr, park in Do for ordinary input; a follow-up resumes the same
        // agent, while Open PR advances this exact proposal without another turn.
        if (!prRequested) {
          status = 'waiting';
          if (input.parentTaskId) {
            waitingFor = { kind: 'parent', detail: 'Waiting for the managing agent to open the PR' };
            await notifyParent(turn.raise?.type ?? 'needs_confirmation',
              turn.raise?.detail ?? 'The Do turn ended. Open the PR only if the requested work is truly complete; otherwise send a comment.');
          } else {
            waitingFor = {
              kind: 'human',
              audience: ['@creator'],
              detail: turn.raise?.detail ?? 'The agent finished its turn. Send a follow-up, or open the PR if the work is truly complete.',
            };
          }
          await publish();
          await condition(() => prRequested || cancelled || msgs.length > seen);
          waitingFor = undefined;
          if (cancelled) return await abort();
          if (!prRequested) {
            stage = 'do';
            status = 'active';
            continue;
          }
        }

        // The Do agent owns commit-vs-ignore judgment. The workflow validates
        // the result, and a refused proposal goes back to the same conversation
        // instead of invoking a second "Merge" personality.
        const readiness = await core.checkProposal(world as any);
        if (!readiness.ready) {
          const detail = readiness.conflict ?? readiness.dirty ?? readiness.note ?? 'the proposal is not ready';
          msgs.push({
            id: `pr-refused-${msgs.length}`,
            role: 'user',
            text: `Open PR was refused: ${readiness.note ?? 'proposal validation failed'}.\n${detail}\nResolve this in the task branch, verify it, then call open_pr again.`,
            ts: msgs.length,
          });
          prRequested = false;
          stage = 'do';
          status = 'active';
          continue;
        }

        stage = 'pr';
        status = 'active';
        await publish();
        if (cancelled) return await abort();
        targetLocked = true;
        if (githubAuthoritativeMerge) {
          const opened = await withResolve('pr', () => core.openPr(world as any, target, {
            title: input.title,
            summary: reviewInfo?.summary ?? lastOutputs(msgs),
          }));
          prs = opened ?? [];
          pr = prs[0];
        }
        branchPreparedForPr = true;
        prRequested = false;
        // The proposal is commit-bound now; rebuild the review packet after the
        // readiness check/open so Review describes the exact published head.
        const preparedReview = await core.buildReview(world as any, base).catch(() => undefined);
        if (preparedReview) reviewInfo = { ...reviewInfo, ...preparedReview };
      } else if (proposalBeforeReview) {
        // Publish the proposal stage before Review. Under GitHub policy this is
        // the actual PR—not a worktree snapshot that will be committed/rebased
        // later. This is still before the point of no return: the Merge agent
        // only prepares the task branch and openPr updates its idempotent PR.
        stage = 'pr';
        status = 'active';
        await publish();
        if (cancelled) return await abort();
        if (githubAuthoritativeMerge) {
          targetLocked = true;
          consumed.add('agent:merge');
          await mergeTurn(
            `Prepare this branch as the exact proposal reviewers will inspect for merge into ${target}. `
            + `The worktree may contain uncommitted changes: commit what should land; gitignore (or delete) what should not. `
            + `Merge ${target} into the current branch, `
            + `resolve every conflict, run the relevant build and tests, and leave the worktree clean. Do not merge the target branch itself.`,
          );
          branchPreparedForPr = true;
          const opened = await withResolve('pr', () => core.openPr(world as any, target, {
            title: input.title,
            summary: reviewInfo?.summary ?? lastOutputs(msgs),
          }));
          prs = opened ?? [];
          pr = prs[0];
          // Preparation may have committed conflict resolutions or cleanup after
          // the Do packet was built. Refresh the human-facing diff now so Review
          // and the PR head describe the same proposal.
          const preparedReview = await core.buildReview(world as any, base).catch(() => undefined);
          if (preparedReview) reviewInfo = { ...reviewInfo, ...preparedReview };
        }
      }
      // Read where every branch stands BEFORE entering Review. Approval is bound to
      // a head sha, so this is also what makes a stale approval lapse: a branch the
      // Do agent touched since it was approved now reports a different head and
      // drops back to unapproved, while the untouched ones keep theirs.
      //
      // Deliberately ahead of `stage = 'review'`: the view is served by a live query,
      // so fetching after the flip leaves a window where Review is observable with
      // its branches missing their heads — and a branch with no head cannot be
      // approved, so that window is a Review whose Approve buttons quietly do nothing.
      if (multiPrEnabled) checkoutHeads = await core.checkoutHeads(world as any).catch(() => checkoutHeads);
      stage = 'review';
      status = 'waiting';
      // `confirmed` is a GATE token, not a latch. Clear it the instant we enter the
      // Review gate — before any await, so nothing that arrives from here on is lost.
      //
      // Why: `confirmSignal` / `parentResponseSignal('confirm')` set the flag at ANY
      // stage. Without this, a confirm that arrived during Do — e.g. a parent
      // answering `confirm` to a mid-Do `needs_info` raise, which means "yes, go on
      // with what you asked", not "your final work is approved" — pre-approved the
      // NEXT Review gate: it returned instantly and the change went to PR/merge
      // completely unseen.
      //
      // Semantics chosen: a confirm only counts for a Review gate that was already
      // open when it arrived. The legitimate race (a human/parent clicking Confirm
      // between our `publish()` and the `condition()` park) is preserved, because
      // the clear happens strictly BEFORE the publish that advertises the gate — a
      // confirmer cannot even see the gate until after we have cleared. Confirms
      // that predate the gate are deliberately dropped; the confirmer is re-shown
      // the gate and can click again.
      if (clearsConfirmOnGate) confirmed = false;
      // Who confirms (SPEC §5.2/§5.3): a child always routes to its parent; a top-level
      // task plays its confirm layers in order (each a human click or a Confirm agent).
      if (input.parentTaskId) {
        // Parent-as-confirmer (SPEC §5.3): raise to the parent instead of blocking on
        // a human the parent-managed child isn't even surfaced to. The parent's reply
        // drives `confirmed`/follow-up via parentResponseSignal.
        waitingFor = { kind: 'parent' };
        await notifyParent(turn.raise?.type ?? 'needs_confirmation', reviewInfo?.summary);
        await publish();
        await condition(() => confirmed || cancelled || msgs.length > seen);
        waitingFor = undefined;
        if (cancelled) return await abort();
        if (confirmed) break;
        // the parent's comment arrived → back to Do
        stage = 'do';
        status = 'active';
        continue;
      }
      // Zero layers auto-confirm — but only a turn that actually finished its work (or
      // is explicitly raising for a decision), never a bare needsInput stall, which
      // would push a zero-/partial-work diff straight through to merge unseen: a stall
      // degrades to a single human gate. (In goal mode the loop above already
      // guarantees completed|raise here, so the guard changes no reachable goal path.)
      // Recomputed on every iteration, never captured: the Review route is `untilUsed`,
      // so an edit that lands while the gate is parked must take effect here.
      const gatesNow = (): ConfirmLayer[] => {
        const layers: ConfirmLayer[] = modeSwitching
          ? (goalMode ? (turn.raise ? [{ kind: 'human', audience: ['@creator'] }] : []) : softwareDevConfirmLayers)
          : softwareDevConfirmLayers;
        return layers.length || turnFinished || turn.raise ? layers : [{ kind: 'human', audience: ['@creator'] }];
      };
      let backToDo = false;
      let li = 0;
      while (!backToDo) {
        // Snapshot the route's revision before parking; a bump means what we were
        // playing is stale, so the gate replays from its first layer (partial approval
        // under a route the user has since replaced is not credit worth keeping).
        const epoch = confirmEpoch;
        const gates = gatesNow();
        if (li >= gates.length) break; // every layer approved (or the route is now empty)
        const layer = gates[li]!;
        const gateDetail = gates.length > 1 ? `confirm layer ${li + 1}/${gates.length}` : undefined;
        if (layer.kind === 'agent') {
          // Run this layer's Confirm agent; its verdict maps onto the SAME transitions
          // a human drives (confirm / follow-up-to-Do / cancel).
          waitingFor = { kind: 'confirm', ...(gateDetail ? { detail: gateDetail } : {}) };
          await publish();
          const decision = await confirmTurn(layer);
          waitingFor = undefined;
          if (cancelled) return await abort();
          // The route changed while this agent was reviewing — its verdict was about a
          // gate that no longer exists, so replay rather than credit it.
          if (confirmEpoch !== epoch) { li = 0; continue; }
          if (decision?.action === 'confirm') { li++; continue; } // this layer approves → the next
          if (decision?.action === 'reject') {
            if (decision.text) msgs.push({ id: `cr-${msgs.length}`, role: 'system', text: `Confirm agent rejected the work: ${decision.text}`, ts: msgs.length });
            cancelled = true;
            return await abort();
          }
          if (decision?.action === 'revise') {
            // Feedback goes into the Do transcript as a follow-up and we loop back to
            // Do; the next Review replays the layers from the first.
            msgs.push({ id: `cv-${msgs.length}`, role: 'user', text: decision.text || 'Please revise the work per the reviewer feedback.', ts: msgs.length });
            backToDo = true;
            continue;
          }
          // No verdict (turn failed / declined) → degrade THIS layer to the human gate
          // below so nothing is silently auto-confirmed.
        }
        // A human layer: wait for the Confirm click — one click passes ONE layer — or a
        // follow-up, which sends the task back to Do. A re-route also wakes us, so the
        // newly named audience is who the task is actually shown as waiting on.
        waitingFor = { kind: 'human', ...(gateDetail ? { detail: gateDetail } : {}),
          audience: layer.kind === 'human' && layer.audience?.length ? layer.audience : ['@creator'] };
        await publish();
        // Approving individual branches marks what has been reviewed — deliberately
        // NOT a way to pass the layer. Confirm stays the one act that does, so the
        // authorization and quorum rules that guard it (api.signalTask) keep
        // guarding it, and per-branch approval cannot route around them. What the
        // marks buy is the loop-back: a branch approved now is still approved when
        // the task returns from Do, as long as the agent did not touch it.
        await condition(() => confirmed || cancelled || msgs.length > seen || confirmEpoch !== epoch);
        waitingFor = undefined;
        if (cancelled) return await abort();
        if (confirmEpoch !== epoch) { li = 0; confirmed = false; continue; }
        // One Confirm click is the same decision taken for every branch at once.
        if (confirmed && multiPrEnabled && world) {
          checkoutApprovals = approveAll(worldRepos(world as any), checkoutHeads, checkoutApprovals);
        }
        if (!confirmed) backToDo = true; // follow-up arrived → back to Do
        confirmed = false; // consumed by this layer (a later layer needs its own click)
        li++;
      }
      if (!backToDo) {
        confirmed = true; // every layer approved
        // The route has now done its job for this task; freeze it (SPEC §4.5/§5.5).
        // A gate that sent the task back to Do never reaches here, so a re-route
        // stays possible for as long as another Review can still happen.
        consumed.add('confirm');
        break;
      }
      stage = 'do';
      status = 'active';
      continue;
    }
  }
  }

  if (repositoryless) {
    stage = 'done';
    status = 'done';
    reviewInfo = {
      ...reviewInfo,
      summary: reviewInfo?.summary
        ? `${reviewInfo.summary}\n\nCompleted; no repository merge required.`
        : 'Completed; no repository merge required.',
    };
    await publish();
    const remoteWorld = world ? releaseWorldOnCompletion(world) : false;
    await core.destroyWorld(world as any);
    if (remoteWorld) {
      world = undefined;
      await publish();
    }
    return { stage };
  }

  // ── PR (optional) ──
  if (!proposalBeforeReview && recoveryStage !== 'merge') {
  stage = 'pr';
  status = 'active';
  await publish();
  if (cancelled) return await abort();
  if (remotePolicyOf(input.project) === 'pr') {
    // Opening a PR binds it to `target`; close the edit window before we do (SPEC §2).
    targetLocked = true;
    await publish();
    if (prepareBranchBeforePr) {
      // GitHub cannot open a PR for an uncommitted worktree: the branch still
      // equals its base. Run the judgment-bearing Merge work first, while the
      // protected target is untouched. This is preparation, not the point of no
      // return; cancellation remains valid until finalizeMergeActivity lands it.
      consumed.add('agent:merge');
      await mergeTurn(
        `Prepare this branch for merge into ${target} before opening the pull request. `
        + `The worktree may contain uncommitted changes: commit what should land; gitignore (or delete) what should not. `
        + `Merge ${target} into the current branch, resolve any conflicts, ensure the build and tests pass, and leave the worktree clean.`,
      );
      branchPreparedForPr = true;
    }
    const opened = await withResolve('pr', () => core.openPr(world as any, target, {
      title: input.title,
      summary: reviewInfo?.summary ?? lastOutputs(msgs),
    }));
    prs = opened ?? [];
    pr = prs[0];
    // No publish here: the merge stage below opens with one, and adding an
    // activity call inside a stage older pinned versions also run would break
    // their replay.
  }
  }

  // ── Merge (point of no return) ──
  // Lock the target before committing it to a merge-queue domain: the queue is
  // keyed by target, so from here it's load-bearing and no longer editable (SPEC §5.5).
  // Set before any await so no queued edit can slip in and desync the domain.
  targetLocked = true;
  // Conflict loop-back state: how many rejected merges this round, and the last
  // rejection's detail (fed into the merge agent's next prompt so it actually
  // knows what to fix — a human retry resets the attempt budget, not the context).
  let mergeAttempts = 0;
  let mergeConflict: string | undefined;
  let mergeDirty: string | undefined;
  for (;;) {
    stage = 'merge';
    status = 'active';
    mergeGranted = false;
    await publish();
    if (cancelled) return await abort();

    // Acquire the merge slot for EVERY repo this task touches, one at a time in a
    // fixed global order (sorted). Ordered acquisition is what makes concurrent
    // multi-repo merges deadlock-free (SPEC §6.1): all tasks request shared repos
    // in the same sequence, so the wait-for graph can't form a cycle. Acquiring
    // sequentially (not all at once) also keeps the payload-less grant signal
    // unambiguous — we only ever wait on a single coordinator at a time.
    const domains = mergeQueueDomains(world, target, input.projectId);
    const held: string[] = [];
    let acquireCancelled = false;
    let result;
    let githubResult: GitHubMergeAuthorization | undefined;
    // Every acquired domain MUST be released — including when enqueueMerge / the
    // position publish / the merge agent throws while acquiring or holding a LATER
    // domain. Without this, domains 0..n-1 stayed leased until the coordinator's
    // 5-minute lease timeout and every other task on those repos stalled behind a
    // task that had already failed. Paths that release explicitly empty `held`
    // first, so this never double-releases.
    try {
      for (const domain of domains) {
        mergeGranted = false;
        await coordinator.enqueueMerge(domain, taskId);
        // Wait for this domain's grant; allow cancel only before it.
        while (!mergeGranted && !cancelled) {
          const pos = await coordinator.mergeQueuePosition(domain, taskId);
          // Republish only on an actual change: the view carries every message and
          // transcript, so an unconditional publish per tick is what pushed a long
          // wait into Temporal's history-size limit (see `boundedMergeWait`).
          if (!boundedMergeWait || !samePosition(pos, mergeQueuePos)) {
            mergeQueuePos = pos;
            await publish();
          }
          await condition(() => mergeGranted || cancelled, boundedMergeWait ? MERGE_POLL : '5s');
        }
        if (cancelled && !mergeGranted) {
          await coordinator.cancelMerge(domain, taskId); // drop the slot we're still waiting on
          acquireCancelled = true;
          break;
        }
        held.push(domain);
      }
      if (acquireCancelled) {
        for (const d of held) await coordinator.releaseMerge(d, taskId); // release every slot already held
        held.length = 0; // released here → the finally below is a no-op (command order preserved)
        return await abort();
      }
      mergeQueuePos = { position: 0, total: mergeQueuePos?.total ?? 1 };
      await publish();

      try {
        // Under PR policy v1.11 already prepared the branch before opening the
        // PR. Do not spend a duplicate agent turn; go straight to the protected
        // landing. If the target raced or the branch is still dirty, finalize's
        // rejection loops back here and the Merge agent gets the exact details.
        const runsMergeAgent = !explicitPrCycle
          && (!branchPreparedForPr || mergeAttempts > 0 || !!mergeDirty || !!mergeConflict);
        if (runsMergeAgent) {
          consumed.add('agent:merge');
          await mergeTurn(mergeDirty
            ? `The merge into ${target} was rejected — the worktree has uncommitted changes:\n${mergeDirty}\nStage and commit what belongs in this change; gitignore (or delete) what doesn't. Leave the worktree clean.`
            : mergeConflict
              ? `The merge into ${target} was rejected — unresolved conflicts or leftover conflict markers in:\n${mergeConflict}\nIn the worktree: merge ${target} into the current branch, resolve every conflict (no <<<<<<< / ======= / >>>>>>> markers may remain anywhere), preserve both sides' intent, and commit the resolution.`
              : `Prepare branch for merge into ${target}. Commit any work that should land; gitignore (or delete) anything that shouldn't — the merge is rejected if the worktree isn't clean.`);
        }
        if (!explicitPrCycle && branchPreparedForPr && runsMergeAgent && remotePolicyOf(input.project) === 'pr') {
          // A conflict/dirty rejection after PR creation sends the branch back to
          // the Merge agent. Its fix changes the proposed head, so refresh the
          // remote branch and existing PR BEFORE landing it. This runs while all
          // merge domains are leased: the target cannot race between the refreshed
          // proposal and finalizeMergeActivity. openPr is idempotent by branch and
          // updates the existing PR rather than creating another one.
          const refreshed = await core.openPr(world as any, target, {
            title: input.title,
            summary: reviewInfo?.summary ?? lastOutputs(msgs),
          });
          prs = refreshed;
          pr = prs[0];
        }
        if (githubAuthoritativeMerge) {
          // The proposal was already prepared and reviewed. Do not create a
          // second local merge and push it with the installation credential;
          // request the exact reviewed PR merge under a consenting human token.
          githubResult = await core.mergeGithubPrs(world as any, prs);
        } else {
          // …then the authoritative, deterministic local merge that guarantees
          // work lands for non-PR and replay-pinned historical workflows.
          result = await long.finalizeMergeActivity(world as any, target);
        }
      } catch (err) {
        if (githubAuthoritativeMerge) {
          githubResult = { status: 'waiting', prs, detail: String(err) };
        } else {
          result = { merged: false, landedFiles: [], note: String(err) };
        }
      }
    } finally {
      // Swallow per-domain. From 1.9.0 `coordinator` retries a bounded 5 times
      // (~15 s), which a coordinator mid-continueAsNew or a worker restart can
      // outlast. An throwing release would abort this loop mid-iteration — leaking
      // every remaining slot, the exact leak the try/finally exists to prevent —
      // and replace the in-flight merge error with a release error. Scheduling the
      // activity is what history records, so catching changes no replay.
      for (const d of held) await coordinator.releaseMerge(d, taskId).catch(() => undefined);
      held.length = 0;
    }

    if (githubAuthoritativeMerge) {
      const decision = githubResult ?? { status: 'waiting' as const, prs, detail: 'GitHub merge did not return a result.' };
      prs = decision.prs;
      pr = prs[0];
      if (prs.some((candidate) => candidate.merged)) pointOfNoReturnPassed = true;
      if (decision.status === 'merged') {
        sha = decision.sha;
        pointOfNoReturnPassed = true;
        break;
      }
      if (explicitPrCycle && (decision.status === 'needs-revision' || decision.status === 'stale-review')) {
        msgs.push({
          id: `merge-revise-${msgs.length}`,
          role: 'user',
          text: `${decision.detail ?? 'The pull request must be revised before it can merge'}\nInspect the live branch, repair the proposal, run the relevant tests, then call open_pr again. The updated head will go through Review again.`,
          ts: msgs.length,
        });
        confirmed = false;
        prRequested = false;
        branchPreparedForPr = false;
        checkoutApprovals = {};
        stage = 'do';
        status = 'active';
        continue proposalCycle;
      }
      if (decision.status === 'needs-authorizer' || decision.status === 'stale-review') {
        // A controlled terminal human layer. It does not rewrite the configured
        // Review route (already consumed/frozen); its only meaning is consent to
        // retry this unchanged GitHub proposal under the confirming person's
        // token. Every retry re-checks repository permission live.
        confirmed = false;
        status = 'waiting';
        const eligible = decision.eligibleUserIds ?? [];
        const audience = eligible.length
          ? [...eligible.map((userId) => `user:${userId}`), '@creator']
          : ['@creator'];
        waitingFor = {
          kind: 'human', audience,
          detail: decision.detail ?? (decision.status === 'stale-review'
            ? 'The pull request changed after Review; review and confirm the new head.'
            : 'A connected human with GitHub merge access must confirm this merge.'),
        };
        await publish();
        await condition(() => confirmed || cancelled);
        waitingFor = undefined;
        if (cancelled) return await abort();
        confirmed = false;
        continue;
      }
      status = 'waiting';
      waitingFor = { kind: 'github', detail: decision.detail ?? 'Waiting for GitHub checks or merge queue.' };
      await publish();
      await condition(() => cancelled, '30s');
      waitingFor = undefined;
      if (cancelled) return await abort();
      continue;
    }

    if (!result) result = { merged: false, landedFiles: [], note: 'local merge did not return a result' };

    if (result.merged) {
      sha = result.sha;
      pointOfNoReturnPassed = true;
      // Remote policy 'push'/'pr' (PLAN-git-config.md §5): the landed target leaves
      // the machine — push it (and under 'pr', GitHub marks the PR merged).
      // Best-effort: the merge IS the deliverable; a failed push is recorded, not fatal.
      if (remotePolicyOf(input.project) !== 'none') {
        const pushed = await core.pushTarget(world as any, target).catch(() => undefined);
        // Under 'pr' the pull request is part of the deliverable: reconcile it
        // with what actually landed (merged / closed / still open, and why).
        if (githubPrLifecycle && prs.length) {
          prs = await core.finalizePrs(world as any, prs, { target, sha, pushed: pushed?.pushed ?? [] })
            .catch(() => prs);
          pr = prs[0];
        }
      }
      break;
    }
    if (explicitPrCycle && (result.conflict || result.dirty)) {
      const detail = result.conflict ?? result.dirty ?? result.note ?? 'merge rejected';
      msgs.push({
        id: `merge-revise-${msgs.length}`,
        role: 'user',
        text: `Landing the reviewed PR was refused: ${result.note ?? 'the target changed or the branch is not ready'}.\n${detail}\nRepair this in the task branch, verify it, then call open_pr again. The updated proposal must pass Review again.`,
        ts: msgs.length,
      });
      confirmed = false;
      prRequested = false;
      branchPreparedForPr = false;
      checkoutApprovals = {};
      stage = 'do';
      status = 'active';
      continue proposalCycle;
    }
    // Merge rejected. Conflicts (including leftover markers) and dirty worktrees
    // (commit-vs-gitignore is a judgment call — PLAN-git-config.md §6) are the
    // merge agent's job: loop straight back to it with the details, bounded,
    // before bothering a human/parent (SPEC §5.2).
    error = `merge failed: ${result.conflict ?? result.dirty ?? result.note ?? 'unknown'}`;
    if (result.conflict || result.dirty) {
      mergeDirty = result.dirty;
      mergeConflict = result.dirty ? undefined : `${result.note ? `${result.note}\n` : ''}${result.conflict}`;
      if (++mergeAttempts < MAX_MERGE_ATTEMPTS) {
        mergeMsgs.push({
          id: `m-sys-${mergeMsgs.length}`,
          role: 'system',
          text: `Merge rejected (attempt ${mergeAttempts}/${MAX_MERGE_ATTEMPTS}): ${error}`,
          ts: mergeMsgs.length,
        });
        error = undefined;
        continue;
      }
    }
    // Attempts exhausted (or a non-conflict failure) → escalate. A child raises
    // `blocked` to its parent (which can retry/answer/cancel); a top-level task
    // escalates to a human. Either can retry.
    reviewInfo = { ...reviewInfo, summary: error };
    stage = 'escalated';
    status = 'blocked';
    retryRequested = false;
    if (input.parentTaskId) {
      waitingFor = { kind: 'parent' };
      await notifyParent('blocked', error);
    }
    // As at the Resolve-exhaustion escalation above: `escalated` advertises a
    // follow-up action, so a follow-up must wake this park. The Do transcript is the
    // one a merge escalation's advice belongs in either way (a `merge`-addressed
    // follow-up lands in `mergeMsgs`, which the retried merge turn reads anyway), so
    // wake on EITHER transcript growing rather than silently ignoring the user.
    const seenAtEscalation = msgs.length;
    const mergeSeenAtEscalation = mergeMsgs.length;
    await publish();
    await condition(() =>
      retryRequested || cancelled ||
      (followUpWakesEscalation &&
        (msgs.length > seenAtEscalation || mergeMsgs.length > mergeSeenAtEscalation)));
    waitingFor = undefined;
    if (cancelled) return await abort();
    stage = 'merge';
    status = 'active';
    error = undefined;
    mergeAttempts = 0; // a human/parent retry grants a fresh loop-back budget
  }

  break proposalCycle;
  }

  stage = 'done';
  status = 'done';
  reviewInfo = { ...reviewInfo, summary: `Merged into ${target} at ${world!.repo ?? '(scratch repo)'} as ${sha?.slice(0, 8)}.` };
  await publish();
  const remoteWorld = world ? releaseWorldOnCompletion(world) : false;
  await core.destroyWorld(world as any);
  if (remoteWorld) {
    world = undefined;
    await publish();
  }
  return { stage, sha };
  } catch (e) {
    if (e instanceof Cancelled || (isCancellation(e) && cancelled)) return await abort();
    throw e;
  }

  // ── helpers ──
  async function abort() {
    terminalOrigin = stage;
    stage = 'cancelled';
    status = 'cancelled';
    await cancelChildren(liveAgentStates); // don't strand children when we go away
    // A cancelled task must not leave an open pull request proposing work that
    // will never land.
    if (githubPrLifecycle && world && prs.some((p) => p.state === 'open')) {
      await core.closePrs(world as any, prs, 'The karmax task for this branch was cancelled; closing the pull request.')
        .catch(() => undefined);
      prs = prs.map((p) => ({ ...p, state: 'closed' as const }));
      pr = prs[0];
    }
    await publish();
    if (world) {
      const remoteWorld = releaseWorldOnCompletion(world);
      await core.destroyWorld(world as any);
      if (remoteWorld) {
        world = undefined;
        await publish();
      }
    }
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
