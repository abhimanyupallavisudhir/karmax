import type http from 'node:http';
import type { Store } from '../store/db.js';
import type { AuthorizationService } from '../platform/authorization.js';
import type { ScopedToken } from '../platform/tokens.js';
import { actorPrincipal, requireHumanSubject, type CallerIdentity } from '../platform/identity.js';
import { allows, type Capability } from '../platform/capabilities.js';
import { AppGrants, ceilingScope, type AppGrant, type AppGrantCeiling } from '../auth/app-grants.js';
import { DEVICE_CODE_GRANT, OAuthError, OAuthServer, type Approval } from '../auth/oauth-server.js';
import { serveRemoteMcp } from '../platform/remote-mcp.js';
import { BRAND } from '../domain/brand.js';
import { clientAddress } from './client-address.js';

/**
 * HTTP surface of tavya's authorization server (see `auth/oauth-server.ts`):
 * - before the session gate: RFC 8414 / RFC 9728 metadata, `/oauth/*` and the
 *   remote MCP endpoint `/mcp`;
 * - behind it, as personal operations of the verified human subject: the
 *   approval endpoints the `/device` and consent pages use, Account → Apps and
 *   tokens, and `GET /api/user/me`.
 * The gateway calls `handlePublic` and `handleApi`; everything else stays here.
 */
export interface OAuthRouteDeps {
  store: Store;
  grants: AppGrants;
  oauth: OAuthServer;
  authorization?: AuthorizationService;
  hostLocal: () => boolean;
  /** Whether a bearer authenticates (an app grant token, or a platform token). */
  bearerValid: (token: string) => Promise<boolean>;
  /** Where this gateway answers `/api` itself, and the headers marking those calls. */
  loopback: () => { baseUrl: string; headers: Record<string, string> } | undefined;
  userName: (userId: string) => Promise<{ name?: string; email?: string } | undefined>;
}

/** The context the gateway resolved for an authenticated `/api` request. */
export interface OAuthApiContext {
  session: { user: string; userId?: string; email?: string; appGrant?: AppGrant };
  record: ScopedToken;
  identity: CallerIdentity;
}

/** Route bindings for `routeCapability`: personal self-service, the subject is checked in the handler. */
export function appGrantRouteCapability(p: string): 'none' | undefined {
  return p === '/api/user/me' || p === '/api/user/tokens' || /^\/api\/user\/app-grants(?:\/|$)/.test(p)
    || /^\/api\/oauth\/(?:device|authorizations)(?:\/|$)/.test(p) ? 'none' : undefined;
}

const PERSONAL_TOKEN_CLIENT = 'personal-token';
const HIDDEN_LEVELS = new Set(['god', 'operator']);
const CORS_PATHS = new Set(['/oauth/token', '/oauth/device', '/oauth/register', '/oauth/revoke', '/mcp']);

export class OAuthRoutes {
  constructor(private deps: OAuthRouteDeps) {}

  /** RFC 8414 issuer: the configured public URL, else (host-local only) the request origin. */
  issuer(req: http.IncomingMessage): string | undefined {
    const configured = process.env.KARMAX_PUBLIC_URL?.trim();
    if (configured) try { return new URL(configured).origin; } catch { return undefined; }
    if (!this.deps.hostLocal() || !req.headers.host) return undefined;
    const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim()
      || ((req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
    try { return new URL(`${proto}://${req.headers.host}`).origin; } catch { return undefined; }
  }

  private resources(issuer: string) { return [issuer, `${issuer}/`, `${issuer}/mcp`]; }

  /** Answers the unauthenticated routes; false for anything else. */
  async handlePublic(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname, method = req.method ?? 'GET';
    const metadata = p === '/.well-known/oauth-authorization-server';
    const resourceMetadata = p === '/.well-known/oauth-protected-resource' || p === '/.well-known/oauth-protected-resource/mcp';
    if (!metadata && !resourceMetadata && !CORS_PATHS.has(p) && p !== '/oauth/authorize') return false;
    if (p !== '/oauth/authorize') {
      // Public clients run anywhere (a browser-based MCP client too). Nothing
      // here reads cookies, so any origin may call it.
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id');
      res.setHeader('access-control-expose-headers', 'www-authenticate, mcp-session-id');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      if (method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
    }
    const issuer = this.issuer(req);
    if (!issuer) {
      json(res, 503, { error: 'temporarily_unavailable',
        error_description: 'Signing in apps needs the installation public URL (KARMAX_PUBLIC_URL).' });
      return true;
    }
    if (metadata && method === 'GET') {
      json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        device_authorization_endpoint: `${issuer}/oauth/device`,
        registration_endpoint: `${issuer}/oauth/register`,
        revocation_endpoint: `${issuer}/oauth/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token', DEVICE_CODE_GRANT],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        revocation_endpoint_auth_methods_supported: ['none'],
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true,
      }, { 'cache-control': 'public, max-age=300' });
      return true;
    }
    if (resourceMetadata && method === 'GET') {
      json(res, 200, { resource: `${issuer}/mcp`, authorization_servers: [issuer], bearer_methods_supported: ['header'],
        resource_name: BRAND }, { 'cache-control': 'public, max-age=300' });
      return true;
    }
    if (p === '/mcp') return this.mcp(req, res, issuer);
    try {
      if (p === '/oauth/authorize' && method === 'GET') return await this.authorize(res, url, issuer);
      if (method !== 'POST' || !CORS_PATHS.has(p)) {
        json(res, 405, { error: 'invalid_request', error_description: `Use ${CORS_PATHS.has(p) ? 'POST' : 'GET'}` });
        return true;
      }
      if (p === '/oauth/register') {
        // RFC 7591 metadata is a JSON document.
        let body: unknown;
        try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = undefined; }
        if (!body || typeof body !== 'object' || Array.isArray(body))
          throw new OAuthError('invalid_client_metadata', 'Send the client metadata as a JSON object', 400, false);
        json(res, 201, await this.deps.oauth.register(body as Record<string, unknown>, clientAddress(req)), NO_STORE);
        return true;
      }
      const params = await formParams(req);
      if (p === '/oauth/device') {
        json(res, 200, await this.deps.oauth.startDevice({ clientId: params.get('client_id') ?? undefined,
          name: params.get('name') ?? undefined, scope: params.get('scope') ?? undefined,
          resource: this.resource(params, issuer) }, `${issuer}/device`), NO_STORE);
      } else if (p === '/oauth/token') {
        json(res, 200, await this.deps.oauth.token(params, this.resources(issuer)), NO_STORE);
      } else if (p === '/oauth/revoke') {
        await this.deps.oauth.revoke(params);
        json(res, 200, {}, NO_STORE);
      }
    } catch (e) {
      if (!(e instanceof OAuthError)) throw e;
      json(res, e.status, { error: e.error, error_description: e.description }, NO_STORE);
    }
    return true;
  }

  private resource(params: URLSearchParams, issuer: string): string | undefined {
    const resource = params.get('resource') ?? undefined;
    if (resource && !this.resources(issuer).includes(resource))
      throw new OAuthError('invalid_target', 'Unknown resource; this server issues tokens only for itself');
    return resource;
  }

  /** Validate and park the request, then send the browser to the consent page. */
  private async authorize(res: http.ServerResponse, url: URL, issuer: string): Promise<boolean> {
    try {
      const { requestId } = await this.deps.oauth.authorize(url.searchParams, this.resources(issuer));
      res.writeHead(302, { location: `/oauth/consent?request=${encodeURIComponent(requestId)}`, 'cache-control': 'no-store',
        'referrer-policy': 'no-referrer' });
      res.end();
    } catch (e) {
      if (!(e instanceof OAuthError)) throw e;
      if (!e.redirect) {
        res.writeHead(e.status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end(`This sign-in link is not valid: ${e.description}`);
        return true;
      }
      const target = new URL(url.searchParams.get('redirect_uri')!);
      target.searchParams.set('error', e.error);
      target.searchParams.set('error_description', e.description);
      if (url.searchParams.get('state')) target.searchParams.set('state', url.searchParams.get('state')!);
      target.searchParams.set('iss', issuer);
      res.writeHead(302, { location: target.href, 'cache-control': 'no-store' });
      res.end();
    }
    return true;
  }

  private async mcp(req: http.IncomingMessage, res: http.ServerResponse, issuer: string): Promise<boolean> {
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    if (!bearer || !(await this.deps.bearerValid(bearer))) {
      res.writeHead(401, { 'content-type': 'application/json',
        'www-authenticate': `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"${bearer ? ', error="invalid_token"' : ''}` });
      res.end(JSON.stringify({ error: bearer ? 'invalid_token' : 'unauthorized' }));
      return true;
    }
    const loopback = this.deps.loopback();
    if (!loopback) { json(res, 503, { error: 'MCP is not ready' }); return true; }
    await serveRemoteMcp(req, res, { bearer, apiBaseUrl: loopback.baseUrl, internalHeaders: loopback.headers });
    return true;
  }

  // ── authenticated personal routes ────────────────────────────────────────
  async handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: OAuthApiContext): Promise<boolean> {
    const p = url.pathname, method = req.method ?? 'GET';
    if (!appGrantRouteCapability(p)) return false;
    const subject = requireHumanSubject(ctx.identity);
    const limiter = [`user:${subject.userId}`, `ip:${clientAddress(req)}`];
    if (p === '/api/user/me' && method === 'GET') {
      const person = await this.deps.userName(subject.userId);
      const grant = ctx.session.appGrant;
      json(res, 200, { id: subject.userId, name: person?.name ?? null, email: person?.email ?? null,
        via: grant ? { grantId: grant.id, kind: grant.kind, name: grant.name, scope: ceilingScope(grant.ceiling), expiresAt: grant.expiresAt }
          : { kind: ctx.identity.actor.kind === 'interactive-human' ? 'browser' : 'agent', principal: actorPrincipal(ctx.identity.actor) } });
      return true;
    }
    if (p === '/api/user/app-grants' && method === 'GET') {
      json(res, 200, { grants: (await this.deps.grants.list(subject.userId)).map((grant) => grantView(grant, ctx.session.appGrant?.id)),
        levels: await this.levels() });
      return true;
    }
    const grantMatch = p.match(/^\/api\/user\/app-grants\/([^/]+)$/);
    if (grantMatch && method === 'DELETE') {
      const revoked = await this.deps.grants.revoke(decodeURIComponent(grantMatch[1]!), subject.userId);
      if (revoked) await this.audit(ctx, 'app-grant.revoked', { grantId: grantMatch[1] });
      json(res, revoked ? 200 : 404, revoked ? { revoked: true } : { error: 'app grant not found' });
      return true;
    }
    if (p === '/api/user/tokens' && method === 'POST') {
      const body = await jsonBody(req);
      const days = Number(body.expiresInDays);
      if (!Number.isInteger(days) || days < 1 || days > 366) { json(res, 400, { error: 'expiresInDays must be a whole number of days from 1 to 366' }); return true; }
      if (typeof body.name !== 'string' || !body.name.trim()) { json(res, 400, { error: 'name is required' }); return true; }
      const approval = await this.approval(res, ctx, body);
      if (!approval) return true;
      const grant = await this.deps.grants.create({ userId: approval.userId, kind: 'token', clientId: PERSONAL_TOKEN_CLIENT,
        name: body.name, ceiling: approval.ceiling, createdBy: approval.createdBy, expiresAt: Date.now() + days * 24 * 60 * 60_000 });
      const token = await this.deps.grants.personalToken(grant);
      await this.audit(ctx, 'app-grant.token-created', { grantId: grant.id, scope: ceilingScope(grant.ceiling), expiresAt: grant.expiresAt });
      json(res, 201, { id: grant.id, token, expiresAt: grant.expiresAt, scope: ceilingScope(grant.ceiling) }, NO_STORE);
      return true;
    }
    if (p === '/api/oauth/device' && method === 'GET') {
      const request = await this.oauthCall(res, () => this.deps.oauth.deviceRequest(url.searchParams.get('code') ?? '', limiter));
      if (request === null) return true;
      json(res, request ? 200 : 404, request ? { ...request, levels: await this.levels() } : { error: 'That code is not valid or has expired.' });
      return true;
    }
    const device = p.match(/^\/api\/oauth\/device\/(approve|deny)$/);
    if (device && method === 'POST') {
      const body = await jsonBody(req);
      const approval = device[1] === 'deny' ? 'deny' as const : await this.approval(res, ctx, body);
      if (!approval) return true;
      const decided = await this.oauthCall(res, () => this.deps.oauth.decideDevice(String(body.code ?? ''), limiter, approval));
      if (decided === null) return true;
      if (decided) await this.audit(ctx, `app-grant.device-${device[1] === 'deny' ? 'denied' : 'approved'}`,
        approval === 'deny' ? {} : { scope: ceilingScope(approval.ceiling) });
      json(res, decided ? 200 : 404, decided ? { ok: true } : { error: 'That code is not valid, has expired or was already used.' });
      return true;
    }
    const authorization = p.match(/^\/api\/oauth\/authorizations\/([^/]+)(?:\/(approve|deny))?$/);
    if (authorization && method === (authorization[2] ? 'POST' : 'GET')) {
      const id = decodeURIComponent(authorization[1]!);
      if (!authorization[2]) {
        const request = await this.deps.oauth.authorizationRequest(id);
        json(res, request ? 200 : 404, request ? { ...request, levels: await this.levels() } : { error: 'This sign-in request expired. Start again from the app.' });
        return true;
      }
      const issuer = this.issuer(req);
      if (!issuer) { json(res, 503, { error: 'Signing in apps needs the installation public URL (KARMAX_PUBLIC_URL).' }); return true; }
      const approval = authorization[2] === 'deny' ? 'deny' as const : await this.approval(res, ctx, await jsonBody(req));
      if (!approval) return true;
      const decided = await this.deps.oauth.decideAuthorization(id, approval, issuer);
      if (decided) await this.audit(ctx, `app-grant.authorization-${authorization[2] === 'deny' ? 'denied' : 'approved'}`,
        approval === 'deny' ? {} : { scope: ceilingScope(approval.ceiling) });
      json(res, decided ? 200 : 404, decided ?? { error: 'This sign-in request expired. Start again from the app.' });
      return true;
    }
    json(res, 405, { error: 'method not allowed' });
    return true;
  }

  /** The levels a limit may name: the installation's profiles, minus the wildcard ones. */
  private async levels() {
    const profiles = await this.deps.authorization?.profiles() ?? [];
    return profiles.filter((profile) => !HIDDEN_LEVELS.has(profile.id))
      .map((profile) => ({ id: profile.id, name: profile.name, description: profile.description }));
  }

  /**
   * Turn a requested limit into the ceiling of a new grant, or answer the
   * refusal. A grant never exceeds whoever creates it:
   * - a person in the browser: their current authority applies at every use, so
   *   the limit only narrows it; the projects/organization must be theirs;
   * - an app grant (the CLI making a token) or an agent acting for the person:
   *   the new grant stays inside that grant or token, or is refused.
   */
  private async approval(res: http.ServerResponse, ctx: OAuthApiContext, body: Record<string, unknown>): Promise<Approval | undefined> {
    const subject = requireHumanSubject(ctx.identity);
    const authorization = this.deps.authorization;
    if (!authorization) { json(res, 503, { error: 'authorization service unavailable' }); return undefined; }
    const requested = parseCeiling(body);
    if (typeof requested === 'string') { json(res, 400, { error: requested }); return undefined; }
    const deny = (error: string, missing?: Capability[]) => {
      json(res, 403, { error, code: 'authorization_grant_denied', ...(missing?.length ? { missingCapabilities: missing } : {}) });
      return undefined;
    };
    const record = ctx.record;
    const parent: AppGrantCeiling | undefined = ctx.session.appGrant ? ctx.session.appGrant.ceiling ?? {}
      : ctx.identity.actor.kind === 'interactive-human' ? undefined
      : { caps: record.caps, projectIds: record.projectId ? [record.projectId] : record.projectIds, organizationId: record.organizationId };
    const ceiling: AppGrantCeiling = { ...requested };
    if (parent?.projectIds?.length) {
      const outside = requested.projectIds?.filter((id) => !parent.projectIds!.includes(id)) ?? [];
      if (outside.length) return deny(`Your token is limited to projects ${parent.projectIds.join(', ')}; it cannot reach ${outside.join(', ')}.`);
      ceiling.projectIds ??= parent.projectIds;
    }
    if (parent?.organizationId) {
      if (requested.organizationId && requested.organizationId !== parent.organizationId)
        return deny(`Your token is limited to organization ${parent.organizationId}.`);
      ceiling.organizationId = parent.organizationId;
    }
    if (parent?.caps) ceiling.caps = parent.caps;
    // The scope must be the person's own.
    for (const projectId of ceiling.projectIds ?? []) {
      const project = await this.deps.store.getProject(projectId);
      const organizationId = project?.organizationId ?? 'org_personal';
      if (!project || !allows(await authorization.capabilitiesAsync(`user:${subject.userId}`, projectId, organizationId), 'project:read'))
        return deny(`You have no access to project ${projectId}.`);
      if (ceiling.organizationId && organizationId !== ceiling.organizationId)
        return deny(`Project ${projectId} is not in organization ${ceiling.organizationId}.`);
    }
    if (ceiling.organizationId && !ceiling.projectIds?.length
      && !allows(await authorization.capabilitiesAsync(`user:${subject.userId}`, undefined, ceiling.organizationId), 'organization:read'))
      return deny(`You have no access to organization ${ceiling.organizationId}.`);
    // A level must exist, and stay within a narrower creator.
    const level = requested.level ?? parent?.level;
    if (level) {
      const organizationId = ceiling.organizationId ?? (ceiling.projectIds?.[0] ? (await this.deps.store.getProject(ceiling.projectIds[0]))?.organizationId : undefined);
      const profile = HIDDEN_LEVELS.has(level) ? undefined : await authorization.profile(level, undefined, organizationId);
      if (!profile) { json(res, 400, { error: `Unknown level ${level}` }); return undefined; }
      ceiling.level = level;
      if (requested.level && parent?.level && parent.level !== requested.level) {
        const bound = await authorization.profile(parent.level, undefined, organizationId);
        const missing = profile.capabilities.filter((cap) => !allows(bound?.capabilities ?? [], cap));
        if (missing.length) return deny(`${profile.name} is above your token's level.`, missing);
      }
      if (requested.level && parent?.caps) {
        const missing = profile.capabilities.filter((cap) => !allows(parent.caps!, cap));
        if (missing.length) return deny(`${profile.name} is above your own token's authority.`, missing);
      }
    }
    const createdBy = ctx.identity.actor.kind === 'interactive-human' ? { kind: 'user' as const }
      : { kind: 'agent' as const, principal: actorPrincipal(ctx.identity.actor) };
    return { userId: subject.userId, ceiling, createdBy };
  }

  /** OAuth errors on the approval routes become their status (rate limits). */
  private async oauthCall<T>(res: http.ServerResponse, run: () => Promise<T>): Promise<T | null> {
    try { return await run(); } catch (e) {
      if (!(e instanceof OAuthError)) throw e;
      json(res, e.status, { error: e.description });
      return null;
    }
  }

  private async audit(ctx: OAuthApiContext, action: string, detail: Record<string, unknown>) {
    await this.deps.authorization?.audit(actorPrincipal(ctx.identity.actor), action, 'global', detail);
  }
}

function grantView(grant: AppGrant, currentGrantId?: string) {
  const { caps: _caps, ...ceiling } = grant.ceiling ?? {};
  return { id: grant.id, kind: grant.kind, name: grant.name, clientId: grant.clientId, scope: ceilingScope(grant.ceiling),
    ceiling, limitedByCreator: Boolean(grant.ceiling?.caps), createdAt: grant.createdAt, lastUsedAt: grant.lastUsedAt ?? null,
    expiresAt: grant.expiresAt, createdBy: grant.createdBy?.kind ?? 'user', ...(grant.id === currentGrantId ? { current: true } : {}) };
}

function parseCeiling(body: Record<string, unknown>): AppGrantCeiling | string {
  const id = /^[\w.-]{1,128}$/;
  const level = body.level === null || body.level === '' ? undefined : body.level;
  if (level !== undefined && (typeof level !== 'string' || !id.test(level))) return 'level must be a level id';
  const projectIds = body.projectIds === null ? undefined : body.projectIds;
  if (projectIds !== undefined && (!Array.isArray(projectIds) || projectIds.length > 100
    || projectIds.some((value) => typeof value !== 'string' || !id.test(value)))) return 'projectIds must be a list of project ids';
  const organizationId = body.organizationId === null || body.organizationId === '' ? undefined : body.organizationId;
  if (organizationId !== undefined && (typeof organizationId !== 'string' || !id.test(organizationId))) return 'organizationId must be an organization id';
  return { ...(level ? { level } : {}), ...(projectIds?.length ? { projectIds: [...new Set(projectIds as string[])] } : {}),
    ...(organizationId ? { organizationId } : {}) };
}

const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' };

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage, max = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > max) throw new OAuthError('invalid_request', 'Request body too large', 413, false);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** OAuth endpoints take form posts (RFC 6749) and, for convenience, JSON. */
async function formParams(req: http.IncomingMessage): Promise<URLSearchParams> {
  const text = await readBody(req);
  if (!String(req.headers['content-type'] ?? '').includes('application/json')) return new URLSearchParams(text);
  let body: unknown;
  try { body = text ? JSON.parse(text) : {}; } catch { throw new OAuthError('invalid_request', 'Invalid JSON body', 400, false); }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    for (const item of Array.isArray(value) ? value : [value])
      if (item !== undefined && item !== null) params.append(key, typeof item === 'string' ? item : JSON.stringify(item));
  }
  return params;
}

async function jsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(req);
  if (!text) return {};
  try {
    const body = JSON.parse(text);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  } catch { throw Object.assign(new Error('invalid JSON body'), { status: 400 }); }
}
