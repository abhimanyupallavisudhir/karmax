import { FieldSpec } from '../domain/types.js';
import { ResolveRuleDecl } from '../resolve/cases.js';

/**
 * Workflow manifests (SPEC §4.3). Data-only declarations the host reads to wire
 * a workflow in: name/version, `requires` (transitive deps), emitted event
 * schemas, capability ceiling, UI slot contributions, command registrations,
 * the typed parameter schema (§10.4), and an optional onActivate hook. Pure data
 * so any layer can import them.
 */

// ── reusable field builders ──
const ALL: FieldSpec['scopes'] = ['task', 'project', 'global'];
const promptField = (): FieldSpec => ({ name: 'prompt', type: 'text', label: 'Prompt', required: true, scopes: ['task'], bind: 'prompt', placeholder: 'Describe the task…' });
// Task-scope only: per-role agent DEFAULTS live in the Agent-profiles editor
// (with a per-project override), so this is just the one-off per-task override —
// no duplication with the workflow-defaults settings forms (SPEC §7.1/§10.5).
// `mutable`: an agent role whose turn runs LATER (merge, resolve) can be swapped
// in-flight until that turn runs (SPEC §5.5). The Do agent is left frozen — it
// runs from the first turn and holds a live resumable session, so the follow-up
// box is its live-redirect channel, not a mid-session provider swap.
const agentField = (role: string, label: string, mutable?: FieldSpec['mutable']): FieldSpec => ({ name: `agent:${role}`, type: 'agent', label, scopes: ['task'], bind: 'profile', role, ...(mutable ? { mutable } : {}) });
const baseField = (): FieldSpec => ({ name: 'base', type: 'branch', label: 'Base branch', default: 'main', scopes: ALL, bind: 'top' });
// `untilUsed`: editable in-flight until the target becomes load-bearing (a PR
// opened against it or the merge enqueue). software-dev re-reads `target` at
// PR/merge, so the edit genuinely takes effect (SPEC §4.5/§5.5, §2 setTarget).
const targetField = (): FieldSpec => ({ name: 'target', type: 'branch', label: 'Target (merge-to) branch', default: 'main', scopes: ALL, bind: 'top', mutable: 'untilUsed' });
const reposField = (): FieldSpec => ({ name: 'repos', type: 'list', label: 'Repository directory', help: 'Absolute path, or one starting with ~', scopes: ['project'], bind: 'project' });
const copyGlobsField = (): FieldSpec => ({ name: 'copyGlobs', type: 'list', label: 'Gitignored files to copy into each world', placeholder: '.env', scopes: ['project', 'global'], bind: 'project' });
const worldProviderField = (): FieldSpec => ({ name: 'worldProvider', type: 'select', label: 'World provider', options: ['worktree', 'container'], default: 'worktree', scopes: ['project', 'global'], bind: 'project' });
const prToggleField = (): FieldSpec => ({ name: 'openGithubPr', type: 'boolean', label: 'Open a GitHub PR on confirm', default: false, scopes: ['project', 'global'], bind: 'project' });

export interface EventSchemaDecl {
  type: string;
  description: string;
  fields: Record<string, string>;
}

export interface UiContribution {
  /** Named host slot the contribution mounts into (SPEC §10.1). */
  slot:
    | 'task-detail'
    | 'task-list-item'
    | 'task-list-column'
    | 'project-settings'
    | 'merge-queue-panel'
    | 'review-area'
    | 'dashboard-widget'
    | 'global-nav';
  /** Rendering tier (SPEC §10.2): 1 generic floor, 2 declarative, 3 mounted, 4 sandboxed iframe. */
  tier: 1 | 2 | 3 | 4;
  /** Component/renderer id the UI resolves (for tier-3 mounted components). */
  component?: string;
  /** Declarative widget composition (tier 2) — host draws these, no bespoke code. */
  widgets?: import('./widgets.js').WidgetSpec[];
  title?: string;
}

export interface CommandDecl {
  id: string;
  title: string;
  /** Default keybinding (a view over the command registry; SPEC §10.1). */
  keybinding?: string;
}

export interface OnActivateDecl {
  /** Spawn a preparation task when the workflow is added to a project (SPEC §4.6). */
  spawnTask?: { workflow: string; title: string; prompt: string };
}

/**
 * An agent role a workflow owns (SPEC §7.1). The workflow declares its roles here
 * — each with the system-prompt template, capability ceiling, and default agent
 * knobs — so prompt assembly, profile seeding, and the profiles UI derive from the
 * package instead of the platform hardcoding do/merge/resolve. Provider/model are
 * resolved at seed time from the platform default, so they aren't declared here.
 */
export interface WorkflowRole {
  name: string;
  label: string;
  /** System-prompt template; `{{bindings}}` are filled at turn time (agent/prompt.ts). */
  promptTemplate: string;
  /** Capability ceiling seeded onto this role's default profile. */
  capabilities?: string[];
  defaults?: { effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; maxTurns?: number };
}

// The bundled roles, defined once and referenced by the workflows that use them
// (do/merge/resolve are shared vocabulary — see PLAN-dynamic-repos.md §2b).
// `{{toolsPreamble}}` and the other `{{...}}` are filled by assemblePrompt.
const DO_ROLE: WorkflowRole = {
  name: 'do',
  label: 'Do agent',
  capabilities: ['create-sub-task', 'create-review-info', 'signal-completion', 'save-skill'],
  promptTemplate: `{{toolsPreamble}}

# Task
{{title}}

{{prompt}}

# World
Working directory: {{worldPath}} (branch {{branch}} off {{base}}).

{{instructions}}`,
};
const MERGE_ROLE: WorkflowRole = {
  name: 'merge',
  label: 'Merge agent',
  capabilities: ['merge-into:*', 'signal-completion'],
  promptTemplate: `{{toolsPreamble}}

You are merging task "{{title}}". Its work is on branch {{branch}} in the worktree at {{worldPath}}.
Merge {{target}} into this branch, resolve any conflicts, ensure the build and tests pass, then the work will be merged into {{target}}.
Review context: {{reviewInfo}}
Call signal_completion when the branch is ready to merge.`,
};
const RESOLVE_ROLE: WorkflowRole = {
  name: 'resolve',
  label: 'Resolve agent',
  capabilities: ['signal-completion', 'save-skill'],
  promptTemplate: `{{toolsPreamble}}

The "{{stage}}" step failed for task "{{title}}".
Error: {{error}}
Worktree: {{worldPath}}
Recent transcript: {{transcript}}
Candidate resolution skills: {{skills}}
Diagnose and fix so {{stage}} can resume. If you cannot, explain why, then call signal_completion.`,
};

// Lifecycle stages per bundled workflow (the pipeline the UI renders).
const SOFTWARE_DEV_STAGES: StageDef[] = [
  { key: 'setup', label: 'Setup' },
  { key: 'do', label: 'Do', aliases: ['resolve'] },
  { key: 'review', label: 'Review' },
  { key: 'pr', label: 'PR' },
  { key: 'merge', label: 'Merge', ponr: true, aliases: ['escalated'] },
  { key: 'done', label: 'End' },
];

/**
 * A stage in a workflow's lifecycle (SPEC §5). The workflow declares its own
 * pipeline so the UI renders *its* lifecycle, not software-dev's. `key` must match
 * the value the workflow sets on `view.stage`; `aliases` fold transient/meta
 * stages onto a node (e.g. `resolve` → the `do` node); `ponr` marks the point of
 * no return. Terminal stages (done/cancelled/failed) are handled generically.
 */
export interface StageDef {
  key: string;
  label: string;
  ponr?: boolean;
  aliases?: string[];
}

/**
 * An MCP server a workflow gives its agents, on top of the platform baseline
 * (SPEC §7.5). A stdio server launched per turn — e.g. a browser MCP or a
 * domain tool. Auth-bearing servers should read their creds from env, not here.
 */
export interface AgentMcpServer {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Map declared agent MCP servers to the Claude Agent SDK `mcpServers` shape. */
export function agentMcpToConfig(servers: AgentMcpServer[] | undefined): Record<string, { command: string; args: string[]; env?: Record<string, string> }> {
  const out: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};
  for (const s of servers ?? []) out[s.name] = { command: s.command, args: s.args ?? [], ...(s.env ? { env: s.env } : {}) };
  return out;
}

export interface WorkflowManifest {
  name: string;
  version: string;
  description: string;
  requires: string[];
  events: EventSchemaDecl[];
  capabilities: string[];
  ui: UiContribution[];
  commands: CommandDecl[];
  /** Agent roles this workflow owns (SPEC §7.1). */
  roles?: WorkflowRole[];
  /** MCP servers this workflow's agents get, beyond the platform baseline (SPEC §7.5). */
  agentMcp?: AgentMcpServer[];
  /** Declared auto-resolve rules, checked before the platform defaults (SPEC §5.2). */
  resolveRules?: ResolveRuleDecl[];
  /** Override the platform tools-preamble in this workflow's agent prompts (SPEC §5.4). */
  promptPreamble?: string;
  /** The workflow's lifecycle stages (SPEC §5) — drives the pipeline UI. */
  stages?: StageDef[];
  /** Typed parameter schema (SPEC §10.4) — drives task forms + settings + defaults. */
  params: FieldSpec[];
  onActivate?: OnActivateDecl;
  /** Coordinators are long-lived singletons (SPEC §6), not task workflows. */
  kind?: 'task' | 'coordinator';
}

export const MANIFESTS: WorkflowManifest[] = [
  {
    name: 'software-dev',
    version: '1.0.0',
    description: 'Branch/world → do → review → PR → merge → end, with resolve and sub-tasks.',
    requires: ['merge-queue'],
    capabilities: ['create-sub-task', 'create-review-info', 'signal-completion', 'save-skill', 'merge-into:*'],
    events: [
      { type: 'software-dev.stage-changed', description: 'Task moved between stages.', fields: { stage: 'Stage', status: 'string' } },
      { type: 'software-dev.merged', description: 'Work landed on the target branch.', fields: { sha: 'string' } },
    ],
    ui: [
      { slot: 'task-detail', tier: 1, title: 'Task' },
      // Tier-2 declarative composition (SPEC §10.2): host widgets bound to the
      // view-model — drawn generically, no software-dev-specific UI code.
      {
        slot: 'task-detail',
        tier: 2,
        title: 'Progress',
        widgets: [
          { type: 'badge', bind: 'stage', title: 'Stage' },
          { type: 'gauge', bind: 'mergeQueue', title: 'Merge queue', valueKey: 'position', maxKey: 'total' },
          { type: 'list', bind: 'reviewInfo.changedFiles', title: 'Changed files', empty: 'No changes yet.' },
        ],
      },
      { slot: 'review-area', tier: 4, component: 'review-iframe', title: 'Review' },
      { slot: 'project-settings', tier: 2, component: 'software-dev-settings', title: 'Software dev' },
    ],
    commands: [
      { id: 'task.confirm', title: 'Confirm task', keybinding: 'c' },
      { id: 'task.followUp', title: 'Send follow-up', keybinding: 'f' },
      { id: 'task.cancel', title: 'Cancel task', keybinding: 'x' },
    ],
    roles: [DO_ROLE, MERGE_ROLE, RESOLVE_ROLE],
    stages: SOFTWARE_DEV_STAGES,
    params: [
      promptField(),
      agentField('do', 'Do agent'),
      baseField(),
      targetField(),
      reposField(),
      copyGlobsField(),
      worldProviderField(),
      prToggleField(),
      agentField('merge', 'Merge agent', 'untilUsed'),
      agentField('resolve', 'Resolve agent', 'untilUsed'),
    ],
    onActivate: {
      spawnTask: {
        workflow: 'just-do',
        title: 'Make this project karmax-ready',
        prompt:
          'Ensure git is initialized in each repo. For brownfield repos, scan for hardcoded resources (e.g. ports) that would collide between worktrees and fix them. Report what you changed.',
      },
    },
  },
  {
    name: 'just-do',
    version: '1.0.0',
    description: 'A single straightforward agent call, no merge machinery.',
    requires: [],
    capabilities: ['create-review-info', 'signal-completion', 'save-skill'],
    events: [{ type: 'just-do.done', description: 'Single agent call finished.', fields: {} }],
    ui: [{ slot: 'task-detail', tier: 1, title: 'Task' }],
    commands: [],
    roles: [DO_ROLE],
    // No merge machinery: do → review → done.
    stages: [
      { key: 'setup', label: 'Setup' },
      { key: 'do', label: 'Do', aliases: ['resolve'] },
      { key: 'review', label: 'Review' },
      { key: 'done', label: 'End' },
    ],
    params: [promptField(), agentField('do', 'Do agent'), baseField(), reposField(), worldProviderField()],
  },
  {
    name: 'script-exec',
    version: '1.0.0',
    description: 'Run a script/command as a task.',
    requires: [],
    capabilities: ['signal-completion'],
    events: [{ type: 'script-exec.done', description: 'Command finished.', fields: { code: 'number' } }],
    ui: [{ slot: 'task-detail', tier: 1, title: 'Task' }],
    commands: [],
    // No agent: run the command, then show its output.
    stages: [
      { key: 'setup', label: 'Setup' },
      { key: 'do', label: 'Run' },
      { key: 'review', label: 'Output' },
      { key: 'done', label: 'End' },
    ],
    params: [
      { name: 'command', type: 'text', label: 'Command', required: true, scopes: ['task'], bind: 'top', placeholder: 'npm test' },
      reposField(),
    ],
  },
  {
    name: 'goal',
    version: '1.0.0',
    description: 'Like software-dev, but auto-continues until structured completion.',
    requires: ['merge-queue'],
    capabilities: ['create-sub-task', 'create-review-info', 'signal-completion', 'save-skill', 'merge-into:*'],
    events: [{ type: 'goal.completed', description: 'Goal reached.', fields: {} }],
    ui: [{ slot: 'task-detail', tier: 1, title: 'Task' }],
    commands: [],
    // goal delegates to softwareDev, so it runs merge/resolve too.
    roles: [DO_ROLE, MERGE_ROLE, RESOLVE_ROLE],
    stages: SOFTWARE_DEV_STAGES,
    params: [promptField(), agentField('do', 'Do agent'), baseField(), targetField(), reposField(), copyGlobsField(), worldProviderField(), prToggleField()],
  },
  {
    name: 'merge-only',
    version: '1.0.0',
    description: 'The review-and-merge half of software-dev (no Do). The dogfooded PR gate.',
    requires: ['merge-queue'],
    capabilities: ['create-review-info', 'signal-completion', 'merge-into:*'],
    events: [{ type: 'merge-only.merged', description: 'Reviewed branch merged.', fields: { sha: 'string' } }],
    ui: [{ slot: 'task-detail', tier: 1, title: 'Task' }],
    commands: [],
    roles: [MERGE_ROLE],
    // Review an existing branch, then merge it (no Do).
    stages: [
      { key: 'setup', label: 'Setup' },
      { key: 'review', label: 'Review' },
      { key: 'merge', label: 'Merge', ponr: true, aliases: ['escalated'] },
      { key: 'done', label: 'End' },
    ],
    params: [
      { name: 'branch', type: 'branch', label: 'Branch to merge', required: true, scopes: ['task'], bind: 'top' },
      targetField(),
      reposField(),
      agentField('merge', 'Merge agent'),
    ],
  },
  {
    name: 'merge-queue',
    version: '1.0.0',
    description: 'Leases the single merge slot per target branch (coordinator).',
    requires: [],
    capabilities: [],
    events: [],
    ui: [{ slot: 'merge-queue-panel', tier: 2, component: 'merge-queue', title: 'Merge queue' }],
    commands: [],
    params: [],
    kind: 'coordinator',
  },
  {
    name: 'account-coordinator',
    version: '1.0.0',
    description: 'Tracks per-account limits and leases agent-account capacity (coordinator).',
    requires: [],
    capabilities: [],
    events: [],
    ui: [{ slot: 'dashboard-widget', tier: 2, component: 'accounts', title: 'Accounts' }],
    commands: [],
    params: [],
    kind: 'coordinator',
  },
];

export function manifest(name: string): WorkflowManifest | undefined {
  return MANIFESTS.find((m) => m.name === name);
}

/** A declared role plus which workflow(s) declare it (for the profiles UI). */
export interface RoleWithSource extends WorkflowRole {
  workflows: string[];
}

/** Every role declared across the given manifests, deduped by name (first wins),
 *  tracking which workflows use each. Resolution is by role name — shared
 *  vocabulary — matching how profiles resolve (SPEC §7.1). */
export function allRoles(manifests: WorkflowManifest[] = MANIFESTS): RoleWithSource[] {
  const byName = new Map<string, RoleWithSource>();
  for (const m of manifests) {
    for (const r of m.roles ?? []) {
      const cur = byName.get(r.name);
      if (cur) {
        if (!cur.workflows.includes(m.name)) cur.workflows.push(m.name);
      } else {
        byName.set(r.name, { ...r, workflows: [m.name] });
      }
    }
  }
  return [...byName.values()];
}

/** The declared role by name (or undefined if no active workflow declares it). */
export function roleDef(name: string, manifests: WorkflowManifest[] = MANIFESTS): RoleWithSource | undefined {
  return allRoles(manifests).find((r) => r.name === name);
}

/** Resolve the transitive closure of `requires` for a set of workflows (SPEC §4.6). */
export function resolveRequires(names: string[]): string[] {
  const seen = new Set<string>();
  const visit = (n: string) => {
    if (seen.has(n)) return;
    seen.add(n);
    for (const dep of manifest(n)?.requires ?? []) visit(dep);
  };
  names.forEach(visit);
  return [...seen];
}
