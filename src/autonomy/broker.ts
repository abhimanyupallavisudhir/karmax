import type { SecretVault } from './vault-crypto.js';
import type { VaultScope } from './vault-keys.js';
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
  private auditNext = 0;
  private static readonly AUDIT_LIMIT = 1000;

  constructor(private vault: SecretVault) {}

  /** Write back a (possibly newly created) secret under a handle, encrypted
   * under the data key of the `scope` that owns it (SS-1). A handle stays in
   * its scope: writing it as another owner's is refused. */
  registerHandle(handle: string, secret: string, scope: VaultScope, options?: { history?: boolean }) {
    return this.vault.put(handle, secret, scope, options);
  }

  /** Initialize a shared encryption key without rotating a concurrent creator's key. */
  ensureHandle(handle: string, secret: string, scope: VaultScope) {
    return this.vault.putIfAbsent(handle, secret, scope);
  }

  hasHandle(handle: string): Promise<boolean> {
    return this.vault.has(handle);
  }

  /** The scope recorded on a handle's entry. */
  scopeOf(handle: string): Promise<VaultScope | undefined> {
    return this.vault.scopeOf(handle);
  }

  deleteHandle(handle: string) {
    return this.vault.delete(handle);
  }

  deleteHandleIfUnchanged(handle: string, observed: string) {
    return this.vault.deleteIfEqual(handle, observed);
  }

  /** Rename and/or rotate a handle without revealing its current secret to the
   * gateway. Supplying no replacement keeps the existing secret. */
  updateHandle(handle: string, nextHandle: string, scope: VaultScope, replacement?: string) {
    return this.vault.move(handle, nextHandle, scope, replacement);
  }

  /** Crypto-shred everything an organization or user owned (SS-1). */
  destroyScope(scope: VaultScope) {
    return this.vault.destroyScope(scope);
  }

  listHandles(): Promise<string[]> {
    return this.vault.list();
  }

  /**
   * JIT-resolve a handle to its secret. The requester must hold
   * `use-credential:<handle>` (or a covering wildcard). Every attempt is audited.
   */
  async resolve(handle: string, ctx: ResolveContext): Promise<string> {
    const permitted = allows(ctx.caps, `use-credential:${handle}`);
    if (!permitted) {
      this.audit({ ts: Date.now(), handle, taskId: ctx.taskId, profileId: ctx.profileId, granted: false, reason: 'capability denied' });
      throw new Error(`credential broker: not permitted to use ${handle}`);
    }
    const secret = await this.vault.reveal(handle);
    if (secret === undefined) {
      this.audit({ ts: Date.now(), handle, taskId: ctx.taskId, profileId: ctx.profileId, granted: false, reason: 'no such handle' });
      throw new Error(`credential broker: no secret for handle ${handle}`);
    }
    this.audit({ ts: Date.now(), handle, taskId: ctx.taskId, profileId: ctx.profileId, granted: true });
    return secret;
  }

  private audit(e: AuditEntry) {
    if (this.auditLog.length < CredentialBroker.AUDIT_LIMIT) this.auditLog.push(e);
    else this.auditLog[this.auditNext] = e;
    this.auditNext = (this.auditNext + 1) % CredentialBroker.AUDIT_LIMIT;
  }

  audit_log(): AuditEntry[] {
    return this.auditLog.length < CredentialBroker.AUDIT_LIMIT
      ? [...this.auditLog]
      : [...this.auditLog.slice(this.auditNext), ...this.auditLog.slice(0, this.auditNext)];
  }
}
