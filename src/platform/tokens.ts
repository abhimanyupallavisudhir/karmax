import crypto from 'node:crypto';
import { Capability, allows, attenuate, OWN_TASK_CAPABILITIES } from './capabilities.js';
import type { TaskRecord } from '../domain/types.js';
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
  identitySessionId?: string;
  id: string;
  taskId: string;
  profileId: string;
  /** Workflow role running with this token; authorization comes from the task grant. */
  role?: string;
  /** Which agent of the task holds this token (software-dev ≥1.27:
   * `do`, `responder`, `confirm`, `agent-3`…); attribution, never authority. */
  participant?: string;
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
  /** Measurement provenance only; never grants authority. */
  executionAttempt?: number;
  executionRunId?: string;
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
  participant?: string;
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
  /** Measurement provenance only; never grants authority. */
  executionAttempt?: number;
  executionRunId?: string;
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

  private sessionValidator?: (sessionId: string, userId: string) => Promise<boolean>;
  connectIdentitySessions(validate: (sessionId: string, userId: string) => Promise<boolean>): void {
    this.sessionValidator = validate;
  }
  /** Is a browser (identity) session still signed in? True where none are
   * tracked. A lookup that fails throws: it is not a sign-out. */
  async identitySessionLive(sessionId: string, userId: string): Promise<boolean> {
    return this.sessionValidator ? this.sessionValidator(sessionId, userId) : true;
  }

  constructor(private store?: Store) {}

  private digest(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private async issue(record: ScopedToken): Promise<{ token: string; record: ScopedToken }> {
    const token = `kt_${record.id.slice(4)}.${crypto.randomBytes(32).toString('base64url')}`;
    const digest = this.digest(token);
    if (!this.store) this.tokens.set(digest, record);
    (await this.store?.putScopedToken(digest, record.id, record as unknown as Record<string, unknown>, record.expiresAt));
    return { token, record };
  }

  private async tokenById(id: string): Promise<ScopedToken | undefined> {
    if (this.store) return (await this.store.getScopedTokenById(id)) as unknown as ScopedToken | undefined;
    for (const record of this.tokens.values()) if (record.id === id && record.expiresAt > Date.now()) return record;
    return undefined;
  }

  private async delegation(id: string, visited = new Set<string>()): Promise<HumanDelegation | undefined> {
    if (visited.has(id)) return undefined;
    visited.add(id);
    const record = ((await this.store?.getHumanDelegation(id)) as unknown as HumanDelegation | undefined)
      ?? this.delegations.get(id);
    if (!record || record.expiresAt <= Date.now()) return undefined;
    if (await this.store?.kvGet(`account-closed:${record.humanUserId}`)) return undefined;
    if (record.parentDelegationId) {
      const parent = (await this.delegation(record.parentDelegationId, visited));
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

  private async delegationDescendsFrom(record: HumanDelegation, ancestorId: string): Promise<boolean> {
    let current: HumanDelegation | undefined = record;
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      if (current.id === ancestorId) return true;
      visited.add(current.id);
      current = current.parentDelegationId ? (await this.delegation(current.parentDelegationId)) : undefined;
    }
    return false;
  }

  /** Pin a human subject to a task from an already verified bearer. For an
   * interactive human, the external identity was selected by trusted host code;
   * an agent may only inherit its existing pinned identity unchanged. */
  async delegateHuman(token: string, args: HumanDelegationArgs): Promise<HumanDelegation | undefined> {
    const parent = (await this.verify(token));
    if (!parent?.humanSubject) return undefined;
    this.assertScopeWithin(parent, args);
    if (parent.kind === 'agent' && args.externalIdentities?.githubAccountId !== parent.externalIdentities?.githubAccountId)
      throw new Error('an agent cannot substitute a delegated GitHub account');
    return (await this.issueDelegation({ ...args, humanUserId: parent.humanSubject.userId,
      externalIdentities: args.externalIdentities ?? parent.externalIdentities,
      parentDelegationId: parent.delegationId,
      maxExpiresAt: parent.delegationId ? (await this.delegation(parent.delegationId))?.expiresAt : undefined }));
  }

  /** Pin the subject of a live human session to a scope already authorized by
   * the durable authorization service. Browser API tokens are narrowed to the
   * project in the current route, so their resource scope cannot also be used as
   * the authority boundary for an explicitly verified multi-project,
   * organization, or global task grant. This trusted path deliberately accepts
   * only an interactive human — delegated agents must keep using
   * `delegateHuman`, which enforces strict scope attenuation. */
  async delegateAuthorizedInteractiveHuman(token: string, args: HumanDelegationArgs): Promise<HumanDelegation | undefined> {
    const parent = (await this.verify(token));
    if (!parent?.humanSubject) return undefined;
    if (parent.kind !== 'human' || parent.humanSubject.presence !== 'interactive')
      throw new Error('authorized delegation requires an interactive human');
    return (await this.issueDelegation({ ...args, humanUserId: parent.humanSubject.userId,
      externalIdentities: args.externalIdentities ?? parent.externalIdentities }));
  }

  /** Derive a child-task delegation from durable parent provenance. This is used
   * by workflow activities after the short-lived parent bearer is gone. */
  async deriveHumanDelegation(parentDelegationId: string, args: {
    taskId: string; projectId?: string; projectIds?: string[]; organizationId?: string; ttlMs?: number;
  }): Promise<HumanDelegation> {
    const parent = (await this.delegation(parentDelegationId));
    if (!parent) throw new Error('invalid or expired human delegation');
    this.assertScopeWithin(parent, args);
    return (await this.issueDelegation({ ...args, humanUserId: parent.humanUserId,
      externalIdentities: parent.externalIdentities, parentDelegationId, maxExpiresAt: parent.expiresAt }));
  }

  private async issueDelegation(args: {
    taskId: string; humanUserId: string; projectId?: string; projectIds?: string[]; organizationId?: string;
    externalIdentities?: ExternalIdentityClaims; parentDelegationId?: string; ttlMs?: number; maxExpiresAt?: number;
  }): Promise<HumanDelegation> {
    const issuedAt = Date.now();
    const expiresAt = Math.min(issuedAt + (args.ttlMs ?? 30 * 24 * 60 * 60 * 1000), args.maxExpiresAt ?? Number.MAX_SAFE_INTEGER);
    const record: HumanDelegation = {
      id: `dlg_${crypto.randomBytes(12).toString('hex')}`, taskId: args.taskId, humanUserId: args.humanUserId,
      projectId: args.projectId, projectIds: args.projectIds?.length ? [...new Set(args.projectIds)] : undefined,
      organizationId: args.organizationId, externalIdentities: args.externalIdentities,
      parentDelegationId: args.parentDelegationId, issuedAt, expiresAt,
    };
    if (this.store) (await this.store.putHumanDelegation(record.id, record as unknown as Record<string, unknown>, expiresAt));
    else this.delegations.set(record.id, record);
    return record;
  }

  async mint(args: MintArgs): Promise<{ token: string; record: ScopedToken }> {
    const id = `tok_${crypto.randomBytes(12).toString('hex')}`;
    const parent = args.parentTokenId ? (await this.tokenById(args.parentTokenId)) : undefined;
    if (args.parentTokenId && !parent) throw new Error('invalid or expired parent token');
    if (parent) this.assertScopeWithin(parent, args);
    const delegationId = args.delegationId ?? parent?.delegationId;
    const delegation = delegationId ? (await this.delegation(delegationId)) : undefined;
    if (delegationId && (!delegation || delegation.taskId !== args.taskId))
      throw new Error('invalid, expired, or task-mismatched human delegation');
    if (delegation) this.assertScopeWithin(delegation, args);
    if (parent && delegation && (!parent.humanSubject
      || parent.humanSubject.userId !== delegation.humanUserId
      || parent.delegationId && !(await this.delegationDescendsFrom(delegation, parent.delegationId))))
      throw new Error('child token human delegation does not descend from its parent token');
    const grantorCaps = parent ? attenuate(args.grantorCaps, parent.caps) : args.grantorCaps;
    const expiresAt = Math.min(Date.now() + (args.ttlMs ?? 24 * 60 * 60 * 1000),
      parent?.expiresAt ?? Number.MAX_SAFE_INTEGER, delegation?.expiresAt ?? Number.MAX_SAFE_INTEGER);
    const record: ScopedToken = {
      id,
      taskId: args.taskId,
      profileId: args.profileId,
      role: args.role,
      ...(args.participant ? { participant: args.participant } : {}),
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
      executionAttempt: args.executionAttempt,
      executionRunId: args.executionRunId,
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
    return (await this.issue(record));
  }

  /** Mint a token for a (non-task) principal such as a logged-in user. */
  async mintPrincipal(principal: string, caps: Capability[], projectId?: string, ttlMs = 12 * 60 * 60 * 1000, organizationId?: string, identitySessionId?: string): Promise<{ token: string; record: ScopedToken }> {
    const id = `tok_${crypto.randomBytes(12).toString('hex')}`;
    const userId = principal.startsWith('user:') && principal.length > 5 ? principal.slice(5) : undefined;
    const system = principal.startsWith('system:');
    const record: ScopedToken = {
      id,
      taskId: '*',
      profileId: 'user',
      identitySessionId,
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
    return (await this.issue(record));
  }

  async verify(token: string): Promise<ScopedToken | undefined> {
    const digest = this.digest(token);
    // A durable authority deliberately checks shared state on every request so
    // revocation by another gateway replica takes effect immediately.
    const record = this.store
      ? (await this.store.getScopedToken(digest)) as unknown as ScopedToken | undefined
      : this.tokens.get(digest);
    if (record && record.expiresAt > Date.now()) {
      if (record.identitySessionId && !(await this.sessionValidator?.(record.identitySessionId,
        record.principal.slice(5)).catch(() => false))) {
        await this.revoke(token);
        return undefined;
      }
      const subject = record.humanSubject?.userId
        ?? (record.actor?.kind === 'interactive-human' ? record.actor.userId : undefined);
      const users = new Set([subject, record.principal.startsWith('user:') ? record.principal.slice(5) : undefined]);
      for (const userId of users)
        if (userId && await this.store?.kvGet(`account-closed:${userId}`)) return undefined;
      if (record.parentTokenId && !(await this.tokenById(record.parentTokenId))) return undefined;
      if (record.delegationId) {
        const delegation = (await this.delegation(record.delegationId));
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
      (await this.store?.revokeScopedToken({ tokenHash: digest }));
    }
    return undefined;
  }

  /** Where a refused capability was looked for, in words a person and an
   * agent can both act on: the project and organization, by name and id. */
  private async describeScope(record: ScopedToken, scope?: { projectId?: string; taskId?: string; organizationId?: string }): Promise<string> {
    const projectId = scope?.projectId ?? (scope?.taskId ? await this.store?.taskProjectIdAsync(scope.taskId) : undefined)
      ?? (scope?.organizationId ? undefined : record.projectId);
    const project = projectId ? await this.store?.getProject(projectId) : undefined;
    const organizationId = scope?.organizationId ?? project?.organizationId ?? record.organizationId;
    const organization = organizationId ? await this.store?.getOrganization(organizationId) : undefined;
    const named = (kind: string, id: string, name?: string) => name ? `${kind} ${JSON.stringify(name)} (${id})` : `${kind} ${id}`;
    if (projectId && organizationId)
      return `in ${named('project', projectId, project?.name)} of ${named('organization', organizationId, organization?.name)}`;
    if (projectId) return `in ${named('project', projectId, project?.name)}`;
    if (organizationId) return `in ${named('organization', organizationId, organization?.name)}`;
    return 'across the installation (the request names no project or organization)';
  }

  /** Verify the token and check it allows the requested capability. */
  async check(token: string, capability: Capability, scope?: { projectId?: string; taskId?: string; organizationId?: string;
    audience?: ScopedToken['audience']; executionId?: string; worldGeneration?: number }): Promise<{ ok: boolean; record?: ScopedToken; reason?: string; missing?: Capability }> {
    const record = (await this.verify(token));
    if (!record) return { ok: false, reason: 'invalid or expired token' };
    if (!allows(record.caps, capability) && !(OWN_TASK_CAPABILITIES.has(capability)
      && allows(record.caps, 'task:manage-own') && scope?.taskId
      && await this.ownsTask(record, scope.taskId)))
      return { ok: false, record, missing: capability, reason: `missing capability ${capability} ${(await this.describeScope(record, scope))}` };
    // Resolve the tenant from durable ownership, including callers that pass
    // only a project/task ID. A transfer must immediately fence old org tokens.
    // A task decides its own project: a scope that pairs it with another one
    // would otherwise be checked against the project the caller named.
    const taskProjectId = scope?.taskId ? (await this.store?.taskProjectIdAsync(scope.taskId)) : undefined;
    if (taskProjectId && scope?.projectId && taskProjectId !== scope.projectId)
      return { ok: false, record, reason: 'task belongs to another project' };
    const projectId = scope?.projectId ?? taskProjectId;
    const projectOrganization = projectId ? await this.store?.projectOrganizationAsync(projectId) : undefined;
    if (projectOrganization && record.organizationId && projectOrganization !== record.organizationId)
      return { ok: false, record, reason: 'project belongs to another organization' };
    if (projectId && !capability.endsWith(':read') && !capability.startsWith('project:transfer-')) {
      const lock = await this.store?.kvGet(`project-transfer-lock:${projectId}`);
      if (lock && JSON.parse(lock).expiresAt > Date.now()
        && !(JSON.parse(lock).kind === 'delete' && capability === 'project:delete'))
        return { ok: false, record, reason: 'project move in progress; retry when it finishes' };
    }
    if (scope?.taskId && await this.store?.kvGet(`project-transfer-history:${scope.taskId}`)
      && ['task:signal', 'task:create', 'task:edit', 'task:conversation:message', 'task:review:execute', 'task:git:publish',
        'resolve-decision', 'confirm-decision', 'review:approve'].includes(capability))
      return { ok: false, record, reason: 'This task is history from before the project moved. Start a new task to continue work.' };

    // Historical records predate the audience field and are platform-only by
    // construction. Treat them as this audience during their bounded TTL.
    if ((record.audience ?? 'karmax-platform') !== (scope?.audience ?? 'karmax-platform'))
      return { ok: false, record, reason: 'token audience mismatch' };
    if (scope?.executionId && record.executionId && scope.executionId !== record.executionId)
      return { ok: false, record, reason: 'token execution lease mismatch' };
    if (scope?.worldGeneration != null && record.worldGeneration != null && scope.worldGeneration !== record.worldGeneration)
      return { ok: false, record, reason: 'token world generation mismatch' };
    if (record.projectId && projectId && record.projectId !== projectId)
      return { ok: false, record, reason: `token is scoped to project ${record.projectId}` };
    if (record.projectIds?.length && projectId && !record.projectIds.includes(projectId))
      return { ok: false, record, reason: `token is scoped to selected projects ${record.projectIds.join(', ')}` };
    if (record.organizationId && scope?.organizationId && record.organizationId !== scope.organizationId)
      return { ok: false, record, reason: `token is scoped to organization ${record.organizationId}` };
    // Origin task identity restricts only the explicit task:manage-own fallback.
    // Ordinary named capabilities continue to authorize peer work in scope.
    return { ok: true, record };
  }

  private async ownsTask(record: ScopedToken, taskId: string): Promise<boolean> {
    // The actor owns work, never the human whose authority it was delegated.
    const actor = record.actor;
    if (!actor) return false;
    // Legacy workflow tokens use a system principal but still carry a concrete
    // originating task. Interactive and autonomous principal tokens carry '*'.
    const originTaskId = actor.kind === 'task-agent' ? actor.taskId
      : actor.kind === 'system' && record.taskId !== '*' ? record.taskId : undefined;
    const seen = new Set<string>();
    let id: string | undefined = taskId;
    while (id && !seen.has(id)) {
      seen.add(id);
      if (originTaskId && id === originTaskId) return true;
      const task: TaskRecord | undefined = await this.store?.taskMetadataAsync(id);
      if (!task) return false;
      const creator = task.createdBy;
      if (actor.kind === 'interactive-human' && creator?.kind === 'user' && creator.userId === actor.userId) return true;
      if (actor.kind === 'autonomous' && creator?.kind === 'avatar' && actor.principal === `avatar:${creator.avatarId}`) return true;
      if (originTaskId && creator?.kind === 'task-agent' && creator.taskId === originTaskId) return true;
      id = task.parentTaskId;
    }
    return false;
  }

  async revoke(token: string) {
    const digest = this.digest(token);
    const record = this.tokens.get(digest);
    this.tokens.delete(digest);
    (await this.store?.revokeScopedToken(record ? { tokenId: record.id } : { tokenHash: digest }));
  }

  async revokeTaskDelegation(taskId: string): Promise<number> {
    if (this.store) return (await this.store.revokeHumanDelegationsForTask(taskId));
    let revoked = 0;
    for (const [id, record] of this.delegations) if (record.taskId === taskId) {
      this.delegations.delete(id); revoked++;
    }
    return revoked;
  }
}
