import { AgentProfile, AgentRole, Message, Provider, ReviewInfo } from '../domain/types.js';
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
}

export interface TurnInput {
  profile: AgentProfile;
  world: World;
  /** Conversation so far; the agent acts on the latest user message(s). */
  messages: Message[];
  /** Resume id from the prior turn (SPEC §7.2). */
  session?: string;
  /** Assembled system prompt (role template + bindings + instructions), snapshotted upstream. */
  systemPrompt: string;
  role: AgentRole;
  /** Max tool/agent iterations for this turn. */
  maxTurns?: number;
  /** Credentials resolved JIT by the broker (never journaled); preferred over env. */
  resolvedAuth?: { apiKey?: string; configHome?: string };
}

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
}

export type { AgentProfile, AgentRole, Provider, Message, ReviewInfo };
