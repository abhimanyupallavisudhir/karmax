import crypto from 'node:crypto';
import { openPage, CdpSession } from './cdp.js';

/**
 * Agent-enrolled passkeys (PLAN-passwords.md §8). The user's own passkeys are
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
  constructor(private ttlMs = 180_000) {}


  /**
   * Prepare a virtual authenticator on the page (origin-verified). For `login`,
   * the stored credential is loaded so the agent can immediately sign in. The
   * session stays open (held under TTL) until `harvest`/`release`.
   */
  async begin(cdpUrl: string, opts: { expectDomains?: string[]; mode: 'enroll' | 'login'; credential?: PasskeyCredential; owner: string; onCredentials?: (credentials: PasskeyCredential[]) => Promise<void> }): Promise<{ authenticatorId: string; origin: string }> {
    if (!opts.owner || !opts.expectDomains?.length) throw new Error('passkey sessions require an owner and target domains');
    const { session, origin } = await openPage(cdpUrl, { expectDomains: opts.expectDomains });
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
