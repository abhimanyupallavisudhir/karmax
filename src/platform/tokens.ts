import crypto from 'node:crypto';
import { Capability, allows, attenuate } from './capabilities.js';

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
  principal: string; // the granting user/principal id
  projectId?: string;
  caps: Capability[]; // effective (attenuated) capabilities
  issuedAt: number;
  expiresAt: number;
  parentTokenId?: string;
  kind: 'agent' | 'human' | 'system';
}

export interface MintArgs {
  taskId: string;
  profileId: string;
  principal: string;
  projectId?: string;
  /** The profile-declared ceiling (the most it may attempt). */
  ceiling: Capability[];
  /** The granting principal's capabilities. */
  grantorCaps: Capability[];
  parentTokenId?: string;
  ttlMs?: number;
}

export class TokenAuthority {
  private tokens = new Map<string, ScopedToken>();

  mint(args: MintArgs): { token: string; record: ScopedToken } {
    const id = `kt_${crypto.randomBytes(18).toString('hex')}`;
    const record: ScopedToken = {
      id,
      taskId: args.taskId,
      profileId: args.profileId,
      principal: args.principal,
      projectId: args.projectId,
      caps: attenuate(args.ceiling, args.grantorCaps),
      issuedAt: Date.now(),
      expiresAt: Date.now() + (args.ttlMs ?? 24 * 60 * 60 * 1000),
      parentTokenId: args.parentTokenId,
      kind: args.principal.startsWith('system:') ? 'system' : 'agent',
    };
    this.tokens.set(id, record);
    return { token: id, record };
  }

  /** Mint a token for a (non-task) principal such as a logged-in user. */
  mintPrincipal(principal: string, caps: Capability[], projectId?: string, ttlMs = 12 * 60 * 60 * 1000): { token: string; record: ScopedToken } {
    const id = `kt_${crypto.randomBytes(18).toString('hex')}`;
    const record: ScopedToken = {
      id,
      taskId: '*',
      profileId: 'user',
      principal,
      projectId,
      caps,
      issuedAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      kind: principal.startsWith('system:') ? 'system' : 'human',
    };
    this.tokens.set(id, record);
    return { token: id, record };
  }

  verify(token: string): ScopedToken | undefined {
    const record = this.tokens.get(token);
    if (record && record.expiresAt > Date.now()) return record;
    if (record) this.tokens.delete(token);
    return undefined;
  }

  /** Verify the token and check it allows the requested capability. */
  check(token: string, capability: Capability, scope?: { projectId?: string; taskId?: string }): { ok: boolean; record?: ScopedToken; reason?: string } {
    const record = this.verify(token);
    if (!record) return { ok: false, reason: 'invalid or expired token' };
    if (!allows(record.caps, capability)) return { ok: false, record, reason: `missing capability ${capability}` };
    if (record.projectId && scope?.projectId && record.projectId !== scope.projectId)
      return { ok: false, record, reason: `token is scoped to project ${record.projectId}` };
    // `taskId` records which workflow minted the token; it is provenance, not an
    // implicit object ACL. Project scope + named capabilities decide which other
    // tasks the agent may discover or coordinate with. A future explicit
    // resource-task scope should be a separate field, never inferred here.
    return { ok: true, record };
  }

  revoke(token: string) {
    this.tokens.delete(token);
  }
}
