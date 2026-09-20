import { AsyncLocalStorage } from 'node:async_hooks';
import { Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler,
  type CompiledQuery, type DatabaseConnection, type Driver, type QueryResult, type TransactionBuilder } from 'kysely';
import type { SqlDatabase } from './sql.js';

interface Lease extends DatabaseConnection {
  release(): void;
  done: Promise<void>;
  rollback(): Promise<void>;
}

/** Better Auth must use the same admission and transaction boundary as direct
 * identity operations. Handing it DatabaseSync would let an unrelated login
 * write inside a transaction suspended at an await and be rolled back with it.
 * A Kysely checkout owns a transaction until release; query functions are bound
 * to that checkout's context, never to another request's ambient context. */
class IdentitySqliteDriver implements Driver {
  private closed = false;
  private active = new Set<Promise<void>>();
  constructor(private db: SqlDatabase) {}
  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> {
    if (this.closed) throw new Error('identity database is closed');
    let ready!: (connection: Lease) => void;
    let fail!: (error: unknown) => void;
    const acquired = new Promise<Lease>((resolve, reject) => { ready = resolve; fail = reject; });
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const done = this.db.transaction(async () => {
      const within = AsyncLocalStorage.snapshot();
      const lease: Lease = {
        get done() { return done; },
        release,
        rollback: () => within(() => this.db.exec('ROLLBACK')),
        executeQuery: <R>(query: CompiledQuery): Promise<QueryResult<R>> => within(async () => {
          const result = await this.db.result(query.sql, [...query.parameters]);
          return { rows: result.rows as R[],
            ...(result.changes === undefined ? {} : { numAffectedRows: BigInt(result.changes) }),
            ...(result.lastInsertRowid === undefined ? {} : { insertId: BigInt(result.lastInsertRowid) }) };
        }),
        async *streamQuery() { throw new Error('identity query streaming is unsupported'); },
      };
      ready(lease);
      await released;
    });
    this.active.add(done);
    void done.then(() => this.active.delete(done), error => { this.active.delete(done); fail(error); });
    return acquired;
  }
  async beginTransaction(): Promise<void> { /* checkout already owns the transaction */ }
  async commitTransaction(): Promise<void> { /* release commits after all queries settle */ }
  async rollbackTransaction(connection: DatabaseConnection): Promise<void> { await (connection as Lease).rollback(); }
  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    const lease = connection as Lease;
    lease.release();
    await lease.done;
  }
  async destroy(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.active);
  }
}

export function identitySqliteDatabase(db: SqlDatabase): Kysely<any> {
  if (db.dialect !== 'sqlite') throw new Error('identity SQLite driver requires SQLite');
  const identity = new Kysely({ dialect: {
    createDriver: () => new IdentitySqliteDriver(db),
    createAdapter: () => new SqliteAdapter(),
    createQueryCompiler: () => new SqliteQueryCompiler(),
    createIntrospector: kysely => new SqliteIntrospector(kysely),
  } });
  const transaction = identity.transaction.bind(identity);
  identity.transaction = () => withinStoreTransaction(transaction(), db);
  return identity;
}

/** The checkout scope alone only covers SQL statements. Better Auth also runs
 * lifecycle hooks inside its transaction callback; those hooks read the Store
 * directly. Enter the Store scope around the entire callback so they cannot
 * queue behind the very transaction that is waiting for them to return. */
function withinStoreTransaction<T>(builder: TransactionBuilder<T>, db: SqlDatabase): TransactionBuilder<T> {
  return new Proxy(builder, {
    get(target, property) {
      if (property === 'execute') return (callback: Parameters<typeof target.execute>[0]) =>
        db.transaction(() => target.execute(callback));
      // Fluent builders return new instances; preserve the scope wrapper.
      if (property === 'setIsolationLevel') return (level: Parameters<typeof target.setIsolationLevel>[0]) =>
        withinStoreTransaction(target.setIsolationLevel(level), db);
      if (property === 'setAccessMode') return (mode: Parameters<typeof target.setAccessMode>[0]) =>
        withinStoreTransaction(target.setAccessMode(mode), db);
      return Reflect.get(target, property, target);
    },
  });
}
