import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, types, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { splitStatements, translate } from './postgres-sql.mjs';

export class DatabaseCapacityError extends Error {
  readonly status = 503;
  constructor() { super('database request capacity exceeded'); this.name = 'DatabaseCapacityError'; }
}

export class DatabaseQueueTimeoutError extends Error {
  readonly status = 503;
  constructor() { super('database request expired before execution'); this.name = 'DatabaseQueueTimeoutError'; }
}

/** A pool checkout that waited out `connectionTimeoutMillis` was never
 * executed: report it as the same retryable admission timeout as the queue. */
/** The database was out of reach — restarting, shutting down, its name not
 * resolving, the connection cut — so every statement that ran then failed
 * alike, and none of the call sites is at fault: answered 503, and one bug to
 * error reports however many places met it (`errorFingerprint`). Keeps the
 * driver's words and `code` (ECONNREFUSED, 57P01, …). */
export class DatabaseUnavailableError extends Error {
  readonly status = 503;
  readonly code?: string;
  constructor(cause: Error) {
    super(`database unavailable: ${cause.message}`);
    this.name = 'DatabaseUnavailableError';
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string') this.code = code;
  }
}

/**
 * pg-pool hears a connection's 'error' only while it is idle. One checked out
 * (a transaction, an ORM's) whose server goes away — a restart, a shutdown —
 * emits it to nobody: an uncaught exception, which ends the process (main.ts
 * lets those crash). Its own statements fail anyway, and the pool discards it
 * on release since it is no longer queryable; so every client has a listener.
 */
export function keepLostConnectionsCaught(pool: Pool): void {
  pool.on('connect', client => { client.on('error', () => { /* its statements fail with it */ }); });
}

/** Socket errors on the way to the server, SQLSTATE class 08 (connection
 * exception) and 57P01–57P03 (the server shutting down, crashed, starting up). */
const UNREACHABLE = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH']);
function unreachable(error: Error): boolean {
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') return UNREACHABLE.has(code) || /^08[0-9A-Z]{3}$/.test(code) || /^57P0[123]$/.test(code);
  return /^Connection terminated\b/.test(error.message); // the driver's own word for a socket that closed
}

/** What a failed statement or connection says to its caller. */
function databaseFailure(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  if (/timeout exceeded when trying to connect/i.test(error.message)) return new DatabaseQueueTimeoutError();
  return unreachable(error) ? new DatabaseUnavailableError(error) : error;
}

interface TransactionScope { client: PoolClient; active: boolean; pending: number; failure?: unknown }

/** Connections per process (`KARMAX_STORE_POOL_SIZE`, default 8). Transactions
 * use all but one (`sql.ts`). It was 4 until the 2026-10 load test: once the
 * per-socket permission reads were gone, the activity worker queued past its
 * 256-request admission bound behind 4 connections at 96 tenants while
 * PostgreSQL had 43 of 100 connections spare. Each app process (gateway,
 * worker) holds up to this many; keep the sum, Temporal's and identity's well
 * under PostgreSQL's max_connections. */
export function storePoolSize(env: NodeJS.ProcessEnv = process.env): number {
  const configured = env.KARMAX_STORE_POOL_SIZE?.trim();
  if (!configured) return 8;
  const size = Number(configured);
  if (!Number.isSafeInteger(size) || size < 1 || size > 64) throw new Error('KARMAX_STORE_POOL_SIZE must be an integer from 1 to 64');
  return size;
}

/** Bounded native asynchronous PostgreSQL access. Each transaction has its own
 * checked-out connection; unrelated requests never inherit its transaction. */
export class AsyncPostgres {
  private readonly pool: Pool;
  private readonly transactionScope = new AsyncLocalStorage<TransactionScope>();
  private closed = false;
  private pending = 0;
  private readonly maxPending: number;
  readonly maxConnections: number;

  constructor(url: string, options: { max?: number; maxPending?: number; statementTimeoutMs?: number } = {}) {
    this.maxPending = options.maxPending ?? 256;
    this.maxConnections = options.max ?? storePoolSize();
    if (!Number.isSafeInteger(this.maxPending) || this.maxPending < 1
      || !Number.isSafeInteger(this.maxConnections) || this.maxConnections < 1)
      throw new Error('database pool and admission limits must be positive integers');
    this.pool = new Pool({ connectionString: url, max: this.maxConnections, application_name: 'karmax',
      connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000,
      statement_timeout: options.statementTimeoutMs ?? 15_000,
      types: { getTypeParser: (oid, format) => oid === 20 || oid === 1700 ? Number : types.getTypeParser(oid, format) } });
    this.pool.on('error', error => console.error('[postgres] idle connection failed:', error.message));
    keepLostConnectionsCaught(this.pool);
  }

  get stats() { return { pending: this.pending, connections: this.pool.totalCount, waiting: this.pool.waitingCount }; }

  private async admitted<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('database is closed');
    if (this.pending >= this.maxPending) throw new DatabaseCapacityError();
    this.pending++;
    try { return await operation(); }
    finally { this.pending--; }
  }

  async query<T extends QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.result<T>(sql, params)).rows;
  }

  async result<T extends QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<Pick<QueryResult<T>, 'rows' | 'rowCount'>> {
    const scope = this.transactionScope.getStore();
    if (scope && !scope.active) throw new Error('transaction is already closed');
    const statements = splitStatements(sql);
    if (statements.length > 1) throw new Error('query() accepts one statement; use exec() for a batch');
    const command = sql.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, '');
    if (/^(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|END|ABORT|PREPARE\s+TRANSACTION)\b/i.test(command))
      throw new Error('use transaction() for transaction control');
    const translated = translate(sql);
    if (translated.skip) return { rows: [], rowCount: 0 };
    const execute = async () => {
      try {
        const result = await (scope?.client ?? this.pool).query<T>(translated.sql!, translated.forcedParams ?? params);
        return result;
      } catch (error) {
        if (!scope) throw databaseFailure(error);
        // PostgreSQL aborts the transaction after any statement error, even if
        // application code catches it. Never report a silently rolled-back
        // COMMIT as a successful transaction.
        scope.failure = databaseFailure(error);
        throw scope.failure;
      }
    };
    // The outer transaction already holds one admission slot. Bound its own
    // queued statements separately so maxPending=1 still permits transactions.
    if (scope) {
      if (scope.pending >= this.maxPending) throw new DatabaseCapacityError();
      scope.pending++;
      try { return await execute(); } finally { scope.pending--; }
    }
    return this.admitted(execute);
  }

  async exec(sql: string): Promise<void> {
    for (const statement of splitStatements(sql)) await this.query(statement);
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    const parent = this.transactionScope.getStore();
    if (parent) {
      if (!parent.active) throw new Error('transaction is already closed');
      return operation();
    }
    return this.admitted(async () => {
      const client = await this.pool.connect().catch(error => { throw databaseFailure(error); });
      const scope: TransactionScope = { client, active: true, pending: 0 };
      let broken: Error | undefined;
      try {
        await client.query('BEGIN');
        const result = await this.transactionScope.run(scope, operation);
        if (scope.pending) throw new Error('transaction callback returned with pending queries');
        if (scope.failure) throw scope.failure;
        scope.active = false;
        await client.query('COMMIT');
        return result;
      } catch (error) {
        scope.active = false;
        try { await client.query('ROLLBACK'); }
        catch (rollback) { broken = rollback instanceof Error ? rollback : new Error(String(rollback)); }
        throw databaseFailure(error);
      } finally { client.release(broken); }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}
