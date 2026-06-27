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
    };
    this.tokens.set(id, record);
    return { token: id, record };
  }

  /** Mint a token for a (non-task) principal such as a logged-in user. */
  mintPrincipal(principal: string, caps: Capability[], projectId?: string): { token: string; record: ScopedToken } {
    const id = `kt_${crypto.randomBytes(18).toString('hex')}`;
    const record: ScopedToken = {
      id,
      taskId: '*',
      profileId: 'user',
      principal,
      projectId,
      caps,
      issuedAt: Date.now(),
    };
    this.tokens.set(id, record);
    return { token: id, record };
  }

  verify(token: string): ScopedToken | undefined {
    return this.tokens.get(token);
  }

  /** Verify the token and check it allows the requested capability. */
  check(token: string, capability: Capability): { ok: boolean; record?: ScopedToken; reason?: string } {
    const record = this.tokens.get(token);
    if (!record) return { ok: false, reason: 'invalid or expired token' };
    if (!allows(record.caps, capability)) return { ok: false, record, reason: `missing capability ${capability}` };
    return { ok: true, record };
  }

  revoke(token: string) {
    this.tokens.delete(token);
  }
}
