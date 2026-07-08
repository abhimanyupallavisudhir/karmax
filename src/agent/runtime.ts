import { AgentAdapter, PlatformToolContext, TurnInput, TurnResult } from './types.js';
import type { Transition } from '../resolve/transitions.js';
import { Provider, ReviewInfo, SubTaskResponse, RaiseToParent } from '../domain/types.js';

const fmt = (cents?: number) => `$${((cents ?? 0) / 100).toFixed(2)}`;

export interface RunTurnDeps {
  adapters: Map<Provider, AgentAdapter>;
  /** Stream incremental output to the task's live event log. */
  onEmit?: (text: string) => void;
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
  let raise: RaiseToParent | undefined;
  let waitForSubtasks = false;
  const subTasks: { title: string; prompt: string }[] = [];
  const subTaskResponses: SubTaskResponse[] = [];
  const skills: { name: string; content: string }[] = [];

  const ctx: PlatformToolContext = {
    signalCompletion(summary) {
      completed = true;
      if (summary && !reviewInfo?.summary) reviewInfo = { ...reviewInfo, summary };
    },
    resolveDecision(t) {
      resolution = t;
      completed = true; // a decision ends the resolve turn
    },
    createReviewInfo(info) {
      reviewInfo = { ...reviewInfo, ...info };
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
    emit(text) {
      deps.onEmit?.(text);
    },
    onSession: deps.onSession,
    signal: deps.signal,
    heartbeat: deps.heartbeat,
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
  try {
    turn = await adapter.runTurn(input, ctx);
  } finally {
    if (hb) clearInterval(hb);
  }

  return {
    session: turn.session,
    completed,
    output: turn.output,
    reviewInfo,
    resolution,
    raise,
    waitForSubtasks,
    pendingSubagents: turn.pendingSubagents,
    subTasks: subTasks.length ? subTasks : undefined,
    subTaskResponses: subTaskResponses.length ? subTaskResponses : undefined,
    skills: skills.length ? skills : undefined,
    // If the agent did work but didn't signal completion — and didn't spawn, answer,
    // raise, or wait on a sub-task, and isn't still waiting on its own in-harness
    // sub-agents (those route through the workflow, not the human Review gate) — it is
    // surfaced as needs-input.
    needsInput:
      !completed && subTasks.length === 0 && subTaskResponses.length === 0 && !raise && !waitForSubtasks && !turn.pendingSubagents,
  };
}
