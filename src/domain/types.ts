/**
 * The karmax domain model (SPEC §2) and the task view-model contract (§10.2).
 * These types are shared across the workflow contract, the gateway, and the UI.
 */

// ─── Identity ────────────────────────────────────────────────────────────────

export type Provider = 'claude' | 'codex' | 'mock';

export type AgentRole = 'do' | 'merge' | 'resolve' | (string & {});

// ─── Project / list / task records (the metadata index) ──────────────────────

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  config: ProjectConfig;
}

export interface ProjectConfig {
  /** Repo directories software-dev operates on (worktrees branch off these). */
  repos?: string[];
  /** Default base branch worlds branch off (e.g. "main"). */
  defaultBase?: string;
  /** Default branch merges land on. */
  defaultTarget?: string;
  /** Gitignored files copied into each world at setup (e.g. .env). */
  copyGlobs?: string[];
  /** Open a real GitHub PR (gated by GitHub auth). The Review stage IS the PR conceptually. */
  openGithubPr?: boolean;
  /** role -> agent profile id. */
  defaultProfiles?: Record<string, string>;
  /** World backend. */
  worldProvider?: 'worktree' | 'container';
  /** Snapshot-on-park resumable worlds (§11.3). */
  resumeWorlds?: boolean;
}

export interface TaskList {
  id: string;
  projectId: string;
  name: string;
  createdAt: number;
  order: number;
}

/** The persisted index record for a task. The live view comes from the workflow query. */
export interface TaskRecord {
  id: string;
  projectId: string;
  listId: string;
  title: string;
  workflow: string; // workflow definition name
  workflowVersion: string; // pinned at creation (SPEC §4.4)
  params: TaskParams;
  createdAt: number;
  order: number;
  parentTaskId?: string;
  /**
   * Free-form human notes about the task (SPEC §10). Purely cosmetic — shown only
   * in the UI and never assembled into any agent prompt. The human jots whatever
   * they want here; it has no effect on workflow execution.
   */
  notes?: string;
  /** Last view snapshot, refreshed opportunistically so terminal/parked tasks list cheaply. */
  lastView?: TaskView;
}

export interface TaskParams {
  prompt: string;
  base?: string;
  target?: string;
  /** role -> profile id overrides. */
  profiles?: Record<string, string>;
  /** script-exec command. */
  command?: string;
  /** UI lifecycle: stored-not-queued (draft) / hidden from the default list (archived). */
  draft?: boolean;
  archived?: boolean;
  [k: string]: unknown;
}

// ─── The view-model (SPEC §10.2 — the mandatory typed projection) ─────────────

export type Stage =
  | 'setup'
  | 'do'
  | 'review'
  | 'pr'
  | 'merge'
  | 'done'
  | 'resolve'
  | 'escalated'
  | 'cancelled'
  | 'failed';

export type TaskStatus = 'active' | 'waiting' | 'blocked' | 'done' | 'failed' | 'cancelled';

export interface Message {
  id: string;
  role: 'user' | 'agent' | 'system';
  text: string;
  ts: number;
}

/**
 * A single click-to-verify affordance the reviewer can act on. Review info is a
 * list of these — NOT a prose changelog (that belongs in the conversation). Two
 * primitives:
 *  - `run`  — a shell command executed IN THE TASK'S WORLD (start a server, run an
 *             app or script). A long-lived one (`server: true`) streams logs and can
 *             be stopped; `openUrls` are opened once it's up.
 *  - `open` — open a produced artifact: a world-relative file (PDF, notebook, image,
 *             video) or an absolute URL. No command runs.
 */
export type ReviewActionKind = 'run' | 'open';

export interface ReviewAction {
  kind: ReviewActionKind;
  /** Short button label, e.g. "Start dev server", "Open coverage report". */
  label: string;
  /** `run` only: the exact shell command executed in the task's world. */
  command?: string;
  /** `run` only: the command is a long-lived server/watcher (stream logs + Stop). */
  server?: boolean;
  /** `run` only: URLs to open once the command is up (e.g. a dev server page). */
  openUrls?: string[];
  /** `open` only: world-relative file path OR an absolute URL to open. */
  target?: string;
}

export interface ReviewInfo {
  /**
   * Terse orientation — WHAT to verify, not a narrative of what was done. One line.
   * Prose about the work belongs in the conversation/messages, not here.
   */
  caption?: string;
  /** Click-to-verify affordances (SPEC §5.5): the primary review payload. */
  actions?: ReviewAction[];
  /** @deprecated Legacy free-form summary; kept for back-compat rendering only. */
  summary?: string;
  links?: { label: string; url: string }[];
  diff?: string;
  /** Files changed vs base (auto-derived from git so Review always shows them). */
  changedFiles?: string[];
  /** Agent-authored rich HTML, rendered in a sandboxed iframe (§10.2 tier 4). */
  html?: string;
}

export type ActionKind = 'signal' | 'update' | 'query';

export interface ActionArg {
  name: string;
  type: 'string' | 'text' | 'boolean' | 'number' | 'select';
  label?: string;
  required?: boolean;
  options?: string[];
  default?: unknown;
}

// ─── Parameter schema (SPEC §10.4) — drives task forms + settings + defaults ──

export type FieldType = 'text' | 'string' | 'number' | 'boolean' | 'select' | 'list' | 'repoPath' | 'branch' | 'agent';
/** Which surfaces a field appears on. */
export type FieldScope = 'task' | 'project' | 'global';
/** Where a resolved value lands in TaskInput (the generic assembler reads this). */
export type FieldBind = 'prompt' | 'top' | 'project' | 'profile';
/**
 * When a param may be edited after the task is queued (SPEC §4.5/§5.5). This is
 * the single declaration that drives in-flight edits: the workflow validator
 * enforces it, and the UI/gateway derive which fields to expose as editable.
 * - `queue`    — frozen once the workflow starts (draft-only). The default.
 * - `untilUsed`— editable in-flight until the workflow *consumes* it: the target
 *                branch until a PR opens / the merge enqueue; the merge agent
 *                until the merge turn runs; the resolve agent until a resolve
 *                turn runs. Consumption points are workflow-specific.
 * - `always`   — editable at any time (reserved; unused in v1).
 * An `untilUsed`/`always` field is only truly live if the workflow actually
 * re-reads it at consumption time; declaring it without re-reading it is a bug.
 */
export type FieldMutable = 'queue' | 'untilUsed' | 'always';

export interface FieldSpec {
  name: string;
  type: FieldType;
  label: string;
  help?: string;
  required?: boolean;
  options?: string[];
  default?: unknown;
  placeholder?: string;
  scopes: FieldScope[];
  bind: FieldBind;
  /** For agent fields / bind:'profile' — the role this configures (do/merge/resolve). */
  role?: string;
  /** In-flight editability window (SPEC §4.5/§5.5). Omitted ⇒ `queue`. */
  mutable?: FieldMutable;
}

/** A per-use agent override collected by the `agent` field (SPEC §10.5). */
export interface AgentSpec {
  provider: Provider;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Continue a prior agent session: a source task (+ which role's agent) or a
   *  raw provider conversation/session id. */
  resumeFrom?: { taskId?: string; role?: string; sessionId?: string };
}

/** A declared action the workflow exposes; auto-rendered as a button/form (§10.2 tier 1). */
export interface DeclaredAction {
  name: string;
  kind: ActionKind;
  label: string;
  enabled: boolean;
  danger?: boolean;
  args?: ActionArg[];
}

/** The typed projection of a task's state + allowed actions the UI renders. */
export interface TaskView {
  taskId: string;
  title: string;
  workflow: string;
  stage: Stage;
  status: TaskStatus;
  /**
   * Free-form human notes (cosmetic, UI-only — never sent to any agent). Mirrored
   * onto the view from the task record so the UI can show/edit them at any stage,
   * even for a task not currently in the loaded list. Not produced by the workflow.
   */
  notes?: string;
  messages: Message[];
  /**
   * Per-role conversation transcripts (Do / Merge / Resolve). `messages` above is
   * kept as the Do transcript for back-compat + the live bubble; this carries all
   * roles so the UI can show each — collapsed except the one owning the active
   * stage (SPEC §5.5). Roles with no turns yet are omitted.
   */
  transcripts?: { role: string; label: string; messages: Message[] }[];
  reviewInfo?: ReviewInfo;
  actions: DeclaredAction[];
  /** Mandatory structured state — keeps search/audit/auto-render working (§10.2). */
  state: Record<string, unknown>;
  branch?: string;
  base?: string;
  targetBranch?: string;
  worldPath?: string;
  pr?: { url: string; number: number };
  mergeQueue?: { position: number; total: number };
  subTasks?: string[];
  parentTaskId?: string;
  error?: string;
  /**
   * What the task is currently parked on, if anything (SPEC §6.2). Surfaced so the
   * UI can show e.g. "Waiting for quota refresh" while a turn waits for a compatible
   * agent login to free up or refresh. Cleared once unparked.
   */
  waitingFor?: { kind: 'account' | 'mergeSlot' | 'human' | 'subtask' | 'parent'; provider?: string; earliestResetAt?: number; detail?: string };
  pointOfNoReturnPassed?: boolean;
  /**
   * Task-scope param field names the workflow will accept live edits for right
   * now (SPEC §5.5). Derived from each field's `mutable` window and the current
   * stage; the UI renders these editable and everything else read-only. Enriched
   * by the gateway from the manifest schema (the workflow needn't know its schema).
   */
  editableParams?: string[];
  updatedAt: number;
}

// ─── Agent profiles (SPEC §7.1) ──────────────────────────────────────────────

export interface AuthSource {
  kind: 'none' | 'configHome' | 'apiKeyHandle';
  /** A CODEX_HOME / CLAUDE_CONFIG_DIR directory. */
  configHome?: string;
  /** Credential-broker handle (never a raw key). */
  handle?: string;
  /** Account id for config-home leasing via the account coordinator. */
  account?: string;
}

export interface AgentProfile {
  id: string;
  name: string;
  provider: Provider;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  role: AgentRole;
  /** Prompt template path under the content store, or inline text. */
  promptTemplate?: string;
  /** Capability ceiling this profile may ever attempt (SPEC §8.2). */
  capabilities: string[];
  maxTurns?: number;
  auth?: AuthSource;
  /**
   * Which accounts this agent may use (SPEC §7.3/§6.2). Each ref is
   * `login:<provider>:<account>` (a connected config-home login) or
   * `key:<handle>` (a stored API key). Empty/undefined = all connected accounts.
   * This set is the agent's credential/lease pool — the coordinator rotates
   * across exactly these logins.
   */
  allowedAccounts?: string[];
}

// ─── Workflow input ──────────────────────────────────────────────────────────

export interface TaskInput {
  taskId: string;
  projectId: string;
  /** The workflow this task runs (so activities can read its manifest — roles, agentMcp). */
  workflow?: string;
  title: string;
  prompt: string;
  base?: string;
  target?: string;
  /** Existing branch to merge (merge-only workflow). */
  branch?: string;
  command?: string;
  parentTaskId?: string;
  /** Resolved profile ids per role. */
  profiles?: Record<string, string>;
  /** Per-role agent overrides (provider/model/effort/resume) from the task form (§10.5). */
  agents?: Record<string, AgentSpec>;
  /** A snapshot of project config, captured at creation. */
  project: ProjectConfig;
  /** Capability grant from the spawning principal. */
  grant?: string[];
  /**
   * Per-field in-flight editability windows (SPEC §4.5/§5.5), copied from the
   * workflow manifest at assembly time. Lets the deterministic workflow validate
   * live param edits without importing the manifest into the Temporal sandbox.
   * Sparse — only non-`queue` fields are carried; a missing name means `queue`.
   */
  paramWindows?: Record<string, FieldMutable>;
}

// ─── Events (SPEC §5 — typed, namespaced, schema-declared) ───────────────────

export interface KarmaxEvent {
  type: string; // e.g. "software-dev.stage-changed"
  taskId: string;
  ts: number;
  payload: Record<string, unknown>;
}

// ─── Sub-task hierarchy (raise-to-parent) ────────────────────────────────────
// A child task doesn't block on a hidden human at Review/Escalation; it RAISES a
// typed event to its parent, whose Do agent decides. The parent's decision maps
// onto the SAME state transitions a human would drive (confirm/retry/cancel/
// follow-up), so "the parent as confirmer" is literal (SPEC §5.2/§5.3).

/** Why a child is asking its parent to act. */
export type RaiseType = 'needs_confirmation' | 'needs_info' | 'needs_permission' | 'blocked';

/** Signal a child sends UP to its parent when it reaches a decision point. */
export interface ChildRaise {
  childTaskId: string;
  childTitle: string;
  type: RaiseType;
  detail?: string;
}

/** How a parent's Do agent answers a child raise (the `respond_to_sub_task` tool). */
export type SubTaskAction = 'confirm' | 'comment' | 'retry' | 'cancel';

/** Signal a parent sends DOWN to a child in response to a raise. */
export interface ParentResponse {
  action: SubTaskAction;
  text?: string;
}

/** A parent-agent response emitted in a turn. `childTaskId` omitted ⇒ all children
 *  currently awaiting a response (the common "confirm my sub-tasks" case). */
export interface SubTaskResponse {
  childTaskId?: string;
  action: SubTaskAction;
  text?: string;
}

/** A child-agent's explicit request up to its parent (the `raise_to_parent` tool). */
export interface RaiseToParent {
  type: RaiseType;
  detail?: string;
}
