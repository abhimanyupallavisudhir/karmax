import { afterEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { AsyncPostgres, DatabaseUnavailableError, keepLostConnectionsCaught } from '../src/store/async-sql.js';

const url = process.env.KARMAX_TEST_POSTGRES_URL;
describe.skipIf(!url)('native asynchronous PostgreSQL', () => {
  let db: AsyncPostgres;
  afterEach(async () => { await db?.close(); });

  // `deploy/karmax doctor` and operators reading pg_stat_activity tell the
  // app's sessions from psql, pg_dump and backups by this name.
  it('names its sessions after the app', async () => {
    db = new AsyncPostgres(url!, { max: 1 });
    expect(await db.query("SELECT current_setting('application_name') AS name")).toEqual([{ name: 'karmax' }]);
  });

  it('keeps timers and independent queries responsive while a query is sleeping', async () => {
    db = new AsyncPostgres(url!, { max: 2 });
    let timerFired = false;
    let finished = false;
    const slow = db.query('SELECT pg_sleep(0.3)').then(() => { finished = true; });
    await new Promise(resolve => setTimeout(() => { timerFired = true; resolve(undefined); }, 20));
    expect(timerFired).toBe(true);
    expect(finished).toBe(false);
    expect(await db.query('SELECT 42 AS answer')).toEqual([{ answer: 42 }]);
    expect(finished).toBe(false);
    await slow;
  });

  it('pins nested transactions, rolls back failures, and isolates concurrent callers', async () => {
    db = new AsyncPostgres(url!, { max: 2 });
    const table = `async_fixture_${process.pid}`;
    await db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`);
    try {
      await expect(db.transaction(async () => {
        await db.query(`INSERT INTO ${table} (id) VALUES (?)`, [1]);
        await db.transaction(async () => { await db.query(`INSERT INTO ${table} (id) VALUES (?)`, [2]); });
        throw new Error('abort');
      })).rejects.toThrow('abort');
      expect(await db.query(`SELECT * FROM ${table}`)).toEqual([]);
      const transactions = await Promise.all([0, 1].map(() => db.transaction(async () => {
        const [before] = await db.query<{ id: number }>('SELECT txid_current() AS id');
        await db.query('SELECT pg_sleep(0.02)');
        const [after] = await db.query<{ id: number }>('SELECT txid_current() AS id');
        expect(after!.id).toBe(before!.id);
        return before!.id;
      })));
      expect(new Set(transactions).size).toBe(2);
    } finally { await db.exec(`DROP TABLE ${table}`); }
  });

  it('allows a transaction at minimum capacity and refuses raw transaction control', async () => {
    db = new AsyncPostgres(url!, { max: 1, maxPending: 1 });
    await db.transaction(async () => {
      expect(await db.query('SELECT 7 AS value')).toEqual([{ value: 7 }]);
      await db.transaction(async () => { await db.query('SELECT 1'); });
    });
    await expect(db.exec('BEGIN')).rejects.toThrow('use transaction()');
    await expect(db.query('/* comment */ BEGIN')).rejects.toThrow('use transaction()');
    await expect(db.query('SELECT 1; BEGIN')).rejects.toThrow('one statement');
    expect(db.stats.pending).toBe(0);
  });

  it('rejects a query escaping a completed transaction context', async () => {
    db = new AsyncPostgres(url!);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let escaped!: Promise<unknown>;
    await db.transaction(async () => {
      escaped = gate.then(() => db.query('SELECT 1'));
      await db.query('SELECT 1');
    });
    const rejected = expect(escaped).rejects.toThrow('transaction is already closed');
    release();
    await rejected;
    expect(await db.query('SELECT 1 AS ok')).toEqual([{ ok: 1 }]);
  });

  it('does not report success when the callback catches a PostgreSQL statement error', async () => {
    db = new AsyncPostgres(url!);
    await expect(db.transaction(async () => {
      await db.query('SELECT * FROM missing_async_fixture').catch(() => undefined);
      return 'would otherwise appear committed';
    })).rejects.toThrow('missing_async_fixture');
    expect(await db.query('SELECT 1 AS ok')).toEqual([{ ok: 1 }]);
  });

  it('sizes the pool from KARMAX_STORE_POOL_SIZE, and transactions use all but one connection', async () => {
    const { storePoolSize } = await import('../src/store/async-sql.js');
    expect(storePoolSize({})).toBe(8);
    expect(storePoolSize({ KARMAX_STORE_POOL_SIZE: '12' })).toBe(12);
    for (const bad of ['0', '65', '2.5', 'many']) expect(() => storePoolSize({ KARMAX_STORE_POOL_SIZE: bad })).toThrow('KARMAX_STORE_POOL_SIZE');
    db = new AsyncPostgres(url!);
    expect(db.maxConnections).toBe(8);
  });

  it('bounds admission and releases capacity after failures', async () => {
    db = new AsyncPostgres(url!, { max: 1, maxPending: 1 });
    const slow = db.query('SELECT pg_sleep(0.1)');
    await expect(db.query('SELECT 1')).rejects.toThrow('capacity exceeded');
    await slow;
    await expect(db.query('SELECT * FROM missing_async_fixture')).rejects.toThrow();
    expect(await db.query('SELECT 1 AS ok')).toEqual([{ ok: 1 }]);
  });
});

// A database out of reach fails every call site alike: what each meets says so,
// in one error the gateway answers 503 and error reports count as one bug.
describe('a database out of reach', () => {
  let db: AsyncPostgres;
  afterEach(async () => { await db?.close(); });

  it('is DatabaseUnavailableError, keeping what the driver said', async () => {
    db = new AsyncPostgres('postgres://nobody:nothing@127.0.0.1:1/none', { max: 1 });
    const refused = await db.query('SELECT 1').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DatabaseUnavailableError);
    expect(refused).toMatchObject({ name: 'DatabaseUnavailableError', status: 503, code: 'ECONNREFUSED' });
    expect((refused as Error).message).toMatch(/^database unavailable: .*ECONNREFUSED/);
    await expect(db.transaction(async () => db.query('SELECT 1'))).rejects.toBeInstanceOf(DatabaseUnavailableError);
  });

  it.skipIf(!url)('never ends the process when it goes away under a connection someone holds', async () => {
    // What an ORM's transaction does with a pool (the identity store's better-auth): check a client out.
    const pool = new Pool({ connectionString: url!, max: 1 });
    keepLostConnectionsCaught(pool);
    const uncaught = vi.fn();
    process.prependListener('uncaughtException', uncaught);
    try {
      const client = await pool.connect();
      await expect(client.query('SELECT pg_terminate_backend(pg_backend_pid())')).rejects.toMatchObject({ code: '57P01' });
      await new Promise(resolve => setTimeout(resolve, 200));
      client.release();
      expect((await pool.query('SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);
    } finally { process.removeListener('uncaughtException', uncaught); await pool.end(); }
    expect(uncaught).not.toHaveBeenCalled();
  });

  it.skipIf(!url)('is so when the server ends the connection, and nothing else is', async () => {
    db = new AsyncPostgres(url!, { max: 1 });
    // What a restart or shutdown does to a session: 57P01, "terminating connection due to administrator command".
    await expect(db.query('SELECT pg_terminate_backend(pg_backend_pid())')).rejects.toMatchObject({ name: 'DatabaseUnavailableError', code: '57P01' });
    // A transaction's connection is the pool's no longer: its socket closing must not be an
    // uncaught 'error' event, which ends the process (main.ts lets uncaught exceptions crash).
    const uncaught = vi.fn();
    process.prependListener('uncaughtException', uncaught);
    try {
      await expect(db.transaction(async () => { await db.query('SELECT pg_terminate_backend(pg_backend_pid())'); }))
        .rejects.toMatchObject({ name: 'DatabaseUnavailableError', code: '57P01' });
      await new Promise(resolve => setTimeout(resolve, 200));
    } finally { process.removeListener('uncaughtException', uncaught); }
    expect(uncaught).not.toHaveBeenCalled();
    // The pool replaces the connection, and a statement's own error stays its own.
    expect(await db.query('SELECT 42 AS answer')).toEqual([{ answer: 42 }]);
    const wrong = await db.query('SELECT * FROM no_such_table_here').catch((error: unknown) => error);
    expect(wrong).not.toBeInstanceOf(DatabaseUnavailableError);
    expect(wrong).toMatchObject({ code: '42P01' });
  });
});
