import { Store } from '../store/db.js';
import { Capability, CAPABILITIES, DEVELOPER_WORKSPACE_CAPABILITIES, allows, attenuate } from './capabilities.js';
import type { AuthorizationSelection } from '../domain/types.js';

export type AuthorizationProfileId = 'viewer' | 'developer' | 'maintainer' | 'administrator' | 'god' | string;
export type AuthorizationScope = 'global' | `organization:${string}` | `project:${string}`;

export interface EffectiveAuthorization extends AuthorizationSelection {
  profileId: AuthorizationProfileId;
  organizationId?: string;
  capabilities: Capability[];
  attenuated: boolean;
}

export interface AuthorizationProfile {
  id: AuthorizationProfileId;
  name: string;
  description: string;
  capabilities: Capability[];
  builtin?: boolean;
  scopeKey?: AuthorizationScope;
}

export interface PrincipalGrant {
  principalId: string;
  scopeKey: AuthorizationScope;
  profileId: AuthorizationProfileId;
  /** Optional explicit narrowing; it can never widen the selected profile. */
  capabilities?: Capability[];
  grantedBy: string;
  grantedAt: number;
}

export class AuthorizationGrantError extends Error {
  status = 403;
  code = 'authorization_grant_denied';
}

const viewer = [
  'project:read', 'project:settings:read',
  'task:read', 'task:conversation:read', 'task:event:read',
  'queue:read', 'workflow:read', 'profile:read',
  'organization:read', 'organization:member:read', 'team:read', 'repository:read', 'inbox:read',
  'github:actions:read',
] satisfies Capability[];
const developer = [
  ...DEVELOPER_WORKSPACE_CAPABILITIES,
  // Workflow-internal decisions and merges are still narrowed by the role
  // profile and the workflow's exact branch target at execution time.
  'resolve-decision', 'confirm-decision', 'merge-into:*',
] satisfies Capability[];
const maintainer = [
  ...developer, 'project:edit', 'project:settings:*', 'queue:write', 'profile:write',
  'project:resource:shared-write',
  'workflow:install', 'workflow:edit', 'team:write', 'repository:write',
  'github:actions:write',
  // A maintainer's agent may stand in for a human at a Review gate; a
  // developer's may not (it reviews through its own Confirm turn instead).
  'review:approve',
] satisfies Capability[];
// A project grant can never turn into authority over unrelated projects or the
// host. Global grants remain the explicit trust root for users, host processes,
// safe mode, and installation settings. Organization grants can manage
// tenant-owned credentials and payments but cannot cross that boundary.
const PROJECT_GRANT_CEILING: Capability[] = [
  'project:read', 'project:edit', 'project:delete', 'project:settings:*',
  'project:resource:shared-write',
  'task:*', 'queue:*', 'workflow:read', 'workflow:edit', 'profile:*',
  'credential:read', 'vault:store', 'use-credential:*', 'skill:write',
  'use-card:*',
  'resolve-decision', 'confirm-decision', 'merge-into:*',
  'organization:read', 'organization:member:read', 'team:*', 'repository:*', 'inbox:*',
  'github:actions:*',
];

const ORGANIZATION_GRANT_CEILING: Capability[] = [
  'organization:*', 'team:*', 'repository:*', 'inbox:*',
  'project:read', 'project:create', 'project:edit', 'project:delete', 'project:settings:*',
  'project:resource:shared-write',
  'task:*', 'queue:*', 'workflow:read', 'workflow:edit', 'workflow:install', 'profile:*',
  'credential:*', 'vault:store', 'use-credential:*', 'skill:write', 'payment:*', 'use-card:*',
  'resolve-decision', 'confirm-decision', 'merge-into:*',
  'github:actions:*',
];

/** The five canonical levels are deliberately job-shaped, not permission checklists. */
const CANONICAL_AUTHORIZATION_LEVELS = ['viewer', 'developer', 'maintainer', 'administrator', 'god'] as const;

export const DEFAULT_AUTHORIZATION_PROFILES: AuthorizationProfile[] = [
  {
    id: 'viewer', name: 'Viewer', builtin: true,
    description: 'Read projects, tasks, conversations, settings, workflows, and queues without changing them.',
    capabilities: viewer,
  },
  {
    id: 'developer', name: 'Developer', builtin: true,
    description: 'Work with tasks, conversations, review actions, queues, and skills inside assigned projects.',
    capabilities: developer,
  },
  {
    id: 'maintainer', name: 'Project maintainer', builtin: true,
    description: 'Developer access plus project settings, agent profiles, queues, and reviewed workflow changes.',
    capabilities: maintainer,
  },
  {
    id: 'administrator', name: 'Administrator', builtin: true,
    description: 'Full access inside one organization.',
    capabilities: ORGANIZATION_GRANT_CEILING,
  },
  {
    id: 'god', name: 'God', builtin: true,
    description: 'Unrestricted global operation across every organization and the installation.',
    capabilities: ['*'],
  },
];

// Exact snapshots seeded by the last pre-vault/organization-role release.
// Built-ins are customizable, so seed migrations must never overwrite an
// arbitrary profile merely because it still has `builtin: true`. Matching a
// complete historical capability set lets old untouched installs acquire new
// platform primitives while preserving every genuinely customized profile.
const LEGACY_BUILTIN_CAPABILITIES: Partial<Record<AuthorizationProfileId, Capability[][]>> = {
  developer: [developer.filter((capability) => capability !== 'github:actions:read'), [
    'project:read', 'task:*', 'queue:read', 'workflow:read', 'profile:read',
    'credential:read', 'skill:write', 'resolve-decision', 'confirm-decision', 'merge-into:*',
  ]],
  maintainer: [maintainer.filter((capability) => capability !== 'review:approve'),
    maintainer.filter((capability) => !capability.startsWith('github:actions:') && capability !== 'review:approve'), [
    'project:read', 'task:*', 'queue:read', 'workflow:read', 'profile:read',
    'credential:read', 'skill:write', 'resolve-decision', 'confirm-decision', 'merge-into:*',
    'project:edit', 'project:settings:*', 'queue:write', 'profile:write',
    'workflow:install', 'workflow:edit',
  ]],
  operator: [[
    'project:read', 'task:*', 'queue:read', 'workflow:read', 'profile:read',
    'credential:read', 'skill:write', 'resolve-decision', 'confirm-decision', 'merge-into:*',
    'project:edit', 'project:settings:*', 'queue:write', 'profile:write',
    'workflow:install', 'workflow:edit', 'project:create', 'diagnostic:read',
    'process:*', 'credential:*', 'payment:*', 'settings:*', 'safe-mode:write',
  ]],
};

function sameCapabilities(a: Capability[], b: Capability[]): boolean {
  return a.length === b.length && a.every((capability) => b.includes(capability));
}

export const projectScope = (projectId: string): AuthorizationScope => `project:${projectId}`;
export const organizationScope = (organizationId: string): AuthorizationScope => `organization:${organizationId}`;

export class AuthorizationService {
  constructor(private store: Store) {
    this.seed();
  }

  seed(): void {
    for (const profile of DEFAULT_AUTHORIZATION_PROFILES) {
      const stored = this.store.getAuthorizationProfile('global', profile.id) as AuthorizationProfile | undefined;
      if (!stored) {
        this.store.setAuthorizationProfile('global', profile as any);
        continue;
      }
      const historical = LEGACY_BUILTIN_CAPABILITIES[profile.id] ?? [];
      if (stored.builtin && stored.name === profile.name && stored.description === profile.description
        && historical.some((caps) => sameCapabilities(stored.capabilities, caps))) {
        this.store.setAuthorizationProfile('global', profile as any);
      }
    }
    this.migrateLegacyGrants();
    if (!this.store.kvGet('authz:default:global')) this.store.kvSet('authz:default:global', 'developer');
    this.migrateLegacyDefaults();
  }

  private migrateLegacyDefaults(): void {
    const keys = ['authz:default:global',
      ...this.store.listProjects().map((project) => `authz:default:project:${project.id}`)];
    for (const key of keys) {
      const level = this.store.kvGet(key);
      if (level && !CANONICAL_AUTHORIZATION_LEVELS.includes(level as any)) this.store.kvSet(key, 'developer');
    }
  }

  private migrateLegacyGrants(): void {
    for (const grant of this.store.listPrincipalGrants() as PrincipalGrant[]) {
      let profileId = grant.profileId;
      if (grant.scopeKey === 'global' && (profileId === 'operator' || profileId === 'administrator')) profileId = 'god';
      else if (grant.scopeKey.startsWith('organization:') && profileId === 'operator') profileId = 'administrator';
      else if (grant.scopeKey.startsWith('project:') && (profileId === 'operator' || profileId === 'administrator')) profileId = 'maintainer';

      if (grant.scopeKey === 'global' && (profileId === 'developer' || profileId === 'maintainer' || profileId === 'viewer')) {
        for (const organization of this.store.listOrganizations()) {
          const scopeKey = organizationScope(organization.id);
          this.store.setPrincipalGrant(grant.principalId, scopeKey, { ...grant, scopeKey, profileId });
        }
        this.store.deletePrincipalGrant(grant.principalId, grant.scopeKey);
      } else if (profileId !== grant.profileId) {
        this.store.setPrincipalGrant(grant.principalId, grant.scopeKey, { ...grant, profileId });
      }
    }
  }

  profiles(projectId?: string): AuthorizationProfile[] {
    const global = new Map<string, AuthorizationProfile>(
      this.store.listAuthorizationProfiles('global').filter((p) => p.id !== 'operator').map((p) => [p.id, p]),
    );
    if (projectId) {
      for (const p of this.store.listAuthorizationProfiles(projectScope(projectId))) {
        if (p.id !== 'operator') global.set(p.id, p);
      }
    }
    return [...global.values()];
  }

  profile(id: string, projectId?: string): AuthorizationProfile | undefined {
    return (projectId ? this.store.getAuthorizationProfile(projectScope(projectId), id) : undefined)
      ?? this.store.getAuthorizationProfile('global', id);
  }

  saveProfile(actor: string, scopeKey: AuthorizationScope, profile: AuthorizationProfile): AuthorizationProfile {
    if (!profile.id.trim() || !profile.name.trim()) throw new Error('authorization profile needs an id and name');
    if (!profile.capabilities.length) throw new Error('authorization profile needs at least one capability');
    for (const cap of profile.capabilities) {
      // `use-credential:` grants are target-scoped (item/tag/domain names), so
      // their concrete values cannot be enumerated in the catalogue (§ the
      // "separate advanced control" of PLAN-authorization).
      if (cap !== '*' && !cap.endsWith(':*') && !CAPABILITIES.includes(cap as any) && !cap.startsWith('merge-into:') && !cap.startsWith('use-credential:'))
        throw new Error(`unknown capability ${cap}`);
    }
    const { scopeKey: _claimedScope, ...clean } = profile;
    const saved = { ...clean, id: profile.id.trim(), name: profile.name.trim() };
    this.store.setAuthorizationProfile(scopeKey, saved);
    this.audit(actor, 'authorization.profile.saved', scopeKey, { profileId: saved.id, capabilities: saved.capabilities });
    return { ...saved, scopeKey };
  }

  deleteProfile(actor: string, scopeKey: AuthorizationScope, id: string): void {
    if (scopeKey === 'global' && DEFAULT_AUTHORIZATION_PROFILES.some((p) => p.id === id))
      throw new Error('built-in global profiles can be customized but not deleted');
    this.store.deleteAuthorizationProfile(scopeKey, id);
    this.audit(actor, 'authorization.profile.deleted', scopeKey, { profileId: id });
  }

  defaultProfile(projectId?: string): string {
    const level = (projectId && this.store.kvGet(`authz:default:project:${projectId}`))
      || this.store.kvGet('authz:default:global') || 'developer';
    return CANONICAL_AUTHORIZATION_LEVELS.includes(level as any) ? level : 'developer';
  }

  setDefault(actor: string, profileId: string, projectId?: string): void {
    if (!CANONICAL_AUTHORIZATION_LEVELS.includes(profileId as any))
      throw new Error(`unknown authorization level ${profileId}`);
    const key = projectId ? `authz:default:project:${projectId}` : 'authz:default:global';
    this.store.kvSet(key, profileId);
    this.audit(actor, 'authorization.default.changed', projectId ? projectScope(projectId) : 'global', { profileId });
  }

  grants(principalId?: string): PrincipalGrant[] {
    return this.store.listPrincipalGrants(principalId);
  }

  grant(actor: string, input: Omit<PrincipalGrant, 'grantedBy' | 'grantedAt'>): PrincipalGrant {
    const projectId = input.scopeKey.startsWith('project:') ? input.scopeKey.slice(8) : undefined;
    const profile = this.profile(input.profileId, projectId);
    if (!profile) throw new Error(`unknown authorization profile ${input.profileId}`);
    const grant: PrincipalGrant = { ...input, grantedBy: actor, grantedAt: Date.now() };
    if (grant.capabilities && grant.capabilities.some((cap) => !allows(profile.capabilities, cap)))
      throw new Error('an explicit grant may narrow but not widen its authorization profile');
    this.store.setPrincipalGrant(grant.principalId, grant.scopeKey, grant as any);
    this.audit(actor, 'authorization.grant.saved', grant.scopeKey, { principalId: grant.principalId, profileId: grant.profileId });
    return grant;
  }

  revoke(actor: string, principalId: string, scopeKey: AuthorizationScope): void {
    this.store.deletePrincipalGrant(principalId, scopeKey);
    this.audit(actor, 'authorization.grant.revoked', scopeKey, { principalId });
  }

  capabilities(principalId: string, projectId?: string, organizationId?: string): Capability[] {
    const out = new Set<Capability>();
    const resolvedOrganizationId = organizationId ?? (projectId ? this.store.getProject(projectId)?.organizationId : undefined);
    const relevant = this.grants(principalId).filter((g) => g.scopeKey === 'global'
      || (resolvedOrganizationId && g.scopeKey === organizationScope(resolvedOrganizationId))
      || (projectId && g.scopeKey === projectScope(projectId)));
    for (const grant of relevant) {
      // A project overlay must not silently redefine an account's global grant.
      const p = grant.scopeKey === 'global' ? this.profile(grant.profileId) : this.profile(grant.profileId, projectId);
      if (!p) continue;
      let caps = grant.capabilities ? attenuate(p.capabilities, grant.capabilities) : p.capabilities;
      if (grant.scopeKey.startsWith('project:')) caps = attenuate(caps, PROJECT_GRANT_CEILING);
      else if (grant.scopeKey.startsWith('organization:')) caps = attenuate(caps, ORGANIZATION_GRANT_CEILING);
      for (const cap of caps) out.add(cap);
    }
    // Team and @all project access are durable principals, not UI aliases.
    // Their selected profile applies dynamically, including to people added to
    // the team/organization later, so group authorization is never cosmetic.
    if (projectId && principalId.startsWith('user:')) {
      const userId = principalId.slice(5);
      const project = this.store.getProject(projectId);
      for (const membership of this.store.listProjectMemberships(projectId)) {
        const applies = membership.principal.kind === 'user' ? membership.principal.userId === userId
          : membership.principal.kind === 'team' ? this.store.listTeamMemberships(membership.principal.teamId).some((member) => member.userId === userId)
          : membership.principal.kind === 'organization' ? membership.principal.organizationId === project?.organizationId
            && Boolean(project?.organizationId && this.store.organizationMembership(project.organizationId, userId)) : false;
        if (!applies) continue;
        const profileId = ['owner', 'admin', 'administrator', 'operator'].includes(membership.role)
          ? 'maintainer'
          : this.profile(membership.role, projectId) ? membership.role : 'developer';
        const profile = this.profile(profileId, projectId);
        if (profile) for (const cap of attenuate(profile.capabilities, PROJECT_GRANT_CEILING)) out.add(cap);
      }
    }
    return [...out];
  }

  /** Workflow grant = selected task profile capped by the creator's effective set. */
  taskGrant(
    principalId: string,
    projectId: string,
    requestedProfileId?: string | AuthorizationSelection,
    grantorCaps?: Capability[],
  ): EffectiveAuthorization {
    const requested = requestedProfileId ?? this.defaultProfile(projectId);
    return this.scopedTaskGrant(principalId, projectId, requested, grantorCaps);
  }

  /** The complete package represented by a selection, before it is attenuated
   * against any grantor. Used for gap explanations and recipient eligibility. */
  requestedCapabilities(projectId: string, requested: AuthorizationSelection): Capability[] {
    return this.scopedTaskGrant('system:authorization-preview', projectId, requested, ['*']).capabilities;
  }

  missingCapabilities(
    principalId: string,
    projectId: string,
    requested: AuthorizationSelection,
    grantorCaps?: Capability[],
  ): Capability[] {
    const full = this.requestedCapabilities(projectId, requested);
    const held = this.scopedTaskGrant(principalId, projectId, requested, grantorCaps).capabilities;
    return full.filter((capability) => !allows(held, capability));
  }

  canGrantSelection(principalId: string, projectId: string, requested: AuthorizationSelection): boolean {
    return !this.scopedTaskGrant(principalId, projectId, requested).attenuated;
  }

  scopedTaskGrant(
    principalId: string,
    taskProjectId: string,
    requested: AuthorizationSelection | string,
    grantorCaps?: Capability[],
  ): EffectiveAuthorization {
    const taskProject = this.store.getProject(taskProjectId);
    if (!taskProject) throw new Error(`no project ${taskProjectId}`);
    const organizationId = taskProject.organizationId ?? 'org_personal';
    const legacy = typeof requested === 'string';
    const level = (requested === 'operator' ? 'god' : typeof requested === 'string' ? requested : requested.level)
      || this.defaultProfile(taskProjectId);
    const selection: AuthorizationSelection = typeof requested === 'string'
      ? { level, scope: level === 'god' ? 'global' : 'projects', projectIds: level === 'god' ? undefined : [taskProjectId] }
      : { ...requested, level };
    const normalized = this.normalizeSelection(selection, organizationId, legacy);
    const profile = this.profile(normalized.level,
      normalized.scope === 'projects' ? normalized.projectIds?.[0] : undefined);
    if (!profile) throw new Error(`unknown authorization level ${normalized.level}`);
    const ceiling = normalized.scope === 'projects'
      ? attenuate(profile.capabilities, PROJECT_GRANT_CEILING)
      : normalized.scope === 'organization'
        ? attenuate(profile.capabilities, ORGANIZATION_GRANT_CEILING)
        : profile.capabilities;
    let principal: Capability[];
    if (grantorCaps) {
      // The immediate bearer is authoritative for agent-to-task delegation.
      // Re-loading the named human would be a confused-deputy escalation.
      principal = grantorCaps;
    } else if (normalized.scope === 'projects') {
      const projectCaps = normalized.projectIds!.map((id) => this.capabilities(principalId, id, organizationId));
      principal = projectCaps.slice(1).reduce((common, caps) => attenuate(common, caps), projectCaps[0] ?? []);
    } else if (normalized.scope === 'organization') {
      principal = this.capabilities(principalId, undefined, organizationId);
    } else {
      principal = this.capabilities(principalId);
    }
    const capabilities = attenuate(ceiling, principal);
    return {
      ...normalized,
      profileId: normalized.level,
      ...(normalized.scope === 'global' ? {} : { organizationId }),
      capabilities,
      attenuated: ceiling.some((capability) => !allows(capabilities, capability)),
    };
  }

  private normalizeSelection(
    input: AuthorizationSelection,
    organizationId: string,
    allowLegacyAdministratorProject = false,
  ): AuthorizationSelection {
    const level = String(input.level || '').trim();
    if (!CANONICAL_AUTHORIZATION_LEVELS.includes(level as any))
      throw new Error(`unknown authorization level ${level}`);
    if (level === 'administrator' && input.scope !== 'organization' && !allowLegacyAdministratorProject)
      throw new Error('Administrator requires organization scope');
    if (level === 'god' && input.scope !== 'global') throw new Error('God requires global scope');
    if (['viewer', 'developer', 'maintainer'].includes(level) && !['projects', 'organization'].includes(input.scope))
      throw new Error(`${level} requires project or organization scope`);
    if (input.scope === 'projects') {
      const projectIds = [...new Set((input.projectIds ?? []).map(String).filter(Boolean))];
      if (!projectIds.length) throw new Error('choose at least one project or @organization');
      for (const projectId of projectIds) {
        if (this.store.getProject(projectId)?.organizationId !== organizationId)
          throw new Error('authorization projects must belong to the same organization');
      }
      return { level, scope: 'projects', projectIds };
    }
    return { level, scope: input.scope };
  }

  replacePrincipalAuthorization(
    actor: string,
    principalId: string,
    organizationId: string,
    selection: AuthorizationSelection,
    grantorCaps?: Capability[],
  ): AuthorizationSelection {
    const normalized = this.normalizeSelection(selection, organizationId);
    this.assertCanGrantSelection(actor, organizationId, normalized, grantorCaps);

    for (const grant of this.grants(principalId)) {
      const projectId = grant.scopeKey.startsWith('project:') ? grant.scopeKey.slice(8) : undefined;
      const belongs = grant.scopeKey === organizationScope(organizationId)
        || (projectId && this.store.getProject(projectId)?.organizationId === organizationId)
        || (grant.scopeKey === 'global' && ['god', 'administrator', 'operator'].includes(grant.profileId));
      if (belongs) this.revoke(actor, principalId, grant.scopeKey);
    }
    const scopes: AuthorizationScope[] = normalized.scope === 'global' ? ['global']
      : normalized.scope === 'organization' ? [organizationScope(organizationId)]
        : normalized.projectIds!.map(projectScope);
    for (const scopeKey of scopes) this.grant(actor, { principalId, scopeKey, profileId: normalized.level });
    return normalized;
  }

  assertCanGrantSelection(
    actor: string,
    organizationId: string,
    selection: AuthorizationSelection,
    grantorCaps?: Capability[],
  ): AuthorizationSelection {
    const normalized = this.normalizeSelection(selection, organizationId);
    const project = this.store.listProjects().find((candidate) => candidate.organizationId === organizationId);
    const effective = project
      ? this.scopedTaskGrant(actor, project.id, normalized, grantorCaps)
      : this.effectiveWithoutProject(actor, organizationId, normalized, grantorCaps);
    if (effective.attenuated)
      throw new AuthorizationGrantError('you cannot grant an authorization level you do not hold for the selected scope');
    return normalized;
  }

  private effectiveWithoutProject(
    actor: string,
    organizationId: string,
    selection: AuthorizationSelection,
    grantorCaps?: Capability[],
  ): EffectiveAuthorization {
    if (selection.scope === 'projects') throw new Error('this organization has no projects to authorize');
    const profile = this.profile(selection.level);
    if (!profile) throw new Error(`unknown authorization level ${selection.level}`);
    const ceiling = selection.scope === 'organization'
      ? attenuate(profile.capabilities, ORGANIZATION_GRANT_CEILING) : profile.capabilities;
    const principal = grantorCaps ?? this.capabilities(actor, undefined,
      selection.scope === 'organization' ? organizationId : undefined);
    const capabilities = attenuate(ceiling, principal);
    return { ...selection, profileId: selection.level,
      ...(selection.scope === 'organization' ? { organizationId } : {}), capabilities,
      attenuated: ceiling.some((capability) => !allows(capabilities, capability)) };
  }

  selectionForPrincipal(principalId: string, organizationId: string): AuthorizationSelection | undefined {
    const grants = this.grants(principalId);
    const global = grants.find((grant) => grant.scopeKey === 'global' && grant.profileId === 'god');
    if (global) return { level: 'god', scope: 'global' };
    const organization = grants.find((grant) => grant.scopeKey === organizationScope(organizationId));
    if (organization && ['viewer', 'developer', 'maintainer', 'administrator'].includes(organization.profileId))
      return { level: organization.profileId, scope: 'organization' };
    const projects = grants.filter((grant) => grant.scopeKey.startsWith('project:')
      && this.store.getProject(grant.scopeKey.slice(8))?.organizationId === organizationId
      && ['viewer', 'developer', 'maintainer'].includes(grant.profileId));
    if (!projects.length) return undefined;
    const level = projects[0]!.profileId;
    if (projects.some((grant) => grant.profileId !== level)) return undefined;
    const projectIds = projects.map((grant) => grant.scopeKey.slice(8)).sort((a, b) =>
      (this.store.getProject(a)?.name ?? a).localeCompare(this.store.getProject(b)?.name ?? b));
    return { level, scope: 'projects', projectIds };
  }

  bootstrapAdministrator(userId: string): void {
    if (this.store.listPrincipalGrants().length) return;
    this.grant('system:bootstrap', { principalId: `user:${userId}`, scopeKey: 'global', profileId: 'god' });
  }

  bootstrapOrganizationOwner(actor: string, userId: string, organizationId: string): void {
    this.grant(actor, { principalId: `user:${userId}`, scopeKey: organizationScope(organizationId), profileId: 'administrator' });
  }

  audit(principalId: string, action: string, scopeKey: AuthorizationScope | string = 'global', detail: Record<string, unknown> = {}): number {
    return this.store.appendAudit({ principalId, action, scopeKey, detail });
  }
}
