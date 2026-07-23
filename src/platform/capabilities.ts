/**
 * The capability model + attenuation (SPEC §8.1, §8.2). A flat set of named
 * capabilities granted to principals. An agent's effective capabilities are the
 * intersection of its profile-declared ceiling and the granting principal's
 * capabilities — least privilege, capability attenuation.
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
  'task:read', 'task:create', 'task:edit', 'task:signal', 'task:delete',
  'task:conversation:read', 'task:conversation:fork', 'task:conversation:message',
  'task:event:read', 'task:git:publish', 'task:git:import', 'task:review:write', 'task:review:execute',
  'task:assign', 'task:subscribe',
  'project:read', 'project:create', 'project:edit', 'project:delete',
  'project:settings:read', 'project:settings:write',
  'organization:read', 'organization:create', 'organization:edit',
  'organization:member:read', 'organization:member:write',
  'team:read', 'team:write', 'repository:read', 'repository:write',
  'inbox:read', 'inbox:write',
  'queue:read', 'queue:write', 'workflow:read', 'workflow:install', 'workflow:edit',
  'profile:read', 'profile:write', 'skill:write',
  'diagnostic:read', 'process:read', 'process:kill',
  'credential:read', 'credential:write', 'vault:store', 'payment:read', 'payment:write',
  'settings:read', 'settings:write', 'safe-mode:write',
  'authorization:read', 'authorization:write', 'user:read', 'user:write',
  // Workflow-internal decisions are ordinary capabilities too. They are kept
  // in the public catalogue so a profile can be edited without knowing hidden
  // strings; the concrete role profile still provides the second ceiling.
  'resolve-decision', 'confirm-decision', 'merge-into:*',
] as const;

export type KnownCapability = (typeof CAPABILITIES)[number];

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
      ['task:edit', 'Edit tasks', 'Change task fields, drafts, tags, views, and task-scoped settings.'],
      ['task:signal', 'Act on tasks', 'Send follow-ups, confirmations, cancellations, and other workflow signals.'],
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
      ['organization:edit', 'Edit organizations', 'Change organization settings and lifecycle.'],
      ['organization:member:read', 'View members', 'View organization membership, invitations, and teams.'],
      ['organization:member:write', 'Manage members', 'Invite, remove, and change organization members.'],
      ['team:read', 'View teams', 'View organization and project teams.'],
      ['team:write', 'Manage teams', 'Create teams and change their membership.'],
      ['repository:read', 'View repositories', 'View repositories imported into an organization.'],
      ['repository:write', 'Manage repositories', 'Connect GitHub installations and attach repositories to projects.'],
      ['inbox:read', 'View inbox', 'Read the signed-in user’s organization inbox.'],
      ['inbox:write', 'Manage inbox', 'Mark inbox items and set delivery preferences.'],
    ].map((entry) => definition(entry as [KnownCapability, string, string])),
  },
  {
    id: 'collaboration', label: 'Conversations and review', description: 'Inspect and coordinate agents, and operate review actions.',
    capabilities: [
      ['task:conversation:read', 'Read agent conversations', 'Discover attached agents and read their conversation history.'],
      ['task:conversation:fork', 'Fork agent conversations', 'Create a new task from an existing agent conversation.'],
      ['task:conversation:message', 'Message forked agents', 'Continue a forked conversation with additional messages.'],
      ['task:review:write', 'Write review information', 'Publish structured review summaries and evidence.'],
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
      ['project:settings:read', 'View project settings', 'Read effective project and workflow settings.'],
      ['project:settings:write', 'Edit project settings', 'Change project defaults and workflow settings.'],
    ].map((entry) => definition(entry as [KnownCapability, string, string])),
  },
  {
    id: 'automation', label: 'Automation', description: 'Queues, workflows, agent profiles, and reusable skills.',
    capabilities: [
      ['queue:read', 'View queues', 'Inspect merge and resource queues.'],
      ['queue:write', 'Manage queues', 'Reorder or otherwise operate queues.'],
      ['workflow:read', 'View workflows', 'Discover workflow packages, schemas, and platform operations.'],
      ['workflow:install', 'Install workflows', 'Install and activate reviewed workflow packages.'],
      ['workflow:edit', 'Propose workflow changes', 'Create reviewed changes to workflow repositories and version pins.'],
      ['profile:read', 'View agent profiles', 'Read provider, model, account, and role-profile configuration.'],
      ['profile:write', 'Edit agent profiles', 'Change role profiles and their capability ceilings.'],
      ['skill:write', 'Save skills', 'Persist reusable agent knowledge and resolution skills.'],
    ].map((entry) => definition(entry as [KnownCapability, string, string])),
  },
  {
    id: 'resources', label: 'Host and resources', description: 'Sensitive operational access to the host, credentials, and spending.',
    capabilities: [
      ['diagnostic:read', 'View diagnostics', 'Read host health and agent admission diagnostics.'],
      ['process:read', 'View processes', 'Inspect processes managed by karmax.'],
      ['process:kill', 'Stop processes', 'Terminate processes managed by karmax.'],
      ['credential:read', 'View credential metadata', 'Discover credential handles, vault items, and non-secret policy.'],
      ['credential:write', 'Manage credentials', 'Create, replace, delete, and configure credential handles and vault items, and resolve credential access requests.'],
      ['vault:store', 'Store new credentials', 'Write newly created credentials (accounts an agent registered) back into the vault as items.'],
      ['payment:read', 'View payments', 'Inspect payment methods, limits, and transactions.'],
      ['payment:write', 'Manage payments', 'Create payment resources and authorize spending within policy.'],
    ].map((entry) => definition(entry as [KnownCapability, string, string])),
  },
  {
    id: 'administration', label: 'Administration', description: 'Global configuration, accounts, and authorization policy.',
    capabilities: [
      ['settings:read', 'View global settings', 'Read global workflow and platform defaults.'],
      ['settings:write', 'Edit global settings', 'Change global workflow and platform defaults.'],
      ['safe-mode:write', 'Control safe mode', 'Enable or disable safe mode.'],
      ['authorization:read', 'View authorization', 'Read profiles, grants, defaults, and the audit log.'],
      ['authorization:write', 'Manage authorization', 'Change profiles, grants, and authorization defaults.'],
      ['user:read', 'View user accounts', 'List human accounts and their access grants.'],
      ['user:write', 'Manage user accounts', 'Create and remove human accounts.'],
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
  save_skill: 'skill:write', signal_task: 'task:signal', reorder_queue: 'queue:write',
  get_task: 'task:read', find_task: 'task:read', list_tasks: 'task:read', search_tasks: 'task:read',
  list_tags: 'task:read', list_views: 'task:read', search_fields: 'task:read',
  manage_tag: 'task:edit', set_task_tags: 'task:edit', set_task_priority: 'task:edit', manage_view: 'task:edit',
  list_workflows: 'workflow:read', edit_workflow: 'workflow:edit', install_workflow: 'workflow:install',
  list_projects: 'project:read', create_project: 'project:create', edit_project: 'project:edit', delete_project: 'project:delete',
  get_settings: 'settings:read', set_settings: 'settings:write',
  list_agents: 'task:conversation:read', get_conversation: 'task:conversation:read',
  fork_agent: 'task:conversation:fork', message_agent: 'task:conversation:message',
  publish_task_branch: 'task:git:publish', import_task_branch: 'task:git:import', refresh_upstream: 'task:git:import',
  list_events: 'task:event:read', diagnostics: 'diagnostic:read', list_processes: 'process:read', kill_process: 'process:kill',
  execute_review_action: 'task:review:execute', stop_review_action: 'task:review:execute',
  list_credentials: 'credential:read', manage_credentials: 'credential:write',
  get_credential: 'credential:read', fill_credential: 'credential:read',
  request_credential: 'credential:read', store_credential: 'vault:store',
  check_agent_mail: 'credential:read', enroll_passkey: 'credential:read',
  use_passkey: 'credential:read', save_passkey: 'vault:store',
  list_payments: 'payment:read', manage_payments: 'payment:write',
  set_safe_mode: 'safe-mode:write', list_users: 'user:read', manage_users: 'user:write',
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
