import { afterEach, describe, expect, it } from 'vitest';
import { AsyncPostgres } from '../src/store/async-sql.js';

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

  it('bounds admission and releases capacity after failures', async () => {
    db = new AsyncPostgres(url!, { max: 1, maxPending: 1 });
    const slow = db.query('SELECT pg_sleep(0.1)');
    await expect(db.query('SELECT 1')).rejects.toThrow('capacity exceeded');
    await slow;
    await expect(db.query('SELECT * FROM missing_async_fixture')).rejects.toThrow();
    expect(await db.query('SELECT 1 AS ok')).toEqual([{ ok: 1 }]);
  });
});
