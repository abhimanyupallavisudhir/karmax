import type { SqlDatabase } from './sql.js';

/**
 * Committed writes that can withdraw authority, and whose authority each one
 * touched. A cache of authorization decisions, or a long-lived socket, names
 * what its decision stands on (an `AuthoritySubject`) and decides again only
 * when a change touches it, so revocation, removal and transfer take effect at
 * once in this process (#396 review item 3). Other processes and replicas are
 * bounded only by the TTL of whatever decided.
 *
 * It used to be one installation-wide epoch. Every agent turn ends by revoking
 * its token, so the epoch moved about once a second under load and every open
 * socket re-derived its person's access each time: the first wall of the
 * 2026-10 load test (benchmarks/results/load-report-2026-10.md). A revoked
 * token now touches the connections that hold it, not everyone's.
 */
export interface AuthorityChange {
  readonly seq: number;
  /** An unrecognised write: anything may have changed. */
  readonly all?: boolean;
  /** `user:…`, `team:…`, `organization:…` (a project membership's group), or a token's principal. */
  readonly principals?: readonly string[];
  readonly projects?: readonly string[];
  readonly organizations?: readonly string[];
  /** Scoped tokens, by SHA-256 digest or by id. */
  readonly tokens?: readonly string[];
  readonly delegations?: readonly string[];
}
export type AuthorityScope = Omit<AuthorityChange, 'seq'>;
/** What a decision stands on. A dimension it leaves out is one no change to it can affect. */
export interface AuthoritySubject {
  principals?: ReadonlySet<string>;
  projects?: ReadonlySet<string>;
  organizations?: ReadonlySet<string>;
  tokens?: ReadonlySet<string>;
  delegations?: ReadonlySet<string>;
}

const DIMENSIONS = ['principals', 'projects', 'organizations', 'tokens', 'delegations'] as const;
export function affects(change: AuthorityScope, subject: AuthoritySubject): boolean {
  if (change.all) return true;
  return DIMENSIONS.some((dimension) => {
    const values = change[dimension], held = subject[dimension];
    return !!values && !!held && values.some((value) => held.has(value));
  });
}

/** Recent changes, so a cache that records `authoritySeq()` when it decides
 * can ask whether anything since touched it. Older ones are forgotten, and a
 * decision older than the oldest remembered is treated as touched. */
const RETAINED = 1_024;
const recent: AuthorityChange[] = [];
let seq = 0;
const listeners = new Set<(change: AuthorityChange) => void>();
export const authoritySeq = (): number => seq;

export function changedSince(since: number, subject: AuthoritySubject): boolean {
  if (since >= seq) return false;
  if (!recent.length || recent[0]!.seq > since + 1) return true;
  for (let index = recent.length - 1; index >= 0 && recent[index]!.seq > since; index--)
    if (affects(recent[index]!, subject)) return true;
  return false;
}

/** Changes announced in this process, broad (`all`) and scoped: `/api/metrics`.
 * A steady stream of broad ones means a hot write the classifier misses. */
const counts = { all: 0, scoped: 0 };
export const authorityChangeCounts = (): Readonly<typeof counts> => ({ ...counts });

export function authorityChanged(scope: AuthorityScope = { all: true }): void {
  counts[scope.all ? 'all' : 'scoped']++;
  const change: AuthorityChange = { ...scope, seq: ++seq };
  recent.push(change);
  if (recent.length > RETAINED) recent.splice(0, recent.length - RETAINED);
  for (const listener of listeners) try { listener(change); } catch { /* a listener's own failure */ }
}
/** Anything may have changed: every decision is made again. */
export const authorizationChanged = (): void => authorityChanged({ all: true });

/** Call `listener` after each change. It is called for every change, cheaply:
 * a listener tests `affects(change, subject)` and does work only for its own. */
export function onAuthorityChange(listener: (change: AuthorityChange) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Tables are matched on the statement, not on the Store method, so every path
 * that writes them (deprovisioning, account closure, a project move, a revoked
 * preview lease) is caught. Grant and membership inserts are included: they can
 * replace a grant with a narrower one, as can a profile edit. A minted token or
 * delegation withdraws nothing, and every agent turn mints some, so only their
 * updates and deletes count. */
const AUTHORITY_WRITE = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b[\s\S]*?\b(?:principal_grants|organization_memberships|project_memberships|team_memberships|authorization_profiles)\b|^\s*(?:UPDATE|DELETE)\b[\s\S]*?\b(?:scoped_tokens|human_delegations)\b|^\s*UPDATE\s+projects\s+SET\b[\s\S]*?\borganizationId\b|^\s*(?:UPDATE|DELETE)\b[\s\S]*?\bpreview_leases\b|^\s*DELETE\s+FROM\s+(?:projects|teams|organizations)\b/i;

/** The authority writes whose scope their parameters say, by statement. Any
 * other authority write touches everyone: a new or reworded statement is
 * slower, never unsafe. `tests/authority-changes.test.ts` keeps the hot ones here. */
const text = (value: unknown) => String(value);
const normalized = (sql: string) => sql.replace(/\s+/g, ' ').replace(/\s*([=(),<>])\s*/g, '$1').trim();
type Scoper = (params: unknown[]) => AuthorityScope | undefined;
const SCOPED = new Map(([
  // A token's revocation touches the connections it authenticated (and its children's).
  ['UPDATE scoped_tokens SET revokedAt=? WHERE tokenHash=?', (p) => ({ tokens: [text(p[1])] })],
  ['UPDATE scoped_tokens SET revokedAt=? WHERE tokenId=?', (p) => ({ tokens: [text(p[1])] })],
  ['UPDATE scoped_tokens SET revokedAt=? WHERE principal=? AND revokedAt IS NULL', (p) => ({ principals: [text(p[1])] })],
  ['UPDATE scoped_tokens SET revokedAt=? WHERE revokedAt IS NULL AND organizationId=?', (p) => ({ organizations: [text(p[1])] })],
  ['UPDATE scoped_tokens SET revokedAt=? WHERE revokedAt IS NULL AND tokenHash IN(SELECT tokenHash FROM scoped_token_projects WHERE projectId=?)', (p) => ({ projects: [text(p[1])] })],
  ['UPDATE human_delegations SET revokedAt=? WHERE id=?', (p) => ({ delegations: [text(p[1])] })],
  ['UPDATE human_delegations SET revokedAt=? WHERE id=? AND revokedAt IS NULL', (p) => ({ delegations: [text(p[1])] })],
  // Purges delete rows that already authorize nothing (expired or revoked).
  ['DELETE FROM human_delegations WHERE expiresAt<=? OR revokedAt IS NOT NULL', () => undefined],
  ['UPDATE preview_leases SET tlsRequestedAt=? WHERE hostname=? AND tlsRequestedAt IS NULL', () => undefined],
  // A person's access: their grants and memberships, and their groups'.
  ['INSERT INTO principal_grants(principalId,scopeKey,json)VALUES(?,?,?)ON CONFLICT(principalId,scopeKey)DO UPDATE SET json=excluded.json', (p) => ({ principals: [text(p[0])] })],
  ['DELETE FROM principal_grants WHERE principalId=? AND scopeKey=?', (p) => ({ principals: [text(p[0])] })],
  ['DELETE FROM principal_grants WHERE principalId=?', (p) => ({ principals: [text(p[0])] })],
  ['INSERT INTO organization_memberships(organizationId,userId,role,joinedAt)VALUES(?,?,?,?)ON CONFLICT(organizationId,userId)DO UPDATE SET role=excluded.role', (p) => ({ principals: [`user:${text(p[1])}`] })],
  ['DELETE FROM organization_memberships WHERE organizationId=? AND userId=?', (p) => ({ principals: [`user:${text(p[1])}`] })],
  ['INSERT INTO team_memberships(teamId,userId,role,joinedAt)VALUES(?,?,?,?)ON CONFLICT(teamId,userId)DO UPDATE SET role=excluded.role', (p) => ({ principals: [`user:${text(p[1])}`] })],
  ['DELETE FROM team_memberships WHERE teamId=? AND userId=?', (p) => ({ principals: [`user:${text(p[1])}`] })],
  ['DELETE FROM team_memberships WHERE teamId=?', (p) => ({ principals: [`team:${text(p[0])}`] })],
  ['INSERT INTO project_memberships(projectId,principalKey,principal,role,joinedAt)VALUES(?,?,?,?,?)ON CONFLICT(projectId,principalKey)DO UPDATE SET role=excluded.role', (p) => ({ principals: [text(p[1])], projects: [text(p[0])] })],
  ['DELETE FROM project_memberships WHERE projectId=? AND principalKey=?', (p) => ({ principals: [text(p[1])], projects: [text(p[0])] })],
] as Array<[string, Scoper]>).map(([sql, scope]) => [normalized(sql), scope]));
/** `deleteRows` chunks: a purge names the dead tokens it deletes. */
const TOKEN_ROWS = /^DELETE FROM (?:scoped_tokens|scoped_token_projects) WHERE tokenHash IN\((?:\?,?)+\)$/;

/** Whose authority `sql` with `params` touched: undefined if nobody's. */
export function authorityScope(sql: string, params: unknown[] = []): AuthorityScope | undefined {
  if (!AUTHORITY_WRITE.test(sql)) return undefined;
  const statement = normalized(sql);
  if (statement.split('?').length - 1 !== params.length) return { all: true };
  const scoped = SCOPED.get(statement);
  if (scoped) return scoped(params);
  if (TOKEN_ROWS.test(statement)) return { tokens: params.map(text) };
  return { all: true };
}

/** `db`, announcing each authority write once it has committed. */
export function watchAuthorityWrites(db: SqlDatabase): SqlDatabase {
  const changed = (sql: string, params?: unknown[]) => {
    const scope = authorityScope(sql, params);
    if (scope) db.afterCommit(() => authorityChanged(scope));
  };
  return Object.assign(Object.create(db) as SqlDatabase, {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      return { ...statement, async run(...params: unknown[]) {
        const result = await statement.run(...params);
        changed(sql, params);
        return result;
      } };
    },
    async exec(sql: string) { await db.exec(sql); changed(sql); },
    async result(sql: string, params: unknown[]) {
      const result = await db.result(sql, params);
      changed(sql, params);
      return result;
    },
  });
}
