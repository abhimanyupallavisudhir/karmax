import { Vault } from './vault.js';
import { Capability, allows } from '../platform/capabilities.js';

export interface AuditEntry {
  ts: number;
  handle: string;
  taskId?: string;
  profileId?: string;
  granted: boolean;
  reason?: string;
}

export interface ResolveContext {
  taskId?: string;
  profileId?: string;
  /** Effective capabilities of the requesting principal (from the scoped token). */
  caps: Capability[];
}

/**
 * The credential broker (SPEC §8.4). Agents never see raw secrets in
 * prompt/context. The broker provides just-in-time resolution of a handle into a
 * live secret, scoped to what the task needs, with a full audit trail. Newly
 * created accounts are written back to the vault.
 */
export class CredentialBroker {
  private auditLog: AuditEntry[] = [];

  constructor(private vault: Vault) {}

  /** Write back a (possibly newly created) secret under a handle. */
  registerHandle(handle: string, secret: string) {
    this.vault.put(handle, secret);
  }

  hasHandle(handle: string): boolean {
    return this.vault.has(handle);
  }

  deleteHandle(handle: string) {
    this.vault.delete(handle);
  }

  /** Rename and/or rotate a handle without revealing its current secret to the
   * gateway. Supplying no replacement keeps the existing secret. */
  updateHandle(handle: string, nextHandle: string, replacement?: string) {
    const secret = replacement ?? this.vault.reveal(handle);
    if (secret === undefined) throw new Error(`credential broker: no secret for handle ${handle}`);
    this.vault.put(nextHandle, secret);
    if (nextHandle !== handle) this.vault.delete(handle);
  }

  listHandles(): string[] {
    return this.vault.list();
  }

  /**
   * JIT-resolve a handle to its secret. The requester must hold
   * `use-credential:<handle>` (or a covering wildcard). Every attempt is audited.
   */
  resolve(handle: string, ctx: ResolveContext): string {
    const permitted = allows(ctx.caps, `use-credential:${handle}`);
    if (!permitted) {
      this.audit({ ts: Date.now(), handle, taskId: ctx.taskId, profileId: ctx.profileId, granted: false, reason: 'capability denied' });
      throw new Error(`credential broker: not permitted to use ${handle}`);
    }
    const secret = this.vault.reveal(handle);
    if (secret === undefined) {
      this.audit({ ts: Date.now(), handle, taskId: ctx.taskId, profileId: ctx.profileId, granted: false, reason: 'no such handle' });
      throw new Error(`credential broker: no secret for handle ${handle}`);
    }
    this.audit({ ts: Date.now(), handle, taskId: ctx.taskId, profileId: ctx.profileId, granted: true });
    return secret;
  }

  private audit(e: AuditEntry) {
    this.auditLog.push(e);
  }

  audit_log(): AuditEntry[] {
    return [...this.auditLog];
  }
}
