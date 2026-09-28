import crypto from 'node:crypto';
import { openPage, CdpSession } from './cdp.js';

/**
 * Agent-enrolled passkeys (wiki plans/PLAN-passwords §8). The user's own passkeys are
 * unusable by an agent by design — the OS biometric gesture is the product.
 * Instead the agent enrolls ITS OWN passkey on the account, via a CDP virtual
 * authenticator whose credential material karmax generates and stores as a
 * `passkey` vault item. After enrollment a passkey login is the most automatable
 * and phishing-proof path (origin-bound, no 2FA prompt), and the karmax key sits
 * alongside the user's own on the site, individually revocable there.
 *
 * A CDP virtual authenticator is bound to the DevTools session that added it, so
 * the manager must HOLD that session open across the agent's browser click
 * (create the passkey / sign in). Sessions are held under a TTL and released
 * explicitly (or on expiry), so a dropped flow cannot leak an authenticator.
 */

export interface PasskeyCredential {
  credentialId: string;
  isResidentCredential?: boolean;
  rpId: string;
  privateKey: string;
  userHandle?: string;
  signCount?: number;
}

/** Opens an origin-verified session on the task browser's page for `expectDomains`:
 *  a loopback CDP URL on this host, or `openWorldPage` in a remote world. */
export type PageOpener = (expectDomains: string[]) => Promise<{ session: CdpSession; origin: string }>;

const AUTH_OPTIONS = {
  protocol: 'ctap2',
  transport: 'internal',
  hasResidentKey: true,
  hasUserVerification: true,
  automaticPresenceSimulation: true,
  isUserVerified: true,
};

export class PasskeyManager {
  private held = new Map<string, { session: CdpSession; origin: string; timer: NodeJS.Timeout;
    owner: string; authenticatorId: string; mode: 'enroll' | 'login';
    onCredentials?: (credentials: PasskeyCredential[]) => Promise<void> }>();
  /** Each held session keeps a browser session (in a remote world, also a
   * terminal and the world itself) open until it is released or expires. */
  constructor(private ttlMs = 180_000, private limits = { perOwner: 3, total: 64 }) {}
  /** Sessions `begin` has admitted but not yet opened, by owner. */
  private reserved = new Map<string, number>();


  /**
   * Prepare a virtual authenticator on the page (origin-verified), in the task's
   * own browser. For `login`,
   * the stored credential is loaded so the agent can immediately sign in. The
   * session stays open (held under TTL) until `harvest`/`release`.
   */
  async begin(page: string | PageOpener, opts: { expectDomains?: string[]; mode: 'enroll' | 'login'; credential?: PasskeyCredential; owner: string; onCredentials?: (credentials: PasskeyCredential[]) => Promise<void>; reserved?: boolean }): Promise<{ authenticatorId: string; origin: string }> {
    if (!opts.owner || !opts.expectDomains?.length) throw new Error('passkey sessions require an owner and target domains');
    // Take the slot before the first await, so parallel requests cannot all pass
    // the check; a caller that reserved one already (to open the page, or spend a
    // grant, only when a session can be held) passes `reserved`.
    const release = opts.reserved ? () => {} : this.reserve(opts.owner);
    try { return await this.open(page, opts); }
    finally { release(); }
  }

  /** Hold one of `owner`'s session slots until the returned release is called. */
  reserve(owner: string): () => void {
    this.assertRoom(owner);
    this.reserved.set(owner, (this.reserved.get(owner) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.reserved.get(owner) ?? 1) - 1;
      if (left) this.reserved.set(owner, left); else this.reserved.delete(owner);
    };
  }

  private async open(page: string | PageOpener, opts: { expectDomains?: string[]; mode: 'enroll' | 'login'; credential?: PasskeyCredential; owner: string; onCredentials?: (credentials: PasskeyCredential[]) => Promise<void> }): Promise<{ authenticatorId: string; origin: string }> {
    if (!opts.expectDomains?.length) throw new Error('passkey sessions require target domains');
    const { session, origin } = typeof page === 'string'
      ? await openPage(page, { expectDomains: opts.expectDomains })
      : await page(opts.expectDomains);
    try {
      await session.call('WebAuthn.enable', { enableUI: false });
      const added = await session.call('WebAuthn.addVirtualAuthenticator', { options: AUTH_OPTIONS });
      const authenticatorId = String(added?.authenticatorId ?? '');
      if (!authenticatorId) throw new Error('CDP did not return an authenticator id (is this Chromium with WebAuthn?)');
      if (opts.mode === 'login') {
        if (!opts.credential) throw new Error('login mode needs a stored credential');
        await session.call('WebAuthn.addCredential', { authenticatorId, credential: opts.credential });
      }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        void this.release(id, opts.owner).catch(() => console.warn('[passkey] could not persist expired login session'));
      }, this.ttlMs);
      timer.unref?.();
      this.held.set(id, { session, origin, timer, owner: opts.owner, authenticatorId,
        mode: opts.mode, onCredentials: opts.onCredentials });
      return { authenticatorId: id, origin };
    } catch (e) {
      (await session.close());
      throw e;
    }
  }

  /** Throw unless `owner` may hold one more session, counting ones still opening. */
  assertRoom(owner: string): void {
    const owned = [...this.held.values()].filter((held) => held.owner === owner).length + (this.reserved.get(owner) ?? 0);
    if (owned >= this.limits.perOwner)
      throw new Error(`this task already has ${owned} passkey sessions open; save or release one first`);
    const opening = [...this.reserved.values()].reduce((sum, count) => sum + count, 0);
    if (this.held.size + opening >= this.limits.total) throw new Error('too many passkey sessions are open; try again in a few minutes');
  }

  /** Read the credential(s) the site just wrote into the authenticator, then
   *  release the session. The result is stored as the passkey item's secret. */
  async harvest(authenticatorId: string, owner: string): Promise<PasskeyCredential[]> {
    const held = this.held.get(authenticatorId);
    if (!held) throw new Error('no held passkey session — enrollment expired or was already saved; start over');
    if (held.owner !== owner) throw new Error('passkey session owner mismatch');
    if (held.mode !== 'enroll') throw new Error('only enrollment sessions can be saved');
    const result = await held.session.call('WebAuthn.getCredentials', { authenticatorId: held.authenticatorId });
    const credentials = (result?.credentials ?? []) as PasskeyCredential[];
    (await this.release(authenticatorId, owner));
    return credentials;
  }

  async release(authenticatorId: string, owner: string): Promise<void> {
    const held = this.held.get(authenticatorId);
    if (!held) return;
    if (held.owner !== owner) throw new Error('passkey session owner mismatch');
    clearTimeout(held.timer);
    this.held.delete(authenticatorId);
    try {
      if (held.mode === 'login' && held.onCredentials) {
        const result = await held.session.call('WebAuthn.getCredentials', { authenticatorId: held.authenticatorId });
        await held.onCredentials((result?.credentials ?? []) as PasskeyCredential[]);
      }
    } finally {
      try { await held.session.call('WebAuthn.removeVirtualAuthenticator', { authenticatorId: held.authenticatorId }); }
      finally { await held.session.close(); }
    }
  }
}
