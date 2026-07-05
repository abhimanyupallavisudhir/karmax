import { AgentProfile, AgentRole, Message, Provider, ReviewInfo } from '../domain/types.js';
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
  /** Spawn a child task awaited by the parent (SPEC §5.2). */
  createSubTask(t: { title: string; prompt: string }): void;
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
  skills?: { name: string; content: string }[];
  needsInput?: boolean;
  error?: string;
  /** The Resolve agent's structured recovery decision (RESOLVE-PLAN §3.2). */
  resolution?: Transition;
}

export type { AgentProfile, AgentRole, Provider, Message, ReviewInfo };
