import crypto from 'node:crypto';

/**
 * Google service-account OAuth (RFC 7523 JWT bearer grant) from node:crypto:
 * sign an RS256 assertion with the account's private key and trade it at
 * Google's token endpoint for an access token. Used by the Google Cloud world
 * driver (`world/gcp.ts`) and the FCM sender (`collaboration/native-push.ts`),
 * so neither needs google-auth-library or firebase-admin.
 */
export interface GoogleServiceAccount { client_email: string; private_key: string; project_id: string; token_uri?: string }

export const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';

/** A service account key as Google downloads it (JSON). `what` names it in errors. */
export function parseGoogleServiceAccount(text: string, what = 'a Google service account key'): GoogleServiceAccount {
  let value: Partial<GoogleServiceAccount> & { type?: string };
  try { value = JSON.parse(String(text ?? '').trim()); }
  catch { throw new Error(`${what} is a service account key file (JSON)`); }
  if (!value || typeof value !== 'object' || !value.client_email || !value.private_key || !value.project_id)
    throw new Error(`${what} is a service account key file (JSON) with client_email, private_key and project_id`);
  try { crypto.createPrivateKey(value.private_key); }
  catch { throw new Error(`${what} has a private_key that is not a PEM private key`); }
  return value as GoogleServiceAccount;
}

/** The signed JWT the token endpoint accepts for `scope`, valid for an hour. */
export function serviceAccountAssertion(account: GoogleServiceAccount, scope: string, now = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: account.client_email, scope,
    aud: account.token_uri ?? GOOGLE_TOKEN_URI, iat: seconds, exp: seconds + 3600 })}`;
  return `${unsigned}.${crypto.sign('RSA-SHA256', Buffer.from(unsigned), account.private_key).toString('base64url')}`;
}

/** Google refused the assertion (`status` its HTTP status; ≥ 500 is worth retrying). */
export class GoogleTokenError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Trade an assertion for an access token. */
export async function fetchServiceAccountToken(account: GoogleServiceAccount, scope: string, fetchImpl: typeof fetch = fetch,
  now = Date.now()): Promise<{ accessToken: string; expiresAt: number }> {
  const audience = account.token_uri ?? GOOGLE_TOKEN_URI;
  const response = await fetchImpl(audience, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: serviceAccountAssertion(account, scope, now) }).toString(),
    signal: AbortSignal.timeout(60_000) });
  const answer = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!response.ok || !answer.access_token)
    throw new GoogleTokenError(`Google refused the service account key (${response.status}): ${answer.error_description ?? answer.error ?? 'no reason given'}`, response.status);
  return { accessToken: answer.access_token, expiresAt: now + (answer.expires_in ?? 3600) * 1000 };
}

/**
 * Access tokens per (account, scope), kept until a minute before they expire.
 * A replaced key (another private key for the same address) gets its own.
 */
export class GoogleAccessTokens {
  private held = new Map<string, { accessToken: string; expiresAt: number }>();
  constructor(private fetchImpl: typeof fetch = fetch) {}

  async token(account: GoogleServiceAccount, scope: string): Promise<string> {
    const key = `${account.client_email}\0${scope}\0${crypto.createHash('sha256').update(account.private_key).digest('hex')}`;
    const held = this.held.get(key);
    if (held && held.expiresAt > Date.now() + 60_000) return held.accessToken;
    const fresh = await fetchServiceAccountToken(account, scope, this.fetchImpl);
    if (this.held.size > 32) this.held.clear();
    this.held.set(key, fresh);
    return fresh.accessToken;
  }

  /** Forget a token the API refused (401): the next call fetches another. */
  forget(account: GoogleServiceAccount, scope: string): void {
    for (const key of this.held.keys()) if (key.startsWith(`${account.client_email}\0${scope}\0`)) this.held.delete(key);
  }
}
