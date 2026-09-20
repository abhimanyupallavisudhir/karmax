import { createRequire } from 'node:module';
import fs from 'node:fs';
import { MessageChannel, MessagePort, Worker } from 'node:worker_threads';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export interface SqlRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface SqlStatement {
  run(...params: any[]): SqlRunResult;
  get(...params: any[]): unknown;
  all(...params: any[]): unknown[];
}

/** The small synchronous surface Store historically consumed from node:sqlite. */
export interface SqlDatabase {
  readonly dialect: 'sqlite' | 'postgres';
  readonly native?: unknown;
  prepare(sql: string): SqlStatement;
  exec(sql: string): void;
  inTransaction(): boolean;
  close(): void;
}

class SqliteDatabase implements SqlDatabase {
  readonly dialect = 'sqlite' as const;
  readonly raw: DatabaseSyncType;
  get native(): DatabaseSyncType { return this.raw; }

  constructor(filename: string, options?: { readOnly?: boolean }) {
    this.raw = options ? new DatabaseSync(filename, options) : new DatabaseSync(filename);
  }

  prepare(sql: string): SqlStatement { return this.raw.prepare(sql) as SqlStatement; }
  exec(sql: string): void { this.raw.exec(sql); }
  inTransaction(): boolean { return this.raw.isTransaction; }
  close(): void { this.raw.close(); }
}

interface RpcResponse {
  ok: boolean;
  transactionOpen?: boolean;
  value?: unknown;
  spill?: string;
  error?: { message: string; stack?: string; code?: string };
}

/**
 * Transitional synchronous facade over node-postgres.
 *
 * Store predates remote databases and deliberately exposes synchronous methods
 * throughout the control plane. Rewriting that entire boundary in the same
 * release as the persistence migration would make the data cutover impossible
 * to review. A dedicated worker owns one PostgreSQL connection; Atomics only
 * block the calling thread while preserving Store's existing transaction scope.
 * This class is intentionally private to the store boundary and can disappear
 * when Store itself becomes asynchronous.
 */
class PostgresDatabase implements SqlDatabase {
  readonly dialect = 'postgres' as const;
  private readonly worker: Worker;
  private readonly port: MessagePort;
  private readonly control = new Int32Array(new SharedArrayBuffer(12));
  private readonly payload = new Uint8Array(new SharedArrayBuffer(4 * 1024 * 1024));
  private requestId = 0;
  private closed = false;
  private transactionOpen = false;

  constructor(connectionString: string) {
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.worker = new Worker(new URL('./postgres-worker.mjs', import.meta.url), {
      workerData: {
        connectionString,
        port: channel.port2,
        control: this.control.buffer,
        payload: this.payload.buffer,
      },
      transferList: [channel.port2],
    });
    this.call('ready', {});
  }

  prepare(sql: string): SqlStatement {
    return {
      run: (...params: any[]) => this.call('query', { sql, params, mode: 'run' }) as SqlRunResult,
      get: (...params: any[]) => this.call('query', { sql, params, mode: 'get' }),
      all: (...params: any[]) => this.call('query', { sql, params, mode: 'all' }) as unknown[],
    };
  }

  exec(sql: string): void {
    this.call('exec', { sql });
  }
  inTransaction(): boolean { return this.transactionOpen; }

  close(): void {
    if (this.closed) return;
    try { this.call('close', {}); } finally {
      this.closed = true;
      this.port.close();
      void this.worker.terminate();
    }
  }

  private call(op: string, input: Record<string, unknown>): unknown {
    if (this.closed) throw new Error('database is closed');
    Atomics.store(this.control, 0, 0);
    Atomics.store(this.control, 1, 0);
    this.port.postMessage({ id: ++this.requestId, op, ...input });
    const status = Atomics.wait(this.control, 0, 0, 60_000);
    if (status === 'timed-out') throw new Error(`PostgreSQL ${op} timed out after 60s`);
    const length = Atomics.load(this.control, 1);
    const decoded = new TextDecoder().decode(this.payload.subarray(0, length));
    let response = JSON.parse(decoded) as RpcResponse;
    if (response.spill) {
      const spill = response.spill;
      try { response = JSON.parse(fs.readFileSync(spill, 'utf8')) as RpcResponse; }
      finally { fs.rmSync(spill, { force: true }); }
    }
    if (response.transactionOpen !== undefined) this.transactionOpen = response.transactionOpen;
    if (!response.ok) {
      const error = new Error(response.error?.message ?? 'PostgreSQL operation failed');
      if (response.error?.stack) error.stack = response.error.stack;
      if (response.error?.code) (error as any).code = response.error.code;
      throw error;
    }
    return response.value;
  }
}

export function isPostgresTarget(target: string): boolean {
  return /^postgres(?:ql)?:\/\//i.test(target);
}

export function openSqlDatabase(target: string, options?: { readOnly?: boolean }): SqlDatabase {
  return isPostgresTarget(target) ? new PostgresDatabase(target) : new SqliteDatabase(target, options);
}
