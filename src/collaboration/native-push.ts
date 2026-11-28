import crypto from 'node:crypto';
import type { CredentialBroker } from '../autonomy/broker.js';
import { INSTALLATION_SCOPE } from '../autonomy/vault-keys.js';
import { GoogleAccessTokens, parseGoogleServiceAccount, type GoogleServiceAccount } from '../integrations/google-service-account.js';
import type { PushMessage } from './push-delivery.js';

/**
 * Native push for the phone apps (wiki features/phone-apps): one FCM HTTP v1
 * request per device, Android directly and iOS through FCM's APNs bridge, so
 * the installation holds one credential — its Firebase project's service
 * account, kept in the vault at installation scope and set from Installation
 * → Phone apps. Until it is set, native push is unavailable: the app hides its
 * switch and the gateway refuses to register a phone.
 *
 * The OAuth access token comes from an RS256 JWT signed with node:crypto
 * (`integrations/google-service-account.ts`); firebase-admin would bring a
 * large dependency tree for one POST.
 */
export const FCM_CREDENTIAL_HANDLE = 'push:fcm-service-account';
export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const FCM_ORIGIN = 'https://fcm.googleapis.com';
/** How long the service account read from the vault is trusted before it is read again (another replica may change it). */
const ACCOUNT_CACHE_MS = 60_000;

/** What a send came to: delivered, the device is gone for good, try again later, or refused for another reason. */
export type FcmOutcome = { outcome: 'sent' | 'gone' | 'retry' | 'refused'; detail: string };

/** A short stable id for collapsing undelivered copies of one inbox item. */
const collapseId = (tag: string) => crypto.createHash('sha256').update(tag).digest('base64url').slice(0, 32);

/**
 * The FCM v1 `messages:send` body for one device. Asks (high, critical) ring
 * and are delivered at once; the rest arrive quietly when the device is next
 * awake. `data.url` is the console path the app opens when it is tapped.
 */
export function fcmRequestBody(token: string, message: PushMessage, ttlSeconds: number, now = Date.now()): object {
  const loud = message.urgency === 'high' || message.urgency === 'critical';
  return { message: {
    token,
    notification: { title: message.title, body: message.body },
    data: { url: message.url, tag: message.tag, urgency: message.urgency },
    android: { priority: loud ? 'HIGH' : 'NORMAL', ttl: `${ttlSeconds}s`, collapse_key: collapseId(message.tag),
      // The tag replaces an earlier notification for the same inbox item instead of stacking.
      notification: { tag: message.tag, ...(loud ? { sound: 'default' } : {}) } },
    apns: {
      headers: { 'apns-priority': loud ? '10' : '5', 'apns-push-type': 'alert',
        'apns-expiration': String(Math.floor(now / 1000) + ttlSeconds), 'apns-collapse-id': collapseId(message.tag) },
      payload: { aps: loud ? { sound: 'default' } : {} },
    },
  } };
}

/** A data-only message: Android runs the app's messaging service for it even in
 *  the background (a notification message is shown by the system alone), so the
 *  app refreshes its home-screen widget (wiki features/phone-apps § Widget). */
export function fcmRefreshBody(token: string): object {
  return { message: { token, data: { type: 'refresh' }, android: { priority: 'NORMAL', ttl: '3600s', collapse_key: 'tavya-refresh' } } };
}

export class NativePush {
  private tokens: GoogleAccessTokens;
  private cached?: { account: GoogleServiceAccount | undefined; at: number };

  constructor(private options: { broker: CredentialBroker; fetcher?: typeof fetch; log?: (line: string) => void }) {
    this.tokens = new GoogleAccessTokens(options.fetcher ?? fetch);
  }

  /** The configured service account, if any. */
  private async account(): Promise<GoogleServiceAccount | undefined> {
    if (this.cached && Date.now() - this.cached.at < ACCOUNT_CACHE_MS) return this.cached.account;
    const { broker } = this.options;
    const account = await broker.hasHandle(FCM_CREDENTIAL_HANDLE)
      ? parseGoogleServiceAccount(await broker.resolve(FCM_CREDENTIAL_HANDLE, { caps: [`use-credential:${FCM_CREDENTIAL_HANDLE}`] }), 'The Firebase key')
      : undefined;
    this.cached = { account, at: Date.now() };
    return account;
  }

  async available(): Promise<boolean> {
    return !!(await this.account().catch(() => undefined));
  }

  /** What Installation settings shows: never the key itself. */
  async view(): Promise<{ configured: boolean; projectId?: string; clientEmail?: string }> {
    const account = await this.account().catch(() => undefined);
    return account ? { configured: true, projectId: account.project_id, clientEmail: account.client_email } : { configured: false };
  }

  /** Save a Firebase service account key, after Google accepted it. */
  async configure(json: string): Promise<{ configured: boolean; projectId?: string; clientEmail?: string }> {
    const account = parseGoogleServiceAccount(json, 'The Firebase key');
    await this.tokens.token(account, FCM_SCOPE);
    await this.options.broker.registerHandle(FCM_CREDENTIAL_HANDLE, JSON.stringify(account), INSTALLATION_SCOPE);
    this.cached = { account, at: Date.now() };
    return this.view();
  }

  async remove(): Promise<void> {
    if (await this.options.broker.hasHandle(FCM_CREDENTIAL_HANDLE)) await this.options.broker.deleteHandle(FCM_CREDENTIAL_HANDLE);
    this.cached = { account: undefined, at: Date.now() };
  }

  /** Send one message to one device. Throws only when native push is not configured. */
  async send(token: string, message: PushMessage, ttlSeconds: number): Promise<FcmOutcome> {
    return this.post(fcmRequestBody(token, message, ttlSeconds));
  }

  /** Tell an Android phone to refresh what it shows outside the app (best effort). */
  async refresh(token: string): Promise<FcmOutcome> {
    return this.post(fcmRefreshBody(token));
  }

  private async post(message: object): Promise<FcmOutcome> {
    const account = await this.account();
    if (!account) throw new Error('native push is not configured');
    const fetcher = this.options.fetcher ?? fetch;
    const body = JSON.stringify(message);
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        const accessToken = await this.tokens.token(account, FCM_SCOPE);
        response = await fetcher(`${FCM_ORIGIN}/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`, {
          method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(15_000),
          headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' } });
      } catch (error) {
        return { outcome: 'retry', detail: error instanceof Error ? error.message : String(error) };
      }
      const answer = await response.json().catch(() => ({})) as { error?: { status?: string; message?: string; details?: Array<{ errorCode?: string }> } };
      const code = answer.error?.details?.find((detail) => detail.errorCode)?.errorCode ?? answer.error?.status ?? '';
      const detail = `${response.status}${code ? ` ${code}` : ''}`;
      if (response.ok) return { outcome: 'sent', detail };
      // The app was uninstalled or the token expired: FCM will never take it again.
      if (response.status === 404 || code === 'UNREGISTERED') return { outcome: 'gone', detail };
      // An access token Google stopped accepting: fetch another, once.
      if (response.status === 401 && attempt === 0) { this.tokens.forget(account, FCM_SCOPE); continue; }
      if (response.status === 429 || response.status >= 500) return { outcome: 'retry', detail };
      // 400 INVALID_ARGUMENT, 403 SENDER_ID_MISMATCH (a token from another Firebase project), THIRD_PARTY_AUTH_ERROR
      // (the APNs key in Firebase): repeating will not help, and the device may be fine once the operator fixes it.
      this.options.log?.(`FCM refused a message: ${detail}${answer.error?.message ? ` ${answer.error.message}` : ''}`);
      return { outcome: 'refused', detail };
    }
  }
}
