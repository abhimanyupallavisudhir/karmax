import { FieldSpec } from '../domain/types.js';
import { CONFIRM_PROMPT_DEFAULT } from '../domain/confirm-prompt.js';
import { ResolveRuleDecl } from '../resolve/cases.js';
import { RESOLVE_AGENT_ENABLED } from '../config/features.js';
import { DEVELOPER_WORKSPACE_CAPABILITIES } from '../platform/capabilities.js';

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
// `mutable: 'always'`: an agent role's *model* and *effort* can be re-tuned
// in-flight at any time up to the point of no return (SPEC §5.5) — the change
// lands at the next best convenience in the conversation (the next turn the role
// runs, e.g. a follow-up). What stays gated is the role's IDENTITY (provider /
// resumed session), enforced by the workflow's update validator: the Do agent
// holds a live resumable session from its first turn so its provider can't be
// swapped mid-flight (retune model/effort, or send a follow-up to redirect it);
// merge can still be fully swapped until its own turn runs.
const agentField = (role: string, label: string, mutable?: FieldSpec['mutable']): FieldSpec => ({ name: `agent:${role}`, type: 'agent', label, scopes: ['task'], bind: 'profile', role, ...(mutable ? { mutable } : {}) });
// The confirmer field holds the ordered confirm LAYERS the Review gate plays —
// each a human confirmation or a review agent; zero layers ⇒ auto-confirm.
// Unlike the agent fields it spans all scopes (task/project/global) so the layer
// list has the usual default-inheritance; an agent layer carries the same agent
// knobs (provider/model/effort/fork) as the Do/Merge fields, PLUS the
// review-request prompt template (pre-filled with `promptDefault`, editable per
// task/project/global).
// `untilUsed`: the route is consumed by the gate it drives, not by queueing — so
// it stays editable in-flight right up to the moment Review passes (SPEC §4.5/§5.5).
// That is exactly when re-routing is useful ("actually, have Bob look at this"),
// and it also self-heals the race the old queue-time freeze only avoided: a task
// reaching Review while someone is mid-edit now simply picks up the saved route.
// The workflows re-read the layers at every gate iteration and replay the gate
// from its first layer when the route changes under them.
const confirmerField = (): FieldSpec => ({ name: 'confirm', type: 'confirmer', label: 'Review route', help: 'The workflow decides who is pinged at Review. Add people, teams, or @all to human steps; agent steps can review first. Steps run in order, and no steps means auto-confirm.', scopes: ALL, bind: 'confirm', role: 'confirm', default: { layers: [{ kind: 'human', audience: ['@creator'] }] }, promptDefault: CONFIRM_PROMPT_DEFAULT, mutable: 'untilUsed' });
const baseField = (): FieldSpec => ({ name: 'base', type: 'branch', label: 'Base (branch-from) branch', default: 'main', scopes: ALL, bind: 'top' });
// `untilUsed`: editable in-flight until the target becomes load-bearing (a PR
// opened against it or the merge enqueue). software-dev re-reads `target` at
// PR/merge, so the edit genuinely takes effect (SPEC §4.5/§5.5, §2 setTarget).
const targetField = (): FieldSpec => ({ name: 'target', type: 'branch', label: 'Target (merge-to) branch', default: 'main', scopes: ALL, bind: 'top', mutable: 'untilUsed' });
const reposField = (): FieldSpec => ({ name: 'repos', type: 'list', label: 'Repositories', help: 'One per line. Local worlds accept filesystem paths; E2B accepts SSH Git URLs (git@github.com:org/repo.git). Multiple repos are checked out in separate world subdirectories.', scopes: ['project'], bind: 'project' });
// Deprecated compatibility path (SPEC §11.4). Keep the wire field so historical
// projects remain editable while resource attachments replace host-file copying.
// The warning is deliberately visible: a host path is not a hosted transport and
// `.env` belongs in the credential broker, not a durable workspace snapshot.
const copyGlobsField = (): FieldSpec => ({
  name: 'copyGlobs',
  type: 'list',
  label: 'Legacy local file copies',
  help: 'Self-hosted compatibility only. These host-local ignored files are copied into task worlds; they are not available to hosted projects. Put secrets in the credential broker and durable data in project resources.',
  placeholder: '.env',
  scopes: ['project', 'global'],
  bind: 'project',
});
const remoteField = (): FieldSpec => ({
  name: 'remote',
  type: 'select',
  label: 'Remote policy',
  help: 'What leaves a local machine: none — merges stay local; push — push the target after merge; pr — also open a GitHub PR at Review. In E2B, the SSH repository is necessarily the durable source of truth, so confirmed merges are broker-pushed even when this is none.',
  options: ['none', 'push', 'pr'],
  default: 'none',
  scopes: ['project', 'global'],
  bind: 'project',
});
// Multi-PR (SPEC §11.1, PLAN-multi-pr.md). Off, a task is one branch per repo,
// exactly as before. On, the Do agent may partition its change across several
// branches with `create_branch`, each landing as its own pull request — so the
// world nests its checkouts from Setup, which is the only structural difference
// and is why this is a task-scoped field rather than something inferred later.
// The lifecycle stays singular: one Review, one Merge, one point of no return.
const multiPrField = (): FieldSpec => ({
  name: 'multiPr',
  type: 'boolean',
  label: 'Allow several branches per task',
  help: 'Let the agent split one task\'s change into several branches, each reviewed and merged as its own pull request (including stacked ones). They share a single Review gate and a single Merge — work that needs its own review timing belongs in a separate task.',
  default: false,
  scopes: ALL,
  bind: 'project',
});
const gitProfileField = (): FieldSpec => ({
  name: 'gitProfile',
  type: 'string',
  label: 'Git profile',
  help: 'Named git identity/credentials (Organization settings → Git accounts) this project commits, signs and pushes as. Empty ⇒ the organization default, else the host’s own git setup.',
  scopes: ['project', 'global'],
  bind: 'project',
});
// "Agent environment" (SPEC §11) — the world backend a task's agent runs in: a
// local git worktree/container or a remote sandbox (E2B/Daytona). Canonical
// storage remains the execution policy (ProjectConfig.worldProvider / the
// organization policy); this field exposes it as an ordinary task default AND a
// per-task override, so a single task can pick a different environment without a
// project-wide change. `bind:'project'` lands the resolved value on
// `input.project.worldProvider`, which every world-creating workflow already
// reads. Options are filled in by the client from the organization's connected
// providers; an empty value ⇒ inherit the project / organization default. It is
// frozen once the task starts (default `queue`): the world is provisioned at
// setup and can't be swapped mid-flight.
const agentEnvironmentField = (): FieldSpec => ({
  name: 'worldProvider',
  type: 'select',
  label: 'Agent environment',
  options: [''],
  scopes: ALL,
  bind: 'project',
});

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
    | 'queue-panel'
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
 * package instead of the platform hardcoding role names. Provider/model are
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

// The bundled roles, defined once and referenced by the workflows that use them.
// `{{toolsPreamble}}` and the other `{{...}}` are filled by assemblePrompt.
const DO_ROLE: WorkflowRole = {
  name: 'do',
  label: 'Do agent',
  // Task authorization is the deliberate delegation boundary. A Do agent may
  // use everything the granting human selected (including organization/global
  // operation); attenuation still removes everything that human did not hold.
  // Workflow decisions and protected-target merges stay reserved for their
  // concrete Resolve/Confirm/Merge roles even when the task is God-authorized.
  capabilities: [
    // Keep the historical spellings in the declaration for replay/tests; the
    // capability layer normalizes them to the task:* / skill:* families below.
    'create-sub-task', 'create-review-info', 'signal-completion', 'save-skill',
    'task:*', 'project:*', 'organization:*', 'team:*', 'repository:*', 'inbox:*',
    'queue:*', 'workflow:*', 'profile:*', 'skill:write',
    'diagnostic:read', 'process:*', 'credential:*', 'vault:store', 'use-credential:*',
    'payment:*', 'use-card:*', 'settings:*', 'safe-mode:write',
    'authorization:*', 'user:*',
  ],
  promptTemplate: `{{toolsPreamble}}

# Task
{{title}}

{{prompt}}

# World
Working directory: {{worldPath}} (branch {{branch}} off {{base}}).
{{worldRepos}}

{{instructions}}`,
};
const MERGE_ROLE: WorkflowRole = {
  name: 'merge',
  label: 'Merge agent',
  // Merge remains a developer working in the task branch. The protected merge
  // itself is still this role's additional, workflow-specific power.
  capabilities: [...DEVELOPER_WORKSPACE_CAPABILITIES, 'merge-into:*', 'signal-completion', 'task:escalate'],
  promptTemplate: `{{toolsPreamble}}

You are merging task "{{title}}". Its work is on branch {{branch}} in the worktree at {{worldPath}}.
{{worldRepos}}
Merge {{target}} into this branch, resolve any conflicts, ensure the build and tests pass, then the work will be merged into {{target}}.
Review context: {{reviewInfo}}
Finish the turn only when the branch is ready to merge. signal_completion is optional.`,
};
// Retained privately so version-pinned executions created before the global flag
// was disabled can replay their already-recorded Resolve turns. It is deliberately
// absent from current manifests, schemas, profiles, and every UI surface.
const LEGACY_RESOLVE_ROLE: WorkflowRole = {
  name: 'resolve',
  label: 'Resolve agent',
  capabilities: ['signal-completion', 'save-skill', 'resolve-decision', 'task:escalate'],
  promptTemplate: `{{toolsPreamble}}

You are the RESOLVE agent for task "{{title}}". The "{{stage}}" step failed.

Error:
{{error}}

Worktree: {{worldPath}}
Recent transcript:
{{transcript}}

Candidate resolution skills (read any that look relevant before acting):
{{skills}}

## Read carefully — your job is narrow
(a) You are NOT here to finish the task. Your ONLY job is to diagnose THIS error and decide how to get the task back on track, then report that decision with the resolve_decision tool. Do not implement the task's feature.

(b) Our strong preference is that errors are caught by the auto-resolve SCRIPT, never by an agent. This one reached you because no auto-resolve case matched it. So, in order:
  1. Diagnose the cause. If you can fix it in the worktree (a bad file, a missing dependency, a stale artifact), do so, then call resolve_decision({action:"resume"}) to continue the interrupted agent, or {action:"retryStage"} to re-run the step fresh.
  2. If this class of error is MECHANICALLY recognizable (a stable error signature → a scripted fix), capture that so it auto-resolves next time WITHOUT an agent: save_skill a skill named "resolve/<slug>" whose content states (i) a regex/signature that matches this error, (ii) the exact fix or retry that resolves it, and (iii) whether it's safe to auto-retry. These skills are the source material for new auto-resolve cases (added later through the reviewed PR gate — the merge-only workflow — so they are tested before they ever run automatically).
  3. If the failure is rooted NOT in this project's code but in a DEPENDENCY — karmax itself, or another library/tool/service — file a bug against that dependency's own repository using the \`gh\` CLI (or the appropriate tracker). karmax's repo is https://github.com/abhimanyupallavisudhir/karmax/ (e.g. \`gh issue create --repo abhimanyupallavisudhir/karmax --title "..." --body "..."\`). Include the error, a minimal repro, and enough context to reproduce. Then still record a resolve_decision for THIS task (resume/retryStage if you found a workaround, otherwise escalate).
  4. If you cannot fix it, call resolve_decision({action:"escalate", reason:"<what a human needs to do>"}). Do not loop or keep trying.

(c) The candidate skills above are your index of prior resolutions — prefer reusing a known fix over rediscovering one.

Always finish by calling resolve_decision exactly once.`,
};
const CONFIRM_ROLE: WorkflowRole = {
  name: 'confirm',
  label: 'Confirm agent',
  capabilities: ['confirm-decision', 'signal-completion', 'task:escalate'],
  defaults: { effort: 'low' },
  // The task recap + the Do agent's response arrive as a per-Review conversation
  // message (domain/confirm-prompt.ts, template user-editable via the confirmer
  // field), so repeated Reviews read as one transcript; this system prompt carries
  // the role, the current state of the world under review, and the same shared
  // global/project instructions (including resolved wiki context) as the Do agent.
  promptTemplate: `{{toolsPreamble}}

You are the CONFIRM (review) agent for task "{{title}}". The Do agent believes the work is finished and it has reached the Review gate. Your job is to decide whether to accept it — NOT to keep building it. Each time the task reaches Review you receive a message with the task and the agent's latest response; judge the CURRENT state of the work.

# Work under review
Worktree: {{worldPath}} (branch {{branch}} off {{base}}).
{{worldRepos}}
Review summary: {{reviewInfo}}
Changed files:
{{changedFiles}}

Recent Do-agent transcript:
{{transcript}}

{{instructions}}

## How to review
Inspect the diff and the worktree (read files, run the build/tests) to judge whether the work actually satisfies the task. Then finish by calling confirm_decision exactly once:
- action:"confirm" — the work is acceptable; it proceeds to PR/merge.
- action:"revise"  — it needs changes; put specific, actionable feedback in \`text\` and it goes back to the Do agent.
- action:"reject"  — it is unsalvageable or the task should not proceed; say why in \`text\` (this cancels the task).

Do not implement the task yourself. Decide, then call confirm_decision.`,
};

// Lifecycle stages per bundled workflow (the pipeline the UI renders).
const SOFTWARE_DEV_STAGES: StageDef[] = [
  { key: 'setup', label: 'Setup' },
  { key: 'do', label: 'Do', ...(RESOLVE_AGENT_ENABLED ? { aliases: ['resolve'] } : {}) },
  { key: 'review', label: 'Review' },
  { key: 'pr', label: 'PR' },
  { key: 'merge', label: 'Merge', ponr: true }, // 'escalated' is a blocked state, not a position — the UI flags it separately
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
  /** False for replay/backward-compatible workflows that remain runnable by
   * existing tasks and API callers but are hidden from new-task UI surfaces. */
  selectable?: boolean;
}

export const MANIFESTS: WorkflowManifest[] = [
  {
    name: 'software-dev',
    version: '1.11.0',
    description: 'Branch/world → do → review → PR → merge → end, with auto-resolution, escalation, and sub-tasks.',
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
    roles: [DO_ROLE, MERGE_ROLE, ...(RESOLVE_AGENT_ENABLED ? [LEGACY_RESOLVE_ROLE] : []), CONFIRM_ROLE],
    stages: SOFTWARE_DEV_STAGES,
    params: [
      promptField(),
      // `always`: the Do/Merge agents' model + effort can be retuned
      // in-flight up to the point of no return (SPEC §5.5); software-dev's update
      // validator still gates the IDENTITY swap (provider/session) per role.
      agentField('do', 'Do agent', 'always'),
      baseField(),
      targetField(),
      agentEnvironmentField(),
      reposField(),
      multiPrField(),
      copyGlobsField(),
      remoteField(),
      gitProfileField(),
      agentField('merge', 'Merge agent', 'always'),
      ...(RESOLVE_AGENT_ENABLED ? [agentField('resolve', 'Resolve agent', 'always')] : []),
      confirmerField(),
    ],
    onActivate: {
      spawnTask: {
        workflow: 'goal',
        title: 'Make this project krmax-ready',
        prompt:
          'Ensure git is initialized in each repo. For brownfield repos, scan for hardcoded resources (e.g. ports) that would collide between worktrees and fix them. Report what you changed.',
      },
    },
  },
  {
    name: 'just-do',
    version: '1.4.0',
    description: 'Legacy single-agent workflow retained for existing tasks and API compatibility.',
    selectable: false,
    requires: [],
    capabilities: ['create-review-info', 'signal-completion', 'save-skill'],
    events: [{ type: 'just-do.done', description: 'Single agent call finished.', fields: {} }],
    ui: [{ slot: 'task-detail', tier: 1, title: 'Task' }],
    commands: [],
    roles: [DO_ROLE, CONFIRM_ROLE],
    // No merge machinery: do → review → done.
    stages: [
      { key: 'setup', label: 'Setup' },
      { key: 'do', label: 'Do' },
      { key: 'review', label: 'Review' },
      { key: 'done', label: 'End' },
    ],
    params: [promptField(), agentField('do', 'Do agent'), baseField(), agentEnvironmentField(), reposField(), confirmerField()],
  },
  {
    name: 'script-exec',
    version: '1.0.0',
    description: 'Legacy command workflow retained for existing tasks and API compatibility.',
    selectable: false,
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
      agentEnvironmentField(),
      reposField(),
    ],
  },
  {
    name: 'goal',
    version: '1.11.0',
    description: 'Software Dev in autonomous completion mode; keeps taking turns until explicit completion and is switchable in-flight before confirmation.',
    requires: ['merge-queue'],
    capabilities: ['create-sub-task', 'create-review-info', 'signal-completion', 'save-skill', 'merge-into:*'],
    events: [{ type: 'goal.completed', description: 'Goal reached.', fields: {} }],
    ui: [{ slot: 'task-detail', tier: 1, title: 'Task' }],
    commands: [],
    // goal delegates to softwareDev, so it shares the Do/Merge/Review machinery.
    roles: [DO_ROLE, MERGE_ROLE, ...(RESOLVE_AGENT_ENABLED ? [LEGACY_RESOLVE_ROLE] : []), CONFIRM_ROLE],
    stages: SOFTWARE_DEV_STAGES,
    params: [promptField(), agentField('do', 'Do agent'), baseField(), targetField(), agentEnvironmentField(), reposField(), copyGlobsField(), remoteField(), gitProfileField(), confirmerField()],
  },
  {
    name: 'merge-only',
    version: '1.6.0',
    description: 'The review-and-merge half of software-dev (no Do). The dogfooded PR gate.',
    requires: ['merge-queue'],
    capabilities: ['create-review-info', 'signal-completion', 'merge-into:*'],
    events: [{ type: 'merge-only.merged', description: 'Reviewed branch merged.', fields: { sha: 'string' } }],
    ui: [{ slot: 'task-detail', tier: 1, title: 'Task' }],
    commands: [],
    roles: [MERGE_ROLE, CONFIRM_ROLE],
    // Review an existing branch, then merge it (no Do).
    stages: [
      { key: 'setup', label: 'Setup' },
      { key: 'review', label: 'Review' },
      { key: 'merge', label: 'Merge', ponr: true }, // 'escalated' is a blocked state, not a position — the UI flags it separately
      { key: 'done', label: 'End' },
    ],
    params: [
      { name: 'branch', type: 'branch', label: 'Branch to merge', required: true, scopes: ['task'], bind: 'top' },
      targetField(),
      agentEnvironmentField(),
      reposField(),
      agentField('merge', 'Merge agent'),
      confirmerField(),
    ],
  },
  {
    name: 'merge-queue',
    version: '1.0.0',
    description: 'Leases the single merge slot per target branch (coordinator).',
    requires: [],
    capabilities: [],
    events: [],
    ui: [{ slot: 'queue-panel', tier: 2, component: 'merge-queue', title: 'Merge queue' }],
    commands: [],
    params: [],
    kind: 'coordinator',
  },
  {
    name: 'agent-queue',
    version: '1.0.0',
    description: 'Orders and leases host capacity for concurrent agent turns (coordinator).',
    requires: [],
    capabilities: [],
    events: [],
    ui: [{ slot: 'queue-panel', tier: 2, component: 'agent-queue', title: 'Agent queue' }],
    commands: [],
    params: [
      {
        name: 'capacity',
        type: 'number',
        label: 'Concurrent agent turns',
        help: 'Maximum model subprocesses running at once across all projects. This is distinct from general Temporal activity concurrency and per-login concurrency.',
        default: 3,
        required: true,
        scopes: ['global'],
        bind: 'top',
      },
    ],
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

/** Bundled historical manifests whose workflow implementations must remain
 * resolvable for existing version-pinned tasks. They are intentionally omitted
 * from MANIFESTS so workflow pickers expose only the current release. */
export const LEGACY_BUNDLED_MANIFESTS: WorkflowManifest[] = MANIFESTS
  .filter((m) => ['software-dev', 'just-do', 'goal', 'merge-only'].includes(m.name))
  // Bundled workflows release as `1.<n>.0`, and every earlier minor is still
  // replayed by executions pinned to it — so the historical set is simply every
  // minor below the current one, and a version bump needs no edit here.
  .flatMap((m) => Array.from({ length: Number(m.version.split('.')[1]) },
    (_, minor) => ({ ...m, version: `1.${minor}.0` })));

export function manifest(name: string): WorkflowManifest | undefined {
  return MANIFESTS.find((m) => m.name === name);
}

/** The pull-request payload every GitHub webhook event carries (see
 *  `pullRequestWebhookEvent`), so each `github.pr.*` entry declares one shape. */
const GITHUB_PR_FIELDS = {
  number: 'number', url: 'string', repo: 'owner/name on GitHub', branch: 'the task branch the PR heads',
  target: 'the branch the PR merges into', state: 'open | closed', merged: 'boolean', title: 'string',
} as const;
/** …plus the delivery's action, on the events minted from `pull_request` itself. */
const GITHUB_PR_ACTION_FIELDS = {
  ...GITHUB_PR_FIELDS, action: "GitHub's action for the delivery (opened, synchronize, merged, …)",
} as const;

/**
 * Core platform events (not owned by any one workflow) that a task can trigger
 * on, with the payload keys a filter can match. These are the generally-useful,
 * stable events emitted by the activity layer (src/activities/core.ts) and the
 * GitHub feed — a curated subset, not every internal event, so the event-trigger
 * picker offers meaningful choices rather than raw noise.
 */
export const PLATFORM_EVENTS: EventSchemaDecl[] = [
  { type: 'view.updated', description: "A task changed stage/status (the task lifecycle feed).", fields: { stage: 'string', status: 'active | waiting | done | failed | cancelled', waitingFor: 'account | agentSlot | mergeSlot | human | other | null', waitingDetail: 'string | null', waitingProvider: 'string | null', waitingResetAt: 'number | null', agentTurn: 'waiting-slot | running | null' } },
  { type: 'pr.opened', description: 'karmax opened a pull request for a task (remote policy "pr").', fields: { repo: 'world repo name', slug: 'owner/name on GitHub', number: 'number', url: 'string', base: 'the branch the PR merges into', state: 'open | closed' } },
  // The GitHub side of the same pull request, fed back by the App's webhook —
  // what happened *on GitHub*, as opposed to what karmax did (SPEC §5.4).
  { type: 'github.pr.opened', description: "A task's pull request was opened on GitHub.", fields: GITHUB_PR_ACTION_FIELDS },
  { type: 'github.pr.merged', description: "A task's pull request was merged on GitHub.", fields: GITHUB_PR_ACTION_FIELDS },
  { type: 'github.pr.closed', description: "A task's pull request was closed without merging.", fields: GITHUB_PR_ACTION_FIELDS },
  { type: 'github.pr.synchronize', description: "New commits were pushed to a task's pull request.", fields: GITHUB_PR_ACTION_FIELDS },
  { type: 'github.pr.review', description: "A review was submitted on a task's pull request.", fields: { ...GITHUB_PR_FIELDS, review: 'approved | changes_requested | commented | dismissed', reviewer: 'GitHub login' } },
  { type: 'merge.result', description: "A task's work was merged (or the merge finished).", fields: { ok: 'boolean', sha: 'string' } },
  { type: 'work.committed', description: 'An agent committed work in its world.', fields: { sha: 'string' } },
  { type: 'world.created', description: "A task's local or cloud world was provisioned.", fields: {} },
  { type: 'world.parked', description: "A waiting task's metered world compute was paused while durable state was retained.", fields: {} },
  { type: 'world.destroyed', description: "A task's world was torn down.", fields: {} },
  { type: 'spend.requested', description: 'An agent requested spend above the auto-approve threshold.', fields: { status: 'string', reason: 'string' } },
];

/** The full event catalog: every workflow's declared events + the platform events,
 *  tagged with their source, deduped by type (first wins). Drives the event-trigger
 *  picker + payload-filter builder (SPEC §5). */
export function eventCatalog(manifests: WorkflowManifest[] = MANIFESTS): (EventSchemaDecl & { source: string })[] {
  const out: (EventSchemaDecl & { source: string })[] = [];
  const seen = new Set<string>();
  for (const m of manifests) for (const e of m.events) if (!seen.has(e.type)) { seen.add(e.type); out.push({ ...e, source: m.name }); }
  for (const e of PLATFORM_EVENTS) if (!seen.has(e.type)) { seen.add(e.type); out.push({ ...e, source: 'platform' }); }
  return out;
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

/** Prompt lookup for workflow execution. The disabled Resolve prompt remains
 * available only so historical version-pinned executions can replay. */
export function agentRoleDef(name: string, manifests: WorkflowManifest[] = MANIFESTS): RoleWithSource | undefined {
  return roleDef(name, manifests) ?? (name === 'resolve' ? { ...LEGACY_RESOLVE_ROLE, workflows: [] } : undefined);
}

/**
 * The capability ceiling a turn is minted against (SPEC §8.2) — always resolved
 * from the declaring workflow, never from a copy stored on the agent profile.
 *
 * The ceiling is the ROLE contract ("what could a Merge agent ever need"), which
 * is orthogonal to the task's authorization grant ("what this task's creator may
 * delegate"); effective caps are the intersection of the two. Because it is the
 * workflow's to declare, it is not a user setting: a persisted copy only ever
 * went stale — profiles seed once, so a role that gained a capability kept the
 * old ceiling forever and the new tool silently 403'd.
 *
 * Every role also gets the self-only human escalation safety valve. An
 * undeclared role is otherwise floored at `signal-completion`.
 */
export function roleCeiling(name: string, manifests: WorkflowManifest[] = MANIFESTS): string[] {
  return [...new Set([...(agentRoleDef(name, manifests)?.capabilities ?? ['signal-completion']), 'task:escalate'])];
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
