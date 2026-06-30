import { FieldSpec } from '../domain/types.js';

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
const agentField = (role: string, label: string): FieldSpec => ({ name: `agent:${role}`, type: 'agent', label, scopes: ALL, bind: 'profile', role });
const baseField = (): FieldSpec => ({ name: 'base', type: 'branch', label: 'Base branch', default: 'main', scopes: ALL, bind: 'top' });
const targetField = (): FieldSpec => ({ name: 'target', type: 'branch', label: 'Target (merge-to) branch', default: 'main', scopes: ALL, bind: 'top' });
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

export interface WorkflowManifest {
  name: string;
  version: string;
  description: string;
  requires: string[];
  events: EventSchemaDecl[];
  capabilities: string[];
  ui: UiContribution[];
  commands: CommandDecl[];
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
          { type: 'thread', bind: 'messages', title: 'Conversation' },
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
    params: [
      promptField(),
      agentField('do', 'Do agent'),
      baseField(),
      targetField(),
      reposField(),
      copyGlobsField(),
      worldProviderField(),
      prToggleField(),
      agentField('merge', 'Merge agent'),
      agentField('resolve', 'Resolve agent'),
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
