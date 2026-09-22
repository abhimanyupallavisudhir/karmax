import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqlDatabase, type SqlDatabase } from '../src/store/sql.js';

const targets = ['sqlite', ...(process.env.KARMAX_TEST_POSTGRES_URL ? ['postgres'] : [])];
for (const target of targets) describe(`async database ownership (${target})`, () => {
  let dir: string;
  let first: SqlDatabase;
  let second: SqlDatabase;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-db-scope-'));
    const url = target === 'sqlite' ? path.join(dir, 'db.sqlite') : process.env.KARMAX_TEST_POSTGRES_URL!;
    first = openSqlDatabase(url);
    second = openSqlDatabase(url);
    await first.exec('CREATE TABLE IF NOT EXISTS async_scope_probe (id INTEGER PRIMARY KEY, value TEXT)');
    await first.exec('DELETE FROM async_scope_probe');
  });
  afterEach(async () => {
    await first.close();
    await second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('shares the pinned transaction across service handles, including rollback', async () => {
    await expect(first.transaction(async () => {
      await first.prepare('INSERT INTO async_scope_probe VALUES (?, ?)').run(1, 'pending');
      await second.transaction(async () => {
        expect(second.inTransaction()).toBe(true);
        expect(await second.prepare('SELECT value FROM async_scope_probe WHERE id=?').get(1)).toMatchObject({ value: 'pending' });
        await second.prepare('UPDATE async_scope_probe SET value=? WHERE id=?').run('changed', 1);
      });
      throw new Error('abort both services');
    })).rejects.toThrow('abort both services');
    expect(await second.prepare('SELECT * FROM async_scope_probe').all()).toEqual([]);
  });

  it('notifies only after commit, with a fresh context that can write', async () => {
    let called = 0;
    let complete!: () => void;
    const completed = new Promise<void>(resolve => { complete = resolve; });
    await first.transaction(async () => {
      await first.prepare('INSERT INTO async_scope_probe VALUES (?, ?)').run(1, 'pending');
      first.afterCommit(async () => {
        expect(second.inTransaction()).toBe(false);
        await second.transaction(async () => {
          expect(await second.prepare('SELECT value FROM async_scope_probe WHERE id=1').get()).toMatchObject({ value: 'pending' });
          await second.prepare('UPDATE async_scope_probe SET value=? WHERE id=1').run('notified');
        });
        called++;
        complete();
      });
      await Promise.resolve();
      expect(called).toBe(0);
    });
    await completed;
    expect(called).toBe(1);
    await expect(first.transaction(async () => {
      first.afterCommit(() => { called++; });
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    await new Promise(resolve => setImmediate(resolve));
    expect(called).toBe(1);
  });

  it('bounds queued transactions and leaves independent handles usable after close', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const active = first.transaction(async () => gate);
    const queued = Array.from({ length: 255 }, () => second.transaction(async () => {}));
    try {
      await expect(second.transaction(async () => {})).rejects.toThrow('capacity exceeded');
    } finally { release(); }
    await Promise.all([active, ...queued]);
    await first.close();
    await expect(first.exec('SELECT 1')).rejects.toThrow('handle is closed');
    await second.exec('SELECT 1');
    expect(second.stats.pending).toBe(0);
  });
});
