import type { AgentSpec, Avatar, AvatarSetting, TaskRecord } from '../domain/types.js';
import type { Store } from '../store/db.js';
import { attenuate, type Capability } from './capabilities.js';
import type { AuthorizationService } from './authorization.js';
import { ValidationError } from './errors.js';

/**
 * An Avatar is a task marked Avatar (`params.avatar`, wiki features/avatars):
 * its future forks — a task's main agent, a Responder, a Reviewer, an agent
 * called in with @ — act with its authorization without anyone granting it
 * again, as long as whoever made the fork may call it. Nothing else about it
 * differs from a task: its instructions are its conversation (or, never run,
 * its prompt), and editing it edits the task.
 */

export function avatarPrincipal(id: string): string {
  return `avatar:${id}`;
}

/** Who may call an Avatar when its setting names nobody. */
export const DEFAULT_AVATAR_CALLERS = ['@project'];

/** The Avatar setting stored on a task, or undefined for an ordinary task. */
export function avatarSetting(params: Record<string, unknown> | undefined): AvatarSetting | undefined {
  const raw = params?.avatar;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const callableBy = Array.isArray(record.callableBy)
    ? record.callableBy.map(String).map((value) => value.trim()).filter(Boolean) : [];
  return { callableBy: callableBy.length ? [...new Set(callableBy)] : [...DEFAULT_AVATAR_CALLERS],
    ...(record.forksMayBeAvatars === true ? { forksMayBeAvatars: true } : {}) };
}

const CALLER = /^(@project|@all|@owners|@creator|@maintainers|@admins|@superadmins|user:[^\s,]+|@team:[^\s,]+|team:[^\s,]+)$/;

/** A task-form `avatar` value, normalized; `false`/`null` clears it. Throws on
 * an unknown caller selector. */
export function normalizeAvatarSetting(raw: unknown): AvatarSetting | null {
  if (raw === undefined || raw === null || raw === false) return null;
  if (raw === true) return { callableBy: [...DEFAULT_AVATAR_CALLERS] };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('avatar must be { callableBy?, forksMayBeAvatars? }');
  const record = raw as Record<string, unknown>;
  if (record.callableBy !== undefined && !Array.isArray(record.callableBy))
    throw new ValidationError('avatar.callableBy must be a list of audience selectors');
  for (const selector of (record.callableBy as unknown[] | undefined) ?? []) {
    if (typeof selector !== 'string' || !CALLER.test(selector.trim()))
      throw new ValidationError(`avatar.callableBy: ${JSON.stringify(selector)} is not a person, team or group selector`);
  }
  return avatarSetting({ avatar: record })!;
}

/** The Avatar a task is, read off the task itself. */
export async function avatarOfTask(store: Store, task: TaskRecord): Promise<Avatar | undefined> {
  const setting = avatarSetting(task.params);
  if (!setting) return undefined;
  const organizationId = (await store.getProject(task.projectId))?.organizationId ?? 'org_personal';
  const stored = (task.params._authorization ?? {}) as Partial<Avatar['authorization']> & { credentialPolicies?: Avatar['credentialPolicies'] };
  const agent = task.params['agent:do'] as Partial<AgentSpec> | undefined;
  return {
    id: task.id,
    ...(task.num != null ? { num: task.num } : {}),
    organizationId,
    projectId: task.projectId,
    ownerUserId: (await store.taskCreatorUserId(task.id)),
    name: task.title,
    prompt: String(task.params.prompt ?? ''),
    callableBy: setting.callableBy,
    forksMayBeAvatars: !!setting.forksMayBeAvatars,
    authorization: {
      level: stored.level ?? stored.profileId ?? 'developer',
      scope: stored.scope ?? 'projects',
      ...((stored.scope ?? 'projects') === 'projects' ? { projectIds: stored.projectIds?.length ? stored.projectIds : [task.projectId] } : {}),
      profileId: stored.profileId ?? stored.level ?? 'developer',
      capabilities: stored.capabilities ?? [],
      ...(stored.organizationId ? { organizationId: stored.organizationId } : {}),
      ...(stored.principal ? { principal: stored.principal } : {}),
    },
    ...(stored.credentialPolicies ? { credentialPolicies: stored.credentialPolicies } : {}),
    ...(typeof task.params._githubAccountId === 'string' ? { githubAccountId: task.params._githubAccountId } : {}),
    ...(agent?.provider ? { runtime: { provider: agent.provider,
      ...(agent.model ? { model: agent.model } : {}), ...(agent.effort ? { effort: agent.effort } : {}) } } : {}),
  };
}

export async function avatarEnabled(store: Store, avatar: Avatar): Promise<boolean> {
  return (await store.avatarAvailability(avatar.projectId)).effective;
}

/** Resolve an Avatar's authority through its live backing principal: its
 * creator's grants, or — for an Avatar that is a fork of another — that one's,
 * while it still lets its forks be Avatars. Cycles, removal or disablement
 * fail closed. */
export async function avatarAuthorizationCapabilities(
  store: Store,
  authorization: AuthorizationService | undefined,
  avatar: Avatar,
  projectId = avatar.projectId,
  seen = new Set<string>(),
): Promise<Capability[]> {
  if (seen.has(avatar.id) || !(await avatarEnabled(store, avatar))) return [];
  seen.add(avatar.id);
  const principal = avatar.authorization.principal ?? (avatar.ownerUserId ? `user:${avatar.ownerUserId}` : undefined);
  if (!principal) return [];
  let backing: Capability[];
  if (principal.startsWith('avatar:')) {
    const parent = (await store.getAvatar(principal.slice(7)));
    backing = parent?.forksMayBeAvatars
      ? (await avatarAuthorizationCapabilities(store, authorization, parent, projectId, seen)) : [];
  } else {
    backing = authorization
      ? (await authorization.capabilities(principal, projectId, avatar.organizationId))
      : avatar.authorization.capabilities;
  }
  return attenuate(avatar.authorization.capabilities, backing);
}

/** Calling an Avatar is its creator's delegation decision. Groups and teams are
 * resolved live, so a change of membership changes who can call it at once. */
export async function avatarCallableBy(store: Store, avatar: Avatar, userId: string): Promise<boolean> {
  if (avatar.ownerUserId === userId) return true;
  if (!avatar.callableBy.length) return false;
  return (await store.humanAudience(avatar.id, avatar.callableBy)).includes(userId);
}

/** The Avatar `id` names, when it is an Avatar of this project, Avatars are
 * enabled there, and `userId` may call it. */
export async function callableAvatar(store: Store, projectId: string, id: string | undefined,
  userId: string | undefined): Promise<Avatar | undefined> {
  if (!id || !userId) return undefined;
  const avatar = (await store.getAvatar(id));
  if (!avatar || avatar.projectId !== projectId || !(await avatarEnabled(store, avatar))) return undefined;
  return (await avatarCallableBy(store, avatar, userId)) ? avatar : undefined;
}

/** The Avatar an agent spec forks and may act for: the task it resumes from,
 * when that is an Avatar `userId` (the human behind the forking task) may call. */
export async function forkedAvatar(store: Store, projectId: string, spec: unknown,
  userId: string | undefined): Promise<Avatar | undefined> {
  const resumeFrom = spec && typeof spec === 'object' && !Array.isArray(spec)
    ? (spec as Partial<AgentSpec>).resumeFrom : undefined;
  return callableAvatar(store, projectId, resumeFrom?.taskId, userId);
}

/** The Avatar a task's role acts for this turn, judged live against the task's
 * creator: calling it, the Avatar setting and its project's availability may
 * all have changed since the task was made. */
export async function avatarForRole(store: Store, task: { taskId: string; projectId: string; agents?: Record<string, Partial<AgentSpec> | undefined> },
  role: string): Promise<Avatar | undefined> {
  const spec = task.agents?.[role];
  if (!spec?.resumeFrom?.taskId) return undefined;
  return forkedAvatar(store, task.projectId, spec, (await store.taskCreatorUserId(task.taskId)));
}

/** The Avatar whose authority backs a task's stored authorization
 * (`principal: avatar:<id>`), judged live like `avatarForRole`; undefined when
 * it no longer may (the authority then fails closed). */
export async function authorizingAvatar(store: Store, task: { id: string; projectId: string }, principal: string | undefined)
  : Promise<Avatar | undefined> {
  if (!principal?.startsWith('avatar:')) return undefined;
  return callableAvatar(store, task.projectId, principal.slice(7), (await store.taskCreatorUserId(task.id)));
}
