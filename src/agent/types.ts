import { AgentProfile, AgentRole, Message, Provider, ReviewInfo, SubTaskResponse, RaiseToParent } from '../domain/types.js';
import type { Transition } from '../resolve/transitions.js';
import { World } from '../world/types.js';

/**
 * The provider-adapter interface (SPEC §7.1). A profile is translated by an
 * adapter into a concrete invocation. The agent runs ONE turn per activity
 * (SPEC §7.2); between turns only a session id is stored.
 */

/** Platform capabilities the agent reaches via the platform MCP, surfaced as tool calls. */
export interface PlatformToolContext {
  /** Structured, unspoofable completion signal (SPEC §5.2). */
  signalCompletion(summary?: string): void;
  /** Attach review info (links, diff, polished output) for the Review stage. */
  createReviewInfo(info: ReviewInfo): void;
  /** Spawn a child task the parent manages (branches off + merges back into the
   *  parent's world branch; the parent is its confirmer, SPEC §5.2/§5.3). */
  createSubTask(t: { title: string; prompt: string }): void;
  /** Parent-agent ONLY: answer a child that raised to you (confirm/comment/retry/
   *  cancel). `childTaskId` omitted ⇒ all children awaiting a response. */
  respondToSubTask(r: SubTaskResponse): void;
  /** Child-agent ONLY: raise a typed request UP to your parent (needs_info /
   *  needs_permission / needs_confirmation / blocked) and pause for its reply. */
  raiseToParent(r: RaiseToParent): void;
  /** Parent-agent ONLY: pause your own work until your running sub-tasks settle (or
   *  one raises). Use when you have nothing to do but wait; otherwise just keep
   *  working — sub-tasks run in the background either way. */
  waitForSubtasks(): void;
  /** Persist a reusable skill (content, freely editable; SPEC §4.4). */
  saveSkill(s: { name: string; content: string }): void;
  /** Resolve agent's structured verdict (RESOLVE-PLAN §3.2): a bounded recovery
   *  transition the workflow executes (resume/retryStage/gotoStage/parkUntil/escalate)
   *  instead of guessing. Also marks the resolve turn complete. */
  resolveDecision(t: Transition): void;
  /** Request a payment against the budget lease (SPEC §7.6). Returns the outcome:
   *  granted (charged) | needs_approval | needs_funding | denied. */
  requestSpend(args: { amount: number; merchant?: string; why?: string; cardId?: string }): Promise<{
    status: 'granted' | 'needs_approval' | 'needs_funding' | 'denied';
    reason?: string;
    transactionId?: string;
    shortfall?: number;
  }>;
  /** Stream incremental output to the task's live event log. */
  emit(text: string): void;
  /** Called as soon as the provider session id is known (mid-turn), so the task can
   *  publish it immediately — the drawer then shows a live "fork this agent" command
   *  WHILE the turn runs, not only after it ends (RESOLVE-PLAN #3). Fire-once per id. */
  onSession?: (session: string) => void;
  /** Aborts when the task is cancelled mid-turn (SPEC §5.6): adapters pass this to
   *  fetch and check it between tool iterations so cancel takes effect at once. */
  signal?: AbortSignal;
  /** Called between tool iterations so Temporal delivers a pending cancellation. */
  heartbeat?: () => void;
}

export interface TurnInput {
  profile: AgentProfile;
  world: World;
  /** Conversation so far; the agent acts on the latest user message(s). */
  messages: Message[];
  /** A session to continue (prior turn, SPEC §7.2) OR — with `fork` — to branch from. */
  session?: string;
  /** How many leading `messages` the resumed `session` already holds (delivered on
   *  prior turns). On resume the adapter sends only the delta after this boundary —
   *  the session carries the rest server-side, so re-sending it wastes tokens and
   *  folds the agent's own past replies back in as user input. Ignored on a fresh
   *  session / fork (the full transcript is sent). See `messagesToDeliver`. */
  deliveredMessages?: number;
  /** Fork `session` into a NEW session instead of continuing it (SPEC §10.5): the
   *  source is left untouched. Claude → `--fork-session`; Codex → resume a copied rollout. */
  fork?: boolean;
  /** Assembled system prompt (role template + bindings + instructions), snapshotted upstream. */
  systemPrompt: string;
  role: AgentRole;
  /** Max tool/agent iterations for this turn. */
  maxTurns?: number;
  /** Credentials resolved JIT by the broker (never journaled); preferred over env. */
  resolvedAuth?: { apiKey?: string; configHome?: string; oauthToken?: string };
  /** MCP servers the workflow gives its agents, beyond the platform baseline (SPEC §7.5). */
  agentMcp?: import('../contrib/manifests.js').AgentMcpServer[];
}

/** When no turn cap is set, agents run "unlimited" — this is only a runaway
 *  backstop so an infinite tool-loop can't burn unbounded spend. */
export const RUNAWAY_BACKSTOP = 1000;

export interface AdapterTurn {
  session?: string;
  output: string;
}

export interface AgentAdapter {
  readonly provider: Provider;
  /** Run one turn. Call ctx methods when the agent uses platform tools. */
  runTurn(input: TurnInput, ctx: PlatformToolContext): Promise<AdapterTurn>;
}

export interface TurnResult {
  session?: string;
  completed: boolean;
  output: string;
  reviewInfo?: ReviewInfo;
  subTasks?: { title: string; prompt: string }[];
  /** Parent-agent responses to child raises this turn (SPEC §5.3). */
  subTaskResponses?: SubTaskResponse[];
  /** Child-agent request up to its parent this turn (SPEC §5.3). */
  raise?: RaiseToParent;
  /** Parent-agent asked to park until its sub-tasks settle (SPEC §5.3). */
  waitForSubtasks?: boolean;
  skills?: { name: string; content: string }[];
  needsInput?: boolean;
  error?: string;
  /** The Resolve agent's structured recovery decision (RESOLVE-PLAN §3.2). */
  resolution?: Transition;
}

export type { AgentProfile, AgentRole, Provider, Message, ReviewInfo };
