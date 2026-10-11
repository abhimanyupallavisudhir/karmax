import type { SqlDatabase } from '../store/sql.js';

/**
 * The data epoch this release writes: `deploy/data-epoch` (a test keeps the
 * two equal). An epoch is a one-way change to stored data that an older
 * release would misread (wiki ops/release-and-deploy). The database records
 * the highest epoch that has run against it, and a release older than that
 * refuses to start rather than running on data it cannot read.
 *
 * Releases before epoch 6 do not read the record; they are refused by
 * markers in the data they would misread (the vault's, `vault-backend.ts`).
 */
export const DATA_EPOCH = 6;
const KEY = 'data-epoch';

export async function assertDataEpoch(db: SqlDatabase, epoch = DATA_EPOCH): Promise<void> {
  const row = await db.prepare('SELECT v FROM kv WHERE k = ?').get(KEY) as { v: string } | undefined;
  const recorded = Number(row?.v ?? 0);
  if (recorded > epoch)
    throw new Error(`this database has been used by a release of data epoch ${recorded}, and this release is epoch ${epoch}: `
      + 'it cannot read that data. Run that release (or a later one), or restore the pre-update backup with its own code');
}

/** After this release's one-way migrations: never lowers the record. */
export async function recordDataEpoch(db: SqlDatabase, epoch = DATA_EPOCH): Promise<void> {
  await assertDataEpoch(db, epoch);
  await db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(KEY, String(epoch));
}
