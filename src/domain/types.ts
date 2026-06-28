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

export interface ReviewInfo {
  summary?: string;
  links?: { label: string; url: string }[];
  diff?: string;
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
  messages: Message[];
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
  pointOfNoReturnPassed?: boolean;
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
}

// ─── Workflow input ──────────────────────────────────────────────────────────

export interface TaskInput {
  taskId: string;
  projectId: string;
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
}

// ─── Events (SPEC §5 — typed, namespaced, schema-declared) ───────────────────

export interface KarmaxEvent {
  type: string; // e.g. "software-dev.stage-changed"
  taskId: string;
  ts: number;
  payload: Record<string, unknown>;
}
