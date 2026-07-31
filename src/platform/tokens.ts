import crypto from 'node:crypto';
import { Capability, allows, attenuate } from './capabilities.js';
import type { Store } from '../store/db.js';

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
}

export class TokenAuthority {
  private tokens = new Map<string, ScopedToken>();

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

  mint(args: MintArgs): { token: string; record: ScopedToken } {
    const id = `tok_${crypto.randomBytes(12).toString('hex')}`;
    const record: ScopedToken = {
      id,
      taskId: args.taskId,
      profileId: args.profileId,
      role: args.role,
      principal: args.principal,
      projectId: args.projectId,
      projectIds: args.projectIds?.length ? [...new Set(args.projectIds)] : undefined,
      organizationId: args.organizationId,
      caps: attenuate(args.ceiling, args.grantorCaps),
      issuedAt: Date.now(),
      expiresAt: Date.now() + (args.ttlMs ?? 24 * 60 * 60 * 1000),
      parentTokenId: args.parentTokenId,
      audience: args.audience ?? 'karmax-platform',
      executionId: args.executionId,
      worldGeneration: args.worldGeneration,
      kind: args.principal.startsWith('system:') ? 'system' : 'agent',
    };
    return this.issue(record);
  }

  /** Mint a token for a (non-task) principal such as a logged-in user. */
  mintPrincipal(principal: string, caps: Capability[], projectId?: string, ttlMs = 12 * 60 * 60 * 1000, organizationId?: string): { token: string; record: ScopedToken } {
    const id = `tok_${crypto.randomBytes(12).toString('hex')}`;
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
      kind: principal.startsWith('system:') ? 'system' : 'human',
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
    if (record && record.expiresAt > Date.now()) return record;
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
}
