import { currentTiming } from '../timing/index.js';
import { AgentAdapter, PlatformToolContext, TurnInput, TurnResult } from './types.js';
import type { Transition } from '../resolve/transitions.js';
import { AgentActivity, AgentWait, Provider, ReviewInfo, SubTaskResponse, RaiseToParent, ConfirmDecision } from '../domain/types.js';
import { jobStatuses } from '../world/jobs.js';
import { BRAND } from '../domain/brand.js';

const fmt = (cents?: number) => `$${((cents ?? 0) / 100).toFixed(2)}`;

/** What a turn's tools recorded for the workflow to act on after the turn, plus
 * how many workflow messages reached the agent mid-turn. Saved as each happens,
 * so a retried activity attempt (worker restart, lost heartbeat) keeps every
 * outcome of the attempt it replaces instead of silently dropping them. */
export interface TurnJournal {
  completed?: boolean;
  openPrRequested?: boolean;
  reviewInfo?: ReviewInfo;
  resolution?: Transition;
  confirmDecision?: ConfirmDecision;
  raise?: RaiseToParent;
  waitForSubtasks?: boolean;
  wait?: AgentWait;
  jobsStarted?: string[];
  subTasks?: { title: string; prompt: string }[];
  subTaskResponses?: SubTaskResponse[];
  skills?: { name: string; content: string }[];
  worldHandle?: import('../world/types.js').WorldHandle;
  /** Absolute `msgs` index delivered so far (initial snapshot + mid-turn follow-ups). */
  delivered?: number;
}

export interface RunTurnDeps {
  adapters: Map<Provider, AgentAdapter>;
  /** Stream incremental output to the task's live event log. */
  onEmit?: (text: string, source?: 'assistant' | 'tool') => void;
  /** Persist attachments before acknowledging the tool, including turns stopped by escalation. */
  onReviewInfo?: (info: ReviewInfo, supplied: ReviewInfo) => void | Promise<void>;
  /** Durable, provider-neutral turn items (tools, commands, edits, status, text). */
  onActivity?: (activity: AgentActivity) => void | Promise<void>;
  /** Budget service + scope for request_spend (SPEC §7.6); omitted = payments off. */
  budget?: {
    request(ctx: { projectId: string; taskId: string; organizationId?: string; capabilities?: string[] }, args: { amount: number; merchant?: string; why?: string; cardId?: string }): Promise<{
      status: 'granted' | 'needs_approval' | 'needs_funding' | 'denied';
      reason?: string;
      transactionId?: string;
      shortfall?: number;
      requestId?: string;
      cardId?: string;
      fundingUrl?: string;
    }>;
  };
  spendCtx?: { projectId: string; taskId: string; organizationId?: string; capabilities?: string[] };
  onSpend?: (req: any, outcome: any) => void;
  /** Cancellation propagated from the workflow (SPEC §5.6 mid-turn cancel). */
  signal?: AbortSignal;
  heartbeat?: () => void;
  /** Publish the provider session id the moment it's known (mid-turn), for the live
   *  "fork this agent" command in the drawer (RESOLVE-PLAN #3). */
  onSession?: (session: string) => void;
  /** Pull follow-up messages queued in the workflow at/after `fromIndex` so a
   *  streaming adapter can inject them into the live session mid-turn (SPEC §5.6). */
  pullFollowUps?: (fromIndex: number) => Promise<import('../domain/types.js').Message[]>;
  /** Durable per-turn journal: `restored` is what an interrupted earlier attempt of
   *  this same turn recorded; `save` must persist before the tool call returns. */
  journal?: { restored?: TurnJournal; save(journal: TurnJournal): Promise<void> };
  /** Resolve the project's work-command secrets as they stand now, so a secret
   *  added, rotated or disabled in project settings reaches the running turn. */
  pullSecretEnv?: () => Promise<Record<string, string>>;
  platformRequest?: (method: string, path: string, body?: unknown) => Promise<unknown>;
  fillPaymentCard?: (args: {
    requestId: string;
    cdpUrl: string;
    selectors: import('../autonomy/card-fill.js').CardFillSelectors;
  }) => Promise<{ filled: true; origin: string }>;
}

export const SECRET_ENV_POLL_MS = 5_000;

/** Mirror project-settings changes into the turn's shared secret record and tell
 * the adapter, which rewrites whatever its harness re-reads per command. A failed
 * pull or delivery is retried on the next tick; it never fails the turn. */
function pollSecretEnv(live: Record<string, string>, pull: () => Promise<Record<string, string>>,
  listeners: Set<() => void | Promise<void>>): () => void {
  const serialize = (env: Record<string, string>) => JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)));
  let delivered = serialize(live);
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const next = await pull();
      const serialized = serialize(next);
      if (serialized === delivered) return;
      for (const name of Object.keys(live)) if (!(name in next)) delete live[name];
      Object.assign(live, next);
      for (const listener of listeners) await listener();
      delivered = serialized;
    } catch { /* retried on the next tick */ } finally { busy = false; }
  }, SECRET_ENV_POLL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

export const KARMAX_RUNTIME_PROTOCOL = 1 as const;
export interface RuntimeTurnRequestV1 { version: typeof KARMAX_RUNTIME_PROTOCOL; input: TurnInput }

/** Versioned controller protocol used for every local and cloud turn. API rails
 * run in the activity process; subscription SDK/CLI rails are spawned inside a
 * remote world after its leased config home is seeded there. */
export async function runRuntimeTurn(request: RuntimeTurnRequestV1, deps: RunTurnDeps): Promise<TurnResult> {
  if (request.version !== KARMAX_RUNTIME_PROTOCOL) throw new Error(`unsupported karmax runtime protocol ${request.version}`);
  return runTurn(request.input, deps);
}

/**
 * Run exactly one agent turn (SPEC §7.2). Builds the platform-tool context the
 * agent acts through, dispatches to the provider adapter, and assembles the
 * structured TurnResult. Errors propagate so the workflow's Resolve path runs.
 */
export async function runTurn(input: TurnInput, deps: RunTurnDeps): Promise<TurnResult> {
  const adapter = deps.adapters.get(input.profile.provider);
  if (!adapter) throw new Error(`no agent adapter for provider "${input.profile.provider}"`);

  const trace = (await currentTiming());
  (await trace?.mark('adapter.invoked', { provider: input.profile.provider, model: input.profile.model,
    sessionMode: input.fork ? 'forked' : input.session ? 'resumed' : 'fresh', worldKind: input.world.handle.kind,
    systemPromptChars: input.systemPrompt.length, transcriptChars: input.messages.reduce((n, m) => n + m.text.length, 0),
    messageCount: input.messages.length }));
  const opaqueEnd = (await trace?.start('adapter.to-first-output.opaque'));
  const observedTools = new Map<string, Awaited<ReturnType<NonNullable<typeof trace>['start']>>>();
  const outputObserved = async () => { await Promise.all([trace?.markOnce('first.output'), opaqueEnd?.()]); };
  const restored = deps.journal?.restored ?? {};
  let completed = restored.completed ?? false;
  let openPrRequested = restored.openPrRequested ?? false;
  let reviewInfo: ReviewInfo | undefined = restored.reviewInfo;
  let reviewPublication = Promise.resolve();
  let resolution: Transition | undefined = restored.resolution;
  let confirmDecision: ConfirmDecision | undefined = restored.confirmDecision;
  let raise: RaiseToParent | undefined = restored.raise;
  let waitForSubtasks = restored.waitForSubtasks ?? false;
  let wait: AgentWait | undefined = restored.wait;
  const jobsStarted: string[] = [...(restored.jobsStarted ?? [])];
  const subTasks: { title: string; prompt: string }[] = [...(restored.subTasks ?? [])];
  const subTaskResponses: SubTaskResponse[] = [...(restored.subTaskResponses ?? [])];
  const skills: { name: string; content: string }[] = [...(restored.skills ?? [])];
  // Set only if the agent partitioned its change across another branch this turn.
  let worldHandle: import('../world/types.js').WorldHandle | undefined = restored.worldHandle;
  let delivered = restored.delivered;
  // Saves are serialized so a later snapshot can never be overwritten by an earlier one.
  let journalSaves = Promise.resolve();
  const journal = (): Promise<void> => {
    if (!deps.journal) return Promise.resolve();
    const snapshot: TurnJournal = {
      ...(completed ? { completed } : {}), ...(openPrRequested ? { openPrRequested } : {}),
      ...(reviewInfo ? { reviewInfo } : {}), ...(resolution ? { resolution } : {}),
      ...(confirmDecision ? { confirmDecision } : {}), ...(raise ? { raise } : {}),
      ...(waitForSubtasks ? { waitForSubtasks } : {}),
      ...(wait ? { wait } : {}), ...(jobsStarted.length ? { jobsStarted: [...jobsStarted] } : {}),
      ...(subTasks.length ? { subTasks: [...subTasks] } : {}),
      ...(subTaskResponses.length ? { subTaskResponses: [...subTaskResponses] } : {}),
      ...(skills.length ? { skills: [...skills] } : {}),
      ...(worldHandle ? { worldHandle } : {}), ...(delivered !== undefined ? { delivered } : {}),
    };
    // A failed save leaves this attempt's in-memory outcome intact; only a later
    // retry would lose it, which is no worse than before the journal existed.
    journalSaves = journalSaves.then(() => deps.journal!.save(snapshot)).catch(() => {});
    return journalSaves;
  };
  // Adapters copy `input` (e.g. to resume after a credential refresh), so live
  // secrets are one record shared by every copy and updated in place.
  const liveSecretEnv = deps.pullSecretEnv ? { ...input.secretEnv } : undefined;
  if (liveSecretEnv) input = { ...input, secretEnv: liveSecretEnv };
  const secretEnvListeners = new Set<() => void | Promise<void>>();

  const ctx: PlatformToolContext = {
    openPr() {
      if (input.role !== 'do') throw new Error('open_pr is available only to the Do agent');
      openPrRequested = true;
      completed = true;
      return journal();
    },
    // Optional, structured task-finish annotation. Provider completion is established
    // independently by the adapter's verified terminal event; this tool may add a summary
    // but is no longer required to make an ordinary successful turn count as finished.
    // `completed` is retained because immutable workflow v1.0/v1.1 histories consume it.
    signalCompletion(summary) {
      completed = true;
      if (summary && !reviewInfo?.summary) reviewInfo = { ...reviewInfo, summary };
      return journal();
    },
    resolveDecision(t) {
      resolution = t;
      completed = true; // a decision ends the resolve turn
      return journal();
    },
    confirmDecision(d) {
      confirmDecision = d;
      completed = true; // a verdict ends the confirm turn
      return journal();
    },
    async createReviewInfo(info) {
      // Providers can dispatch tools concurrently. Serialize accumulation with
      // publication so an overlapping call cannot overwrite another's actions.
      const publication = reviewPublication.then(async () => {
        const actions = info.actions ? [...(reviewInfo?.actions ?? []), ...info.actions] : reviewInfo?.actions;
        const supplied = Object.fromEntries(Object.entries(info).filter(([, value]) => value !== undefined));
        const nextReviewInfo = { ...reviewInfo, ...supplied, ...(actions ? { actions } : {}) };
        await deps.onReviewInfo?.(nextReviewInfo, info);
        reviewInfo = nextReviewInfo;
        await journal();
      });
      // A rejected attachment must not prevent the agent correcting it later.
      reviewPublication = publication.catch(() => {});
      await publication;
    },
    createSubTask(t) {
      subTasks.push(t);
      return journal();
    },
    respondToSubTask(r) {
      subTaskResponses.push(r);
      return journal();
    },
    raiseToParent(r) {
      raise = r;
      return journal();
    },
    waitForSubtasks() {
      waitForSubtasks = true;
      return journal();
    },
    requestWait(next) {
      // Only the Do loop parks and resumes an agent; other roles' turns are one-shot.
      if (input.role !== 'do') throw new Error('wait is available only to the Do agent');
      wait = next;
      return journal();
    },
    jobStarted(id) {
      if (!jobsStarted.includes(id)) jobsStarted.push(id);
      return journal();
    },
    saveSkill(s) {
      skills.push(s);
      return journal();
    },
    followUpsDelivered(index) {
      if (delivered !== undefined && index <= delivered) return;
      delivered = index;
      void journal();
    },
    // Do the checkout NOW, so the agent can work in the new branch for the rest
    // of this turn, and hand the updated handle back for the workflow to adopt.
    async addCheckout(spec) {
      // Do-agent only. Every activity re-opens the world from the DURABLE handle
      // (activities/core.ts `ensureRunnerLease`), so a branch added by the merge or
      // resolve agent would be persisted and then landed by a merge that nobody
      // reviewed — while the Do transcript, which owns the partitioning, never
      // mentioned it. Partitioning the change is the Do agent's decision.
      if (input.role !== 'do') {
        throw new Error(`the ${input.role} agent cannot add branches — only the Do agent partitions a task's change`);
      }
      if (!input.world.addCheckout) {
        throw new Error(`the "${input.world.handle.kind}" world backend cannot add branches`);
      }
      worldHandle = await input.world.addCheckout(spec);
      const added = worldHandle.repos?.[worldHandle.repos.length - 1];
      if (!added) throw new Error('checkout was not recorded on the world handle');
      await journal();
      return { name: added.name, root: added.root, branch: added.branch };
    },
    async requestSpend(args) {
      if (!deps.budget || !deps.spendCtx) return { status: 'denied', reason: 'payments not configured' };
      const outcome = await deps.budget.request(deps.spendCtx, args);
      deps.onSpend?.(args, outcome);
      // surface a pending spend at the Review gate so the human can fund/approve
      if (outcome.status !== 'granted') {
        const note =
          outcome.status === 'needs_funding'
            ? `Funding needed: add ${fmt(outcome.shortfall ?? args.amount)} to the card to pay ${fmt(args.amount)}${args.merchant ? ' at ' + args.merchant : ''}. ${args.why ?? ''}`
            : outcome.status === 'needs_approval'
              ? `Approval needed to spend ${fmt(args.amount)}${args.merchant ? ' at ' + args.merchant : ''} (${outcome.reason}). ${args.why ?? ''}`
              : `Spend denied: ${outcome.reason}.`;
        const actions = outcome.requestId && (outcome.status === 'needs_approval' || outcome.status === 'needs_funding')
          ? [
              { kind: 'payment' as const, label: outcome.status === 'needs_funding' ? 'Retry after funding' : 'Approve spend',
                requestId: outcome.requestId, operation: 'approve' as const },
              { kind: 'payment' as const, label: 'Deny spend', requestId: outcome.requestId, operation: 'deny' as const },
              ...(outcome.fundingUrl
                ? [{ kind: 'open' as const, label: 'Fund in Stripe', target: outcome.fundingUrl }]
                : []),
            ]
          : [];
        reviewInfo = { ...reviewInfo, summary: note,
          actions: [...(reviewInfo?.actions ?? []), ...actions] };
        await journal();
      }
      return outcome;
    },
    async platformRequest(method, path, body) {
      if (!deps.platformRequest) throw new Error(`${BRAND} gateway is unavailable to this turn`);
      return deps.platformRequest(method, path, body);
    },
    fillPaymentCard: deps.fillPaymentCard,
    async emit(text, source) {
      const output = text.trim() ? outputObserved() : undefined;
      const firstText = source === 'assistant' && text.trim() ? trace?.markOnce('first.text') : undefined;
      deps.onEmit?.(text, source);
      await Promise.all([output, firstText]);
    },
    async emitActivity(activity) {
      const output = outputObserved();
      const firstText = activity.kind === 'message' && activity.title?.trim() ? trace?.markOnce('first.text') : undefined;
      await Promise.all([deps.onActivity?.(activity), output, firstText]);
      if ((await trace?.enabled()) && ['tool', 'command', 'search', 'file', 'subagent'].includes(activity.kind)) {
        if (activity.phase === 'started' && !observedTools.has(activity.id) && trace)
          observedTools.set(activity.id, (await trace.start('tool.provider-observed', { itemId: activity.id, operation: activity.kind })));
        if (activity.phase === 'completed' || activity.phase === 'failed') {
          (await observedTools.get(activity.id)?.(activity.phase === 'failed' ? 'failed' : 'ok'));
          observedTools.delete(activity.id);
        }
      }

    },
    onSession: deps.onSession,
    signal: deps.signal,
    heartbeat: deps.heartbeat,
    ...(liveSecretEnv ? { onSecretEnvChange(listener: () => void | Promise<void>) {
      secretEnvListeners.add(listener);
      return () => { secretEnvListeners.delete(listener); };
    } } : {}),
    pullFollowUps: deps.pullFollowUps ? async (fromIndex) => {
      const messages = await deps.pullFollowUps!(fromIndex);
      for (const message of messages) (await trace?.markOnce('followup.offered', { requestId: `${trace.context.taskId}:${message.id}` }, `followup:${message.id}`));
      return messages;
    } : undefined,
  };

  // Liveness + cancellation delivery: beat every second for the turn's whole
  // duration. Adapters also heartbeat on activity, but only this interval
  // guarantees a long silent stretch — a big tool run, a slow first token — can't
  // delay cancellation. The Worker caps heartbeat throttling at the same interval.
  const hb = deps.heartbeat
    ? setInterval(() => {
        try {
          deps.heartbeat!();
        } catch {
          /* never let a heartbeat failure kill the turn */
        }
      }, 1_000)
    : undefined;
  const secretPoll = liveSecretEnv ? pollSecretEnv(liveSecretEnv, deps.pullSecretEnv!, secretEnvListeners) : undefined;
  let turn;
  deps.onActivity?.({ id: 'turn', kind: 'turn', phase: 'started', title: 'Agent started working' });
  try {
    turn = await adapter.runTurn(input, ctx);
    // An adapter may deliberately swallow its provider's AbortError so it can clean
    // up and return partial output (Claude SDK, Codex app-server/CLI). That partial
    // result is NOT a completed turn when the enclosing activity was cancelled. In
    // particular, Worker shutdown cancels in-flight activities; accepting the return
    // here turns a server restart into `needsInput` and advances Do -> Review.
    //
    // Keep this invariant at the provider-independent boundary: no adapter return
    // after cancellation can ever be interpreted as a successful turn, regardless
    // of role (Do/Confirm/Resolve/Merge) or provider-specific cleanup behaviour.
    if (deps.signal?.aborted) {
      throw deps.signal.reason instanceof Error ? deps.signal.reason : new Error('agent turn cancelled');
    }
    // This should be guaranteed by AdapterTurn's type, but enforce it at runtime too:
    // adapters and external packages are still JavaScript at the process boundary.
    if (turn.termination?.kind !== 'success') {
      throw new Error('agent provider ended without a verified successful terminal event');
    }
    (await trace?.mark('provider.completed', turn.usage));
    deps.onActivity?.({
      id: 'turn',
      kind: 'turn',
      phase: 'completed',
      title: 'Agent finished',
      ...(turn.termination.reason ? { detail: turn.termination.reason } : {}),
    });
  } catch (error) {
    deps.onActivity?.({
      id: 'turn',
      kind: 'turn',
      phase: 'failed',
      title: 'Agent turn failed',
      detail: error instanceof Error ? error.message.slice(0, 1200) : String(error).slice(0, 1200),
    });
    throw error;
  } finally {
    if (hb) clearInterval(hb);
    secretPoll?.();
  }

  // A job started this turn and still running when the agent stopped without
  // waiting for it: report it, so the workflow resumes the agent when it ends
  // instead of moving on without its result.
  let runningJobs: string[] | undefined;
  if (jobsStarted.length && !wait) {
    try {
      runningJobs = (await jobStatuses(input.world, jobsStarted)).filter((job) => job.state === 'running').map((job) => job.id);
    } catch { /* the turn's outcome never depends on this probe */ }
  }

  return {
    session: turn.session,
    providerCompleted: true,
    providerTermination: turn.termination,
    completed,
    ...(openPrRequested ? { openPrRequested: true } : {}),
    output: turn.output,
    usage: turn.usage,
    delivered: turn.delivered,
    reviewInfo,
    resolution,
    confirmDecision,
    raise,
    waitForSubtasks,
    pendingSubagents: turn.pendingSubagents,
    pendingBackgroundShells: turn.pendingBackgroundShells,
    ...(turn.stoppedBackgroundShells?.length ? { stoppedBackgroundShells: turn.stoppedBackgroundShells } : {}),
    ...(wait ? { wait } : {}),
    ...(runningJobs?.length ? { runningJobs } : {}),
    subTasks: subTasks.length ? subTasks : undefined,
    subTaskResponses: subTaskResponses.length ? subTaskResponses : undefined,
    skills: skills.length ? skills : undefined,
    ...(worldHandle ? { worldHandle } : {}),
    // Legacy v1.0/v1.1 workflows use this old no-signal marker. New versions use
    // providerCompleted and do not interpret a missing optional tool call as a stall.
    needsInput:
      !completed && subTasks.length === 0 && subTaskResponses.length === 0 && !raise &&
      !waitForSubtasks && !wait && !turn.pendingSubagents && !turn.pendingBackgroundShells,
  };
}
