import crypto from 'node:crypto';
import type { CredentialBroker } from '../autonomy/broker.js';
import { INSTALLATION_SCOPE } from '../autonomy/vault-keys.js';

const KEY_HANDLE = 'review-artifacts:url-key';

/** What a signed artifact URL opens: one Review "open" target of one task. */
export interface ArtifactGrant { taskId: string; path: string }

/**
 * Short-lived, stateless URLs for Review artifacts. A `<video>`, `<img>` or
 * `<iframe>` cannot send an Authorization header, and a media element makes a
 * request per byte range, so the viewer gets a URL that is its own credential:
 * minted by `POST /review-action` for a caller already allowed to open the
 * action, valid for that task's target only, for {@link ArtifactUrls.TTL_MS}.
 * Like any bearer URL it keeps working until it expires even if the person
 * loses access meanwhile; the short lifetime bounds that. The key lives in the
 * vault, so URLs survive a restart (and any gateway can check them); without a
 * vault (tests) it is per process.
 */
export class ArtifactUrls {
  static readonly TTL_MS = 60 * 60_000;
  private key?: Promise<Buffer>;
  constructor(private broker?: CredentialBroker) {}

  async mint(grant: ArtifactGrant, now = Date.now()): Promise<string> {
    const body = Buffer.from(JSON.stringify({ t: grant.taskId, p: grant.path, e: now + ArtifactUrls.TTL_MS })).toString('base64url');
    return `${body}.${this.sign(await this.secret(), body)}`;
  }

  async verify(token: string, now = Date.now()): Promise<ArtifactGrant | undefined> {
    const [body, signature, extra] = token.split('.');
    if (!body || !signature || extra !== undefined) return undefined;
    const expected = this.sign(await this.secret(), body);
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return undefined;
    let claims: { t?: unknown; p?: unknown; e?: unknown };
    try { claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return undefined; }
    if (typeof claims.t !== 'string' || typeof claims.p !== 'string' || typeof claims.e !== 'number' || claims.e <= now) return undefined;
    return { taskId: claims.t, path: claims.p };
  }

  private sign(key: Buffer, body: string): string {
    return crypto.createHmac('sha256', key).update(`review-artifact\0${body}`).digest('base64url');
  }

  private secret(): Promise<Buffer> {
    return this.key ??= (async () => {
      const broker = this.broker;
      if (!broker) return crypto.randomBytes(32);
      if (!await broker.hasHandle(KEY_HANDLE))
        await broker.ensureHandle(KEY_HANDLE, crypto.randomBytes(32).toString('base64'), INSTALLATION_SCOPE);
      return Buffer.from(await broker.resolve(KEY_HANDLE, { caps: [`use-credential:${KEY_HANDLE}`] }), 'base64');
    })();
  }
}
