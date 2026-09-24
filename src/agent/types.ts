import { AgentActivity, AgentProfile, AgentRole, Message, Provider, ReviewInfo, SubTaskResponse, RaiseToParent, ConfirmDecision } from '../domain/types.js';
import type { Transition } from '../resolve/transitions.js';
import { World } from '../world/types.js';

/**
 * The provider-adapter interface (SPEC §7.1). A profile is translated by an
 * adapter into a concrete invocation. The agent runs ONE turn per activity
 * (SPEC §7.2); between turns only a session id is stored.
 */

/** Platform capabilities the agent reaches via the platform MCP, surfaced as tool calls. */
export interface PlatformToolContext {
  /** Do-agent ONLY: declare that the completed, committed proposal is ready to
   *  publish and enter Review. This is deliberately distinct from merely ending
   *  a model turn or asking a human for input. */
  openPr(): void;
  /** Optional structured completion summary; provider terminal success is authoritative. */
  signalCompletion(summary?: string): void;
  /** Optionally attach terse, click-to-verify actions/outputs for the Review stage. */
  createReviewInfo(info: ReviewInfo): void | Promise<void>;
  /** Spawn a child task the parent manages (branches off + merges back into the
   *  parent's world branch; the parent is its confirmer, SPEC §5.2/§5.3). */
  createSubTask(t: { title: string; prompt: string }): void;
  /** Parent-agent ONLY: answer a child that raised to you (open_pr/comment/retry/
   *  cancel; `confirm` is a replay-compatible alias). */
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
  /** Do-agent ONLY: partition this task's change across another branch, checked
   *  out beside the current one and landed as its own pull request (SPEC §11.1).
   *  Performed immediately so the agent can work in it during the SAME turn; the
   *  updated world handle rides back on the turn result for the workflow to adopt. */
  addCheckout(spec: import('../world/types.js').WorldCheckoutSpec): Promise<{ name: string; root: string; branch: string }>;
  /** Resolve agent's structured verdict (RESOLVE-PLAN §3.2): a bounded recovery
   *  transition the workflow executes (resume/retryStage/gotoStage/parkUntil/escalate)
   *  instead of guessing. Also marks the resolve turn complete. */
  resolveDecision(t: Transition): void;
  /** Confirm agent's structured verdict at the Review gate (SPEC §5.2): confirm /
   *  revise (back to Do with a comment) / reject (cancel). Ends the confirm turn. */
  confirmDecision(d: ConfirmDecision): void;
  /** Request a payment against the budget lease (SPEC §7.6). Returns the outcome:
   *  granted (settled or authorization reserved) | needs_approval |
   *  needs_funding | denied. */
  requestSpend(args: { amount: number; merchant?: string; why?: string; cardName?: string; cardId?: string }): Promise<{
    status: 'granted' | 'needs_approval' | 'needs_funding' | 'denied';
    reason?: string;
    transactionId?: string;
    shortfall?: number;
    requestId?: string;
    cardId?: string;
    fundingUrl?: string;
  }>;
  /** Fill a reserved Stripe virtual card into checkout fields over loopback CDP.
   * Card details remain in the trusted activity process and never enter model IO. */
  fillPaymentCard?(args: {
    requestId: string;
    cdpUrl: string;
    selectors: import('../autonomy/card-fill.js').CardFillSelectors;
  }): Promise<{ filled: true; origin: string }>;
  /** Call the capability-checked karmax gateway under this turn's scoped token. */
  platformRequest?(method: string, path: string, body?: unknown): Promise<unknown>;
  /** Stream incremental output to the task's live event log. */
  emit(text: string, source?: 'assistant' | 'tool'): void;
  /** Publish a structured provider item for the durable conversation timeline. */
  emitActivity(activity: AgentActivity): void;
  /** Called as soon as the provider session id is known (mid-turn), so the task can
   *  publish it immediately — the drawer then shows a live "fork this agent" command
   *  WHILE the turn runs, not only after it ends (RESOLVE-PLAN #3). Fire-once per id. */
  onSession?: (session: string) => void;
  /** Aborts when the task is cancelled mid-turn (SPEC §5.6): adapters pass this to
   *  fetch and check it between tool iterations so cancel takes effect at once. */
  signal?: AbortSignal;
  /** Called between tool iterations so Temporal delivers a pending cancellation. */
  heartbeat?: () => void;
  /** Pull follow-up messages that landed in the workflow AT OR AFTER `fromIndex`
   *  (a `msgs`-array index), so a streaming-capable adapter can inject them into the
   *  LIVE agent session mid-turn instead of waiting for the next turn (SPEC §5.6).
   *  Returns only genuine follow-ups (user/system), never the agent's own replies.
   *  Undefined when there is no live channel (a resumed retry, or a unit test with no
   *  workflow) — the adapter then just runs the snapshot it was given. */
  pullFollowUps?: (fromIndex: number) => Promise<Message[]>;
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
  /** Extra env for the agent subprocess, resolved JIT (never journaled) — e.g. the
   *  git profile's GIT_SSH_COMMAND / GH_TOKEN (PLAN-git-config.md §4B), so an agent
   *  that pushes or runs `gh` does so as the project's git account. */
  extraEnv?: Record<string, string>;
  /** Environment-shaped project secrets and per-world service endpoints, resolved
   *  JIT from resource leases/credential handles. Available only to work commands,
   *  never to the harness runtime or model authentication. Values are never
   *  stored in a world handle or Temporal history. */
  secretEnv?: Record<string, string>;
  /** MCP servers the workflow gives its agents, beyond the platform baseline (SPEC §7.5). */
  agentMcp?: import('../contrib/manifests.js').AgentMcpServer[];
}

/** When no turn cap is set, agents run "unlimited" — this is only a runaway
 *  backstop so an infinite tool-loop can't burn unbounded spend. */
export const RUNAWAY_BACKSTOP = 1000;

export interface AdapterTurn {
  /**
   * A provider adapter may return only after observing the provider's verified
   * successful terminal event.  Interrupted, cancelled, failed, truncated, and
   * transport-ended turns throw instead, even when they produced partial text.
   * Keeping this explicit prevents "the iterator/process stopped" from being
   * mistaken for "the provider completed the turn".
   */
  termination: {
    kind: 'success';
    /** Provider-native terminal status/reason, retained for diagnostics. */
    status: string;
    reason?: string;
  };
  session?: string;
  output: string;
  /** Provider-reported token counts. Subscription CLIs do not consistently
   * expose these; omission is honest and remains distinguishable from zero. */
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number;
    /** OpenAI includes cached reads in input_tokens; Anthropic reports them
     * separately. Pricing normalizes this without guessing. */
    inputTokensIncludeCacheRead?: boolean;
    /** Provider-normalized total; avoids double-counting APIs where cached input
     * is included in inputTokens while retaining cache details for reporting. */
    totalTokens?: number };
  /** How many leading `input.messages` this turn actually delivered to the agent —
   *  the initial delta PLUS any follow-ups injected in-flight (streaming adapters).
   *  Absolute index into the `msgs` conversation, so the workflow can position the
   *  agent's reply after exactly the messages it answered and advance its delivered
   *  boundary past them (never dropping a mid-turn follow-up, never re-sending one).
   *  Omitted ⇒ the adapter delivered exactly `input.messages` (the schedule snapshot). */
  delivered?: number;
  /** Claude-Agent-SDK sub-agents (the Task tool) still in flight when the turn's
   *  main loop returned — e.g. auto-backgrounded long sub-agents that only settle
   *  later. The workflow holds in Do until this reaches 0 so a task is never
   *  reported "done" while the agent is still waiting on its sub-agents. */
  pendingSubagents?: number;
  /** Backgrounded shells (a `run_in_background` Bash) still running when the turn's
   *  main loop returned. The workflow nudges the agent to wait for them (bounded, so a
   *  deliberately-left-running dev server can't wedge the task). */
  pendingBackgroundShells?: number;
}

export interface AgentAdapter {
  readonly provider: Provider;
  /** Run one turn. Call ctx methods when the agent uses platform tools. */
  runTurn(input: TurnInput, ctx: PlatformToolContext): Promise<AdapterTurn>;
}

export interface TurnResult {
  session?: string;
  /** The adapter observed a verified successful provider terminal event. New
   * workflow versions use this as the turn boundary; `completed` remains the
   * legacy optional signal_completion marker for replay compatibility. */
  providerCompleted?: boolean;
  /** Provider-native successful terminal status/reason. */
  providerTermination?: AdapterTurn['termination'];
  completed: boolean;
  /** The Do agent explicitly requested the PR/Review cycle. */
  openPrRequested?: boolean;
  output: string;
  usage?: AdapterTurn['usage'];
  /** Provider timeline item carrying `output`, when the adapter emitted one. */
  finalActivity?: NonNullable<Message['sourceActivity']>;
  reviewInfo?: ReviewInfo;
  subTasks?: { title: string; prompt: string }[];
  /** Parent-agent responses to child raises this turn (SPEC §5.3). */
  subTaskResponses?: SubTaskResponse[];
  /** Child-agent request up to its parent this turn (SPEC §5.3). */
  raise?: RaiseToParent;
  /** Parent-agent asked to park until its sub-tasks settle (SPEC §5.3). */
  waitForSubtasks?: boolean;
  /** In-harness sub-agents (Claude Agent SDK Task tool) still running when the turn
   *  returned. While > 0 the workflow keeps the agent in Do rather than advancing to
   *  Review — completion is "done AND not waiting on any sub-agents". */
  pendingSubagents?: number;
  /** Backgrounded shells (a `run_in_background` Bash) still running when the turn
   *  returned. The workflow nudges the agent to wait for them before Review, bounded so
   *  a deliberately-left-running background process (e.g. a dev server) can't wedge it. */
  pendingBackgroundShells?: number;
  skills?: { name: string; content: string }[];
  /** The world handle after any branch the agent added this turn (SPEC §11.1).
   *  Present only when it changed, so a workflow version that predates multi-PR
   *  — and every turn that added nothing — is untouched. */
  worldHandle?: import('../world/types.js').WorldHandle;
  needsInput?: boolean;
  /** Absolute count of conversation messages the turn delivered (see AdapterTurn.delivered). */
  delivered?: number;
  error?: string;
  /** The Resolve agent's structured recovery decision (RESOLVE-PLAN §3.2). */
  resolution?: Transition;
  /** The Confirm agent's Review-gate verdict (SPEC §5.2). */
  confirmDecision?: ConfirmDecision;
}

export type { AgentProfile, AgentRole, Provider, Message, ReviewInfo };
