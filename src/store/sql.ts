import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { AsyncPostgres } from './async-sql.js';
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
  readonly native?: unknown;
  prepare(sql: string): SqlStatement;
  exec(sql: string): Promise<void>;
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  inTransaction(): boolean;
  close(): Promise<void>;
}
interface Scope { active: boolean; rollback: boolean }
class AsyncDatabase implements SqlDatabase {
  readonly dialect: 'sqlite' | 'postgres';
  readonly native?: DatabaseSyncType;
  private postgres?: AsyncPostgres;
  private scope = new AsyncLocalStorage<Scope>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(target: string, options?: { readOnly?: boolean }) {
    this.dialect = isPostgresTarget(target) ? 'postgres' : 'sqlite';
    if (this.dialect === 'postgres') this.postgres = new AsyncPostgres(target);
    else this.native = options ? new DatabaseSync(target, options) : new DatabaseSync(target);
  }
  private async access<T>(operation: () => Promise<T>): Promise<T> {
    const scope = this.scope.getStore();
    if (scope && !scope.active) throw Error('transaction is already closed');
    if (this.postgres || scope) return operation();
    const next = this.tail.then(operation, operation);
    this.tail = next.catch(() => {});
    return next;
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
  inTransaction(): boolean { return this.scope.getStore()?.active === true; }
  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    const inherited = this.scope.getStore();
    if (inherited) {
      if (!inherited.active) throw Error('transaction is already closed');
      return operation();
    }
    const run = async () => {
      const scope: Scope = { active: true, rollback: false };
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
        if (this.postgres) return await this.postgres.transaction(async () => {
          // Preserve the former atomic Store mutation boundary across processes.
          await this.postgres!.query('SELECT pg_advisory_xact_lock(1262572115)');
          return work();
        });
        this.native!.exec('BEGIN IMMEDIATE');
        try { const value = await work(); this.native!.exec('COMMIT'); return value; }
        catch (error) { this.native!.exec('ROLLBACK'); throw error; }
      } catch (error) { if (error === rollback) return result; throw error; }
    };
    const next = this.tail.then(run, run);
    this.tail = next.catch(() => {});
    return next;
  }
  async close(): Promise<void> { await this.tail; if (this.postgres) await this.postgres.close(); else this.native!.close(); }
}
export function isPostgresTarget(target: string): boolean { return /^postgres(?:ql)?:\/\//i.test(target); }
export function openSqlDatabase(target: string, options?: { readOnly?: boolean }): SqlDatabase { return new AsyncDatabase(target, options); }
