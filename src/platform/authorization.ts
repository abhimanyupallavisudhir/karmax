import * as __asyncCollections from '../util/async-collections.js';
import { Store } from '../store/db.js';
import { Capability, CAPABILITIES, DEVELOPER_WORKSPACE_CAPABILITIES, allows, attenuate } from './capabilities.js';
import { SHIPPED_BUILTIN_PROFILES } from './builtin-profile-history.js';
import type { AuthorizationSelection, ProjectMembership } from '../domain/types.js';

export type AuthorizationProfileId = 'viewer' | 'developer' | 'maintainer' | 'administrator' | 'superadmin' | 'god' | string;
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
  ...developer, 'task:*', 'project:delete', 'project:edit', 'project:settings:*', 'queue:write', 'profile:write',
  'project:resource:shared-write',
  'workflow:edit', 'team:write', 'repository:write',
  'github:actions:write',
  // A maintainer's agent may stand in for a human at a Review gate; a
  // developer's may not (it reviews through its own Confirm turn instead).
  'review:approve',
  // Organization wiki pages reach every task in the organization, so
  // PROJECT_GRANT_CEILING omits this: only an organization or global grant uses it.
  'organization:wiki:write',
] satisfies Capability[];
// A project grant can never turn into authority over unrelated projects or the
// host. Global grants remain the explicit trust root for users, host processes
// and installation settings. Organization grants can manage
// tenant-owned credentials and payments but cannot cross that boundary.
const PROJECT_GRANT_CEILING: Capability[] = [
  'project:read', 'project:edit', 'project:delete', 'project:settings:*',
  'project:resource:shared-write',
  'task:*', 'queue:*', 'workflow:read', 'workflow:edit', 'profile:*',
  'credential:read', 'vault:store', 'connection:use', 'use-credential:*', 'skill:write',
  'use-card:*',
  'resolve-decision', 'confirm-decision', 'merge-into:*',
  'organization:read', 'organization:member:read', 'team:*', 'repository:*', 'inbox:*',
  'github:actions:*', 'diagnostic:read', 'process:read', 'review:approve',
];

export const ORGANIZATION_GRANT_CEILING: Capability[] = [
  'project:transfer-out', 'project:transfer-in',
  'organization:*', 'team:*', 'repository:*', 'inbox:*',
  'project:read', 'project:create', 'project:edit', 'project:delete', 'project:settings:*',
  'project:resource:shared-write',
  // Loading code into the shared worker is installation authority, never tenant authority.
  'task:*', 'queue:*', 'workflow:read', 'workflow:edit', 'profile:*',
  'credential:*', 'credential:reveal', 'vault:store', 'connection:use', 'use-credential:*', 'skill:write', 'payment:*', 'use-card:*',
  'resolve-decision', 'confirm-decision', 'merge-into:*',
  'github:actions:*', 'diagnostic:read', 'process:read', 'review:approve',
];

/** What only a Super-administrator (or God) may do inside an organization:
 * read the vault regardless of item policy, move money, and delete the
 * organization. Everything else in the organization is an Administrator's. */
export const SUPER_ADMINISTRATOR_CAPABILITIES: Capability[] = ['credential:reveal', 'payment:write', 'organization:delete'];

const administrator: Capability[] = [
  'project:transfer-out', 'project:transfer-in',
  'organization:read', 'organization:create', 'organization:edit', 'organization:wiki:write',
  'organization:member:read', 'organization:member:write', 'team:*', 'repository:*', 'inbox:*',
  'project:read', 'project:create', 'project:edit', 'project:delete', 'project:settings:*',
  'project:resource:shared-write',
  'task:*', 'queue:*', 'workflow:read', 'workflow:edit', 'profile:*',
  'credential:read', 'credential:write', 'vault:store', 'connection:use', 'use-credential:*', 'skill:write',
  'payment:read', 'use-card:*',
  'resolve-decision', 'confirm-decision', 'merge-into:*',
  'github:actions:*', 'diagnostic:read', 'process:read', 'review:approve',
];

/** The six canonical levels are deliberately job-shaped, not permission checklists. */
const CANONICAL_AUTHORIZATION_LEVELS = ['viewer', 'developer', 'maintainer', 'administrator', 'superadmin', 'god'] as const;
/** Levels that only make sense for a whole organization. */
const ORGANIZATION_LEVELS: Record<string, string> = { administrator: 'Administrator', superadmin: 'Super-administrator' };

export const DEFAULT_AUTHORIZATION_PROFILES: AuthorizationProfile[] = [
  {
    id: 'viewer', name: 'Viewer', builtin: true,
    description: 'Read projects, tasks, conversations, settings, workflows, and queues without changing them.',
    capabilities: viewer,
  },
  {
    id: 'developer', name: 'Developer', builtin: true,
    description: 'Read diagnostics and work on your own tasks and descendants inside assigned projects.',
    capabilities: developer,
  },
  {
    id: 'maintainer', name: 'Project maintainer', builtin: true,
    description: 'Manage all tasks, reviews, settings, and automation inside assigned projects.',
    capabilities: maintainer,
  },
  {
    id: 'administrator', name: 'Administrator', builtin: true,
    description: 'Manage one organization: its projects, members, settings, and credentials, within their policies.',
    capabilities: administrator,
  },
  {
    id: 'superadmin', name: 'Super-administrator', builtin: true,
    description: 'Everything an Administrator can do, plus full read access to the vault, payments, and deleting the organization.',
    capabilities: [...administrator, ...SUPER_ADMINISTRATOR_CAPABILITIES],
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
const PREVIOUS_BUILTIN_DESCRIPTIONS: Record<string, string> = {
  developer: 'Work with tasks, conversations, review actions, queues, and skills inside assigned projects.',
  maintainer: 'Developer access plus project settings, agent profiles, queues, and reviewed workflow changes.',
  administrator: 'Full access inside one organization.',
};

/** The organization ceiling before vault read access was its own capability:
 * Administrator was this whole set, which historical profiles still match. */
const PREVIOUS_ORGANIZATION_GRANT_CEILING: Capability[] = ORGANIZATION_GRANT_CEILING.filter((capability) => capability !== 'credential:reveal');

const PREVIOUS_BUILTIN_CAPABILITIES = {
  developer: [
    'project:read', 'project:settings:read', 'task:*', 'queue:read',
    'workflow:read', 'profile:read', 'organization:read', 'organization:member:read',
    'team:read', 'repository:read', 'github:actions:read', 'credential:read',
    'connection:use', 'vault:store', 'skill:write', 'use-card:*',
    'inbox:*', 'resolve-decision', 'confirm-decision', 'merge-into:*',
  ],
  maintainer: [
    'project:read', 'project:settings:read', 'task:*', 'queue:read',
    'workflow:read', 'profile:read', 'organization:read', 'organization:member:read',
    'team:read', 'repository:read', 'github:actions:read', 'credential:read',
    'connection:use', 'vault:store', 'skill:write', 'use-card:*',
    'inbox:*', 'resolve-decision', 'confirm-decision', 'merge-into:*',
    'project:edit', 'project:settings:*', 'queue:write', 'profile:write',
    'project:resource:shared-write', 'workflow:edit', 'team:write', 'repository:write',
    'github:actions:write', 'review:approve',
  ],
  administrator: [
    'project:transfer-out', 'project:transfer-in', 'organization:*', 'team:*',
    'repository:*', 'inbox:*', 'project:read', 'project:create',
    'project:edit', 'project:delete', 'project:settings:*', 'project:resource:shared-write',
    'task:*', 'queue:*', 'workflow:read', 'workflow:edit',
    'profile:*', 'credential:*', 'vault:store', 'connection:use',
    'use-credential:*', 'skill:write', 'payment:*', 'use-card:*',
    'resolve-decision', 'confirm-decision', 'merge-into:*', 'github:actions:*',
  ],
} satisfies Record<string, Capability[]>;

const LEGACY_BUILTIN_CAPABILITIES: Partial<Record<AuthorizationProfileId, Capability[][]>> = {
  developer: [PREVIOUS_BUILTIN_CAPABILITIES.developer!, PREVIOUS_BUILTIN_CAPABILITIES.developer!.filter((capability) => capability !== 'github:actions:read'), [
    'project:read', 'task:*', 'queue:read', 'workflow:read', 'profile:read',
    'credential:read', 'skill:write', 'resolve-decision', 'confirm-decision', 'merge-into:*',
  ]],
  maintainer: [PREVIOUS_BUILTIN_CAPABILITIES.maintainer!,
    // workflow:install releases predate organization:wiki:write.
    [...maintainer.filter((capability) => capability !== 'organization:wiki:write'), 'workflow:install'],
    // With workflow:install (before it became global authority), with and without `review:approve`…
    [...PREVIOUS_BUILTIN_CAPABILITIES.maintainer!, 'workflow:install'],
    [...PREVIOUS_BUILTIN_CAPABILITIES.maintainer!.filter((capability) => capability !== 'review:approve'), 'workflow:install'],
    [...PREVIOUS_BUILTIN_CAPABILITIES.maintainer!.filter((capability) => !capability.startsWith('github:actions:') && capability !== 'review:approve'), 'workflow:install'],
    // …and the release just before `review:approve` shipped.
    PREVIOUS_BUILTIN_CAPABILITIES.maintainer!.filter((capability) => capability !== 'review:approve'), [
    'project:read', 'task:*', 'queue:read', 'workflow:read', 'profile:read',
    'credential:read', 'skill:write', 'resolve-decision', 'confirm-decision', 'merge-into:*',
    'project:edit', 'project:settings:*', 'queue:write', 'profile:write',
    'workflow:install', 'workflow:edit',
  ]],
  administrator: [PREVIOUS_BUILTIN_CAPABILITIES.administrator!, PREVIOUS_ORGANIZATION_GRANT_CEILING, [...PREVIOUS_ORGANIZATION_GRANT_CEILING, 'workflow:install'],
    PREVIOUS_BUILTIN_CAPABILITIES.administrator!.filter(cap => !cap.startsWith('project:transfer-')),
    [...PREVIOUS_BUILTIN_CAPABILITIES.administrator!.filter(cap => !cap.startsWith('project:transfer-')), 'workflow:install'],
    [...PREVIOUS_BUILTIN_CAPABILITIES.administrator!, 'workflow:install'],
  ],
  operator: [[
    'project:read', 'task:*', 'queue:read', 'workflow:read', 'profile:read',
    'credential:read', 'skill:write', 'resolve-decision', 'confirm-decision', 'merge-into:*',
    'project:edit', 'project:settings:*', 'queue:write', 'profile:write',
    'workflow:install', 'workflow:edit', 'project:create', 'diagnostic:read',
    'process:*', 'credential:*', 'payment:*', 'settings:*',
  ]],
};

function sameCapabilities(a: Capability[], b: Capability[]): boolean {
  return a.length === b.length && a.every((capability) => b.includes(capability));
}

export const projectScope = (projectId: string): AuthorizationScope => `project:${projectId}`;
export const organizationScope = (organizationId: string): AuthorizationScope => `organization:${organizationId}`;

type CapabilityRead = { kind: 'organization' | 'grants' | 'profile' | 'projectMembers' | 'teamMember' | 'orgMember'; args: string[] };
function* capabilityRead<T>(kind: CapabilityRead['kind'], ...args: string[]): Generator<CapabilityRead, T, unknown> {
  return (yield { kind, args }) as T;
}

function* capabilityProfile(id: string, projectId?: string, organizationId?: string): Generator<CapabilityRead, AuthorizationProfile | undefined, unknown> {
  const org = organizationId ?? (projectId ? yield* capabilityRead<string | undefined>('organization', projectId) : undefined);
  for (const scope of [...(projectId ? [projectScope(projectId)] : []), ...(org ? [organizationScope(org)] : []), 'global']) {
    const profile = yield* capabilityRead<AuthorizationProfile | undefined>('profile', scope, id);
    if (profile) return profile;
  }
}

export class AuthorizationService {
  constructor(private store: Store) {
  }

  static async create(store: Store) {
    const instance = new AuthorizationService(store);
    await instance.initialize(store);
    return instance;
  }

  private async initialize(store: Store) {

    (await this.seed());
  }

  async seed(): Promise<void> {
    for (const profile of DEFAULT_AUTHORIZATION_PROFILES) {
      const stored = (await this.store.getAuthorizationProfile('global', profile.id)) as AuthorizationProfile | undefined;
      if (!stored) {
        (await this.store.setAuthorizationProfile('global', profile as any));
        continue;
      }
      const historical = LEGACY_BUILTIN_CAPABILITIES[profile.id] ?? [];
      const legacy = (stored.description === profile.description || stored.description === PREVIOUS_BUILTIN_DESCRIPTIONS[profile.id])
        && historical.some((caps) => sameCapabilities(stored.capabilities, caps));
      const shipped = SHIPPED_BUILTIN_PROFILES.some((version) => version.id === profile.id && version.description === stored.description
        && sameCapabilities(stored.capabilities, [...version.capabilities]));
      if (stored.builtin && stored.name === profile.name && (legacy || shipped)) {
        (await this.store.setAuthorizationProfile('global', profile as any));
      }
    }
    (await this.migrateLegacyGrants());
    (await this.promoteOwnersToSuperAdministrator());
    if (!(await this.store.kvGet('authz:default:global'))) (await this.store.kvSet('authz:default:global', 'developer'));
    (await this.migrateLegacyDefaults());
  }

  private async migrateLegacyDefaults(): Promise<void> {
    const keys = ['authz:default:global',
      ...(await this.store.listProjects()).map((project) => `authz:default:project:${project.id}`)];
    for (const key of keys) {
      const level = (await this.store.kvGet(key));
      if (level && !CANONICAL_AUTHORIZATION_LEVELS.includes(level as any)) (await this.store.kvSet(key, 'developer'));
    }
  }

  /** Administrator used to include the vault, payments and deleting the
   * organization. Owners keep them as Super-administrators; other
   * Administrators lose them. Runs once, so an owner later set to
   * Administrator on purpose stays there. */
  private async promoteOwnersToSuperAdministrator(): Promise<void> {
    const marker = 'authz:migration:owners-superadmin';
    if (await this.store.kvGet(marker)) return;
    for (const organization of (await this.store.listOrganizations())) {
      const scopeKey = organizationScope(organization.id);
      for (const membership of (await this.store.listOrganizationMemberships(organization.id))) {
        if (membership.role !== 'owner') continue;
        const principalId = `user:${membership.userId}`;
        const grant = (await this.store.listPrincipalGrants(principalId) as PrincipalGrant[])
          .find((candidate) => candidate.scopeKey === scopeKey);
        if (grant?.profileId !== 'administrator') continue;
        (await this.store.setPrincipalGrant(principalId, scopeKey, { ...grant, profileId: 'superadmin' }));
        (await this.audit('system:migration', 'authorization.grant.migrated', scopeKey,
          { principalId, from: 'administrator', to: 'superadmin' }));
      }
    }
    (await this.store.kvSet(marker, String(Date.now())));
  }

  private async migrateLegacyGrants(): Promise<void> {
    for (const grant of (await this.store.listPrincipalGrants()) as PrincipalGrant[]) {
      let profileId = grant.profileId;
      if (grant.scopeKey === 'global' && (profileId === 'operator' || profileId === 'administrator')) profileId = 'god';
      else if (grant.scopeKey.startsWith('organization:') && profileId === 'operator') profileId = 'administrator';
      else if (grant.scopeKey.startsWith('project:') && (profileId === 'operator' || ORGANIZATION_LEVELS[profileId])) profileId = 'maintainer';

      if (grant.scopeKey === 'global' && (profileId === 'developer' || profileId === 'maintainer' || profileId === 'viewer')) {
        for (const organization of (await this.store.listOrganizations())) {
          const scopeKey = organizationScope(organization.id);
          (await this.store.setPrincipalGrant(grant.principalId, scopeKey, { ...grant, scopeKey, profileId }));
        }
        (await this.store.deletePrincipalGrant(grant.principalId, grant.scopeKey));
      } else if (profileId !== grant.profileId) {
        (await this.store.setPrincipalGrant(grant.principalId, grant.scopeKey, { ...grant, profileId }));
      }
    }
  }

  async profiles(projectId?: string, organizationId?: string): Promise<AuthorizationProfile[]> {
    const global = new Map<string, AuthorizationProfile>(
      (await this.store.listAuthorizationProfiles('global')).filter((p) => p.id !== 'operator').map((p) => [p.id, p]),
    );
    const org = organizationId ?? (projectId ? (await this.store.getProject(projectId))?.organizationId : undefined);
    if (org) for (const p of (await this.store.listAuthorizationProfiles(organizationScope(org)))) global.set(p.id, p);
    if (projectId) {
      for (const p of (await this.store.listAuthorizationProfiles(projectScope(projectId)))) {
        if (p.id !== 'operator') global.set(p.id, p);
      }
    }
    return [...global.values()];
  }

  async profile(id: string, projectId?: string, organizationId?: string): Promise<AuthorizationProfile | undefined> {
    const org = organizationId ?? (projectId ? (await this.store.getProject(projectId))?.organizationId : undefined);
    return (projectId ? (await this.store.getAuthorizationProfile(projectScope(projectId), id)) : undefined)
      ?? (org ? (await this.store.getAuthorizationProfile(organizationScope(org), id)) : undefined)
      ?? (await this.store.getAuthorizationProfile('global', id));
  }

  async saveProfile(actor: string, scopeKey: AuthorizationScope, profile: AuthorizationProfile): Promise<AuthorizationProfile> {
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
    (await this.store.setAuthorizationProfile(scopeKey, saved));
    (await this.audit(actor, 'authorization.profile.saved', scopeKey, { profileId: saved.id, capabilities: saved.capabilities }));
    return { ...saved, scopeKey };
  }

  async createOrganizationRole(actor: string, organizationId: string, input: AuthorizationProfile, actorCaps: Capability[]): Promise<AuthorizationProfile> {
    if (!input || typeof input.name !== 'string' || !input.name.trim()
      || typeof input.description !== 'string' || !input.description.trim() || input.name.length > 80 || input.description.length > 240 || !Array.isArray(input.capabilities)
      || !input.capabilities.length || input.capabilities.some((cap) => typeof cap !== 'string' || !CAPABILITIES.includes(cap as any)))
      throw new Error('Choose a name, description, and at least one catalog capability');
    if (input.capabilities.some((cap) => !allows(ORGANIZATION_GRANT_CEILING, cap) || !allows(actorCaps, cap)))
      throw new AuthorizationGrantError('You cannot grant these capabilities in this organization');
    const name = input.name.trim();
    if ((await this.profiles(undefined, organizationId)).some((role) => role.name.toLowerCase() === name.toLowerCase()))
      throw new Error('A role with this name already exists');
    return (await this.saveProfile(actor, organizationScope(organizationId), {
      id: `role_${crypto.randomUUID()}`, name, description: input.description.trim(),
      capabilities: [...new Set(input.capabilities)], builtin: false,
    }));
  }

  async deleteProfile(actor: string, scopeKey: AuthorizationScope, id: string): Promise<void> {
    if (scopeKey === 'global' && DEFAULT_AUTHORIZATION_PROFILES.some((p) => p.id === id))
      throw new Error('built-in global profiles can be customized but not deleted');
    (await this.store.deleteAuthorizationProfile(scopeKey, id));
    (await this.audit(actor, 'authorization.profile.deleted', scopeKey, { profileId: id }));
  }

  async defaultProfile(projectId?: string): Promise<string> {
    const level = (projectId && (await this.store.kvGet(`authz:default:project:${projectId}`)))
      || (await this.store.kvGet('authz:default:global')) || 'developer';
    return CANONICAL_AUTHORIZATION_LEVELS.includes(level as any) ? level : 'developer';
  }

  async setDefault(actor: string, profileId: string, projectId?: string): Promise<void> {
    if (!CANONICAL_AUTHORIZATION_LEVELS.includes(profileId as any))
      throw new Error(`unknown authorization level ${profileId}`);
    const key = projectId ? `authz:default:project:${projectId}` : 'authz:default:global';
    (await this.store.kvSet(key, profileId));
    (await this.audit(actor, 'authorization.default.changed', projectId ? projectScope(projectId) : 'global', { profileId }));
  }

  async grants(principalId?: string): Promise<PrincipalGrant[]> {
    return (await this.store.listPrincipalGrants(principalId));
  }

  async grant(actor: string, input: Omit<PrincipalGrant, 'grantedBy' | 'grantedAt'>): Promise<PrincipalGrant> {
    const projectId = input.scopeKey.startsWith('project:') ? input.scopeKey.slice(8) : undefined;
    const profile = (await this.profile(input.profileId, projectId, input.scopeKey.startsWith('organization:') ? input.scopeKey.slice(13) : undefined));
    if (!profile) throw new Error(`unknown authorization profile ${input.profileId}`);
    const grant: PrincipalGrant = { ...input, grantedBy: actor, grantedAt: Date.now() };
    if (grant.capabilities && grant.capabilities.some((cap) => !allows(profile.capabilities, cap)))
      throw new Error('an explicit grant may narrow but not widen its authorization profile');
    (await this.store.setPrincipalGrant(grant.principalId, grant.scopeKey, grant as any));
    (await this.audit(actor, 'authorization.grant.saved', grant.scopeKey, { principalId: grant.principalId, profileId: grant.profileId }));
    return grant;
  }

  async revoke(actor: string, principalId: string, scopeKey: AuthorizationScope): Promise<void> {
    (await this.store.deletePrincipalGrant(principalId, scopeKey));
    (await this.audit(actor, 'authorization.grant.revoked', scopeKey, { principalId }));
  }

  async capabilities(principalId: string, projectId?: string, organizationId?: string): Promise<Capability[]> {
    const policy = this.capabilityPolicy(principalId, projectId, organizationId);
    const cache = new Map<string, unknown>();
    let step = policy.next();
    while (!step.done) {
      const request = step.value, key = JSON.stringify(request);
      if (!cache.has(key)) cache.set(key, (await this.readCapability(request)));
      step = policy.next(cache.get(key));
    }
    return step.value;
  }

  async capabilitiesAsync(principalId: string, projectId?: string, organizationId?: string): Promise<Capability[]> {
    const policy = this.capabilityPolicy(principalId, projectId, organizationId);
    // Request-local only: grants and memberships must be re-read on the next
    // request, including revocations after an identity token was cached.
    const cache = new Map<string, unknown>();
    let step = policy.next();
    while (!step.done) {
      const request = step.value, key = JSON.stringify(request);
      if (!cache.has(key)) cache.set(key, await this.readCapabilityAsync(request));
      step = policy.next(cache.get(key));
    }
    return step.value;
  }

  private async readCapability({ kind, args: [a, b] }: CapabilityRead): Promise<unknown> {
    switch (kind) {
      case 'organization': return (await this.store.getProject(a!))?.organizationId;
      case 'grants': return (await this.store.listPrincipalGrants(a!));
      case 'profile': return (await this.store.getAuthorizationProfile(a!, b!));
      case 'projectMembers': return (await this.store.listProjectMemberships(a!));
      case 'teamMember': return (await this.store.listTeamMemberships(a!)).some(member => member.userId === b);
      case 'orgMember': return Boolean((await this.store.organizationMembership(a!, b!)));
    }
  }

  private readCapabilityAsync({ kind, args: [a, b] }: CapabilityRead): Promise<unknown> {
    switch (kind) {
      case 'organization': return this.store.projectOrganizationAsync(a!);
      case 'grants': return this.store.listPrincipalGrantsAsync(a!);
      case 'profile': return this.store.getAuthorizationProfileAsync(a!, b!);
      case 'projectMembers': return this.store.listProjectMembershipsAsync(a!);
      case 'teamMember': return this.store.hasTeamMembershipAsync(a!, b!);
      case 'orgMember': return this.store.hasOrganizationMembershipAsync(a!, b!);
    }
  }

  private *capabilityPolicy(principalId: string, projectId?: string, organizationId?: string): Generator<CapabilityRead, Capability[], unknown> {
    // An absent subject is never the administrative “list all grants” query.
    if (!principalId) return [];
    const out = new Set<Capability>();
    const resolvedOrganizationId = organizationId ?? (projectId ? (yield* capabilityRead<string | undefined>('organization', projectId)) : undefined);
    const relevant = (yield* capabilityRead<PrincipalGrant[]>('grants', principalId)).filter((g) => g.scopeKey === 'global'
      || (resolvedOrganizationId && g.scopeKey === organizationScope(resolvedOrganizationId))
      || (projectId && g.scopeKey === projectScope(projectId)));
    for (const grant of relevant) {
      // A project overlay must not silently redefine an account's global grant.
      const p = grant.scopeKey === 'global' ? yield* capabilityProfile(grant.profileId) : yield* capabilityProfile(grant.profileId, projectId, resolvedOrganizationId);
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
      const projectOrganization = yield* capabilityRead<string | undefined>('organization', projectId);
      for (const membership of yield* capabilityRead<ProjectMembership[]>('projectMembers', projectId)) {
        const applies = membership.principal.kind === 'user' ? membership.principal.userId === userId
          : membership.principal.kind === 'team' ? yield* capabilityRead<boolean>('teamMember', membership.principal.teamId, userId)
          : membership.principal.kind === 'organization' ? membership.principal.organizationId === projectOrganization
            && Boolean(projectOrganization && (yield* capabilityRead<boolean>('orgMember', projectOrganization, userId))) : false;
        if (!applies) continue;
        const profileId = ['owner', 'admin', 'administrator', 'operator'].includes(membership.role)
          ? 'maintainer'
          : (yield* capabilityProfile(membership.role, projectId)) ? membership.role : 'developer';
        const profile = yield* capabilityProfile(profileId, projectId);
        if (profile) for (const cap of attenuate(profile.capabilities, PROJECT_GRANT_CEILING)) out.add(cap);
      }
    }
    return [...out];
  }

  /** Workflow grant = selected task profile capped by the creator's effective set. */
  async taskGrant(
    principalId: string,
    projectId: string,
    requestedProfileId?: string | AuthorizationSelection,
    grantorCaps?: Capability[],
  ): Promise<EffectiveAuthorization> {
    const requested = requestedProfileId ?? (await this.defaultProfile(projectId));
    return (await this.scopedTaskGrant(principalId, projectId, requested, grantorCaps));
  }

  /** The complete package represented by a selection, before it is attenuated
   * against any grantor. Used for gap explanations and recipient eligibility. */
  async requestedCapabilities(projectId: string, requested: AuthorizationSelection): Promise<Capability[]> {
    return (await this.scopedTaskGrant('system:authorization-preview', projectId, requested, ['*'])).capabilities;
  }

  async missingCapabilities(
    principalId: string,
    projectId: string,
    requested: AuthorizationSelection,
    grantorCaps?: Capability[],
  ): Promise<Capability[]> {
    const full = (await this.requestedCapabilities(projectId, requested));
    const held = (await this.scopedTaskGrant(principalId, projectId, requested, grantorCaps)).capabilities;
    return full.filter((capability) => !allows(held, capability));
  }

  async canGrantSelection(principalId: string, projectId: string, requested: AuthorizationSelection): Promise<boolean> {
    return !(await this.scopedTaskGrant(principalId, projectId, requested)).attenuated;
  }

  async scopedTaskGrant(
    principalId: string,
    taskProjectId: string,
    requested: AuthorizationSelection | string,
    grantorCaps?: Capability[],
  ): Promise<EffectiveAuthorization> {
    const taskProject = (await this.store.getProject(taskProjectId));
    if (!taskProject) throw new Error(`no project ${taskProjectId}`);
    const organizationId = taskProject.organizationId ?? 'org_personal';
    const legacy = typeof requested === 'string';
    const level = (requested === 'operator' ? 'god' : typeof requested === 'string' ? requested : requested.level)
      || (await this.defaultProfile(taskProjectId));
    const selection: AuthorizationSelection = typeof requested === 'string'
      ? { level, scope: level === 'god' ? 'global' : 'projects', projectIds: level === 'god' ? undefined : [taskProjectId] }
      : { ...requested, level };
    const normalized = (await this.normalizeSelection(selection, organizationId, legacy));
    const profile = (await this.profile(normalized.level,
      normalized.scope === 'projects' ? normalized.projectIds?.[0] : undefined, organizationId));
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
      const projectCaps = (await __asyncCollections.map(normalized.projectIds!, async (id) => (await this.capabilities(principalId, id, organizationId))));
      principal = projectCaps.slice(1).reduce((common, caps) => attenuate(common, caps), projectCaps[0] ?? []);
    } else if (normalized.scope === 'organization') {
      principal = (await this.capabilities(principalId, undefined, organizationId));
    } else {
      principal = (await this.capabilities(principalId));
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

  private async normalizeSelection(
    input: AuthorizationSelection,
    organizationId: string,
    allowLegacyAdministratorProject = false,
  ): Promise<AuthorizationSelection> {
    const level = String(input.level || '').trim();
    if (!CANONICAL_AUTHORIZATION_LEVELS.includes(level as any) && !(await this.store.getAuthorizationProfile(organizationScope(organizationId), level)))
      throw new Error(`unknown authorization level ${level}`);
    if (ORGANIZATION_LEVELS[level] && input.scope !== 'organization' && !(level === 'administrator' && allowLegacyAdministratorProject))
      throw new Error(`${ORGANIZATION_LEVELS[level]} requires organization scope`);
    if (level === 'god' && input.scope !== 'global') throw new Error('God requires global scope');
    if (!ORGANIZATION_LEVELS[level] && level !== 'god' && !['projects', 'organization'].includes(input.scope))
      throw new Error(`${level} requires project or organization scope`);
    if (input.scope === 'projects') {
      const projectIds = [...new Set((input.projectIds ?? []).map(String).filter(Boolean))];
      if (!projectIds.length) throw new Error('choose at least one project or @organization');
      for (const projectId of projectIds) {
        if ((await this.store.getProject(projectId))?.organizationId !== organizationId)
          throw new Error('authorization projects must belong to the same organization');
      }
      return { level, scope: 'projects', projectIds };
    }
    return { level, scope: input.scope };
  }

  async replacePrincipalAuthorization(
    actor: string,
    principalId: string,
    organizationId: string,
    selection: AuthorizationSelection,
    grantorCaps?: Capability[],
  ): Promise<AuthorizationSelection> {
    const normalized = (await this.normalizeSelection(selection, organizationId));
    (await this.assertCanGrantSelection(actor, organizationId, normalized, grantorCaps));
    (await this.assertCanChangePrincipal(actor, principalId, organizationId, grantorCaps));

    for (const grant of (await this.grants(principalId))) {
      const projectId = grant.scopeKey.startsWith('project:') ? grant.scopeKey.slice(8) : undefined;
      const belongs = grant.scopeKey === organizationScope(organizationId)
        || (projectId && (await this.store.getProject(projectId))?.organizationId === organizationId)
        || (grant.scopeKey === 'global' && ['god', 'administrator', 'operator'].includes(grant.profileId));
      if (belongs) (await this.revoke(actor, principalId, grant.scopeKey));
    }
    const scopes: AuthorizationScope[] = normalized.scope === 'global' ? ['global']
      : normalized.scope === 'organization' ? [organizationScope(organizationId)]
        : normalized.projectIds!.map(projectScope);
    for (const scopeKey of scopes) (await this.grant(actor, { principalId, scopeKey, profileId: normalized.level }));
    return normalized;
  }

  /** Changing or removing someone's authorization takes away what they hold,
   * so it needs the same authority as granting it. */
  async assertCanChangePrincipal(actor: string, principalId: string, organizationId: string, grantorCaps?: Capability[]): Promise<void> {
    const current = (await this.selectionForPrincipal(principalId, organizationId));
    if (!current) return;
    try {
      (await this.assertCanGrantSelection(actor, organizationId, current, grantorCaps));
    } catch (error) {
      if (error instanceof AuthorizationGrantError)
        throw new AuthorizationGrantError('you cannot change the authorization of someone who holds more than you');
      throw error;
    }
  }

  async assertCanGrantSelection(
    actor: string,
    organizationId: string,
    selection: AuthorizationSelection,
    grantorCaps?: Capability[],
  ): Promise<AuthorizationSelection> {
    const normalized = (await this.normalizeSelection(selection, organizationId));
    const project = (await this.store.listProjects()).find((candidate) => candidate.organizationId === organizationId);
    const effective = project
      ? (await this.scopedTaskGrant(actor, project.id, normalized, grantorCaps))
      : (await this.effectiveWithoutProject(actor, organizationId, normalized, grantorCaps));
    if (effective.attenuated)
      throw new AuthorizationGrantError('you cannot grant an authorization level you do not hold for the selected scope');
    return normalized;
  }

  private async effectiveWithoutProject(
    actor: string,
    organizationId: string,
    selection: AuthorizationSelection,
    grantorCaps?: Capability[],
  ): Promise<EffectiveAuthorization> {
    if (selection.scope === 'projects') throw new Error('this organization has no projects to authorize');
    const profile = (await this.profile(selection.level, undefined, organizationId));
    if (!profile) throw new Error(`unknown authorization level ${selection.level}`);
    const ceiling = selection.scope === 'organization'
      ? attenuate(profile.capabilities, ORGANIZATION_GRANT_CEILING) : profile.capabilities;
    const principal = grantorCaps ?? (await this.capabilities(actor, undefined,
      selection.scope === 'organization' ? organizationId : undefined));
    const capabilities = attenuate(ceiling, principal);
    return { ...selection, profileId: selection.level,
      ...(selection.scope === 'organization' ? { organizationId } : {}), capabilities,
      attenuated: ceiling.some((capability) => !allows(capabilities, capability)) };
  }

  async selectionForPrincipal(principalId: string, organizationId: string): Promise<AuthorizationSelection | undefined> {
    const grants = (await this.grants(principalId));
    const global = grants.find((grant) => grant.scopeKey === 'global' && grant.profileId === 'god');
    if (global) return { level: 'god', scope: 'global' };
    const organization = grants.find((grant) => grant.scopeKey === organizationScope(organizationId));
    if (organization && organization.profileId !== 'god' && (await this.profile(organization.profileId, undefined, organizationId)))
      return { level: organization.profileId, scope: 'organization' };
    const projects = (await __asyncCollections.filter(grants, async (grant) => grant.scopeKey.startsWith('project:')
      && (await this.store.getProject(grant.scopeKey.slice(8)))?.organizationId === organizationId
      && !ORGANIZATION_LEVELS[grant.profileId] && grant.profileId !== 'god'
      && (await this.profile(grant.profileId, grant.scopeKey.slice(8), organizationId))));
    if (!projects.length) return undefined;
    const level = projects[0]!.profileId;
    if (projects.some((grant) => grant.profileId !== level)) return undefined;
    const projectIds = (await __asyncCollections.sort(projects.map((grant) => grant.scopeKey.slice(8)), async (a, b) =>
      ((await this.store.getProject(a))?.name ?? a).localeCompare((await this.store.getProject(b))?.name ?? b)));
    return { level, scope: 'projects', projectIds };
  }

  async bootstrapAdministrator(userId: string): Promise<void> {
    if ((await this.store.listPrincipalGrants()).length) return;
    (await this.grant('system:bootstrap', { principalId: `user:${userId}`, scopeKey: 'global', profileId: 'god' }));
  }

  async bootstrapOrganizationOwner(actor: string, userId: string, organizationId: string): Promise<void> {
    (await this.grant(actor, { principalId: `user:${userId}`, scopeKey: organizationScope(organizationId), profileId: 'superadmin' }));
  }

  async audit(principalId: string, action: string, scopeKey: AuthorizationScope | string = 'global', detail: Record<string, unknown> = {}): Promise<number> {
    return (await this.store.appendAudit({ principalId, action, scopeKey, detail }));
  }
}
