import { Store } from '../store/db.js';
import { Capability, CAPABILITIES, allows, attenuate } from './capabilities.js';

export type AuthorizationProfileId = 'developer' | 'maintainer' | 'operator' | 'administrator' | string;
export type AuthorizationScope = 'global' | `organization:${string}` | `project:${string}`;

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

const developer = [
  'project:read', 'task:*', 'queue:read', 'workflow:read', 'profile:read', 'credential:read', 'skill:write',
  'organization:read', 'organization:member:read', 'team:read', 'repository:read', 'inbox:*',
  // Workflow-internal decisions and merges are still narrowed by the role
  // profile and the workflow's exact branch target at execution time.
  'resolve-decision', 'confirm-decision', 'merge-into:*',
] satisfies Capability[];
const maintainer = [
  ...developer, 'project:edit', 'project:settings:*', 'queue:write', 'profile:write',
  'workflow:install', 'workflow:edit', 'team:write', 'repository:write',
] satisfies Capability[];
const operator = [
  ...maintainer, 'project:create', 'diagnostic:read', 'process:*', 'credential:*',
  'payment:*', 'settings:*', 'safe-mode:write', 'organization:*',
] satisfies Capability[];

// A project grant can never turn into authority over unrelated projects or the
// host. Even selecting Administrator at project scope narrows to this ceiling.
// Global grants remain the explicit trust root for users, credentials/payments
// writes, processes, safe mode, and global settings.
const PROJECT_GRANT_CEILING: Capability[] = [
  'project:read', 'project:edit', 'project:delete', 'project:settings:*',
  'task:*', 'queue:*', 'workflow:read', 'workflow:edit', 'profile:*',
  'credential:read', 'skill:write', 'resolve-decision', 'confirm-decision', 'merge-into:*',
  'organization:read', 'organization:member:read', 'team:*', 'repository:*', 'inbox:*',
];

const ORGANIZATION_GRANT_CEILING: Capability[] = [
  'organization:*', 'team:*', 'repository:*', 'inbox:*',
  'project:read', 'project:create', 'project:edit', 'project:settings:*',
  'task:*', 'queue:*', 'workflow:read', 'workflow:edit', 'profile:*',
  'credential:read', 'skill:write', 'payment:read',
];

/**
 * The four defaults are deliberately job-shaped, not an exhaustive permission
 * checklist.  They are ordinary stored profiles after seeding and can be
 * replaced globally or per project.
 */
export const DEFAULT_AUTHORIZATION_PROFILES: AuthorizationProfile[] = [
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
    id: 'operator', name: 'Automation operator', builtin: true,
    description: 'Operate projects, credentials, payments, processes, diagnostics, and global automation settings.',
    capabilities: operator,
  },
  {
    id: 'administrator', name: 'Administrator', builtin: true,
    description: 'Unrestricted karmax administration, including users and authorization policy.',
    capabilities: ['*'],
  },
];

export const projectScope = (projectId: string): AuthorizationScope => `project:${projectId}`;
export const organizationScope = (organizationId: string): AuthorizationScope => `organization:${organizationId}`;

export class AuthorizationService {
  constructor(private store: Store) {
    this.seed();
  }

  seed(): void {
    for (const profile of DEFAULT_AUTHORIZATION_PROFILES) {
      if (!this.store.getAuthorizationProfile('global', profile.id)) this.store.setAuthorizationProfile('global', profile as any);
    }
    if (!this.store.kvGet('authz:default:global')) this.store.kvSet('authz:default:global', 'developer');
  }

  profiles(projectId?: string): AuthorizationProfile[] {
    const global = new Map<string, AuthorizationProfile>(
      this.store.listAuthorizationProfiles('global').map((p) => [p.id, p]),
    );
    if (projectId) {
      for (const p of this.store.listAuthorizationProfiles(projectScope(projectId))) global.set(p.id, p);
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
      if (cap !== '*' && !cap.endsWith(':*') && !CAPABILITIES.includes(cap as any) && !cap.startsWith('merge-into:'))
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
    return (projectId && this.store.kvGet(`authz:default:project:${projectId}`))
      || this.store.kvGet('authz:default:global') || 'developer';
  }

  setDefault(actor: string, profileId: string, projectId?: string): void {
    if (!this.profile(profileId, projectId)) throw new Error(`unknown authorization profile ${profileId}`);
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
    return [...out];
  }

  /** Workflow grant = selected task profile capped by the creator's effective set. */
  taskGrant(principalId: string, projectId: string, requestedProfileId?: string, grantorCaps?: Capability[]): { profileId: string; capabilities: Capability[]; attenuated: boolean } {
    const profileId = requestedProfileId ?? this.defaultProfile(projectId);
    const profile = this.profile(profileId, projectId);
    if (!profile) throw new Error(`unknown authorization profile ${profileId}`);
    // The immediate bearer is authoritative. Re-loading only the named human's
    // grant here would let an attenuated agent create a more privileged task on
    // behalf of that human (confused-deputy escalation).
    const principal = grantorCaps ?? this.capabilities(principalId, projectId);
    const capabilities = attenuate(profile.capabilities, principal);
    return { profileId, capabilities, attenuated: profile.capabilities.some((c) => !allows(principal, c)) };
  }

  bootstrapAdministrator(userId: string): void {
    if (this.store.listPrincipalGrants().length) return;
    this.grant('system:bootstrap', { principalId: `user:${userId}`, scopeKey: 'global', profileId: 'administrator' });
  }

  bootstrapOrganizationOwner(actor: string, userId: string, organizationId: string): void {
    this.grant(actor, { principalId: `user:${userId}`, scopeKey: organizationScope(organizationId), profileId: 'administrator' });
  }

  audit(principalId: string, action: string, scopeKey: AuthorizationScope | string = 'global', detail: Record<string, unknown> = {}): number {
    return this.store.appendAudit({ principalId, action, scopeKey, detail });
  }
}
