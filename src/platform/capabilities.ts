import { BRAND } from '../domain/brand.js';
/**
 * The capability model + attenuation (SPEC §8.1, §8.2). A flat set of named
 * capabilities granted to principals. Agent tokens preserve the selected task
 * authorization, attenuated to the granting principal's authority and scope.
 * Workflow duty does not introduce a second permission tier.
 *
 * Capabilities support `:`-segmented scoping and `*` wildcards, e.g.
 *   merge-into:/repo:main   merge-into:*   use-credential:openai   *
 */
export type Capability = string;

/**
 * Stable capability catalogue.  Capabilities are intentionally about platform
 * operations rather than UI pages: the gateway and MCP bind to the same names.
 * A scoped token may carry a wildcard pattern, but profiles below use the
 * smallest useful groups so an operator can understand what is being granted.
 */
export const CAPABILITIES = [
  'task:read', 'task:create', 'task:edit', 'task:signal', 'task:escalate', 'task:delete',
  'task:conversation:read', 'task:conversation:share', 'task:conversation:fork', 'task:conversation:message',
  'task:event:read', 'task:git:publish', 'task:git:import', 'task:review:write', 'task:review:execute', 'review:approve',
  'task:assign', 'task:subscribe', 'task:manage-own',
  'project:read', 'project:create', 'project:edit', 'project:delete',
  'project:settings:read', 'project:settings:write', 'project:secret:use',
  'project:transfer-out', 'project:transfer-in',
  'project:resource:shared-write',
  'organization:read', 'organization:create', 'organization:edit', 'organization:delete', 'organization:wiki:write',
  'organization:member:read', 'organization:member:write',
  'team:read', 'team:write', 'repository:read', 'repository:write',
  'github:actions:read', 'github:actions:write',
  'inbox:read', 'inbox:write',
  'queue:read', 'queue:write', 'workflow:read', 'workflow:install', 'workflow:edit',
  'profile:read', 'profile:write', 'skill:write',
  'diagnostic:read', 'process:read', 'process:kill',
  'credential:read', 'credential:write', 'credential:reveal', 'connection:use', 'vault:store', 'payment:read', 'payment:write', 'use-card:*',
  'settings:read', 'settings:write', 'subscription:gift',
  'authorization:read', 'authorization:write', 'user:read', 'user:write',
  // Workflow decisions are discoverable capabilities too. Authorization selects
  // them; workflow state determines when the corresponding action is valid.
  'resolve-decision', 'confirm-decision', 'merge-into:*',
] as const;

export type KnownCapability = (typeof CAPABILITIES)[number];

/** The refusal the gateway and the API both give without `organization:wiki:write`. */
export const ORGANIZATION_WIKI_WRITE_DENIED =
  'Editing the organization wiki needs Project maintainer or higher, granted for the whole organization (organization:wiki:write).';

/** Ordinary developer operations shared by every role that works in a task
 * world. Workflow-internal decisions are added by concrete role declarations. */
export const DEVELOPER_WORKSPACE_CAPABILITIES: Capability[] = [
  'project:read', 'project:settings:read', 'project:secret:use',
  'task:read', 'task:create', 'task:conversation:read', 'task:conversation:fork',
  'task:event:read', 'task:git:import', 'task:escalate', 'task:manage-own',
  'diagnostic:read', 'process:read',
  'queue:read', 'workflow:read', 'profile:read',
  'organization:read', 'organization:member:read', 'team:read', 'repository:read',
  'github:actions:read',
  'credential:read', 'connection:use', 'vault:store', 'skill:write', 'use-card:*', 'inbox:*',
];

/** Operations covered by own-task management. Reads and creating independent
 * work remain ordinary capabilities; project-wide metadata never qualifies. */
export const OWN_TASK_CAPABILITIES = new Set<Capability>([
  'task:edit', 'task:signal', 'task:delete', 'task:assign', 'task:subscribe',
  'task:conversation:share', 'task:conversation:message', 'task:git:publish',
  'task:review:write', 'task:review:execute',
]);

/** What a child task may inherit from its parent's grant (SPEC §8.2): the whole
 * catalogue and its parameterised families except merge authority, which a
 * child receives only for its parent's own branch. Attenuating this ceiling by
 * the parent's grant copies that grant, expanding any wildcard into explicit
 * capabilities so `*` can never smuggle `merge-into:*` through. Legacy
 * spellings keep grants that predate namespaced capabilities delegable. */
export const CHILD_TASK_CEILING: Capability[] = [
  ...CAPABILITIES.filter((cap) => !cap.startsWith('merge-into:')),
  'use-credential:*',
  'create-sub-task', 'create-review-info', 'signal-completion', 'save-skill',
];

export interface CapabilityDefinition {
  id: KnownCapability;
  label: string;
  description: string;
}

export interface CapabilityGroup {
  id: string;
  label: string;
  description: string;
  capabilities: CapabilityDefinition[];
}

/**
 * Human-facing, complete capability catalogue. This is deliberately next to
 * the enforcement constants: the settings checklist, validation, and agents'
 * discovery response therefore cannot drift into three different lists.
 */
export const CAPABILITY_GROUPS: CapabilityGroup[] = [
  {
    id: 'tasks', label: 'Tasks', description: 'Discover, create, change, run, and remove work.',
    capabilities: [
      ['task:read', 'View tasks', 'Read task metadata, state, and results.'],
      ['task:create', 'Create tasks', 'Create tasks and choose their workflow authorization profile.'],
      ['task:manage-own', 'Manage own tasks', 'Change your own tasks, tasks you created, and their descendants.'],
      ['task:edit', 'Edit tasks', 'Change task fields, drafts, tags, views, and task-scoped settings.'],
      ['task:signal', 'Act on tasks', 'Send follow-ups, confirmations, cancellations, and other workflow signals.'],
      ['task:escalate', 'Request human input', 'Pause the calling agent’s task and route a decision to selected people or teams.'],
      ['task:delete', 'Delete tasks', 'Permanently remove task records where the workflow permits it.'],
      ['task:event:read', 'Read task events', 'Read the task activity and diagnostic event stream.'],
      ['task:git:publish', 'Publish task branches', 'Publish the calling task’s committed branch through the trusted Git broker.'],
      ['task:git:import', 'Import Git branches', 'Fetch upstream or another task’s published branch into the calling task world.'],
      ['task:assign', 'Assign responsibility', 'Assign accountable people or agents and configure explicit review routing.'],
      ['task:subscribe', 'Manage subscriptions', 'Subscribe or unsubscribe principals from routine task updates.'],
    ].map((entry) => definition(entry as [KnownCapability, string, string])),
  },
  {
    id: 'organizations', label: 'Organizations and repositories', description: 'Tenant membership, teams, connected source repositories, and personal inbox.',
    capabilities: [
      ['organization:read', 'View organizations', 'Discover organizations in which the principal is a member.'],
      ['organization:create', 'Create organizations', 'Create a new tenant boundary.'],
      ['organization:edit', 'Edit organizations', 'Change organization settings.'],
      ['organization:delete', 'Delete organizations', 'Permanently delete an organization and everything in it. Takes effect only through an organization-wide grant.'],
      ['organization:wiki:write', 'Edit organization wiki', 'Create, change, and delete organization wiki pages, which every task in the organization sees. Takes effect only through an organization-wide grant.'],
      ['organization:member:read', 'View members', 'View organization membership, invitations, and teams.'],
      ['organization:member:write', 'Manage members', 'Invite, remove, and change organization members.'],
      ['team:read', 'View teams', 'View organization and project teams.'],
      ['team:write', 'Manage teams', 'Create teams and change their membership.'],
      ['repository:read', 'View repositories', 'View repositories imported into an organization.'],
      ['repository:write', 'Manage repositories', 'Connect GitHub installations and attach repositories to projects.'],
      ['github:actions:read', 'Inspect GitHub Actions', 'List workflow runs and read bounded failure diagnostics for repositories attached to the calling task’s project.'],
      ['github:actions:write', 'Operate GitHub Actions', 'Rerun or cancel workflow runs and dispatch workflows for repositories attached to the calling task’s project.'],
      ['inbox:read', 'View inbox', 'Read the signed-in user’s organization inbox.'],
      ['inbox:write', 'Manage inbox', 'Mark inbox items and set delivery preferences.'],
    ].map((entry) => definition(entry as [KnownCapability, string, string])),
  },
  {
    id: 'collaboration', label: 'Conversations and review', description: 'Inspect and coordinate agents, and operate review actions.',
    capabilities: [
      ['task:conversation:read', 'Read agent conversations', 'Discover attached agents and read their conversation history.'],
      ['task:conversation:share', 'Share conversations publicly', 'Create and revoke public conversation snapshots when organization and project policy allows.'],
      ['task:conversation:fork', 'Fork agent conversations', 'Create a new task from an existing agent conversation.'],
      ['task:conversation:message', 'Message forked agents', 'Continue a forked conversation with additional messages.'],
      ['task:review:write', 'Write review information', 'Publish structured review summaries and evidence.'],
      ['review:approve', 'Approve Review gates and route reviews', 'Confirm a task at its Review gate and change who reviews or answers it — the decisions a human reviewer makes. Held by maintainers and above; not by the default developer profile.'],
      ['task:review:execute', 'Execute review actions', 'Run and stop workflow-declared review actions.'],
    ].map((entry) => definition(entry as [KnownCapability, string, string])),
  },
  {
    id: 'projects', label: 'Projects', description: 'See projects and administer their configuration.',
    capabilities: [
      ['project:read', 'View projects', 'Discover projects and their non-sensitive metadata.'],
      ['project:create', 'Create projects', 'Create new project boundaries.'],
      ['project:edit', 'Edit projects', 'Change project identity and configuration.'],
      ['project:delete', 'Delete projects', 'Permanently remove projects and their task metadata.'],
      ['project:transfer-out', 'Move projects out', 'Transfer project data and ownership out of this organization.'],
      ['project:transfer-in', 'Accept project moves', 'Accept project data and ownership into this organization.'],
      ['project:settings:read', 'View project settings', 'Read effective project and workflow settings.'],
      ['project:settings:write', 'Edit project settings', 'Change project defaults and workflow settings.'],
      ['project:secret:use', 'Use project secrets locally', 'Read project secret values on your own machine (tavya run, tavya env); every read is audited.'],
      ['project:resource:shared-write', 'Propose shared writes', 'Allow an agent to propose a writable shared service or database connection for explicit Review.'],
    ].map((entry) => definition(entry as [KnownCapability, string, string])),
  },
  {
    id: 'automation', label: 'Automation', description: 'Queues, workflows, agent profiles, and reusable skills.',
    capabilities: [
      ['queue:read', 'View queues', 'Inspect merge and resource queues.'],
      ['queue:write', 'Manage queues', 'Reorder or otherwise operate queues.'],
      ['workflow:read', 'View workflows', 'Discover workflow packages, schemas, and platform operations.'],
      ['workflow:install', 'Install workflows', 'Self-hosted only: install trusted workflow code into the platform worker.'],
      ['workflow:edit', 'Propose workflow changes', 'Manage version pins; on self-hosted servers, propose external workflow code changes.'],
      ['profile:read', 'View agent profiles', 'Read provider, model, account, and role-profile configuration.'],
      ['profile:write', 'Edit agent profiles', 'Change agent runtime profiles; task authorization controls permissions.'],
      ['skill:write', 'Save skills', 'Persist reusable agent knowledge and resolution skills.'],
    ].map((entry) => definition(entry as [KnownCapability, string, string])),
  },
  {
    id: 'resources', label: 'Host and resources', description: 'Sensitive operational access to the host, credentials, and spending.',
    capabilities: [
      ['diagnostic:read', 'View diagnostics', 'Read host health and agent admission diagnostics.'],
      ['process:read', 'View processes', `Inspect processes managed by ${BRAND}.`],
      ['process:kill', 'Stop processes', `Terminate processes managed by ${BRAND}.`],
      ['credential:read', 'View credential metadata', 'Discover credential handles, vault items, and non-secret policy.'],
      ['connection:use', 'Use connected apps', 'Execute app tools using accounts explicitly shared with the task or project.'],
      ['credential:write', 'Manage credentials', 'Create, rename, replace, and delete credentials and vault items, tighten their policies, and deny credential requests.'],
      ['credential:reveal', 'Read the vault', 'Read any secret regardless of its policy: reveal it, loosen policies, change where it can be filled, approve credential requests, and connect password stores it is copied to. Takes effect only through an organization-wide grant.'],
      ['vault:store', 'Store new credentials', 'Write newly created credentials (accounts an agent registered) back into the vault as items.'],
      ['payment:read', 'View payments', 'Inspect payment methods, limits, and transactions.'],
      ['payment:write', 'Manage payments', 'Add payment cards, set budgets and limits, manage billing, and approve spending.'],
      ['use-card:*', 'Use payment cards', 'Allow tasks to request spending. Narrow this wildcard to use-card:<card-id> in advanced target-scoped capabilities.'],
    ].map((entry) => definition(entry as [KnownCapability, string, string])),
  },
  {
    id: 'administration', label: 'Administration', description: 'Global configuration, accounts, and authorization policy.',
    capabilities: [
      ['settings:read', 'View global settings', 'Read global workflow and platform defaults.'],
      ['settings:write', 'Edit global settings', 'Change global workflow and platform defaults.'],
      ['subscription:gift', 'Gift subscriptions', 'Grant or remove complimentary organization plans.'],
      ['authorization:read', 'View authorization', 'Read profiles, grants, defaults, and the audit log.'],
      ['authorization:write', 'Manage authorization', 'Change profiles, grants, and authorization defaults.'],
      ['user:read', 'View user accounts', 'List human accounts and their access grants.'],
      ['user:write', 'Manage user accounts', 'Create and remove user accounts. Own-account self-service uses verified identity for humans and delegated agents.'],
    ].map((entry) => definition(entry as [KnownCapability, string, string])),
  },
  {
    id: 'workflow-internal', label: 'Workflow role actions', description: 'Powerful actions normally narrowed again by a workflow role.',
    capabilities: [
      ['resolve-decision', 'Resolve workflow failures', 'Return structured recovery decisions from a Resolve role.'],
      ['confirm-decision', 'Make agent confirmation decisions', 'Return confirm, revise, or reject from a Confirm role.'],
      ['merge-into:*', 'Merge into protected targets', 'Permit a Merge role to merge into a target allowed by the task grant.'],
    ].map((entry) => definition(entry as [KnownCapability, string, string])),
  },
];

function definition([id, label, description]: readonly [KnownCapability, string, string]): CapabilityDefinition {
  return { id, label, description };
}

/** Does `pattern` (possibly with trailing `*` segment or bare `*`) cover `cap`? */
export function capMatches(pattern: Capability, cap: Capability): boolean {
  // Before workflow installation was split from editing, the single legacy
  // permission covered both. Preserve that meaning for stored tokens/profiles.
  if (pattern === 'edit-workflow' && (cap === 'workflow:edit' || cap === 'workflow:install')) return true;
  // Workflow discovery was likewise exposed under the old read-task umbrella.
  if (pattern === 'read-task' && cap === 'workflow:read') return true;
  pattern = normalizeCapability(pattern);
  cap = normalizeCapability(cap);
  if (pattern === '*') return true;
  if (pattern === cap) return true;
  // Vault read access is newer than `credential:*`, which Administrators,
  // their tasks and customized profiles have long held. Only an explicit grant
  // (or `*`) confers it, so no stored authorization gains it silently.
  if (cap === 'credential:reveal') return false;
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -1); // keep trailing ':'
    return cap.startsWith(prefix);
  }
  // segment-wise wildcard, e.g. merge-into:*:main
  const pSeg = pattern.split(':');
  const cSeg = cap.split(':');
  if (pSeg.length !== cSeg.length) return false;
  return pSeg.every((s, i) => s === '*' || s === cSeg[i]);
}

/** Does the capability set allow `requested`? */
export function allows(set: Capability[], requested: Capability): boolean {
  return set.some((p) => capMatches(p, requested));
}

/**
 * Effective capabilities = intersection(ceiling, grantor). A concrete cap on
 * either side is kept only if the other side also allows it (so wildcards
 * narrow to the concrete grants they cover).
 */
export function attenuate(ceiling: Capability[], grantor: Capability[]): Capability[] {
  const out = new Set<Capability>();
  for (const c of grantor) if (allows(ceiling, c)) out.add(c);
  for (const c of ceiling) if (allows(grantor, c)) out.add(c);
  return [...out];
}

/** Check a requested capability against both ceiling and grantor. */
export function effectiveAllows(ceiling: Capability[], grantor: Capability[], requested: Capability): boolean {
  return allows(ceiling, requested) && allows(grantor, requested);
}

/** The capabilities a tool requires to be invoked (used by the platform MCP). */
export const TOOL_CAPABILITY: Record<string, Capability> = {
  create_task: 'task:create', edit_task: 'task:edit', delete_task: 'task:delete',
  create_sub_task: 'task:create', respond_to_sub_task: 'task:signal', wait_for_subtasks: 'task:read',
  raise_to_parent: 'task:signal', create_review_info: 'task:review:write', signal_completion: 'task:signal',
  escalate_to_human: 'task:escalate', request_permission: 'task:escalate',
  save_skill: 'skill:write', signal_task: 'task:signal', reorder_queue: 'queue:write',
  get_task: 'task:read', find_task: 'task:read', list_tasks: 'task:read', search_tasks: 'task:read',
  list_tags: 'task:read', list_views: 'task:read', search_fields: 'task:read',
  manage_tag: 'task:edit', set_task_tags: 'task:edit', set_task_priority: 'task:edit', manage_view: 'task:edit',
  list_workflows: 'workflow:read', edit_workflow: 'workflow:edit', install_workflow: 'workflow:install',
  list_projects: 'project:read', create_project: 'project:create', edit_project: 'project:edit', delete_project: 'project:delete',
  get_settings: 'settings:read', set_settings: 'settings:write',
  list_agents: 'task:conversation:read', get_conversation: 'task:conversation:read',
  fork_agent: 'task:conversation:fork', message_agent: 'task:conversation:message', notify: 'task:conversation:message', escalate: 'task:escalate',
  request_agent_action: 'task:conversation:message', cancel_agent_action: 'task:conversation:message',
  publish_task_branch: 'task:git:publish', import_task_branch: 'task:git:import', refresh_upstream: 'task:git:import',
  propose_project_resource: 'task:review:write', adopt_project_resource: 'task:review:execute',
  discard_project_resource: 'task:review:execute',
  list_events: 'task:event:read', diagnostics: 'diagnostic:read', list_processes: 'process:read', kill_process: 'process:kill',
  list_github_actions_workflows: 'github:actions:read',
  list_github_actions_runs: 'github:actions:read', inspect_github_actions_run: 'github:actions:read',
  manage_github_actions_run: 'github:actions:write', dispatch_github_actions_workflow: 'github:actions:write',
  execute_review_action: 'task:review:execute', stop_review_action: 'task:review:execute',
  list_credentials: 'credential:read', manage_credentials: 'credential:write',
  get_credential: 'credential:read', fill_credential: 'credential:read',
  list_connections: 'credential:read', request_connection: 'connection:use', search_connection_tools: 'credential:read', execute_connection_tool: 'connection:use',
  request_credential: 'credential:read', store_credential: 'vault:store',
  check_agent_mail: 'credential:read', enroll_passkey: 'credential:read',
  use_passkey: 'credential:read', save_passkey: 'vault:store',
  use_session: 'credential:read', save_session: 'vault:store',
  list_payments: 'payment:read', manage_payments: 'payment:write',
  list_users: 'user:read', manage_users: 'user:write',
  list_authorization: 'authorization:read', manage_authorization: 'authorization:write',
};

/** Legacy names remain accepted for stored profiles/tokens during migration. */
const LEGACY: Record<string, Capability> = {
  'read-task': 'task:read', 'create-task': 'task:create', 'edit-task': 'task:edit',
  'create-sub-task': 'task:create', 'signal-task': 'task:signal', 'signal-completion': 'task:signal',
  'create-review-info': 'task:review:write', 'save-skill': 'skill:write',
  'reorder-queue': 'queue:write', 'edit-workflow': 'workflow:edit',
};

export function normalizeCapability(cap: Capability): Capability {
  return LEGACY[cap] ?? cap;
}
