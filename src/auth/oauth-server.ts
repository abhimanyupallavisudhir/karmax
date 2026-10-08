import crypto from 'node:crypto';
import type { Store } from '../store/db.js';
import { publicFetch } from '../mcp/connections/http.js';
import { AppGrantError, AppGrants, ceilingScope, digest, scopeCeiling, type AppGrant, type AppGrantCeiling } from './app-grants.js';

/**
 * tavya's OAuth 2.1 authorization server, transport-agnostic (the gateway's
 * `oauth-routes.ts` speaks HTTP). It issues app grants (`app-grants.ts`) through
 * - the device authorization grant (RFC 8628) for the `tavya` CLI and other
 *   headless clients, and
 * - the authorization code grant with PKCE S256 for MCP clients, which identify
 *   themselves by dynamic registration (RFC 7591) or a client ID metadata
 *   document (an https `client_id`).
 * The person approving is signed in through Better Auth; deciding what a grant
 * may do is the gateway's job (it knows the approver's authority).
 */
export const CLI_CLIENT_ID = 'tavya-cli';
export const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const DEVICE_TTL_MS = 15 * 60_000;
const DEVICE_INTERVAL_S = 5;
const CODE_TTL_MS = 60_000;
const AUTHORIZATION_REQUEST_TTL_MS = 10 * 60_000;
/** RFC 8628 §6.1: no vowels or look-alikes, so codes never spell words and read back unambiguously. */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const METADATA_DOCUMENT_MAX_BYTES = 16 * 1024;
const METADATA_CACHE_MS = 10 * 60_000;

export interface OAuthClient {
  clientId: string;
  name: string;
  redirectUris: string[];
  /** first-party (`tavya-cli`), dynamically registered, or a metadata document. */
  kind: 'first-party' | 'registered' | 'metadata';
  /** Whether its identity is vouched for: first-party, or a metadata document
   * served from the host its `client_id` names. Registrations are self-asserted. */
  verified: boolean;
  /** The host to show the approver: the metadata document's, else the redirect's. */
  host?: string;
}

/** An RFC 6749 §5.2 error. `redirect` is false for errors that must not be
 * sent to an unverified redirect URI (bad client or redirect). */
export class OAuthError extends Error {
  constructor(public error: string, public description: string, public status = 400, public redirect = true) { super(description); }
}

interface DeviceRecord {
  userCode: string; clientId: string; name?: string; requested?: AppGrantCeiling; resource?: string;
  expiresAt: number; interval: number; lastPolledAt?: number;
  status: 'pending' | 'approved' | 'denied';
  approval?: Approval;
}
interface AuthorizationRequest {
  clientId: string; redirectUri: string; state?: string; codeChallenge: string; resource?: string;
  requested?: AppGrantCeiling; expiresAt: number;
}
interface CodeRecord {
  clientId: string; redirectUri: string; codeChallenge: string; resource?: string; approval: Approval;
  expiresAt: number; usedBy?: string;
}
/** What the approver decided: who, and the (already validated) ceiling. */
export interface Approval { userId: string; ceiling?: AppGrantCeiling; createdBy?: AppGrant['createdBy'] }

export interface TokenResponse {
  access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string; scope: string;
}

const deviceKey = (deviceCode: string) => `oauth-device:${digest(deviceCode)}`;
const userCodeKey = (userCode: string) => `oauth-user-code:${digest(userCode)}`;
const requestKey = (id: string) => `oauth-request:${id}`;
const codeKey = (code: string) => `oauth-code:${digest(code)}`;
const clientKey = (id: string) => `oauth-client:${id}`;

export class OAuthServer {
  private metadataCache = new Map<string, { client?: OAuthClient; error?: string; until: number }>();
  private limits = new Map<string, { count: number; until: number }>();
  private lastSweep = 0;

  constructor(private store: Store, readonly grants: AppGrants,
    private options: { fetchMetadata?: typeof fetch } = {}) {}

  // ── clients ──────────────────────────────────────────────────────────────
  async client(clientId: string | undefined): Promise<OAuthClient | undefined> {
    if (!clientId) return undefined;
    if (clientId === CLI_CLIENT_ID) return { clientId, name: 'tavya CLI', redirectUris: [], kind: 'first-party', verified: true };
    if (clientId.startsWith('https://')) return this.metadataClient(clientId);
    const raw = await this.store.kvGet(clientKey(clientId));
    if (!raw) return undefined;
    const stored = JSON.parse(raw) as { clientId: string; name: string; redirectUris: string[] };
    return { ...stored, kind: 'registered', verified: false, host: hostOf(stored.redirectUris[0]) };
  }

  /** RFC 7591 dynamic registration: public clients only. */
  async register(body: Record<string, unknown>, address: string): Promise<Record<string, unknown>> {
    if (!this.allow(`register:${address}`, 20, 60 * 60_000))
      throw new OAuthError('too_many_requests', 'Too many client registrations; try again later', 429, false);
    const redirectUris = body.redirect_uris;
    if (!Array.isArray(redirectUris) || !redirectUris.length || redirectUris.length > 10
      || !redirectUris.every((uri) => typeof uri === 'string' && validRedirectUri(uri)))
      throw new OAuthError('invalid_redirect_uri', 'redirect_uris must list 1–10 https, loopback http or private-use scheme URIs', 400, false);
    const method = body.token_endpoint_auth_method ?? 'none';
    if (method !== 'none')
      throw new OAuthError('invalid_client_metadata', 'Only public clients are supported (token_endpoint_auth_method "none")', 400, false);
    const grantTypes = body.grant_types ?? ['authorization_code', 'refresh_token'];
    if (!Array.isArray(grantTypes) || grantTypes.some((type) => !['authorization_code', 'refresh_token'].includes(type)))
      throw new OAuthError('invalid_client_metadata', 'grant_types may contain authorization_code and refresh_token', 400, false);
    const name = typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 100) : undefined;
    const clientId = `tvc_${crypto.randomBytes(16).toString('hex')}`;
    const issuedAt = Math.floor(Date.now() / 1000);
    await this.store.kvSet(clientKey(clientId), JSON.stringify({ clientId, name: name ?? hostOf(redirectUris[0]) ?? 'MCP client',
      redirectUris, createdAt: Date.now() }));
    return { client_id: clientId, client_id_issued_at: issuedAt, ...(name ? { client_name: name } : {}),
      redirect_uris: redirectUris, grant_types: grantTypes, response_types: ['code'], token_endpoint_auth_method: 'none' };
  }

  /** A client ID metadata document: fetched once per cache period with the
   * outbound SSRF guard (public HTTPS only, no redirects, bounded time and size). */
  private async metadataClient(clientId: string): Promise<OAuthClient | undefined> {
    const cached = this.metadataCache.get(clientId);
    if (cached && cached.until > Date.now()) {
      if (cached.error) throw new OAuthError('invalid_client', cached.error, 400, false);
      return cached.client;
    }
    let client: OAuthClient | undefined, error: string | undefined;
    try {
      const url = new URL(clientId);
      if (url.hash || url.username || url.password || url.pathname === '/') throw new Error('client_id must be an https URL with a path');
      const response = await (this.options.fetchMetadata ?? publicFetch)(clientId,
        { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(`metadata document answered HTTP ${response.status}`);
      const text = await response.text();
      if (Buffer.byteLength(text) > METADATA_DOCUMENT_MAX_BYTES) throw new Error('metadata document is too large');
      const document = JSON.parse(text) as Record<string, unknown>;
      if (document.client_id !== clientId) throw new Error('metadata document client_id does not match its URL');
      const redirectUris = document.redirect_uris;
      if (!Array.isArray(redirectUris) || !redirectUris.length || redirectUris.length > 10
        || !redirectUris.every((uri) => typeof uri === 'string' && validRedirectUri(uri)))
        throw new Error('metadata document needs valid redirect_uris');
      if ((document.token_endpoint_auth_method ?? 'none') !== 'none') throw new Error('only public clients are supported');
      client = { clientId, kind: 'metadata', verified: true, host: url.host, redirectUris: redirectUris as string[],
        name: typeof document.client_name === 'string' && document.client_name.trim() ? document.client_name.trim().slice(0, 100) : url.host };
    } catch (e) {
      error = `Client metadata document unusable: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (this.metadataCache.size > 500) this.metadataCache.clear();
    this.metadataCache.set(clientId, { client, error, until: Date.now() + (error ? 60_000 : METADATA_CACHE_MS) });
    if (error) throw new OAuthError('invalid_client', error, 400, false);
    return client;
  }

  // ── device authorization (RFC 8628) ──────────────────────────────────────
  async startDevice(input: { clientId?: string; name?: string; scope?: string; resource?: string }, verificationUri: string) {
    const client = await this.client(input.clientId);
    if (!client) throw new OAuthError('invalid_client', 'Unknown client_id', 401, false);
    await this.maybeSweep();
    const deviceCode = crypto.randomBytes(32).toString('base64url');
    let userCode = '';
    for (let attempt = 0; attempt < 5 && !userCode; attempt++) {
      const candidate = newUserCode();
      if (await this.store.kvClaim(userCodeKey(candidate), deviceKey(deviceCode))) userCode = candidate;
    }
    if (!userCode) throw new OAuthError('temporarily_unavailable', 'Could not allocate a user code', 503, false);
    const record: DeviceRecord = { userCode, clientId: client.clientId, status: 'pending',
      ...(input.name?.trim() ? { name: input.name.trim().slice(0, 100) } : {}),
      ...(scopeCeiling(input.scope) ? { requested: scopeCeiling(input.scope) } : {}),
      ...(input.resource ? { resource: input.resource } : {}),
      expiresAt: Date.now() + DEVICE_TTL_MS, interval: DEVICE_INTERVAL_S };
    await this.store.kvSet(deviceKey(deviceCode), JSON.stringify(record));
    return { device_code: deviceCode, user_code: userCode, verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?code=${userCode}`, expires_in: DEVICE_TTL_MS / 1000, interval: DEVICE_INTERVAL_S };
  }

  /** What the approval page shows for a typed code. Guessing is rate-limited
   * per person and per address; a miss costs one attempt. */
  async deviceRequest(rawCode: string, limiter: string[]) {
    const found = await this.findDevice(rawCode, limiter);
    if (!found) return undefined;
    const { record } = found;
    const client = await this.client(record.clientId).catch(() => undefined);
    return { userCode: record.userCode, deviceName: record.name, status: record.status, expiresAt: record.expiresAt,
      requested: record.requested, client: client && clientView(client) };
  }

  async decideDevice(rawCode: string, limiter: string[], decision: Approval | 'deny'): Promise<boolean> {
    const found = await this.findDevice(rawCode, limiter);
    if (!found || found.record.status !== 'pending') return false;
    return this.updateRecord<DeviceRecord>(found.key, (record) => record.status !== 'pending' ? undefined
      : decision === 'deny' ? { ...record, status: 'denied' } : { ...record, status: 'approved', approval: decision });
  }

  private async findDevice(rawCode: string, limiter: string[]) {
    if (limiter.some((key) => !this.allow(`user-code:${key}`, 10, 15 * 60_000, false)))
      throw new OAuthError('slow_down', 'Too many codes tried; wait a few minutes', 429, false);
    const userCode = normalizeUserCode(rawCode);
    const key = userCode ? await this.store.kvGet(userCodeKey(userCode)) : undefined;
    const raw = key ? await this.store.kvGet(key) : undefined;
    const record = raw ? JSON.parse(raw) as DeviceRecord : undefined;
    if (!key || !record || record.expiresAt <= Date.now() || record.userCode !== userCode) {
      for (const entry of limiter) this.allow(`user-code:${entry}`, 10, 15 * 60_000);
      return undefined;
    }
    return { key, record };
  }

  private async pollDevice(deviceCode: string, client: OAuthClient): Promise<TokenResponse> {
    const key = deviceKey(deviceCode);
    for (let attempt = 0; attempt < 5; attempt++) {
      const raw = await this.store.kvGet(key);
      if (!raw) throw new OAuthError('expired_token', 'The device code expired or was already used; start again');
      const record = JSON.parse(raw) as DeviceRecord;
      if (record.clientId !== client.clientId) throw new OAuthError('invalid_grant', 'The device code was issued to another client');
      if (record.expiresAt <= Date.now()) {
        await this.store.kvDelete(key);
        await this.store.kvDelete(userCodeKey(record.userCode));
        throw new OAuthError('expired_token', 'The device code expired; start again');
      }
      if (record.status === 'denied') {
        await this.store.kvDelete(key);
        await this.store.kvDelete(userCodeKey(record.userCode));
        throw new OAuthError('access_denied', 'The request was denied');
      }
      if (record.status === 'approved' && record.approval) {
        if (!(await this.store.kvCompareAndSet(key, raw, undefined))) continue;
        await this.store.kvDelete(userCodeKey(record.userCode));
        const grant = await this.grants.create({ userId: record.approval.userId, kind: client.clientId === CLI_CLIENT_ID ? 'cli' : 'mcp',
          clientId: client.clientId, name: record.name ?? client.name, ceiling: record.approval.ceiling,
          resource: record.resource, createdBy: record.approval.createdBy });
        return this.tokenResponse(grant, await this.grants.issue(grant));
      }
      const now = Date.now();
      const tooSoon = record.lastPolledAt !== undefined && now - record.lastPolledAt < record.interval * 1000;
      const next: DeviceRecord = { ...record, lastPolledAt: now, interval: tooSoon ? record.interval + 5 : record.interval };
      if (!(await this.store.kvCompareAndSet(key, raw, JSON.stringify(next)))) continue;
      throw tooSoon ? new OAuthError('slow_down', `Poll at most every ${next.interval} seconds`)
        : new OAuthError('authorization_pending', 'Waiting for the user to approve the code');
    }
    throw new OAuthError('authorization_pending', 'Waiting for the user to approve the code');
  }

  // ── authorization code + PKCE ────────────────────────────────────────────
  /** Validate an authorization request and park it for the consent page. */
  async authorize(params: URLSearchParams, resources: string[]): Promise<{ requestId: string }> {
    const client = await this.client(params.get('client_id') ?? undefined);
    if (!client) throw new OAuthError('invalid_client', 'Unknown client_id', 400, false);
    const redirectUri = params.get('redirect_uri') ?? '';
    if (!client.redirectUris.some((registered) => redirectUriMatches(registered, redirectUri)))
      throw new OAuthError('invalid_request', 'redirect_uri is not registered for this client', 400, false);
    if (params.get('response_type') !== 'code') throw new OAuthError('unsupported_response_type', 'Only response_type=code is supported');
    const challenge = params.get('code_challenge') ?? '';
    if (params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge))
      throw new OAuthError('invalid_request', 'PKCE with code_challenge_method=S256 is required');
    const resource = params.getAll('resource');
    if (resource.length > 1 || (resource[0] && !resources.includes(resource[0])))
      throw new OAuthError('invalid_target', 'Unknown resource; this server issues tokens only for itself');
    await this.maybeSweep();
    const id = crypto.randomBytes(18).toString('base64url');
    const record: AuthorizationRequest = { clientId: client.clientId, redirectUri, codeChallenge: challenge,
      ...(params.get('state') ? { state: params.get('state')! } : {}), ...(resource[0] ? { resource: resource[0] } : {}),
      ...(scopeCeiling(params.get('scope') ?? undefined) ? { requested: scopeCeiling(params.get('scope') ?? undefined) } : {}),
      expiresAt: Date.now() + AUTHORIZATION_REQUEST_TTL_MS };
    await this.store.kvSet(requestKey(id), JSON.stringify(record));
    return { requestId: id };
  }

  async authorizationRequest(id: string) {
    const record = await this.readRequest(id);
    if (!record) return undefined;
    const client = await this.client(record.clientId).catch(() => undefined);
    if (!client) return undefined;
    return { id, client: clientView(client), redirectHost: hostOf(record.redirectUri), requested: record.requested,
      expiresAt: record.expiresAt };
  }

  /** Consume the request: a code for the client, or its denial. Either way the
   * browser goes back to the client's redirect URI with `state` and `iss`. */
  async decideAuthorization(id: string, decision: Approval | 'deny', issuer: string): Promise<{ redirectUri: string } | undefined> {
    const raw = await this.store.kvGet(requestKey(id));
    const record = raw ? JSON.parse(raw) as AuthorizationRequest : undefined;
    if (!raw || !record || record.expiresAt <= Date.now() || !(await this.store.kvCompareAndSet(requestKey(id), raw, undefined))) return undefined;
    const target = new URL(record.redirectUri);
    if (decision === 'deny') {
      target.searchParams.set('error', 'access_denied');
    } else {
      const code = crypto.randomBytes(32).toString('base64url');
      const stored: CodeRecord = { clientId: record.clientId, redirectUri: record.redirectUri, codeChallenge: record.codeChallenge,
        ...(record.resource ? { resource: record.resource } : {}), approval: decision, expiresAt: Date.now() + CODE_TTL_MS };
      await this.store.kvSet(codeKey(code), JSON.stringify(stored));
      target.searchParams.set('code', code);
    }
    if (record.state) target.searchParams.set('state', record.state);
    target.searchParams.set('iss', issuer); // RFC 9207
    return { redirectUri: target.href };
  }

  private async exchangeCode(params: URLSearchParams, client: OAuthClient): Promise<TokenResponse> {
    const code = params.get('code') ?? '';
    const key = codeKey(code);
    const raw = code ? await this.store.kvGet(key) : undefined;
    const record = raw ? JSON.parse(raw) as CodeRecord : undefined;
    if (!raw || !record || record.expiresAt <= Date.now()) throw new OAuthError('invalid_grant', 'Invalid or expired authorization code');
    if (record.usedBy) {
      // A replayed code: whatever it bought is revoked (RFC 6749 §4.1.2).
      await this.grants.revoke(record.usedBy);
      throw new OAuthError('invalid_grant', 'Authorization code already used; the tokens it issued were revoked');
    }
    if (record.clientId !== client.clientId || params.get('redirect_uri') !== record.redirectUri)
      throw new OAuthError('invalid_grant', 'The code was issued to another client or redirect_uri');
    const verifier = params.get('code_verifier') ?? '';
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)
      || crypto.createHash('sha256').update(verifier).digest('base64url') !== record.codeChallenge)
      throw new OAuthError('invalid_grant', 'code_verifier does not match the code_challenge');
    const grant = await this.grants.create({ userId: record.approval.userId, kind: 'mcp', clientId: client.clientId, name: client.name,
      ceiling: record.approval.ceiling, resource: record.resource, createdBy: record.approval.createdBy });
    if (!(await this.store.kvCompareAndSet(key, raw, JSON.stringify({ ...record, usedBy: grant.id })))) {
      await this.grants.revoke(grant.id);
      throw new OAuthError('invalid_grant', 'Authorization code already used');
    }
    return this.tokenResponse(grant, await this.grants.issue(grant));
  }

  // ── token and revocation endpoints ───────────────────────────────────────
  async token(params: URLSearchParams, resources: string[]): Promise<TokenResponse> {
    const client = await this.client(params.get('client_id') ?? undefined);
    if (!client) throw new OAuthError('invalid_client', 'Unknown or missing client_id', 401, false);
    const resource = params.getAll('resource');
    if (resource.length > 1 || (resource[0] && !resources.includes(resource[0])))
      throw new OAuthError('invalid_target', 'Unknown resource; this server issues tokens only for itself');
    const type = params.get('grant_type');
    if (type === DEVICE_CODE_GRANT) return this.pollDevice(params.get('device_code') ?? '', client);
    if (type === 'authorization_code') return this.exchangeCode(params, client);
    if (type === 'refresh_token') {
      try {
        const refreshed = await this.grants.refresh(params.get('refresh_token') ?? '', client.clientId);
        return this.tokenResponse(refreshed.grant, refreshed);
      } catch (e) {
        if (e instanceof AppGrantError) throw new OAuthError(e.code, e.message);
        throw e;
      }
    }
    throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code, refresh_token or the device code grant');
  }

  async revoke(params: URLSearchParams): Promise<void> {
    const token = params.get('token');
    if (token) await this.grants.revokeToken(token, params.get('client_id') ?? undefined);
  }

  private tokenResponse(grant: AppGrant, tokens: { accessToken: string; refreshToken: string; expiresIn: number }): TokenResponse {
    return { access_token: tokens.accessToken, token_type: 'Bearer', expires_in: tokens.expiresIn,
      refresh_token: tokens.refreshToken, scope: ceilingScope(grant.ceiling) };
  }

  // ── housekeeping ─────────────────────────────────────────────────────────
  private async readRequest(id: string): Promise<AuthorizationRequest | undefined> {
    const raw = /^[A-Za-z0-9_-]{24}$/.test(id) ? await this.store.kvGet(requestKey(id)) : undefined;
    const record = raw ? JSON.parse(raw) as AuthorizationRequest : undefined;
    return record && record.expiresAt > Date.now() ? record : undefined;
  }

  private async updateRecord<T>(key: string, change: (record: T) => T | undefined): Promise<boolean> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const raw = await this.store.kvGet(key);
      if (!raw) return false;
      const next = change(JSON.parse(raw) as T);
      if (!next) return false;
      if (await this.store.kvCompareAndSet(key, raw, JSON.stringify(next))) return true;
    }
    return false;
  }

  /** Fixed-window limiter. `count` false only checks. */
  private allow(key: string, max: number, windowMs: number, count = true): boolean {
    const now = Date.now();
    if (this.limits.size > 10_000) for (const [k, v] of this.limits) if (v.until <= now) this.limits.delete(k);
    const entry = this.limits.get(key);
    const current = entry && entry.until > now ? entry : { count: 0, until: now + windowMs };
    if (current.count >= max) return false;
    if (count) { current.count++; this.limits.set(key, current); }
    return true;
  }

  /** Expired device codes, authorization requests and codes nobody came back
   * for, and dead token rows; at most every ten minutes per process. */
  private async maybeSweep(): Promise<void> {
    if (Date.now() - this.lastSweep < 10 * 60_000) return;
    this.lastSweep = Date.now();
    const now = Date.now();
    for (const prefix of ['oauth-device:', 'oauth-request:', 'oauth-code:']) {
      for (const { key, value } of await this.store.kvEntries(prefix)) {
        const record = JSON.parse(value) as { expiresAt: number; userCode?: string };
        if (record.expiresAt > now) continue;
        await this.store.kvDelete(key);
        if (record.userCode) await this.store.kvDelete(userCodeKey(record.userCode));
      }
    }
    await this.grants.sweep();
  }
}

function clientView(client: OAuthClient) {
  return { id: client.clientId, name: client.name, kind: client.kind, verified: client.verified, host: client.host };
}

function hostOf(uri: string | undefined): string | undefined {
  try { return uri ? new URL(uri).host || new URL(uri).protocol.replace(/:$/, '') : undefined; } catch { return undefined; }
}

function newUserCode(): string {
  const bytes = crypto.randomBytes(8);
  const chars = [...bytes].map((byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/** Accept the code however it was typed: any case, with or without the dash. */
export function normalizeUserCode(raw: string): string | undefined {
  const chars = String(raw ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  if (chars.length !== 8 || [...chars].some((c) => !USER_CODE_ALPHABET.includes(c))) return undefined;
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** https, loopback http (RFC 8252 §7.3), or a private-use scheme (§7.1). */
export function validRedirectUri(uri: string): boolean {
  let url: URL;
  try { url = new URL(uri); } catch { return false; }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return LOOPBACK_HOSTS.has(url.hostname);
  return /^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+:$/.test(url.protocol);
}

/** Exact match, except that a loopback redirect may use any port (RFC 8252 §7.3). */
export function redirectUriMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  try {
    const a = new URL(registered), b = new URL(requested);
    return a.protocol === 'http:' && b.protocol === 'http:' && LOOPBACK_HOSTS.has(a.hostname) && a.hostname === b.hostname
      && a.pathname === b.pathname && a.search === b.search && !b.hash && !b.username && !b.password;
  } catch { return false; }
}
