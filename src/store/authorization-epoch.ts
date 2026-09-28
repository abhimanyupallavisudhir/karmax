import type { SqlDatabase } from './sql.js';

/**
 * Moves after every committed write that can withdraw access: a revoked token
 * or delegation, a removed member or grant, a project moved to another
 * organization. A cache of authorization decisions records the epoch it decided
 * in and decides again once it has moved, so revocation, removal and transfer
 * take effect at once in this process (#396 review item 3). Other replicas are
 * bounded only by their cache's TTL.
 */
let epoch = 0;
const listeners = new Set<() => void>();
export const authorizationEpoch = (): number => epoch;
export const authorizationChanged = (): void => {
  epoch++;
  for (const listener of listeners) try { listener(); } catch { /* a listener's own failure */ }
};
/** Call `listener` after every change (long-lived sockets re-decide then). */
export function onAuthorizationChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Tables are matched on the statement, not on the Store method, so every path
 * that writes them (deprovisioning, account closure, a project move, a revoked
 * preview lease) is caught. Inserts are included: they can replace a grant
 * with a narrower one. */
const AUTHORITY_WRITE = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b[\s\S]*?\b(?:scoped_tokens|principal_grants|organization_memberships|project_memberships|team_memberships|human_delegations)\b|^\s*UPDATE\s+projects\s+SET\b[\s\S]*?\borganizationId\b|^\s*(?:UPDATE|DELETE)\b[\s\S]*?\bpreview_leases\b|^\s*DELETE\s+FROM\s+(?:projects|teams|organizations)\b/i;

/** `db`, moving the epoch once each authority write has committed. */
export function watchAuthorityWrites(db: SqlDatabase): SqlDatabase {
  const changed = (sql: string) => { if (AUTHORITY_WRITE.test(sql)) db.afterCommit(authorizationChanged); };
  return Object.assign(Object.create(db) as SqlDatabase, {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      return { ...statement, async run(...params: unknown[]) {
        const result = await statement.run(...params);
        changed(sql);
        return result;
      } };
    },
    async exec(sql: string) { await db.exec(sql); changed(sql); },
    async result(sql: string, params: unknown[]) {
      const result = await db.result(sql, params);
      changed(sql);
      return result;
    },
  });
}
