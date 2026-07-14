import { AgentAdapter, PlatformToolContext, TurnInput, TurnResult } from './types.js';
import type { Transition } from '../resolve/transitions.js';
import { AgentActivity, Provider, ReviewInfo, SubTaskResponse, RaiseToParent, ConfirmDecision } from '../domain/types.js';

const fmt = (cents?: number) => `$${((cents ?? 0) / 100).toFixed(2)}`;

export interface RunTurnDeps {
  adapters: Map<Provider, AgentAdapter>;
  /** Stream incremental output to the task's live event log. */
  onEmit?: (text: string) => void;
  /** Durable, provider-neutral turn items (tools, commands, edits, status, text). */
  onActivity?: (activity: AgentActivity) => void;
  /** Budget service + scope for request_spend (SPEC §7.6); omitted = payments off. */
  budget?: {
    request(ctx: { projectId: string; taskId: string }, args: { amount: number; merchant?: string; why?: string; cardId?: string }): Promise<{
      status: 'granted' | 'needs_approval' | 'needs_funding' | 'denied';
      reason?: string;
      transactionId?: string;
      shortfall?: number;
    }>;
  };
  spendCtx?: { projectId: string; taskId: string };
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
  platformRequest?: (method: string, path: string, body?: unknown) => Promise<unknown>;
}

export const KARMAX_RUNTIME_PROTOCOL = 1 as const;
export interface RuntimeTurnRequestV1 { version: typeof KARMAX_RUNTIME_PROTOCOL; input: TurnInput }

/** Versioned controller protocol used for every local and cloud turn. The model
 * loop stays in the trusted control plane; its filesystem/process tools cross
 * only the World interface. This keeps LLM credentials and platform tokens out
 * of untrusted sandboxes while giving remote worlds exactly the same tools. */
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

  let completed = false;
  let reviewInfo: ReviewInfo | undefined;
  let resolution: Transition | undefined;
  let confirmDecision: ConfirmDecision | undefined;
  let raise: RaiseToParent | undefined;
  let waitForSubtasks = false;
  const subTasks: { title: string; prompt: string }[] = [];
  const subTaskResponses: SubTaskResponse[] = [];
  const skills: { name: string; content: string }[] = [];

  const ctx: PlatformToolContext = {
    // Optional, structured task-finish annotation. Provider completion is established
    // independently by the adapter's verified terminal event; this tool may add a summary
    // but is no longer required to make an ordinary successful turn count as finished.
    // `completed` is retained because immutable workflow v1.0/v1.1 histories consume it.
    signalCompletion(summary) {
      completed = true;
      if (summary && !reviewInfo?.summary) reviewInfo = { ...reviewInfo, summary };
    },
    resolveDecision(t) {
      resolution = t;
      completed = true; // a decision ends the resolve turn
    },
    confirmDecision(d) {
      confirmDecision = d;
      completed = true; // a verdict ends the confirm turn
    },
    createReviewInfo(info) {
      // Accumulate `actions` across calls (an agent may attach them incrementally);
      // every other field is last-write-wins.
      const actions = info.actions ? [...(reviewInfo?.actions ?? []), ...info.actions] : reviewInfo?.actions;
      reviewInfo = { ...reviewInfo, ...info, ...(actions ? { actions } : {}) };
    },
    createSubTask(t) {
      subTasks.push(t);
    },
    respondToSubTask(r) {
      subTaskResponses.push(r);
    },
    raiseToParent(r) {
      raise = r;
    },
    waitForSubtasks() {
      waitForSubtasks = true;
    },
    saveSkill(s) {
      skills.push(s);
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
        reviewInfo = { ...reviewInfo, summary: note };
      }
      return outcome;
    },
    async platformRequest(method, path, body) {
      if (!deps.platformRequest) throw new Error('karmax gateway is unavailable to this turn');
      return deps.platformRequest(method, path, body);
    },
    emit(text) {
      deps.onEmit?.(text);
    },
    emitActivity(activity) {
      deps.onActivity?.(activity);
    },
    onSession: deps.onSession,
    signal: deps.signal,
    heartbeat: deps.heartbeat,
    pullFollowUps: deps.pullFollowUps,
  };

  // Liveness: beat every 10s for the turn's whole duration. Adapters also beat on
  // activity (to pick up pending cancellations quickly), but only this interval
  // guarantees a long silent stretch — a big tool run, a slow first token — can't
  // trip the activity's heartbeat timeout.
  const hb = deps.heartbeat
    ? setInterval(() => {
        try {
          deps.heartbeat!();
        } catch {
          /* never let a heartbeat failure kill the turn */
        }
      }, 10_000)
    : undefined;
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
  }

  return {
    session: turn.session,
    providerCompleted: true,
    providerTermination: turn.termination,
    completed,
    output: turn.output,
    delivered: turn.delivered,
    reviewInfo,
    resolution,
    confirmDecision,
    raise,
    waitForSubtasks,
    pendingSubagents: turn.pendingSubagents,
    pendingBackgroundShells: turn.pendingBackgroundShells,
    subTasks: subTasks.length ? subTasks : undefined,
    subTaskResponses: subTaskResponses.length ? subTaskResponses : undefined,
    skills: skills.length ? skills : undefined,
    // Legacy v1.0/v1.1 workflows use this old no-signal marker. New versions use
    // providerCompleted and do not interpret a missing optional tool call as a stall.
    needsInput:
      !completed && subTasks.length === 0 && subTaskResponses.length === 0 && !raise &&
      !waitForSubtasks && !turn.pendingSubagents && !turn.pendingBackgroundShells,
  };
}
