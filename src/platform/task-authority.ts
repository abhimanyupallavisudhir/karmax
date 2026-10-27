import type { AgentSpec, TaskRecord } from '../domain/types.js';
import type { Store } from '../store/db.js';
import { VaultItems } from '../autonomy/vault-items.js';
import { allows, attenuate, CHILD_TASK_CEILING, type Capability } from './capabilities.js';
import { PermissionRequests } from './permission-requests.js';
import { authorizingAvatar, avatarAllows, avatarAuthorizationCapabilities, avatarForRole, avatarRoleFor } from './avatars.js';
import type { AuthorizationService } from './authorization.js';
import type { TokenAuthority } from './tokens.js';
import { delegatedFromParent } from './delegation.js';

/** What a task may do and where (SPEC §8.2): its capabilities and the scope
 * its tokens are minted for. No scope ⇒ the task's own project. */
export interface TaskAuthority {
  capabilities: Capability[];
  scope?: 'projects' | 'organization' | 'global';
  projectIds?: string[];
  organizationId?: string;
}

type StoredAuthorization = Partial<TaskAuthority> & { principal?: string };

const scopeOf = (from: Partial<TaskAuthority> | undefined) => ({
  ...(from?.scope ? { scope: from.scope } : {}),
  ...(from?.projectIds ? { projectIds: from.projectIds } : {}),
  ...(from?.organizationId ? { organizationId: from.organizationId } : {}),
});

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
  const own = { capabilities: stored?.capabilities ?? options.grant ?? [], ...scopeOf(stored) };
  if (!delegatedFromParent(task) || seen.has(task.parentTaskId)) return own;
  const parentTask = await store.getTask(task.parentTaskId);
  if (!parentTask) return own;
  const parent = await taskAuthorityNow(store, authorization, parentTask, { seen: new Set([...seen, task.id]) });
  const mergeBack = own.capabilities.filter((cap) => cap.startsWith('merge-into:') && allows(parent.capabilities, cap));
  return { capabilities: [...new Set([...attenuate(CHILD_TASK_CEILING, parent.capabilities), ...mergeBack])], ...scopeOf(parent) };
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
