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
  private held = new Map<string, { session: CdpSession; origin: string; timer: NodeJS.Timeout }>();
  constructor(private ttlMs = 180_000) {}

  private hold(id: string, session: CdpSession, origin: string) {
    const timer = setTimeout(() => this.release(id), this.ttlMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.held.set(id, { session, origin, timer });
  }

  /**
   * Prepare a virtual authenticator on the page (origin-verified). For `login`,
   * the stored credential is loaded so the agent can immediately sign in. The
   * session stays open (held under TTL) until `harvest`/`release`.
   */
  async begin(cdpUrl: string, opts: { expectDomains?: string[]; mode: 'enroll' | 'login'; credential?: PasskeyCredential }): Promise<{ authenticatorId: string; origin: string }> {
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
      this.hold(authenticatorId, session, origin);
      return { authenticatorId, origin };
    } catch (e) {
      session.close();
      throw e;
    }
  }

  /** Read the credential(s) the site just wrote into the authenticator, then
   *  release the session. The result is stored as the passkey item's secret. */
  async harvest(authenticatorId: string): Promise<PasskeyCredential[]> {
    const held = this.held.get(authenticatorId);
    if (!held) throw new Error('no held passkey session — enrollment expired or was already saved; start over');
    const result = await held.session.call('WebAuthn.getCredentials', { authenticatorId });
    const credentials = (result?.credentials ?? []) as PasskeyCredential[];
    this.release(authenticatorId);
    return credentials;
  }

  release(authenticatorId: string): void {
    const held = this.held.get(authenticatorId);
    if (!held) return;
    clearTimeout(held.timer);
    try {
      held.session.close();
    } catch {
      /* already closed */
    }
    this.held.delete(authenticatorId);
  }
}
