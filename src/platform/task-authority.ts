import type { AgentSpec, AuthorizationSelection, TaskRecord } from '../domain/types.js';
import type { Store } from '../store/db.js';
import { VaultItems } from '../autonomy/vault-items.js';
import { allows, attenuate, CHILD_TASK_CEILING, withoutCapabilities, type Capability } from './capabilities.js';
import { PermissionRequests } from './permission-requests.js';
import { authorizingAvatar, avatarAllows, avatarAuthorizationCapabilities, avatarForRole, avatarRoleFor } from './avatars.js';
import type { AuthorizationService } from './authorization.js';
import type { TokenAuthority } from './tokens.js';
import { DELEGATED_PROFILE, delegatedFromParent, delegatingAncestors } from './delegation.js';
import type { VaultTaskPolicyOverrides } from '../autonomy/vault-items.js';

/** What a task may do and where (SPEC §8.2): its capabilities and the scope
 * its tokens are minted for. No scope ⇒ the task's own project. */
export interface TaskAuthority {
  capabilities: Capability[];
  scope?: 'projects' | 'organization' | 'global';
  projectIds?: string[];
  organizationId?: string;
}

type StoredAuthorization = Partial<TaskAuthority> & { principal?: string; level?: string; heldBack?: Capability[];
  /** A sub-task's projects approved beyond its parent's scope (`request_permission`). */
  addedProjectIds?: string[] };

const scopeOf = (from: Partial<TaskAuthority> | undefined) => ({
  ...(from?.scope ? { scope: from.scope } : {}),
  ...(from?.projectIds ? { projectIds: from.projectIds } : {}),
  ...(from?.organizationId ? { organizationId: from.organizationId } : {}),
});

/**
 * A person's stored grant as it holds now: no more than they could grant the
 * same selection today. Delegations no longer expire (domain/delegation-expiry.ts),
 * so this is what bounds them: removing someone from a project or organization,
 * or lowering their role, narrows every task they authorized at its next turn.
 * Anything else (an Avatār's, a legacy grant without a level) is unchanged.
 */
export async function personGrantNow(authorization: AuthorizationService | undefined,
  stored: { capabilities?: Capability[]; principal?: string; level?: string; scope?: AuthorizationSelection['scope']; projectIds?: string[] } | undefined,
  projectId: string, capabilities: Capability[] = stored?.capabilities ?? []): Promise<Capability[]> {
  if (!authorization || !stored?.principal?.startsWith('user:') || !stored.level || !stored.scope) return capabilities;
  const selection: AuthorizationSelection = { level: stored.level, scope: stored.scope,
    ...(stored.projectIds?.length ? { projectIds: stored.projectIds } : {}) };
  const principal = stored.principal;
  // A selection today's rules refuse (an older shape): what they hold in the project.
  const now = await authorization.taskGrant(principal, projectId, selection).then((grant) => grant.capabilities,
    () => authorization.capabilities(principal, projectId).catch(() => []));
  return attenuate(capabilities, now);
}

/**
 * A task's authority before what was approved for it: its stored grant or,
 * for a sub-task, its parent's authority now (delegation.ts) — everything but
 * merging anywhere other than the parent's branch, which only its own grant
 * names. A sub-task whose parent is gone keeps the grant it started with.
 * `grant`: what a task that stores no grant (a legacy one) was started with.
 */
export async function baseTaskAuthority(store: Store, authorization: AuthorizationService | undefined,
  task: TaskRecord, options: { seen?: Set<string>; grant?: Capability[] } = {}): Promise<TaskAuthority> {
  const seen = options.seen ?? new Set<string>();
  const stored = task.params?._authorization as StoredAuthorization | undefined;
  const own = { capabilities: (await personGrantNow(authorization, stored, task.projectId, stored?.capabilities ?? options.grant ?? [])),
    ...scopeOf(stored) };
  if (!delegatedFromParent(task)) return own;
  const added = (scope: TaskAuthority) => withProjects(scope, stored?.addedProjectIds, task.projectId);
  if (seen.has(task.parentTaskId)) return added(own);
  const parentTask = await store.getTask(task.parentTaskId);
  if (!parentTask) return added(own);
  const parent = await taskAuthorityNow(store, authorization, parentTask, { seen: new Set([...seen, task.id]) });
  const mergeBack = own.capabilities.filter((cap) => cap.startsWith('merge-into:') && allows(parent.capabilities, cap));
  // What a sub-task without a computer holds back, its parent's authority does not bring back.
  return added({ capabilities: withoutCapabilities([...new Set([...attenuate(CHILD_TASK_CEILING, parent.capabilities), ...mergeBack])],
    stored?.heldBack ?? []), ...scopeOf(parent) });
}

/** A scope widened by more projects. An organization or global scope already
 * holds them; no scope means the task's own project. */
function withProjects(authority: TaskAuthority, projectIds: string[] | undefined, ownProjectId: string): TaskAuthority {
  if (!projectIds?.length || authority.scope === 'organization' || authority.scope === 'global') return authority;
  const base = authority.scope === 'projects' && authority.projectIds?.length ? authority.projectIds : [ownProjectId];
  return { ...authority, scope: 'projects', projectIds: [...new Set([...base, ...projectIds])] };
}

/**
 * The grants a task's own record carries, in the shape a new task is created
 * with: the stored selection (level/scope/projects — the elevated one if a
 * human approved a mid-task authorization request), its per-task vault
 * credential caps and the policies chosen for them. A legacy record that only
 * carries a `profileId` still maps to a level. A sub-task's record names no
 * level (`inherited-child` is a placeholder), so it has none here:
 * `taskGrants` gives the one it acts with.
 */
export function previousTaskGrants(task: TaskRecord): {
  authorization?: AuthorizationSelection;
  credentialGrants: string[];
  credentialPolicies: VaultTaskPolicyOverrides;
} {
  const stored = task.params?._authorization as {
    level?: string; profileId?: string; scope?: AuthorizationSelection['scope']; projectIds?: string[];
    capabilities?: string[]; credentialPolicies?: VaultTaskPolicyOverrides;
  } | undefined;
  const level = stored?.level ?? stored?.profileId;
  return {
    ...(level && level !== DELEGATED_PROFILE ? { authorization: {
      level,
      scope: stored?.scope ?? 'projects',
      ...(stored?.scope === 'organization' || stored?.scope === 'global' ? {}
        : { projectIds: stored?.projectIds?.length ? stored.projectIds : [task.projectId] }),
    } } : {}),
    credentialGrants: (stored?.capabilities ?? []).filter((capability) => capability.startsWith('use-credential:')),
    credentialPolicies: stored?.credentialPolicies ?? {},
  };
}

/**
 * The selection (level, scope, projects) a task acts with: its own, or for a
 * sub-task the level of the task it is delegated from, across the scope it
 * holds now (its parent's, with the projects approved for it since). None for
 * a sub-task whose delegating tasks are gone.
 */
export async function taskSelection(store: Store, authorization: AuthorizationService | undefined,
  task: TaskRecord): Promise<AuthorizationSelection | undefined> {
  if (!delegatedFromParent(task)) return previousTaskGrants(task).authorization;
  const root = (await delegatingAncestors(store, task.id)).at(-1);
  const level = root && !delegatedFromParent(root) ? previousTaskGrants(root).authorization?.level : undefined;
  if (!level) return undefined;
  const held = await baseTaskAuthority(store, authorization, task);
  return held.scope === 'organization' || held.scope === 'global' ? { level, scope: held.scope }
    : { level, scope: 'projects', projectIds: held.scope === 'projects' && held.projectIds?.length ? held.projectIds : [task.projectId] };
}

/** `previousTaskGrants` with the selection a task acts with (`taskSelection`)
 * and, for a sub-task, the vault credentials it holds through its parent. */
export async function taskGrants(store: Store, authorization: AuthorizationService | undefined,
  task: TaskRecord): Promise<ReturnType<typeof previousTaskGrants>> {
  const own = previousTaskGrants(task);
  if (!delegatedFromParent(task)) return own;
  const selection = await taskSelection(store, authorization, task);
  const held = await baseTaskAuthority(store, authorization, task);
  return { ...own, ...(selection ? { authorization: selection } : {}),
    credentialGrants: held.capabilities.filter((capability) => capability.startsWith('use-credential:')) };
}

/**
 * Everything a task's main agent holds now: its base authority with the
 * permission requests and vault credentials approved for it since, narrowed
 * to the Avatar it runs as or that authorized it (a disabled or deleted one
 * leaves nothing).
 */
export async function taskAuthorityNow(store: Store, authorization: AuthorizationService | undefined,
  task: TaskRecord, options: { seen?: Set<string>; grant?: Capability[] } = {}): Promise<TaskAuthority> {
  const base = await baseTaskAuthority(store, authorization, task,
    { ...options, seen: new Set([...options.seen ?? [], task.id]) });
  const organizationId = (await store.getProject(task.projectId))?.organizationId ?? 'org_personal';
  const authorizer = (task.params?._authorization as StoredAuthorization | undefined)?.principal;
  const runsAs = (await avatarForRole(store, { taskId: task.id, projectId: task.projectId,
    agents: { do: task.params?.['agent:do'] as Partial<AgentSpec> | undefined } }, 'do'));
  const backed = !runsAs && authorizer?.startsWith('avatar:');
  let capabilities = [...new Set([
    ...base.capabilities,
    ...await new PermissionRequests(store, organizationId).extensionCaps(task.id, 'do'),
    // An Avatar's turn uses its own vault authority, never the task's approvals.
    ...(runsAs ? [] : await new VaultItems(store, undefined, undefined, organizationId).extensionCaps(task.id)),
  ])];
  if (runsAs || backed) {
    const avatar = runsAs ?? await authorizingAvatar(store, task, authorizer);
    const allowed = !runsAs || avatarAllows(runsAs, (await avatarRoleFor(store, task.id, 'do')));
    capabilities = attenuate(capabilities, avatar && allowed ? await avatarAuthorizationCapabilities(store, authorization, avatar, task.projectId) : []);
  }
  return { ...base, capabilities };
}

/** Where a task's tokens and human delegation reach, as its authority's scope
 * says (the shape `createTask` delegates and `turnAuthority` mints): selected
 * projects, its organization, everywhere, or else its own project. */
export function tokenScopeOf(authority: Pick<TaskAuthority, 'scope' | 'projectIds' | 'organizationId'>,
  projectId: string, organizationId: string | undefined): { projectId?: string; projectIds?: string[]; organizationId?: string } {
  return {
    ...(authority.scope ? {} : { projectId }),
    ...(authority.scope === 'projects' && authority.projectIds?.length ? { projectIds: authority.projectIds } : {}),
    ...(authority.scope === 'global' ? {} : { organizationId: authority.organizationId ?? organizationId }),
  };
}

type TokenScope = { projectId?: string; projectIds?: string[]; organizationId?: string; delegationId?: string };

/**
 * A sub-task's tokens carry its human delegation, which must reach as far as
 * the token: its parent's scope. One made for a narrower scope (a sub-task
 * created before sub-tasks acted with their parent's authority, or before the
 * parent's scope grew) is derived again from the parent's and kept. If that is
 * impossible the token is minted for the sub-task's own project, as before.
 */
export async function delegationReaching(store: Store, tokens: Pick<TokenAuthority, 'delegationCovers' | 'deriveHumanDelegation'>,
  task: TaskRecord, scope: TokenScope): Promise<TokenScope> {
  if (!scope.delegationId || !task.parentTaskId || await tokens.delegationCovers(scope.delegationId, scope)) return scope;
  const parentDelegation = ((await store.getTask(task.parentTaskId))?.params?._authorization as { delegationId?: string } | undefined)?.delegationId;
  const derived = parentDelegation ? await tokens.deriveHumanDelegation(parentDelegation, { taskId: task.id,
    projectId: scope.projectId, projectIds: scope.projectIds, organizationId: scope.organizationId }).catch(() => undefined) : undefined;
  if (derived) {
    const current = (await store.getTask(task.id))!;
    await store.updateTaskParams(task.id, { ...current.params,
      _authorization: { ...current.params._authorization as object, delegationId: derived.id } });
    return { ...scope, delegationId: derived.id };
  }
  return { ...scope, projectId: task.projectId, projectIds: undefined,
    organizationId: (await store.getProject(task.projectId))?.organizationId };
}
