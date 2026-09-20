import { expect, it } from 'vitest';
import { openSqlDatabase } from '../src/store/sql.js';
import { identitySqliteDatabase } from '../src/store/identity-sqlite.js';

it('keeps an unrelated identity write outside a suspended transaction rollback', async () => {
  const db = openSqlDatabase(':memory:');
  const identity = identitySqliteDatabase(db);
  await db.exec('CREATE TABLE identity_probe (id INTEGER PRIMARY KEY, name TEXT)');
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const transaction = db.transaction(async () => {
    await db.prepare('INSERT INTO identity_probe VALUES (?, ?)').run(1, 'rolled back');
    entered();
    await blocked;
    throw new Error('rollback direct write');
  });
  const rolledBack = expect(transaction).rejects.toThrow('rollback direct write');
  try {
    await started;
    let completed = false;
    const independent = identity.insertInto('identity_probe').values({ id: 2, name: 'retained' }).execute()
      .then(() => { completed = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(completed).toBe(false);
    release();
    await rolledBack;
    await independent;
    expect(await identity.selectFrom('identity_probe').selectAll().execute()).toEqual([{ id: 2, name: 'retained' }]);
  } finally { release(); await identity.destroy(); await db.close(); }
});

it('shares nested service transactions and rolls back explicit identity transactions', async () => {
  const db = openSqlDatabase(':memory:');
  const identity = identitySqliteDatabase(db);
  await db.exec('CREATE TABLE identity_probe (id INTEGER PRIMARY KEY)');
  try {
    await expect(db.transaction(async () => {
      await identity.insertInto('identity_probe').values({ id: 1 }).execute();
      expect(await db.prepare('SELECT id FROM identity_probe').all()).toEqual([{ id: 1 }]);
      throw new Error('outer rollback');
    })).rejects.toThrow('outer rollback');
    await expect(identity.transaction().execute(async transaction => {
      await transaction.insertInto('identity_probe').values({ id: 2 }).execute();
      throw new Error('identity rollback');
    })).rejects.toThrow('identity rollback');
    expect(await identity.selectFrom('identity_probe').selectAll().execute()).toEqual([]);
    await identity.insertInto('identity_probe').values({ id: 3 }).execute();
    expect(await db.prepare('SELECT id FROM identity_probe').all()).toEqual([{ id: 3 }]);
  } finally { await identity.destroy(); await db.close(); }
});


it('keeps direct lifecycle-hook reads and writes in the identity transaction scope', async () => {
  const db = openSqlDatabase(':memory:');
  const identity = identitySqliteDatabase(db);
  await db.exec('CREATE TABLE identity_probe (id INTEGER PRIMARY KEY)');
  try {
    await expect(identity.transaction().setIsolationLevel('serializable').setAccessMode('read write').execute(async transaction => {
      await transaction.insertInto('identity_probe').values({ id: 1 }).execute();
      expect(db.inTransaction()).toBe(true);
      expect(await db.prepare('SELECT id FROM identity_probe').all()).toEqual([{ id: 1 }]);
      await db.transaction(async () => {
        await db.prepare('INSERT INTO identity_probe VALUES (?)').run(2);
      });
      throw new Error('hook rejected signup');
    })).rejects.toThrow('hook rejected signup');
    expect(await db.prepare('SELECT id FROM identity_probe').all()).toEqual([]);
  } finally { await identity.destroy(); await db.close(); }
});
