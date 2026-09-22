import path from 'node:path';
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { AsyncPostgres } from './async-sql.js';
import { DatabaseQueue } from './database-queue.js';
import { splitStatements } from './postgres-sql.mjs';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
export interface SqlRunResult { changes: number | bigint; lastInsertRowid: number | bigint }
export interface SqlStatement {
  run(...params: any[]): Promise<SqlRunResult>;
  get(...params: any[]): Promise<unknown>;
  all(...params: any[]): Promise<unknown[]>;
}
export interface SqlDatabase {
  readonly dialect: 'sqlite' | 'postgres';
  readonly stats: { pending: number; connections: number; waiting: number };
  prepare(sql: string): SqlStatement;
  exec(sql: string): Promise<void>;
  result(sql: string, params: unknown[]): Promise<{ rows: unknown[]; changes?: number | bigint; lastInsertRowid?: number | bigint }>;
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  inTransaction(): boolean;
  afterCommit(operation: () => unknown): void;
  close(): Promise<void>;
}
interface Scope { active: boolean; rollback: boolean; afterCommit: Array<() => unknown> }
class AsyncDatabase implements SqlDatabase {
  readonly dialect: 'sqlite' | 'postgres';
  readonly native?: DatabaseSyncType;
  private postgres?: AsyncPostgres;
  private scope = new AsyncLocalStorage<Scope>();
  private queue = new DatabaseQueue();
  private closed = false;
  private closing = false;
  get stats() {
    const pool = this.postgres?.stats ?? { pending: 0, connections: 0, waiting: 0 };
    return {
      connections: pool.connections,
      pending: this.postgres ? pool.pending + this.queue.waiting : this.queue.pending,
      waiting: pool.waiting + this.queue.waiting,
    };
  }
  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed || this.closing) throw new Error('database is closed');
    return this.queue.enqueue(operation);
  }
  constructor(target: string, options?: { readOnly?: boolean }) {
    this.dialect = isPostgresTarget(target) ? 'postgres' : 'sqlite';
    if (this.dialect === 'postgres') this.postgres = new AsyncPostgres(target);
    else this.native = options ? new DatabaseSync(target, options) : new DatabaseSync(target);
  }
  private async access<T>(operation: () => Promise<T>): Promise<T> {
    const scope = this.scope.getStore();
    if (this.closed || (this.closing && !scope?.active)) throw new Error('database is closed');
    if (scope && !scope.active) throw Error('transaction is already closed');
    if (this.postgres || scope) return operation();
    return this.enqueue(operation);
  }
  async result(sql: string, params: unknown[]) {
    return this.access(async () => {
      if (this.postgres) {
        const result = await this.postgres.result(sql, params);
        return { rows: result.rows, changes: result.rowCount ?? 0 };
      }
      const statement = this.native!.prepare(sql);
      if (statement.columns().length) return { rows: statement.all(...params as import('node:sqlite').SQLInputValue[]) };
      return { rows: [], ...statement.run(...params as import('node:sqlite').SQLInputValue[]) };
    });
  }
  prepare(sql: string): SqlStatement {
    return {
      run: (...params) => this.access(async () => {
        if (!this.postgres) return this.native!.prepare(sql).run(...params);
        const result = await this.postgres.result(sql, params);
        return { changes: result.rowCount ?? 0, lastInsertRowid: Number(result.rows[0]?.seq ?? 0) };
      }),
      get: (...params) => this.access(async () => this.postgres ? (await this.postgres.query(sql, params))[0] : this.native!.prepare(sql).get(...params)),
      all: (...params) => this.access(async () => this.postgres ? this.postgres.query(sql, params) : this.native!.prepare(sql).all(...params)),
    };
  }
  async exec(sql: string): Promise<void> {
    for (const statement of splitStatements(sql)) {
      if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(statement.trim())) {
        const scope = this.scope.getStore();
        if (!scope?.active) throw Error('use transaction() for transaction control');
        if (/^ROLLBACK\b/i.test(statement.trim())) scope.rollback = true;
        continue;
      }
      await this.access(async () => { if (this.postgres) await this.postgres.exec(statement); else this.native!.exec(statement); });
    }
  }
  afterCommit(operation: () => unknown): void {
    const scope = this.scope.getStore();
    if (scope) {
      if (!scope.active) throw new Error('transaction is already closed');
      scope.afterCommit.push(operation);
    } else this.dispatchAfterCommit([operation]);
  }
  private dispatchAfterCommit(operations: Array<() => unknown>): void {
    this.scope.exit(() => {
      for (const operation of operations) {
        queueMicrotask(() => {
          void Promise.resolve().then(operation).catch(error => console.error('[store] after-commit callback failed:', error));
        });
      }
    });
  }
  inTransaction(): boolean { return this.scope.getStore()?.active === true; }
  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    const inherited = this.scope.getStore();
    if (inherited) {
      if (!inherited.active) throw Error('transaction is already closed');
      return operation();
    }
    const run = async () => {
      const scope: Scope = { active: true, rollback: false, afterCommit: [] };
      const rollback = new Error('transaction requested rollback');
      let result!: T;
      const work = async () => {
        try {
          result = await this.scope.run(scope, operation);
          if (scope.rollback) throw rollback;
          return result;
        } finally { scope.active = false; }
      };
      try {
        if (this.postgres) {
          const value = await this.postgres.transaction(async () => {
            // Preserve the former atomic Store mutation boundary across processes.
            await this.postgres!.query('SELECT pg_advisory_xact_lock(1262572115)');
            return work();
          });
          this.dispatchAfterCommit(scope.afterCommit);
          return value;
        }
        this.native!.exec('BEGIN IMMEDIATE');
        try { const value = await work(); this.native!.exec('COMMIT'); this.dispatchAfterCommit(scope.afterCommit); return value; }
        catch (error) { this.native!.exec('ROLLBACK'); throw error; }
      } catch (error) { if (error === rollback) return result; throw error; }
    };
    return this.enqueue(run);
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.queue.close();
    this.closed = true;
    if (this.postgres) await this.postgres.close(); else this.native!.close();
  }
}
export function isPostgresTarget(target: string): boolean { return /^postgres(?:ql)?:\/\//i.test(target); }
// Store and Identity open the same PostgreSQL target independently. Reusing the
// backend also reuses its transaction context: a nested service call must not
// take a second connection and wait on its own advisory lock. Each caller owns
// a reference, so closing one service cannot close another service's database.
const databases = new Map<string | symbol, { db: AsyncDatabase; references: number }>();
export function openSqlDatabase(target: string, options?: { readOnly?: boolean }): SqlDatabase {
  const key = target === ':memory:' ? Symbol('memory')
    : `${isPostgresTarget(target) ? new URL(target).href : path.resolve(target)}:${options?.readOnly === true}`;
  let shared = databases.get(key);
  if (!shared) {
    shared = { db: new AsyncDatabase(target, options), references: 0 };
    // Independent in-memory databases never need a shared registry entry.
    // Keeping them there would retain abandoned test/ephemeral stores forever.
    if (typeof key === 'string') databases.set(key, shared);
  }
  shared.references++;
  const backend = shared;
  let closed = false;
  const check = () => { if (closed) throw new Error('database handle is closed'); };
  return {
    dialect: backend.db.dialect,
    get stats() { return backend.db.stats; },
    prepare(sql) {
      check();
      const statement = backend.db.prepare(sql);
      return {
        async run(...params) { check(); return statement.run(...params); },
        async get(...params) { check(); return statement.get(...params); },
        async all(...params) { check(); return statement.all(...params); },
      };
    },
    async exec(sql) { check(); return backend.db.exec(sql); },
    async result(sql, params) { check(); return backend.db.result(sql, params); },
    async transaction(operation) { check(); return backend.db.transaction(operation); },
    inTransaction() { check(); return backend.db.inTransaction(); },
    afterCommit(operation) { check(); backend.db.afterCommit(operation); },
    async close() {
      if (closed) return;
      if (backend.db.inTransaction()) throw new Error('cannot close a database handle inside a transaction');
      closed = true;
      if (--backend.references === 0) {
        databases.delete(key);
        await backend.db.close();
      }
    },
  };
}
