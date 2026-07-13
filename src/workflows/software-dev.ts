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
import type { coreActivities } from '../activities/core.js';
import type { coordinatorActivities } from '../activities/coordinator.js';
import { SIG_MERGE_GRANTED, SIG_ACCOUNT_GRANTED } from '../coordinators/names.js';
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
  ConfirmLayer,
  Message,
  ReviewInfo,
  DeclaredAction,
  WorldHandleLike,
  ChildRaise,
  ParentResponse,
  SubTaskResponse,
} from './contract.js';
import { remotePolicyOf } from './contract.js';
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
// Agent turns heartbeat every ~10s (runtime.ts), so a 2-minute gap means the
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
const coord = proxyActivities<coordinatorActivities>({ startToCloseTimeout: '30s' });

// ─── Signals / updates / query (SPEC §5.6) ───────────────────────────────────
// The optional second arg is the agent the follow-up addresses (`do` | `merge` |
// `resolve`); omitted / unknown routes to the Do agent, so old single-arg signals
// (and the other single-agent workflows) keep working unchanged.
export const followUpSignal = defineSignal<[Message, string?]>('followUp');
export const confirmSignal = defineSignal('confirm');
export const cancelSignal = defineSignal('cancel');
export const retrySignal = defineSignal('retry');
export const mergeGrantedSignal = defineSignal(SIG_MERGE_GRANTED);
export const accountGrantedSignal = defineSignal<[{ turnId: string; accountId: string; configHome?: string; apiKeyHandle?: string }]>(SIG_ACCOUNT_GRANTED);
export const agentTurnStateSignal = defineSignal<[{ turnId: string; role: AgentRole; provider?: 'claude' | 'codex' | 'mock'; state: 'running' }]>(SIG_AGENT_TURN_STATE);
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
/** A rejected merge (conflicts / leftover markers) loops back to the merge agent
 *  this many times before escalating to a human/parent (SPEC §5.2). */
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
 * The merge-queue serialization domains for a task — one `<repo>:<target>` per
 * repo the world touches, returned in a GLOBAL total order (sorted, deduped).
 *
 * Acquiring the per-repo slots in this order is what keeps concurrent multi-repo
 * merges deadlock-free (SPEC §6.1, lock ordering). Because every task requests
 * shared repos in the same sequence, a task only ever waits for a domain ordered
 * after everything it already holds — so the "waits-for" graph can't cycle. (A
 * scratch or single-repo world yields one domain, exactly as before.)
 */
function mergeDomains(world: WorldHandleLike | undefined, target: string, projectId: string): string[] {
  const repos = world?.repos?.length ? world.repos.map((r) => r.repo) : world?.repo ? [world.repo] : [projectId];
  return [...new Set(repos.map((r) => `${r}:${target}`))].sort();
}

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
 * The software-development workflow (SPEC §5): Setup → Do ⇄ Review → PR → Merge
 * → End, with cross-cutting Resolve and awaited sub-tasks. Merge is the point of
 * no return.
 */
export async function softwareDev(input: SoftwareDevInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevImpl(input, '1.1.0');
}

/** Current provider-terminal semantics. Kept separate from the bare/back-compat
 * export so executions recorded as `softwareDev` continue replaying v1.1. */
export async function softwareDevV1_2(input: SoftwareDevInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevImpl(input, '1.2.0');
}

/** Replay-compatible entry for executions already recorded as
 * `softwareDev@1.0.0`. v1 published Resolve before invoking autoResolve. */
export async function softwareDevV1(input: SoftwareDevInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevImpl(input, '1.0.0');
}

async function softwareDevImpl(input: SoftwareDevInput, behaviorVersion: '1.0.0' | '1.1.0' | '1.2.0'): Promise<{ stage: Stage; sha?: string }> {
  const liveAgentStates = behaviorVersion !== '1.0.0';
  const providerTerminalCompletion = behaviorVersion === '1.2.0';
  const taskId = input.taskId;
  const recovery = input.recovery;
  let stage: Stage = recovery ? 'do' : 'setup';
  let status: TaskView['status'] = 'active';
  const msgs: Message[] = recovery
    ? recovery.messages.map((m) => ({ ...m }))
    : input.prompt || input.images?.length
      ? [{ id: 'm0', role: 'user', text: input.prompt ?? '', ts: 0, ...(input.images?.length ? { images: input.images } : {}) }]
      : [];
  let target = recovery?.target ?? input.target ?? input.project.defaultTarget ?? input.base ?? input.project.defaultBase ?? 'main';
  const base = input.base ?? input.project.defaultBase ?? 'main';
  let confirmed = false;
  let cancelled = false;
  let retryRequested = false;
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
  let pr: { url: string; number: number } | undefined;
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
  const confirmLayers = confirmLayersOf(input.confirm, !!input.autoConfirm);
  // Account/token leasing (SPEC §6.2): per-turn lease of a connected login.
  const accountGrants = new Map<string, { accountId: string; configHome?: string; apiKeyHandle?: string }>();
  let turnSeq = 0;
  let accountPool = 0; // populated after setup; 0 ⇒ no leasing (zero behavior change)
  // Mid-turn cancel (SPEC §5.6): the running turn's cancellation scope, so a cancel
  // signal aborts the in-flight agent turn instead of waiting for it to finish.
  let activeTurn: CancellationScope | undefined;

  const kind = input.project.worldProvider === 'container' ? 'container' : 'worktree';

  // ── in-flight param edits (SPEC §4.5/§5.5) ──
  // A working copy of the per-role agent overrides that later turns re-read, so a
  // model/effort retune — or, before its turn, a full swap — actually takes effect.
  // Every role re-reads `liveInput.agents[role]` at turn start, so a change lands at
  // the next best convenience in the conversation: the next turn that role runs
  // (e.g. a Do follow-up, a merge retry, or the next resolve attempt).
  const liveInput: SoftwareDevInput = { ...input, agents: { ...(input.agents ?? {}) } };
  // Params the workflow has already consumed (value now load-bearing). `target` is
  // consumed once locked (PR open / merge enqueue); an auxiliary agent's IDENTITY
  // (provider/session) once its turn runs — its model/effort stay retunable after.
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
          `"${name}" can't be edited now — it's frozen after queue, already in use, or past the point of no return`,
          'ParamLocked',
          name,
        );
    }
  }
  /** Apply an already-validated patch to live state. `target` is re-read at PR/merge;
   *  `agent:<role>` overrides are re-read when that role's turn runs. */
  function applyParamPatch(patch: Record<string, unknown>): { applied: string[] } {
    const applied: string[] = [];
    if (typeof patch.target === 'string' && patch.target) {
      target = patch.target;
      applied.push('target');
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

  /** All per-role transcripts, omitting roles that haven't run a turn yet. */
  function buildTranscripts(): { role: string; label: string; messages: Message[] }[] {
    const t = [{ role: 'do', label: 'Do agent', messages: msgs }];
    if (mergeMsgs.length) t.push({ role: 'merge', label: 'Merge agent', messages: mergeMsgs });
    if (resolveMsgs.length) t.push({ role: 'resolve', label: 'Resolve agent', messages: resolveMsgs });
    if (confirmMsgs.length) t.push({ role: 'confirm', label: 'Confirm agent', messages: confirmMsgs });
    return t;
  }

  function buildView(): TaskView {
    return {
      taskId,
      title: input.title,
      workflow: 'software-dev',
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
        mergeDomain: world ? mergeDomains(world, target, input.projectId)[0] : undefined,
        // A failed Temporal execution is terminal. Persist the full handle needed
        // for a replacement run to OPEN this world; reconstructing it through
        // createWorld would force-remove the dirty worktree and lose work.
        recoveryWorld: world,
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
    agentTurn = { turnId: next.turnId, role: next.role, provider: next.provider, state: next.state };
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
    target.push({ ...m, ts: target.length });
  });
  setHandler(confirmSignal, () => {
    confirmed = true;
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
  });
  // A child raised to us: queue it so the Do agent can answer (SPEC §5.3).
  setHandler(raiseFromChildSignal, (r) => {
    raises.push(r);
    awaitingResponse.add(r.childTaskId);
  });
  // Our parent answered a raise. Map its decision onto the SAME flags a human drives
  // (confirm/retry/cancel/follow-up) so the parent is literally our confirmer.
  setHandler(parentResponseSignal, (resp) => {
    if (resp.action === 'confirm') confirmed = true;
    else if (resp.action === 'retry') retryRequested = true;
    else if (resp.action === 'cancel') {
      if (!pointOfNoReturnPassed) {
        cancelled = true;
        activeTurn?.cancel();
      }
    } else if (resp.action === 'comment') {
      if (resp.text) msgs.push({ id: `p-${msgs.length}`, role: 'user', text: resp.text, ts: msgs.length });
      retryRequested = true; // unblocks an escalated child; at Review the new msg drives it
    }
  });
  setHandler(mergeGrantedSignal, () => {
    mergeGranted = true;
  });
  setHandler(accountGrantedSignal, (g) => {
    accountGrants.set(g.turnId, { accountId: g.accountId, configHome: g.configHome, apiKeyHandle: g.apiKeyHandle });
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
              r = await leasedTurn('resolve', (accountConfigHome, accountApiKeyHandle, agentTurnId) =>
                turns.runAgentTurn({
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
                  ...(agentTurnId ? { agentTurnId } : {}),
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
      await publish();
      await condition(() => retryRequested || cancelled);
      waitingFor = undefined;
      if (cancelled) throw new Cancelled();
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
    fn: (accountConfigHome?: string, accountApiKeyHandle?: string, agentTurnId?: string) => Promise<T>,
  ): Promise<T> {
    /** v1.1 publishes the host-admission state before scheduling the turn. The
     * activity changes it to `running` only after it actually acquires a slot. */
    const admittedTurn = async (
      turnId: string,
      provider: 'claude' | 'codex' | 'mock' | undefined,
      resumeStatus: TaskView['status'],
      home?: string,
      key?: string,
    ): Promise<T> => {
      if (liveAgentStates) {
        agentTurnResumeStatus = resumeStatus === 'waiting' ? 'active' : resumeStatus;
        agentTurn = { turnId, role, provider, state: 'waiting-slot' };
        status = 'waiting';
        waitingFor = { kind: 'agentSlot', provider, detail: 'Waiting for host capacity to run the agent' };
        await publish();
      }
      try {
        return await runCancellable(() => fn(home, key, liveAgentStates ? turnId : undefined));
      } finally {
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
    const provider = prov === 'claude' || prov === 'codex' || prov === 'mock' ? prov : undefined;
    if (!provider) {
      if (!liveAgentStates) return await runCancellable(() => fn(undefined, undefined));
      return await admittedTurn(`${taskId}#${turnSeq++}`, undefined, status);
    }
    // Credential-policy allow-list for real providers (precedence + enable/disable,
    // resolved global→project→task); mock uses the coordinator's provider fallback.
    const allowed =
      provider === 'claude' || provider === 'codex'
        ? await core.resolveCredentialOrder({ taskId, projectId: input.projectId, provider }).catch(() => undefined)
        : undefined;
    const turnId = `${taskId}#${turnSeq++}`;
    await coord.leaseAccount(taskId, turnId, provider, allowed);
    const priorStatus = status;
    status = 'waiting';
    waitingFor = { kind: 'account', provider };
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
    if (liveAgentStates && cancelled && !grant) await coord.cancelAccount(taskId, turnId).catch(() => undefined);
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
      throw new CredentialDenied(`No usable ${provider} credential — every allowed login/key needs attention (funding, re-auth, or re-enable it in credential settings).`);
    }
    const passthrough = !grant || grant.accountId === '(passthrough)';
    const leasedHome = passthrough ? undefined : grant?.configHome;
    const leasedKey = passthrough ? undefined : grant?.apiKeyHandle;
    try {
      // This publish happens immediately after the lease grant and replaces the
      // stale account-wait view with the distinct host-slot state.
      return await admittedTurn(turnId, provider, priorStatus, leasedHome, leasedKey);
    } catch (err) {
      // Limit failure → update the coordinator so it re-leases the next allowed
      // credential: a transient window arms a refresh timer; a HARD billing/auth
      // failure is flagged needs-attention (won't self-refresh → a human must act).
      if (grant && !passthrough && !cancelled && !isCancellation(err)) {
        const cls = limitFailureClassification(err);
        if (cls?.hard) {
          await coord.setAccountAvailability({ accountId: grant.accountId, status: 'needs-attention' }).catch(() => undefined);
        } else if (cls?.limited) {
          await coord
            .reportAccountExhausted({ accountId: grant.accountId, window: cls.window ?? '5h', resetHint: cls.resetHint, note: cls.note })
            .catch(() => undefined);
        }
      }
      throw err;
    } finally {
      // returnAccount runs in the parent (uncancelled) scope so the lease is freed.
      if (grant && !passthrough) await coord.returnAccount(grant.accountId).catch(() => undefined);
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
      leasedTurn('do', (accountConfigHome, accountApiKeyHandle, agentTurnId) => {
        doHome = accountConfigHome ?? '(profile)';
        // Resume only when the leased login matches the one that minted the session
        // (§2.5). When we do, the session already holds the first `seen` messages
        // (everything delivered on prior turns), so send only the delta after them —
        // a follow-up reaches the agent as a follow-up, not the whole conversation.
        const resume = sessionMatchesHome(accountConfigHome) ? session : undefined;
        deliveredNow = msgs.length; // everything queued up to this instant is delivered
        return turns.runAgentTurn({
          taskId,
          role: 'do',
          worldHandle: world as any,
          messages: msgs,
          session: resume,
          deliveredMessages: resume ? seen : 0,
          task: liveInput,
          accountConfigHome,
          accountApiKeyHandle,
          ...(agentTurnId ? { agentTurnId } : {}),
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
    if (turn.reviewInfo) reviewInfo = turn.reviewInfo;
    return turn;
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
      leasedTurn('confirm', (accountConfigHome, accountApiKeyHandle, agentTurnId) =>
        // Each Review runs a FRESH confirm turn (session left unset) so the reviewer
        // always gets an up-to-date system prompt (fresh reviewInfo / changed files);
        // continuity comes from `confirmMsgs`, replayed to the fresh session — prior
        // requests and verdicts included. A mid-turn activity retry still resumes via
        // heartbeat details inside runAgentTurn.
        turns.runAgentTurn({
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
          ...(agentTurnId ? { agentTurnId } : {}),
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
      const child = await startChild(softwareDev, {
        workflowId: childInput.taskId,
        args: [childInput as SoftwareDevInput],
      });
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
      core.createWorld({ taskId, repos: input.project.repos, base, target, copyGlobs: input.project.copyGlobs, gitProfile: input.project.gitProfile, kind }),
    )) as WorldHandleLike;
  }
  // One-shot probe: does the account pool exist? (self-configuring; 0 = off)
  accountPool = await coord.accountPoolSize().catch(() => 0);

  // ── Do ⇄ Review ──
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

    const turn = await doTurn();
    // Sub-tasks run in the BACKGROUND: spawn is non-blocking, and answers go straight
    // down to the children they target (SPEC §5.3).
    if (turn.subTasks?.length) await spawnSubTasks(turn.subTasks);
    if (turn.subTaskResponses?.length) await applySubTaskResponses(turn.subTaskResponses);

    // v1.2 advances only after an adapter observed the provider's successful terminal
    // event. v1.0/v1.1 retain their immutable signal/idle semantics for replay.
    const turnFinished = providerTerminalCompletion ? !!turn.providerCompleted : turn.completed;
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
      if (input.goalMode && !turnFinished && !turn.raise) {
        msgs.push({
          id: `kg-${msgs.length}`,
          role: 'user',
          text: providerTerminalCompletion
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
      stage = 'review';
      status = 'waiting';
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
      const gates: ConfirmLayer[] = confirmLayers.length || turnFinished || turn.raise ? confirmLayers : [{ kind: 'human' }];
      let backToDo = false;
      for (let li = 0; li < gates.length && !backToDo; li++) {
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
          if (decision?.action === 'confirm') continue; // this layer approves → the next
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
        // follow-up, which sends the task back to Do.
        if (gateDetail) waitingFor = { kind: 'human', detail: gateDetail };
        await publish();
        await condition(() => confirmed || cancelled || msgs.length > seen);
        waitingFor = undefined;
        if (cancelled) return await abort();
        if (!confirmed) backToDo = true; // follow-up arrived → back to Do
        confirmed = false; // consumed by this layer (a later layer needs its own click)
      }
      if (!backToDo) {
        confirmed = true; // every layer approved
        break;
      }
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
  if (remotePolicyOf(input.project) === 'pr') {
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
    const domains = mergeDomains(world, target, input.projectId);
    const held: string[] = [];
    let acquireCancelled = false;
    for (const domain of domains) {
      mergeGranted = false;
      await coord.enqueueMerge(domain, taskId);
      // Wait for this domain's grant; allow cancel only before it.
      while (!mergeGranted && !cancelled) {
        mergeQueuePos = await coord.mergeQueuePosition(domain, taskId);
        await publish();
        await condition(() => mergeGranted || cancelled, '5s');
      }
      if (cancelled && !mergeGranted) {
        await coord.cancelMerge(domain, taskId); // drop the slot we're still waiting on
        acquireCancelled = true;
        break;
      }
      held.push(domain);
    }
    if (acquireCancelled) {
      for (const d of held) await coord.releaseMerge(d, taskId); // release every slot already held
      return await abort();
    }
    mergeQueuePos = { position: 0, total: mergeQueuePos?.total ?? 1 };
    await publish();

    // The merge agent is about to run — freeze `agent:merge` (SPEC §5.5).
    consumed.add('agent:merge');
    const mergeIn: Message = {
      id: `m-in-${mergeMsgs.length}`,
      role: 'user',
      text: mergeDirty
        ? `The merge into ${target} was rejected — the worktree has uncommitted changes:\n${mergeDirty}\nStage and commit what belongs in this change; gitignore (or delete) what doesn't. Leave the worktree clean.`
        : mergeConflict
          ? `The merge into ${target} was rejected — unresolved conflicts or leftover conflict markers in:\n${mergeConflict}\nIn the worktree: merge ${target} into the current branch, resolve every conflict (no <<<<<<< / ======= / >>>>>>> markers may remain anywhere), preserve both sides' intent, and commit the resolution.`
          : `Prepare branch for merge into ${target}. Commit any work that should land; gitignore (or delete) anything that shouldn't — the merge is rejected if the worktree isn't clean.`,
      ts: mergeMsgs.length,
    };
    mergeMsgs.push(mergeIn);
    let result;
    try {
      // Best-effort merge agent turn (resolve conflicts / ensure tests pass)…
      const mt = await leasedTurn('merge', (accountConfigHome, accountApiKeyHandle, agentTurnId) =>
        turns.runAgentTurn({
          taskId,
          role: 'merge',
          worldHandle: world as any,
          // Feed the merge agent its full transcript so any human follow-up queued
          // for it (SPEC §5.6) is included alongside the merge prompt.
          messages: mergeMsgs,
          session: sessionMatchesHome(accountConfigHome) ? session : undefined,
          task: liveInput,
          bindings: { reviewInfo: reviewInfo?.summary ?? '' },
          accountConfigHome,
          accountApiKeyHandle,
          ...(agentTurnId ? { agentTurnId } : {}),
        }),
      ).catch((e) => {
        if (isCancellation(e)) throw e; // pre-merge cancel → abort, don't merge
        log.warn('merge agent turn failed; proceeding to authoritative merge', { e: String(e) });
        return undefined;
      });
      if (mt?.output?.trim()) mergeMsgs.push({ id: `m-out-${mergeMsgs.length}`, role: 'agent', text: mt.output, ts: mergeMsgs.length });
      // …then the authoritative, deterministic merge that guarantees work lands.
      result = await long.finalizeMergeActivity(world as any, target);
    } catch (err) {
      result = { merged: false, landedFiles: [], note: String(err) };
    }
    for (const d of held) await coord.releaseMerge(d, taskId);

    if (result.merged) {
      sha = result.sha;
      pointOfNoReturnPassed = true;
      // Remote policy 'push'/'pr' (PLAN-git-config.md §5): the landed target leaves
      // the machine — push it (and under 'pr', GitHub marks the PR merged).
      // Best-effort: the merge IS the deliverable; a failed push is recorded, not fatal.
      if (remotePolicyOf(input.project) !== 'none') {
        await core.pushTarget(world as any, target).catch(() => undefined);
      }
      break;
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
    await publish();
    await condition(() => retryRequested || cancelled);
    waitingFor = undefined;
    if (cancelled) return await abort();
    error = undefined;
    mergeAttempts = 0; // a human/parent retry grants a fresh loop-back budget
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
    await cancelChildren(liveAgentStates); // don't strand children when we go away
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
