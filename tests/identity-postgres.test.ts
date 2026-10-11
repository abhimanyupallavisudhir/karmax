import { afterEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { IdentityService } from '../src/auth/identity.js';

const url = process.env.KARMAX_TEST_POSTGRES_URL;

// DB-18 (reviews/2026-09-26): PostgreSQL restarts and server-side idle kills
// terminate the identity pool's idle connections. A pg Pool reports that as an
// 'error' event, and with no listener Node turns it into an uncaught exception
// that took tavya.io down during the 2026-09-30 password rotation.
describe.skipIf(!url)('identity store on PostgreSQL', () => {
  let identity: IdentityService | undefined;
  afterEach(async () => { await identity?.close(); identity = undefined; });

  it('survives PostgreSQL terminating its idle connections', async () => {
    identity = await IdentityService.create(':memory:', { databaseUrl: url });
    // better-auth's sessions run through this pool; a query leaves an idle connection.
    const pool = (identity as unknown as { pool: pg.Pool }).pool;
    await pool.query('SELECT 1');
    const uncaught: unknown[] = [];
    const record = (error: unknown) => { uncaught.push(error); };
    process.prependListener('uncaughtException', record);
    const admin = new pg.Client({ connectionString: url, application_name: 'karmax-test-admin' });
    await admin.connect();
    try {
      expect(pool.idleCount).toBeGreaterThan(0);
      const { rowCount } = await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE application_name = 'karmax' AND usename = current_user AND pid <> pg_backend_pid()`);
      expect(rowCount).toBeGreaterThan(0);
      await expect.poll(() => pool.idleCount, { timeout: 5_000 }).toBe(0);
      expect(uncaught).toEqual([]);
      // The pool replaces the lost connection on the next query.
      expect((await pool.query('SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);
    } finally {
      process.removeListener('uncaughtException', record);
      await admin.end();
    }
  });
});
