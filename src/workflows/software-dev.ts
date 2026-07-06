import {
  proxyActivities,
  defineSignal,
  defineUpdate,
  defineQuery,
  setHandler,
  condition,
  startChild,
<<<<<<< HEAD
=======
  getExternalWorkflowHandle,
>>>>>>> master
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
import { classifyLimitError } from '../agent/limits.js';
import {
  TaskInput,
  TaskView,
  Stage,
  Message,
  ReviewInfo,
  DeclaredAction,
  WorldHandleLike,
  ChildRaise,
  ParentResponse,
  SubTaskResponse,
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
export const accountGrantedSignal = defineSignal<[{ turnId: string; accountId: string; configHome?: string; apiKeyHandle?: string }]>(SIG_ACCOUNT_GRANTED);
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

export interface SoftwareDevInput extends TaskInput {
  /** Sub-tasks run with the parent as confirmer; v1 auto-confirms to avoid deadlock. */
  autoConfirm?: boolean;
  /** Goal workflow (SPEC §4.7): auto-send "keep going" until structured completion. */
  goalMode?: boolean;
}

const MAX_RESOLVE_ATTEMPTS = 2;
/** Sub-task fan-out bounds (SPEC §5.3): concurrent children, and children over the
 *  task's whole life. Non-blocking spawn makes runaway delegation cheap without these. */
const MAX_CONCURRENT_SUBTASKS = 8;
const MAX_TOTAL_SUBTASKS = 50;

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
  // The config home that minted `session`. Provider sessions are login-bound, so a
  // later turn leased a DIFFERENT home must NOT resume this session — we drop it and
  // let the turn start fresh (karmax's own `msgs` carries the conversation). §2.5.
  let sessionHome: string | undefined;
  // What a parked turn is waiting on (surfaced in the view; SPEC §6.2).
  let waitingFor: TaskView['waitingFor'];
  let reviewInfo: ReviewInfo | undefined;
  let error: string | undefined;
  let pr: { url: string; number: number } | undefined;
  let mergeQueuePos: { position: number; total: number } | undefined;
  const subTaskIds: string[] = [];
<<<<<<< HEAD
  // Live child sub-task workflow handles, keyed by taskId. A cancel of this task
  // must tear down its running sub-tasks too — their agents/worlds don't stop on
  // their own (SPEC §5.6). We hold handles so we can signal them `cancel`.
  const childHandles = new Map<string, ChildWorkflowHandle<typeof softwareDev>>();
=======
  // Sub-task hierarchy (SPEC §5.3). Children are managed, not blindly awaited: their
  // handles let us await completion, raised requests queue in `raises`, settlements in
  // `settled`, `outstanding` is the not-yet-finished set, and `awaitingResponse` is the
  // children currently parked on a reply from us.
  const childHandles = new Map<string, ChildWorkflowHandle<typeof softwareDev>>();
  const raises: ChildRaise[] = [];
  const settled: { childTaskId: string; stage: string; detail?: string }[] = [];
  const outstanding = new Set<string>();
  const awaitingResponse = new Set<string>();
>>>>>>> master
  let pointOfNoReturnPassed = false;
  // Flips true when `target` becomes load-bearing — a PR opened against it, or the
  // merge enqueue keyed by it — closing the in-flight target-edit window (SPEC §5.5).
  let targetLocked = false;
  let mergeGranted = false;
  let seen = 0; // messages the Do agent has already processed
  // Per-role transcripts surfaced in the view-model (SPEC §5.5): the Do agent's
  // conversation is `msgs`; the merge/resolve agents run on their own message
  // arrays whose input+output we accumulate here so all three are inspectable.
  const mergeMsgs: Message[] = [];
  const resolveMsgs: Message[] = [];
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

  /** All per-role transcripts, omitting roles that haven't run a turn yet. */
  function buildTranscripts(): { role: string; label: string; messages: Message[] }[] {
    const t = [{ role: 'do', label: 'Do agent', messages: msgs }];
    if (mergeMsgs.length) t.push({ role: 'merge', label: 'Merge agent', messages: mergeMsgs });
    if (resolveMsgs.length) t.push({ role: 'resolve', label: 'Resolve agent', messages: resolveMsgs });
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
      waitingFor,
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
          lastError = describeError(err);
          error = lastError;
          const prevStage = stage;
          stage = 'resolve';
          await publish();
          const auto = await core.autoResolve({ taskId, stage: stageName, error });
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
            const r = await leasedTurn('resolve', (accountConfigHome, accountApiKeyHandle) =>
              long.runAgentTurn({
                taskId,
                role: 'resolve',
                worldHandle: world as any,
                messages: [rin],
                task: liveInput,
                bindings: { stage: stageName, error: error ?? '', transcript: lastOutputs(msgs), skills: '' },
                accountConfigHome,
                accountApiKeyHandle,
              }),
            );
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
  async function leasedTurn<T>(role: string, fn: (accountConfigHome?: string, accountApiKeyHandle?: string) => Promise<T>): Promise<T> {
    // No pool ⇒ no leasing at all (zero behavior change, no extra activity).
    if (accountPool <= 0) return await runCancellable(() => fn(undefined, undefined));
    const prov = await core.resolveProvider({ role, task: liveInput }).catch(() => undefined);
    const provider = prov === 'claude' || prov === 'codex' || prov === 'mock' ? prov : undefined;
    if (!provider) return await runCancellable(() => fn(undefined, undefined));
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
    await condition(() => accountGrants.has(turnId) || cancelled, '6 hours');
    waitingFor = undefined;
    if (status === 'waiting') status = priorStatus === 'waiting' ? 'active' : priorStatus;
    const grant = accountGrants.get(turnId);
    accountGrants.delete(turnId);
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
      return await runCancellable(() => fn(leasedHome, leasedKey));
    } catch (err) {
      // Limit failure → update the coordinator so it re-leases the next allowed
      // credential: a transient window arms a refresh timer; a HARD billing/auth
      // failure is flagged needs-attention (won't self-refresh → a human must act).
      if (grant && !passthrough && !cancelled && !isCancellation(err)) {
        const cls = classifyLimitError(describeError(err));
        if (cls.hard) {
          await coord.setAccountAvailability({ accountId: grant.accountId, status: 'needs-attention' }).catch(() => undefined);
        } else if (cls.limited) {
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
    const turn = await withResolve('do', () =>
      leasedTurn('do', (accountConfigHome, accountApiKeyHandle) => {
        doHome = accountConfigHome ?? '(profile)';
        return long.runAgentTurn({
          taskId,
          role: 'do',
          worldHandle: world as any,
          messages: msgs,
          session: sessionMatchesHome(accountConfigHome) ? session : undefined,
          task: liveInput,
          accountConfigHome,
          accountApiKeyHandle,
        });
      }),
    );
    session = turn.session ?? session;
    sessionHome = doHome ?? sessionHome;
    if (turn.output?.trim()) msgs.push({ id: `a${msgs.length}`, role: 'agent', text: turn.output, ts: msgs.length });
    seen = msgs.length;
    if (turn.reviewInfo) reviewInfo = turn.reviewInfo;
    return turn;
  }

<<<<<<< HEAD
    // Sub-tasks: spawn child workflows and await them (SPEC §5.3 Do→Do).
    if (turn.subTasks?.length) {
      // Start each child and hold its handle before awaiting, so a cancel that
      // arrives while sub-tasks run can propagate `cancel` to them (SPEC §5.6).
      const started = await Promise.all(
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
          const handle = await startChild(softwareDev, {
            workflowId: childInput.taskId,
            args: [{ ...childInput, autoConfirm: true } as SoftwareDevInput],
          });
          childHandles.set(childInput.taskId, handle);
          await publish();
          return { title: s.title, id: childInput.taskId, handle };
        }),
      );
      // If a cancel already landed (before these handles were registered), fan it
      // out now so we don't wait on children that must stop.
      if (cancelled) cancelChildren();
      const children = await Promise.all(
        started.map(async (c) => {
          try {
            const res = await c.handle.result();
            return { title: c.title, res };
          } finally {
            childHandles.delete(c.id);
          }
        }),
      );
      for (const c of children) {
        msgs.push({ id: `st-${msgs.length}`, role: 'system', text: `Sub-task "${c.title}" finished: ${c.res.stage}.`, ts: msgs.length });
      }
      if (cancelled) return await abort();
      continue; // resume Do so the agent sees results
=======
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
        msgs.push({ id: `st-${msgs.length}`, role: 'system', text: `Sub-task "${s.title}" was NOT spawned: ${reason}.`, ts: msgs.length });
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

  /** Cancel any still-running children (on our own abort). Best effort. */
  async function cancelChildren() {
    for (const cid of outstanding) {
      try {
        await getExternalWorkflowHandle(cid).signal(cancelSignal);
      } catch {
        /* best effort */
      }
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
   */
  function drainChildEvents(): void {
    while (raises.length) {
      const r = raises.shift()!;
      msgs.push({ id: `st-${msgs.length}`, role: 'system', text: subtaskRaiseText(r), ts: msgs.length });
    }
    while (settled.length) {
      const s = settled.shift()!;
      outstanding.delete(s.childTaskId);
      awaitingResponse.delete(s.childTaskId);
      msgs.push({
        id: `st-${msgs.length}`,
        role: 'system',
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
  world = (await withResolve('setup', () =>
    core.createWorld({ taskId, repo: input.project.repos?.[0], base, target, copyGlobs: input.project.copyGlobs, kind }),
  )) as WorldHandleLike;
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

    const finishing = turn.completed || turn.needsInput || turn.raise;

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
        await condition(() => raises.length > 0 || settled.length > 0 || cancelled || msgs.length > seen);
        if (cancelled) return await abort();
      }
      // Otherwise the agent kept working (spawned/answered this turn) — loop and run
      // another turn; the children's events drain in at the top.
      continue;
>>>>>>> master
    }

    // No children outstanding.
    if (turn.waitForSubtasks) continue; // nothing to wait for → just take another turn

    {
      // Goal mode: keep nudging the agent until it signals structured completion
      // (unless it's explicitly raising to its parent, which needs an answer).
      if (input.goalMode && !turn.completed && !turn.raise) {
        msgs.push({
          id: `kg-${msgs.length}`,
          role: 'user',
          text: 'Keep going until the goal is fully complete, then call signal_completion.',
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
          summary: reviewInfo?.summary ?? auto.summary,
          changedFiles: auto.changedFiles,
          ...(reviewInfo?.links ? { links: reviewInfo.links } : {}),
          ...(reviewInfo?.html ? { html: reviewInfo.html } : {}),
        };
      }
      // An explicit raise carries its own message; show it as the review summary.
      if (turn.raise?.detail) reviewInfo = { ...reviewInfo, summary: turn.raise.detail };
      stage = 'review';
      status = 'waiting';
      if (input.autoConfirm) {
        confirmed = true;
      } else if (input.parentTaskId) {
        // Parent-as-confirmer (SPEC §5.3): raise to the parent instead of blocking on
        // a human the parent-managed child isn't even surfaced to. The parent's reply
        // drives `confirmed`/follow-up via parentResponseSignal.
        waitingFor = { kind: 'parent' };
        await notifyParent(turn.raise?.type ?? 'needs_confirmation', reviewInfo?.summary);
      }
      await publish();
      await condition(() => confirmed || cancelled || msgs.length > seen);
      waitingFor = undefined;
      if (cancelled) return await abort();
      if (confirmed) break;
      // follow-up (a human, or the parent's comment) arrived → back to Do
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
    const mergeIn: Message = { id: `m-in-${mergeMsgs.length}`, role: 'user', text: `Prepare branch for merge into ${target}.`, ts: mergeMsgs.length };
    mergeMsgs.push(mergeIn);
    let result;
    try {
      // Best-effort merge agent turn (resolve conflicts / ensure tests pass)…
      const mt = await leasedTurn('merge', (accountConfigHome, accountApiKeyHandle) =>
        long.runAgentTurn({
          taskId,
          role: 'merge',
          worldHandle: world as any,
          messages: [mergeIn],
          session: sessionMatchesHome(accountConfigHome) ? session : undefined,
          task: liveInput,
          bindings: { reviewInfo: reviewInfo?.summary ?? '' },
          accountConfigHome,
          accountApiKeyHandle,
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
    await coord.releaseMerge(domain, taskId);

    if (result.merged) {
      sha = result.sha;
      pointOfNoReturnPassed = true;
      break;
    }
    // Merge problem → escalate. A child raises `blocked` to its parent (which can
    // retry/answer/cancel); a top-level task escalates to a human. Either can retry.
    error = `merge failed: ${result.conflict ?? result.note ?? 'unknown'}`;
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
    await cancelChildren(); // don't strand children when we go away
    await publish();
    cancelChildren(); // ensure any still-running sub-task agents are torn down
    if (world) await core.destroyWorld(world as any);
    return { stage } as { stage: Stage };
  }

  // Fan a `cancel` out to every live child sub-task workflow. Each child handles
  // the signal gracefully — aborting its in-flight agent turn, destroying its
  // world, and recursively cancelling its own sub-tasks. Fire-and-forget: the
  // child result is still awaited where it was started. Idempotent and safe to
  // call from the cancel handler or abort().
  function cancelChildren() {
    for (const handle of childHandles.values()) {
      handle.signal(cancelSignal).catch(() => {}); // child may have already finished
    }
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
