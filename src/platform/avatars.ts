import type { AgentProfile, AgentRole, AgentSpec, Avatar } from '../domain/types.js';
import type { Store } from '../store/db.js';
import { agentRoleDef } from '../contrib/manifests.js';
import { applyAgentSpec } from '../agent/profiles.js';
import { attenuate, type Capability } from './capabilities.js';
import type { AuthorizationService } from './authorization.js';

export class AvatarUnavailableError extends Error {
  code = 'avatar_unavailable';
  status = 409;
}

export function avatarPrincipal(id: string): string {
  return `avatar:${id}`;
}

export function avatarEnabled(store: Store, avatar: Avatar): boolean {
  if (!avatar.enabled || avatar.deletedAt) return false;
  const availability = store.avatarAvailability(avatar.projectId);
  return availability.effective;
}

/** Resolve an Avatar delegation through its live backing principal. Avatar-backed
 * approvals may form a short chain; cycles, deletion, or disablement fail closed. */
export function avatarAuthorizationCapabilities(
  store: Store,
  authorization: AuthorizationService | undefined,
  avatar: Avatar,
  projectId = avatar.projectId,
  seen = new Set<string>(),
): Capability[] {
  if (seen.has(avatar.id) || !avatarEnabled(store, avatar)) return [];
  seen.add(avatar.id);
  const principal = avatar.authorization.principal ?? `user:${avatar.ownerUserId}`;
  let backing: Capability[];
  if (principal.startsWith('avatar:')) {
    const parent = store.getAvatar(principal.slice(7));
    backing = parent ? avatarAuthorizationCapabilities(store, authorization, parent, projectId, seen) : [];
  } else {
    backing = authorization
      ? authorization.capabilities(principal, projectId, avatar.organizationId)
      : avatar.authorization.capabilities;
  }
  return attenuate(avatar.authorization.capabilities, backing);
}

/** Invocation is a delegation decision made by the owner. Team membership is
 * resolved live so adding/removing a person immediately changes who can call an
 * Avatar without rewriting it. */
export function avatarCallableBy(store: Store, avatar: Avatar, userId: string): boolean {
  if (avatar.ownerUserId === userId) return true;
  for (const selector of avatar.callableBy) {
    if (selector === '@project') {
      if (store.listProjectMemberships(avatar.projectId).some((membership) => {
        const principal = membership.principal;
        if (principal.kind === 'user') return principal.userId === userId;
        if (principal.kind === 'organization') return Boolean(store.organizationMembership(principal.organizationId, userId));
        if (principal.kind === 'team') return store.listTeamMemberships(principal.teamId).some((member) => member.userId === userId);
        return false;
      })) return true;
    } else if (selector.startsWith('user:') && selector.slice(5) === userId) return true;
    else if (selector.startsWith('@team:')) {
      const slug = selector.slice(6);
      const team = store.listTeams(avatar.organizationId, avatar.projectId)
        .find((candidate) => candidate.slug === slug);
      if (team && store.listTeamMemberships(team.id).some((member) => member.userId === userId)) return true;
    } else if (selector.startsWith('team:')) {
      const team = store.getTeam(selector.slice(5));
      if (team?.organizationId === avatar.organizationId
        && store.listTeamMemberships(team.id).some((member) => member.userId === userId)) return true;
    }
  }
  return false;
}

export function avatarForRole(store: Store, task: { projectId: string; agents?: Record<string, AgentSpec> }, role: AgentRole): Avatar | undefined {
  const spec = task.agents?.[role];
  const id = spec?.avatarId;
  if (!id) return undefined;
  const avatar = store.getAvatar(id);
  if (!avatar || avatar.projectId !== task.projectId) throw new AvatarUnavailableError('the selected Avatar is no longer available in this project');
  if (!avatarEnabled(store, avatar)) throw new AvatarUnavailableError(`Avatar "${avatar.name}" is disabled`);
  const purpose = spec?.avatarPurpose ?? role;
  if (avatar.roles.length && !avatar.roles.includes(purpose))
    throw new AvatarUnavailableError(`Avatar "${avatar.name}" is not available for the ${purpose} role`);
  return avatar;
}

/** Apply the Avatar's owner-controlled runtime and prompt to a workflow role.
 * The role template remains the technical contract (task bindings + required
 * control tool); the Avatar prompt is the behavioral instruction appended to it. */
export function applyAvatarProfile(base: AgentProfile, spec: AgentSpec | undefined, avatar?: Avatar): AgentProfile {
  if (!avatar) return applyAgentSpec(base, spec);
  const roleTemplate = agentRoleDef(base.role)?.promptTemplate ?? base.promptTemplate ?? '';
  const avatarSpec: AgentSpec = {
    provider: avatar.runtime.provider,
    ...(avatar.runtime.model ? { model: avatar.runtime.model } : {}),
    ...(avatar.runtime.effort ? { effort: avatar.runtime.effort } : {}),
    ...(spec?.resumeFrom ? { resumeFrom: spec.resumeFrom } : {}),
    avatarId: avatar.id,
    ...(spec?.avatarPurpose ? { avatarPurpose: spec.avatarPurpose } : {}),
  };
  return {
    ...applyAgentSpec(base, avatarSpec),
    id: `avatar:${avatar.id}:${base.role}`,
    name: avatar.name,
    promptTemplate: `${roleTemplate}\n\n# Avatar instructions\n${avatar.prompt}`,
  };
}
