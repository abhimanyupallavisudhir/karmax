import crypto from 'node:crypto';
import { Capability, allows, attenuate } from './capabilities.js';
import type { Store } from '../store/db.js';

export type TokenActor =
  | { kind: 'interactive-human'; userId: string }
  | { kind: 'task-agent'; taskId: string; profileId: string; role?: string }
  | { kind: 'system'; principal: string }
  | { kind: 'autonomous'; principal: string };

export interface VerifiedHumanSubject {
  kind: 'user';
  userId: string;
  presence: 'interactive' | 'delegated';
  externalIdentities?: ExternalIdentityClaims;
}

export interface ExternalIdentityClaims {
  githubAccountId?: string;
}

/** Durable, authority-minted provenance. Tasks store only this opaque id; the
 * human subject and external identities are reloaded and verified whenever an
 * agent token is minted or used. */
export interface HumanDelegation {
  id: string;
  taskId: string;
  humanUserId: string;
  projectId?: string;
  projectIds?: string[];
  organizationId?: string;
  externalIdentities?: ExternalIdentityClaims;
  parentDelegationId?: string;
  issuedAt: number;
  expiresAt: number;
}

export interface HumanDelegationArgs {
  taskId: string;
  projectId?: string;
  projectIds?: string[];
  organizationId?: string;
  externalIdentities?: ExternalIdentityClaims;
  ttlMs?: number;
}

/**
 * Workflow-minted scoped tokens (SPEC §8.3). The workflow mints the agent's
 * credential when it spawns the agent — it alone knows the task, the profile,
 * and the granting user — issuing a token scoped to the effective capability
 * set. The platform MCP server checks each call against this token.
 */
export interface ScopedToken {
  id: string;
  taskId: string;
  profileId: string;
  /** Workflow role whose ceiling shaped this agent token. */
  role?: string;
  principal: string; // the granting user/principal id
  projectId?: string;
  /** A task may be delegated the same level across an explicit project list. */
  projectIds?: string[];
  organizationId?: string;
  caps: Capability[]; // effective (attenuated) capabilities
  issuedAt: number;
  expiresAt: number;
  parentTokenId?: string;
  /** Confused-deputy boundary. Platform tokens cannot be replayed at a runner or
   * provider API even if a future endpoint accidentally accepts the same shape. */
  audience: 'karmax-platform';
  /** Stable execution/turn lease that caused this credential to exist. */
  executionId?: string;
  worldGeneration?: number;
  kind: 'agent' | 'human' | 'system';
  /** The executor is deliberately distinct from the authority grantor in
   * `principal` and from the optional human on whose behalf it acts. */
  actor: TokenActor;
  humanSubject?: VerifiedHumanSubject;
  delegationId?: string;
  externalIdentities?: ExternalIdentityClaims;
}

export interface MintArgs {
  taskId: string;
  profileId: string;
  role?: string;
  principal: string;
  projectId?: string;
  projectIds?: string[];
  organizationId?: string;
  /** The profile-declared ceiling (the most it may attempt). */
  ceiling: Capability[];
  /** The granting principal's capabilities. */
  grantorCaps: Capability[];
  parentTokenId?: string;
  ttlMs?: number;
  audience?: ScopedToken['audience'];
  executionId?: string;
  worldGeneration?: number;
  /** Opaque authority-minted delegation provenance. Callers cannot supply a
   * user id or external account directly to token minting. */
  delegationId?: string;
  /** Autonomous principals such as Avatars may carry an explicitly delegated
   * external account without impersonating an interactive human. */
  externalIdentities?: ExternalIdentityClaims;
}

export class TokenAuthority {
  private tokens = new Map<string, ScopedToken>();
  private delegations = new Map<string, HumanDelegation>();

  constructor(private store?: Store) {}

  private digest(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private issue(record: ScopedToken): { token: string; record: ScopedToken } {
    const token = `kt_${record.id.slice(4)}.${crypto.randomBytes(32).toString('base64url')}`;
    const digest = this.digest(token);
    this.tokens.set(digest, record);
    this.store?.putScopedToken(digest, record.id, record as unknown as Record<string, unknown>, record.expiresAt);
    return { token, record };
  }

  private tokenById(id: string): ScopedToken | undefined {
    if (this.store) return this.store.getScopedTokenById(id) as unknown as ScopedToken | undefined;
    for (const record of this.tokens.values()) if (record.id === id && record.expiresAt > Date.now()) return record;
    return undefined;
  }

  private delegation(id: string, visited = new Set<string>()): HumanDelegation | undefined {
    if (visited.has(id)) return undefined;
    visited.add(id);
    const record = (this.store?.getHumanDelegation(id) as unknown as HumanDelegation | undefined)
      ?? this.delegations.get(id);
    if (!record || record.expiresAt <= Date.now()) return undefined;
    if (record.parentDelegationId) {
      const parent = this.delegation(record.parentDelegationId, visited);
      if (!parent || parent.humanUserId !== record.humanUserId) return undefined;
      if (parent.organizationId && record.organizationId !== parent.organizationId) return undefined;
      if (parent.projectId && record.projectId !== parent.projectId) return undefined;
      const recordProjects = record.projectIds?.length ? record.projectIds : record.projectId ? [record.projectId] : [];
      if (parent.projectIds?.length && (!recordProjects.length
        || recordProjects.some((projectId) => !parent.projectIds!.includes(projectId)))) return undefined;
      if (record.externalIdentities?.githubAccountId !== parent.externalIdentities?.githubAccountId) return undefined;
      if (record.expiresAt > parent.expiresAt) return undefined;
    }
    return record;
  }

  private assertScopeWithin(parent: Pick<ScopedToken | HumanDelegation, 'projectId' | 'projectIds' | 'organizationId'>,
    target: { projectId?: string; projectIds?: string[]; organizationId?: string }): void {
    if (parent.organizationId && target.organizationId !== parent.organizationId)
      throw new Error(`delegation is scoped to organization ${parent.organizationId}`);
    const targets = target.projectIds?.length ? target.projectIds : target.projectId ? [target.projectId] : [];
    if (parent.projectId && (targets.length !== 1 || targets[0] !== parent.projectId))
      throw new Error(`delegation is scoped to project ${parent.projectId}`);
    if (parent.projectIds?.length && (!targets.length
      || targets.some((projectId) => !parent.projectIds!.includes(projectId))))
      throw new Error(`delegation is scoped to selected projects ${parent.projectIds.join(', ')}`);
  }

  private delegationDescendsFrom(record: HumanDelegation, ancestorId: string): boolean {
    let current: HumanDelegation | undefined = record;
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      if (current.id === ancestorId) return true;
      visited.add(current.id);
      current = current.parentDelegationId ? this.delegation(current.parentDelegationId) : undefined;
    }
    return false;
  }

  /** Pin a human subject to a task from an already verified bearer. For an
   * interactive human, the external identity was selected by trusted host code;
   * an agent may only inherit its existing pinned identity unchanged. */
  delegateHuman(token: string, args: HumanDelegationArgs): HumanDelegation | undefined {
    const parent = this.verify(token);
    if (!parent?.humanSubject) return undefined;
    this.assertScopeWithin(parent, args);
    if (parent.kind === 'agent' && args.externalIdentities?.githubAccountId !== parent.externalIdentities?.githubAccountId)
      throw new Error('an agent cannot substitute a delegated GitHub account');
    return this.issueDelegation({ ...args, humanUserId: parent.humanSubject.userId,
      externalIdentities: args.externalIdentities ?? parent.externalIdentities,
      parentDelegationId: parent.delegationId,
      maxExpiresAt: parent.delegationId ? this.delegation(parent.delegationId)?.expiresAt : undefined });
  }

  /** Pin the subject of a live human session to a scope already authorized by
   * the durable authorization service. Browser API tokens are narrowed to the
   * project in the current route, so their resource scope cannot also be used as
   * the authority boundary for an explicitly verified multi-project,
   * organization, or global task grant. This trusted path deliberately accepts
   * only an interactive human — delegated agents must keep using
   * `delegateHuman`, which enforces strict scope attenuation. */
  delegateAuthorizedInteractiveHuman(token: string, args: HumanDelegationArgs): HumanDelegation | undefined {
    const parent = this.verify(token);
    if (!parent?.humanSubject) return undefined;
    if (parent.kind !== 'human' || parent.humanSubject.presence !== 'interactive')
      throw new Error('authorized delegation requires an interactive human');
    return this.issueDelegation({ ...args, humanUserId: parent.humanSubject.userId,
      externalIdentities: args.externalIdentities ?? parent.externalIdentities });
  }

  /** Derive a child-task delegation from durable parent provenance. This is used
   * by workflow activities after the short-lived parent bearer is gone. */
  deriveHumanDelegation(parentDelegationId: string, args: {
    taskId: string; projectId?: string; projectIds?: string[]; organizationId?: string; ttlMs?: number;
  }): HumanDelegation {
    const parent = this.delegation(parentDelegationId);
    if (!parent) throw new Error('invalid or expired human delegation');
    this.assertScopeWithin(parent, args);
    return this.issueDelegation({ ...args, humanUserId: parent.humanUserId,
      externalIdentities: parent.externalIdentities, parentDelegationId, maxExpiresAt: parent.expiresAt });
  }

  private issueDelegation(args: {
    taskId: string; humanUserId: string; projectId?: string; projectIds?: string[]; organizationId?: string;
    externalIdentities?: ExternalIdentityClaims; parentDelegationId?: string; ttlMs?: number; maxExpiresAt?: number;
  }): HumanDelegation {
    const issuedAt = Date.now();
    const expiresAt = Math.min(issuedAt + (args.ttlMs ?? 30 * 24 * 60 * 60 * 1000), args.maxExpiresAt ?? Number.MAX_SAFE_INTEGER);
    const record: HumanDelegation = {
      id: `dlg_${crypto.randomBytes(12).toString('hex')}`, taskId: args.taskId, humanUserId: args.humanUserId,
      projectId: args.projectId, projectIds: args.projectIds?.length ? [...new Set(args.projectIds)] : undefined,
      organizationId: args.organizationId, externalIdentities: args.externalIdentities,
      parentDelegationId: args.parentDelegationId, issuedAt, expiresAt,
    };
    if (this.store) this.store.putHumanDelegation(record.id, record as unknown as Record<string, unknown>, expiresAt);
    else this.delegations.set(record.id, record);
    return record;
  }

  mint(args: MintArgs): { token: string; record: ScopedToken } {
    const id = `tok_${crypto.randomBytes(12).toString('hex')}`;
    const parent = args.parentTokenId ? this.tokenById(args.parentTokenId) : undefined;
    if (args.parentTokenId && !parent) throw new Error('invalid or expired parent token');
    if (parent) this.assertScopeWithin(parent, args);
    const delegationId = args.delegationId ?? parent?.delegationId;
    const delegation = delegationId ? this.delegation(delegationId) : undefined;
    if (delegationId && (!delegation || delegation.taskId !== args.taskId))
      throw new Error('invalid, expired, or task-mismatched human delegation');
    if (delegation) this.assertScopeWithin(delegation, args);
    if (parent && delegation && (!parent.humanSubject
      || parent.humanSubject.userId !== delegation.humanUserId
      || parent.delegationId && !this.delegationDescendsFrom(delegation, parent.delegationId)))
      throw new Error('child token human delegation does not descend from its parent token');
    const grantorCaps = parent ? attenuate(args.grantorCaps, parent.caps) : args.grantorCaps;
    const expiresAt = Math.min(Date.now() + (args.ttlMs ?? 24 * 60 * 60 * 1000),
      parent?.expiresAt ?? Number.MAX_SAFE_INTEGER, delegation?.expiresAt ?? Number.MAX_SAFE_INTEGER);
    const record: ScopedToken = {
      id,
      taskId: args.taskId,
      profileId: args.profileId,
      role: args.role,
      principal: args.principal,
      projectId: args.projectId,
      projectIds: args.projectIds?.length ? [...new Set(args.projectIds)] : undefined,
      organizationId: args.organizationId,
      caps: attenuate(args.ceiling, grantorCaps),
      issuedAt: Date.now(),
      expiresAt,
      parentTokenId: args.parentTokenId,
      audience: args.audience ?? 'karmax-platform',
      executionId: args.executionId,
      worldGeneration: args.worldGeneration,
      kind: args.principal.startsWith('system:') ? 'system' : 'agent',
      actor: args.principal.startsWith('system:')
        ? { kind: 'system', principal: args.principal }
        : { kind: 'task-agent', taskId: args.taskId, profileId: args.profileId, role: args.role },
      ...(args.externalIdentities ? { externalIdentities: args.externalIdentities } : {}),
      ...(delegation ? {
        humanSubject: { kind: 'user' as const, userId: delegation.humanUserId, presence: 'delegated' as const,
          externalIdentities: delegation.externalIdentities },
        delegationId: delegation.id,
        externalIdentities: delegation.externalIdentities,
      } : {}),
    };
    return this.issue(record);
  }

  /** Mint a token for a (non-task) principal such as a logged-in user. */
  mintPrincipal(principal: string, caps: Capability[], projectId?: string, ttlMs = 12 * 60 * 60 * 1000, organizationId?: string): { token: string; record: ScopedToken } {
    const id = `tok_${crypto.randomBytes(12).toString('hex')}`;
    const userId = principal.startsWith('user:') && principal.length > 5 ? principal.slice(5) : undefined;
    const system = principal.startsWith('system:');
    const record: ScopedToken = {
      id,
      taskId: '*',
      profileId: 'user',
      principal,
      projectId,
      organizationId,
      caps,
      issuedAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      audience: 'karmax-platform',
      kind: system ? 'system' : 'human',
      actor: system ? { kind: 'system', principal }
        : userId ? { kind: 'interactive-human', userId }
        : { kind: 'autonomous', principal },
      ...(userId ? { humanSubject: { kind: 'user' as const, userId, presence: 'interactive' as const } } : {}),
    };
    return this.issue(record);
  }

  verify(token: string): ScopedToken | undefined {
    const digest = this.digest(token);
    // A durable authority deliberately checks shared state on every request so
    // revocation by another gateway replica takes effect immediately.
    const record = this.store
      ? this.store.getScopedToken(digest) as unknown as ScopedToken | undefined
      : this.tokens.get(digest);
    if (record && record.expiresAt > Date.now()) {
      if (record.parentTokenId && !this.tokenById(record.parentTokenId)) return undefined;
      if (record.delegationId) {
        const delegation = this.delegation(record.delegationId);
        if (!delegation || delegation.taskId !== record.taskId
          || delegation.humanUserId !== record.humanSubject?.userId
          || delegation.externalIdentities?.githubAccountId !== record.externalIdentities?.githubAccountId
          || delegation.externalIdentities?.githubAccountId !== record.humanSubject?.externalIdentities?.githubAccountId)
          return undefined;
      }
      return record;
    }
    if (record) {
      this.tokens.delete(digest);
      this.store?.revokeScopedToken({ tokenHash: digest });
    }
    return undefined;
  }

  /** Verify the token and check it allows the requested capability. */
  check(token: string, capability: Capability, scope?: { projectId?: string; taskId?: string; organizationId?: string;
    audience?: ScopedToken['audience']; executionId?: string; worldGeneration?: number }): { ok: boolean; record?: ScopedToken; reason?: string } {
    const record = this.verify(token);
    if (!record) return { ok: false, reason: 'invalid or expired token' };
    if (!allows(record.caps, capability)) return { ok: false, record, reason: `missing capability ${capability}` };
    // Historical records predate the audience field and are platform-only by
    // construction. Treat them as this audience during their bounded TTL.
    if ((record.audience ?? 'karmax-platform') !== (scope?.audience ?? 'karmax-platform'))
      return { ok: false, record, reason: 'token audience mismatch' };
    if (scope?.executionId && record.executionId && scope.executionId !== record.executionId)
      return { ok: false, record, reason: 'token execution lease mismatch' };
    if (scope?.worldGeneration != null && record.worldGeneration != null && scope.worldGeneration !== record.worldGeneration)
      return { ok: false, record, reason: 'token world generation mismatch' };
    if (record.projectId && scope?.projectId && record.projectId !== scope.projectId)
      return { ok: false, record, reason: `token is scoped to project ${record.projectId}` };
    if (record.projectIds?.length && scope?.projectId && !record.projectIds.includes(scope.projectId))
      return { ok: false, record, reason: `token is scoped to selected projects ${record.projectIds.join(', ')}` };
    if (record.organizationId && scope?.organizationId && record.organizationId !== scope.organizationId)
      return { ok: false, record, reason: `token is scoped to organization ${record.organizationId}` };
    // `taskId` records which workflow minted the token; it is provenance, not an
    // implicit object ACL. Project scope + named capabilities decide which other
    // tasks the agent may discover or coordinate with. A future explicit
    // resource-task scope should be a separate field, never inferred here.
    return { ok: true, record };
  }

  revoke(token: string) {
    const digest = this.digest(token);
    const record = this.tokens.get(digest);
    this.tokens.delete(digest);
    this.store?.revokeScopedToken(record ? { tokenId: record.id } : { tokenHash: digest });
  }

  revokeTaskDelegation(taskId: string): number {
    if (this.store) return this.store.revokeHumanDelegationsForTask(taskId);
    let revoked = 0;
    for (const [id, record] of this.delegations) if (record.taskId === taskId) {
      this.delegations.delete(id); revoked++;
    }
    return revoked;
  }
}
