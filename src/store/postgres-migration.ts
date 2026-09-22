import fs from 'node:fs';
import { openSqlDatabase, type SqlDatabase } from './sql.js';

const MIGRATION_TABLE = 'karmax_migrations';

export interface SqliteImportResult {
  imported: boolean;
  tables: number;
  rows: number;
}

const quote = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;

async function count(db: SqlDatabase, table: string): Promise<number> {
  return Number(((await db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)}`).get()) as any)?.n ?? 0);
}

function convert(value: unknown, dataType: string | undefined): unknown {
  if (value == null || !dataType) return value;
  if (dataType.includes('timestamp')) {
    if (value instanceof Date) return value;
    const numeric = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numeric) ? new Date(numeric).toISOString() : value;
  }
  if (dataType === 'boolean') return Boolean(value);
  if (dataType === 'json' || dataType === 'jsonb')
    return typeof value === 'string' ? JSON.parse(value) : value;
  return value;
}

async function dependencyOrder(tables: string[], target: SqlDatabase): Promise<string[]> {
  const wanted = new Set(tables);
  const parents = new Map<string, Set<string>>(tables.map((table) => [table, new Set()]));
  for (const row of (await target.prepare(`SELECT child.relname AS child, parent.relname AS parent
    FROM pg_constraint constraint_row
    JOIN pg_class child ON child.oid=constraint_row.conrelid
    JOIN pg_class parent ON parent.oid=constraint_row.confrelid
    JOIN pg_namespace namespace_row ON namespace_row.oid=child.relnamespace
    WHERE constraint_row.contype='f' AND namespace_row.nspname=current_schema()`).all()) as any[]) {
    const child = String(row.child), parent = String(row.parent);
    if (wanted.has(child) && wanted.has(parent) && child !== parent) parents.get(child)!.add(parent);
  }
  const ordered: string[] = [];
  const remaining = new Set(tables);
  while (remaining.size) {
    const ready = [...remaining].filter((table) => [...parents.get(table)!].every((parent) => !remaining.has(parent))).sort();
    if (!ready.length) throw new Error(`cannot import cyclic PostgreSQL foreign keys: ${[...remaining].join(', ')}`);
    for (const table of ready) { ordered.push(table); remaining.delete(table); }
  }
  return ordered;
}

/**
 * One-way, transactional import used for the SQLite → PostgreSQL cutover.
 *
 * The source is opened read-only and is never renamed or deleted. A PostgreSQL
 * advisory lock makes concurrent rolling starts serialize on the same import,
 * while a durable marker makes every later boot a constant-time no-op.
 */
export async function importSqliteDatabase(sourceFile: string, target: SqlDatabase, scope: string,
  options: {
    sentinelTable: string;
    allowedSeedRows?: number;
    transformRows?: (table: string, rows: Record<string, unknown>[]) => Record<string, unknown>[];
  } = { sentinelTable: 'tasks' }): Promise<SqliteImportResult> {
  if (target.dialect !== 'postgres') throw new Error('SQLite import target must be PostgreSQL');
  (await target.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
    key TEXT PRIMARY KEY, completed_at BIGINT NOT NULL, source TEXT NOT NULL,
    tables INTEGER NOT NULL, rows BIGINT NOT NULL
  )`));
  return target.transaction(async () => {
  const marker = `sqlite-import:${scope}:v1`;
  (await target.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`karmax:${marker}`));
  try {
    if ((await target.prepare(`SELECT 1 FROM ${MIGRATION_TABLE} WHERE key=?`).get(marker)))
      return { imported: false, tables: 0, rows: 0 };
    if (!fs.existsSync(sourceFile)) return { imported: false, tables: 0, rows: 0 };

    const existing = (await count(target, options.sentinelTable));
    if (existing > (options.allowedSeedRows ?? 0)) {
      throw new Error(`refusing SQLite import into non-empty PostgreSQL ${scope} database `
        + `(${options.sentinelTable} contains ${existing} rows and no migration marker exists)`);
    }

    const source = openSqlDatabase(sourceFile, { readOnly: true });
    let tableCount = 0;
    let rowCount = 0;
    try {
      const targetTables = new Set(((await target.prepare(`SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema=current_schema() AND table_type='BASE TABLE'`).all()) as any[]).map((row) => String(row.name)));
      const discoveredTables = ((await source.prepare(`SELECT name FROM sqlite_master
        WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all()) as any[])
        .map((row) => String(row.name)).filter((name) => targetTables.has(name));
      const sourceTables = (await dependencyOrder(discoveredTables, target));

      (await target.exec('BEGIN'));
      try {
        for (const table of sourceTables) {
          try {
            const sourceColumns = ((await source.prepare(`PRAGMA table_info(${quote(table)})`).all()) as any[])
              .map((column) => String(column.name));
            const targetColumns = new Map(((await target.prepare(`SELECT column_name AS name, data_type AS dataType
              FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=?
              ORDER BY ordinal_position`).all(table)) as any[])
              .map((column) => [String(column.name), String(column.dataType)]));
            const columns = sourceColumns.filter((column) => targetColumns.has(column));
            if (!columns.length) continue;
            const sourceRows = (await source.prepare(`SELECT ${columns.map(quote).join(',')} FROM ${quote(table)}`)
              .all()) as unknown as Record<string, unknown>[];
            const rows = options.transformRows?.(table, sourceRows) ?? sourceRows;
            const placeholders = columns.map(() => '?').join(',');
            const insert = target.prepare(`INSERT INTO ${quote(table)} (${columns.map(quote).join(',')})
              VALUES (${placeholders}) ON CONFLICT DO NOTHING`);
            for (const row of rows) (await insert.run(...columns.map((column) => convert(row[column], targetColumns.get(column)))));
            const after = (await count(target, table));
            if (after !== rows.length)
              throw new Error(`expected ${rows.length} rows, found ${after}`);
            tableCount++;
            rowCount += rows.length;
          } catch (error) {
            throw new Error(`PostgreSQL import failed for table ${table}: ${error instanceof Error ? error.message : error}`, { cause: error });
          }
        }
        for (const table of ['events', 'audit_log']) {
          if (!targetTables.has(table)) continue;
          (await target.prepare(`SELECT setval(pg_get_serial_sequence(?, 'seq'),
            COALESCE((SELECT MAX(seq) FROM ${quote(table)}), 1),
            EXISTS (SELECT 1 FROM ${quote(table)}))`).get(table));
        }
        (await target.prepare(`INSERT INTO ${MIGRATION_TABLE} (key, completed_at, source, tables, rows)
          VALUES (?, ?, ?, ?, ?)`)
          .run(marker, Date.now(), sourceFile, tableCount, rowCount));
        (await target.exec('COMMIT'));
      } catch (error) {
        (await target.exec('ROLLBACK'));
        throw error;
      }
    } finally { (await source.close()); }
    return { imported: true, tables: tableCount, rows: rowCount };
  } finally {
    // Transaction-scoped advisory lock releases with commit or rollback.
  }
  });
}
