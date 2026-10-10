import crypto from 'node:crypto';
import type { Store } from '../store/db.js';
import { attenuate, type Capability } from '../platform/capabilities.js';
import type { AuthorizationProfileId } from '../platform/authorization.js';

/**
 * App grants: one durable record per approval a person gave an application —
 * a CLI device login (`cli`), an MCP client's OAuth consent (`mcp`) or a
 * personal access token (`token`). tavya is the authorization server; Better
 * Auth stays the identity provider for the person approving.
 *
 * Tokens are opaque and stored only as SHA-256 digests:
 * - `tva_…` OAuth access token, one hour;
 * - `tvr_<grant>.<secret>` refresh token, rotated on every use. The grant keeps
 *   the current digest and the last few rotated ones, so presenting a rotated
 *   token is recognized as reuse and revokes the whole grant;
 * - `tvp_…` personal access token, with the fixed expiry chosen at creation.
 *
 * A token is valid only while its grant record exists, so revoking a grant (or
 * closing the account) kills every token at once on every gateway replica: each
 * request reads durable state, as `TokenAuthority.verify` does.
 */
export type AppGrantKind = 'cli' | 'mcp' | 'token';

/** What a grant may do at most. The person's current authority always applies
 * on top: a grant can narrow it, never widen it. */
export interface AppGrantCeiling {
  /** An authorization level (profile id); its capabilities cap the grant. */
  level?: AuthorizationProfileId;
  /** Only these projects. */
  projectIds?: string[];
  /** Only this organization. */
  organizationId?: string;
  /** Explicit capability cap, recorded when an agent (or a narrower grant)
   * created this one: it may never exceed the creator's own token. */
  caps?: Capability[];
}

export interface AppGrant {
  id: string;
  userId: string;
  kind: AppGrantKind;
  clientId: string;
  name: string;
  ceiling?: AppGrantCeiling;
  /** RFC 8707 resource the client asked for (always this installation). */
  resource?: string;
  createdAt: number;
  lastUsedAt?: number;
  expiresAt: number;
  /** Who approved it: the person, or an agent acting for them. */
  createdBy?: { kind: 'user' } | { kind: 'agent'; principal: string };
  /** Refresh-token family (OAuth grants only). */
  refresh?: { current: string; previous: string[] };
}

interface TokenRecord { type: 'access' | 'pat'; grantId: string; userId: string; expiresAt: number }

export const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
/** `cli` and `mcp` grants unused for this long expire. */
export const GRANT_IDLE_TTL_MS = 90 * 24 * 60 * 60_000;
/** `lastUsedAt` is written at most this often per grant. */
const TOUCH_INTERVAL_MS = 60_000;
/** Rotated refresh digests kept for reuse detection. */
const ROTATED_REFRESH_KEPT = 16;
const MAX_TOKEN_TTL_MS = 366 * 24 * 60 * 60_000;

const grantKey = (id: string) => `app-grant:${id}`;
const userIndexKey = (userId: string, id: string) => `app-grant-user:${userId}:${id}`;
const tokenKey = (digest: string) => `app-token:${digest}`;
export const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const secret = () => crypto.randomBytes(32).toString('base64url');

export class AppGrantError extends Error {
  constructor(public code: 'invalid_grant' | 'invalid_request', message: string) { super(message); }
}

/** Is this bearer one of ours (an access or personal token)? */
export const isAppBearer = (token: string | undefined): token is string =>
  !!token && (token.startsWith('tva_') || token.startsWith('tvp_'));

export class AppGrants {
  constructor(private store: Store) {}

  async create(input: { userId: string; kind: AppGrantKind; clientId: string; name: string; ceiling?: AppGrantCeiling;
    resource?: string; expiresAt?: number; createdBy?: AppGrant['createdBy'] }): Promise<AppGrant> {
    const now = Date.now();
    if (input.kind === 'token' && !(Number.isFinite(input.expiresAt) && input.expiresAt! > now && input.expiresAt! <= now + MAX_TOKEN_TTL_MS))
      throw new AppGrantError('invalid_request', 'A personal token needs an expiry between now and one year from now');
    const grant: AppGrant = {
      id: `grant_${crypto.randomBytes(12).toString('hex')}`, userId: input.userId, kind: input.kind,
      clientId: input.clientId, name: input.name.trim().slice(0, 100) || input.clientId,
      ...(normalizeCeiling(input.ceiling) ? { ceiling: normalizeCeiling(input.ceiling) } : {}),
      ...(input.resource ? { resource: input.resource } : {}),
      createdAt: now, expiresAt: input.kind === 'token' ? input.expiresAt! : now + GRANT_IDLE_TTL_MS,
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    };
    await this.store.transaction(async () => {
      await this.store.kvSet(grantKey(grant.id), JSON.stringify(grant));
      await this.store.kvSet(userIndexKey(grant.userId, grant.id), '1');
    });
    return grant;
  }

  /** A live grant, or undefined once it is revoked, expired or its account closed. */
  async get(id: string): Promise<AppGrant | undefined> {
    const raw = await this.store.kvGet(grantKey(id));
    if (!raw) return undefined;
    const grant = JSON.parse(raw) as AppGrant;
    if (grant.expiresAt <= Date.now()) { await this.delete(grant); return undefined; }
    if (await this.store.kvGet(`account-closed:${grant.userId}`)) return undefined;
    return grant;
  }

  async list(userId: string): Promise<AppGrant[]> {
    const grants: AppGrant[] = [];
    for (const { key } of await this.store.kvEntries(`app-grant-user:${userId}:`)) {
      const grant = await this.get(key.slice(`app-grant-user:${userId}:`.length));
      if (grant) grants.push(grant);
      else await this.store.kvDelete(key);
    }
    return grants.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Revoke a grant and, with it, every token it issued. */
  async revoke(id: string, userId?: string): Promise<boolean> {
    const raw = await this.store.kvGet(grantKey(id));
    if (!raw) return false;
    const grant = JSON.parse(raw) as AppGrant;
    if (userId && grant.userId !== userId) return false;
    await this.delete(grant);
    return true;
  }

  /** Account closure: every grant of the person goes. */
  async revokeUser(userId: string): Promise<number> {
    let revoked = 0;
    for (const { key } of await this.store.kvEntries(`app-grant-user:${userId}:`)) {
      await this.store.kvDelete(grantKey(key.slice(`app-grant-user:${userId}:`.length)));
      await this.store.kvDelete(key);
      revoked++;
    }
    return revoked;
  }

  /** Is the grant behind a minted principal token still live? */
  async live(id: string, userId: string): Promise<boolean> {
    return (await this.get(id))?.userId === userId;
  }

  /** Access + refresh token for an OAuth grant (a new refresh family). */
  async issue(grant: AppGrant): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const refreshToken = `tvr_${grant.id}.${secret()}`;
    if (!(await this.update(grant.id, (current) => ({ ...current, refresh: { current: digest(refreshToken), previous: [] } }))))
      throw new AppGrantError('invalid_grant', 'The grant was revoked');
    return { accessToken: await this.accessToken(grant), refreshToken, expiresIn: ACCESS_TOKEN_TTL_MS / 1000 };
  }

  /** The one-time plaintext of a personal access token grant. */
  async personalToken(grant: AppGrant): Promise<string> {
    const token = `tvp_${secret()}`;
    const record: TokenRecord = { type: 'pat', grantId: grant.id, userId: grant.userId, expiresAt: grant.expiresAt };
    await this.store.kvSet(tokenKey(digest(token)), JSON.stringify(record));
    return token;
  }

  private async accessToken(grant: AppGrant): Promise<string> {
    const token = `tva_${secret()}`;
    const record: TokenRecord = { type: 'access', grantId: grant.id, userId: grant.userId,
      expiresAt: Math.min(Date.now() + ACCESS_TOKEN_TTL_MS, grant.expiresAt) };
    await this.store.kvSet(tokenKey(digest(token)), JSON.stringify(record));
    return token;
  }

  /** Resolve a `tva_`/`tvp_` bearer to its live grant and note the use. */
  async authenticate(token: string): Promise<AppGrant | undefined> {
    if (!isAppBearer(token)) return undefined;
    const key = tokenKey(digest(token));
    const raw = await this.store.kvGet(key);
    if (!raw) return undefined;
    const record = JSON.parse(raw) as TokenRecord;
    if (record.expiresAt <= Date.now() || (record.type === 'access') !== token.startsWith('tva_')) {
      if (record.expiresAt <= Date.now()) await this.store.kvDelete(key);
      return undefined;
    }
    const grant = await this.get(record.grantId);
    if (!grant || grant.userId !== record.userId) { await this.store.kvDelete(key); return undefined; }
    return this.touch(grant);
  }

  /** Rotate a refresh token. Presenting one that was already rotated means it
   * leaked (or a client raced itself): the whole grant is revoked. */
  async refresh(token: string, clientId: string): Promise<{ grant: AppGrant; accessToken: string; refreshToken: string; expiresIn: number }> {
    const grantId = token.match(/^tvr_(grant_[0-9a-f]+)\.[A-Za-z0-9_-]+$/)?.[1];
    const grant = grantId ? await this.get(grantId) : undefined;
    const presented = digest(token);
    if (!grant?.refresh || grant.clientId !== clientId) throw new AppGrantError('invalid_grant', 'Invalid refresh token');
    if (grant.refresh.current !== presented) {
      if (grant.refresh.previous.includes(presented)) {
        await this.revoke(grant.id);
        throw new AppGrantError('invalid_grant', 'Refresh token reuse detected; the grant was revoked. Sign in again.');
      }
      throw new AppGrantError('invalid_grant', 'Invalid refresh token');
    }
    const next = `tvr_${grant.id}.${secret()}`;
    let reused = false;
    const updated = await this.update(grant.id, (current) => {
      if (current.refresh?.current !== presented) { reused = true; return undefined; }
      return { ...current, lastUsedAt: Date.now(), ...(current.kind === 'token' ? {} : { expiresAt: Date.now() + GRANT_IDLE_TTL_MS }),
        refresh: { current: digest(next), previous: [presented, ...current.refresh.previous].slice(0, ROTATED_REFRESH_KEPT) } };
    });
    if (reused) {
      await this.revoke(grant.id);
      throw new AppGrantError('invalid_grant', 'Refresh token reuse detected; the grant was revoked. Sign in again.');
    }
    if (!updated) throw new AppGrantError('invalid_grant', 'The grant was revoked');
    return { grant: updated, accessToken: await this.accessToken(updated), refreshToken: next, expiresIn: ACCESS_TOKEN_TTL_MS / 1000 };
  }

  /** RFC 7009: revoking a refresh or personal token revokes its grant; an
   * access token only itself. Unknown tokens and other clients' tokens are
   * ignored (the endpoint answers 200 either way). */
  async revokeToken(token: string, clientId?: string): Promise<void> {
    if (token.startsWith('tvr_')) {
      const grantId = token.match(/^tvr_(grant_[0-9a-f]+)\./)?.[1];
      const grant = grantId ? await this.get(grantId) : undefined;
      const known = grant?.refresh && (grant.refresh.current === digest(token) || grant.refresh.previous.includes(digest(token)));
      if (grant && known && (!clientId || grant.clientId === clientId)) await this.revoke(grant.id);
      return;
    }
    if (!isAppBearer(token)) return;
    const key = tokenKey(digest(token));
    const raw = await this.store.kvGet(key);
    if (!raw) return;
    const record = JSON.parse(raw) as TokenRecord;
    const grant = await this.get(record.grantId);
    if (clientId && grant && grant.clientId !== clientId) return;
    if (record.type === 'pat') await this.revoke(record.grantId);
    else await this.store.kvDelete(key);
  }

  /** Remove expired token rows left by tokens nobody presented again. */
  async sweep(): Promise<number> {
    let removed = 0;
    const now = Date.now();
    for (const { key, value } of await this.store.kvEntries('app-token:')) {
      const record = JSON.parse(value) as TokenRecord;
      if (record.expiresAt <= now || !(await this.store.kvGet(grantKey(record.grantId)))) {
        await this.store.kvDelete(key); removed++;
      }
    }
    return removed;
  }

  /** Record a use at most once a minute; `cli`/`mcp` grants slide their expiry. */
  private async touch(grant: AppGrant): Promise<AppGrant> {
    const now = Date.now();
    if (now - (grant.lastUsedAt ?? 0) < TOUCH_INTERVAL_MS) return grant;
    return (await this.update(grant.id, (current) => ({ ...current, lastUsedAt: now,
      ...(current.kind === 'token' ? {} : { expiresAt: now + GRANT_IDLE_TTL_MS }) }), 1)) ?? grant;
  }

  /** Compare-and-set loop on the grant record, so a concurrent use or refresh
   * never overwrites another's write. `undefined` from `change` aborts. */
  private async update(id: string, change: (grant: AppGrant) => AppGrant | undefined, attempts = 5): Promise<AppGrant | undefined> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const raw = await this.store.kvGet(grantKey(id));
      if (!raw) return undefined;
      const next = change(JSON.parse(raw) as AppGrant);
      if (!next) return undefined;
      if (await this.store.kvCompareAndSet(grantKey(id), raw, JSON.stringify(next))) return next;
    }
    return undefined;
  }

  private async delete(grant: AppGrant): Promise<void> {
    await this.store.kvDelete(grantKey(grant.id));
    await this.store.kvDelete(userIndexKey(grant.userId, grant.id));
  }
}

function normalizeCeiling(ceiling: AppGrantCeiling | undefined): AppGrantCeiling | undefined {
  if (!ceiling) return undefined;
  const out: AppGrantCeiling = {
    ...(ceiling.level ? { level: ceiling.level } : {}),
    ...(ceiling.projectIds?.length ? { projectIds: [...new Set(ceiling.projectIds)].sort() } : {}),
    ...(ceiling.organizationId ? { organizationId: ceiling.organizationId } : {}),
    ...(ceiling.caps ? { caps: [...new Set(ceiling.caps)].sort() } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

/**
 * A grant's capabilities in a scope: the person's current capabilities there,
 * attenuated by the grant's level and explicit cap, and nothing at all outside
 * its project or organization scope.
 */
export function grantCapabilities(ceiling: AppGrantCeiling | undefined, userCaps: Capability[],
  scope: { projectId?: string; organizationId?: string }, levelCaps: Capability[] | undefined): Capability[] {
  if (!ceiling) return userCaps;
  if (!grantReaches(ceiling, scope)) return [];
  let caps = userCaps;
  if (ceiling.level) caps = levelCaps ? attenuate(levelCaps, caps) : [];
  if (ceiling.caps) caps = attenuate(ceiling.caps, caps);
  return caps;
}

/**
 * A person's capabilities in a scope as one of their sessions may use them:
 * their current grants there, attenuated by the app grant the session stands
 * for (none for a browser session). Every check that authorizes a person
 * directly, rather than through their route-scoped token, goes through here,
 * so a limited CLI, MCP or personal token stays limited.
 */
export async function sessionCapabilities(
  authorization: {
    capabilitiesAsync(principalId: string, projectId?: string, organizationId?: string): Promise<Capability[]>;
    profile(id: string, projectId?: string, organizationId?: string): Promise<{ capabilities: Capability[] } | undefined>;
  },
  userId: string, ceiling: AppGrantCeiling | undefined, scope: { projectId?: string; organizationId?: string },
): Promise<Capability[]> {
  const caps = await authorization.capabilitiesAsync(`user:${userId}`, scope.projectId, scope.organizationId);
  if (!ceiling) return caps;
  const level = ceiling.level ? (await authorization.profile(ceiling.level, scope.projectId, scope.organizationId))?.capabilities : undefined;
  return grantCapabilities(ceiling, caps, scope, level);
}

/** Is a project/organization inside the grant's scope? A route that names
 * neither is (it is filtered by the capabilities found there). */
export function grantReaches(ceiling: AppGrantCeiling | undefined, scope: { projectId?: string; organizationId?: string }): boolean {
  if (!ceiling) return true;
  if (ceiling.organizationId && scope.organizationId && scope.organizationId !== ceiling.organizationId) return false;
  if (ceiling.projectIds?.length && scope.projectId && !ceiling.projectIds.includes(scope.projectId)) return false;
  // A project-limited grant reaches an organization-level route only as far as
  // the organization of its projects; it carries no organization authority.
  if (ceiling.projectIds?.length && !scope.projectId && scope.organizationId) return false;
  return true;
}

/** Human-readable OAuth `scope` for a ceiling: `level:<id> project:<id>…`, or `all`. */
export function ceilingScope(ceiling: AppGrantCeiling | undefined): string {
  const parts = [
    ...(ceiling?.level ? [`level:${ceiling.level}`] : []),
    ...(ceiling?.organizationId ? [`organization:${ceiling.organizationId}`] : []),
    ...(ceiling?.projectIds ?? []).map((id) => `project:${id}`),
  ];
  return parts.length ? parts.join(' ') : 'all';
}

/** Parse a requested OAuth `scope` into a ceiling (unknown words are ignored). */
export function scopeCeiling(scope: string | undefined): AppGrantCeiling | undefined {
  const ceiling: AppGrantCeiling = {};
  for (const word of String(scope ?? '').split(/\s+/).filter(Boolean)) {
    const [kind, ...rest] = word.split(':');
    const value = rest.join(':');
    if (!value || !/^[\w.-]+$/.test(value)) continue;
    if (kind === 'level') ceiling.level = value;
    else if (kind === 'organization') ceiling.organizationId = value;
    else if (kind === 'project') (ceiling.projectIds ??= []).push(value);
  }
  return normalizeCeiling(ceiling);
}
