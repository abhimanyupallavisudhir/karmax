import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isPostgresTarget, openSqlDatabase, type SqlDatabase } from '../store/sql.js';
import { LocalObjectStore, type ObjectInfo } from '../store/objects.js';
import { formatBytes } from '../store/object-reconciliation.js';

// The inventory (which objects the database references) is shared with the
// in-app reconciliation.
export {
  formatBytes, formatInventory, inventoryObjects, loadObjectReferences, type FamilyReport, type InventoryReport, type ObjectReferences,
} from '../store/object-reconciliation.js';

/** What the migration needs from the bucket: an `S3ObjectStore`. */
export interface MigrationTarget {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  head(key: string): Promise<ObjectInfo | undefined>;
  list?(prefix?: string): AsyncIterable<ObjectInfo & { key: string }>;
}

export interface LocalObject { key: string; file: string; bytes: number; modifiedAt: number }
export interface Tally { count: number; bytes: number }
/** A tally that also names its first keys, for the operator to look at. */
export interface KeyedTally extends Tally { keys: string[] }

export interface MigrationReport {
  verifyOnly: boolean;
  total: Tally;
  copied: Tally;
  /** Already present with the same content. */
  skipped: Tally;
  /** Present with other content; re-copied unless verifying only. */
  mismatched: KeyedTally;
  /** Absent from the destination when verifying only. */
  missing: KeyedTally;
  failed: KeyedTally;
  /** Deleted locally while the migration ran. */
  vanished: Tally;
  /** The local store's unfinished `<key>.<12 hex>.tmp` writes, never copied. */
  temporary: Tally;
}

const KEYS_SHOWN = 20;
const TEMPORARY = /\.[0-9a-f]{12}\.tmp$/;

/** Every file under the local object store, keyed as `LocalObjectStore` keys
 * it: by its path relative to the root. Symbolic links are not followed. */
export async function* localObjects(root: string): AsyncGenerator<LocalObject> {
  const walk = async function* (directory: string): AsyncGenerator<LocalObject> {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) yield* walk(file);
      else if (entry.isFile()) {
        const stat = await fs.promises.stat(file).catch(() => undefined);
        if (stat) yield { key: path.relative(root, file).split(path.sep).join('/'), file, bytes: stat.size, modifiedAt: stat.mtimeMs };
      }
    }
  };
  yield* walk(root);
}

/**
 * Copy every local object to the bucket under the same key (or under
 * `prefix/`). Idempotent and resumable: an object already there is skipped
 * when its size matches and its ETag is the local MD5 (a single-part PUT);
 * otherwise it is downloaded and compared by SHA-256. A copy that differs is
 * reported and copied again. `verifyOnly` writes nothing. `fromS3` copies the
 * other way, every object in the bucket into the local store, to roll back
 * to it. Nothing is ever deleted, locally or remotely.
 */
export async function migrateObjects(options: {
  root: string; target: MigrationTarget; prefix?: string; verifyOnly?: boolean; fromS3?: boolean;
  /** Objects in flight at once. */
  concurrency?: number;
  /** Bytes held in memory at once; one larger object still runs, alone. */
  memoryBytes?: number;
  log?: (line: string) => void; progressEveryMs?: number;
  /** Pre-scanned objects, to avoid walking the store twice. */
  objects?: LocalObject[];
}): Promise<MigrationReport> {
  const { target, verifyOnly = false, concurrency = 8, memoryBytes = 256 * 1024 * 1024 } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const prefix = options.prefix?.replace(/^\/+|\/+$/g, '') ?? '';
  const remoteKey = (key: string) => prefix ? `${prefix}/${key}` : key;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be a positive integer');
  const tally = (): Tally => ({ count: 0, bytes: 0 });
  const keyed = (): KeyedTally => ({ count: 0, bytes: 0, keys: [] });
  const report: MigrationReport = { verifyOnly, total: tally(), copied: tally(), skipped: tally(), mismatched: keyed(),
    missing: keyed(), failed: keyed(), vanished: tally(), temporary: tally() };
  const add = (into: Tally | KeyedTally, bytes: number, key?: string) => {
    into.count++; into.bytes += bytes;
    if (key && 'keys' in into && into.keys.length < KEYS_SHOWN) into.keys.push(key);
  };

  const queue: Array<{ key: string; bytes: number; file?: string; etag?: string }> = [];
  const bucket = prefix ? `the bucket under ${prefix}/` : 'the bucket';
  if (options.fromS3) {
    if (!target.list) throw new Error('copying from S3 needs a store that can list');
    for await (const remote of target.list(prefix ? `${prefix}/` : '')) {
      const key = prefix ? remote.key.slice(prefix.length + 1) : remote.key;
      if (key.startsWith('.karmax-connection-test/')) continue; // doctor's probes
      queue.push({ ...remote, key });
      add(report.total, remote.bytes);
    }
    log(`${verifyOnly ? 'verifying' : 'copying'} ${count(report.total)} from ${bucket} to ${options.root} (${concurrency} at a time)`);
  } else {
    const all: LocalObject[] = options.objects ?? [];
    if (!options.objects) for await (const object of localObjects(options.root)) all.push(object);
    for (const object of all) {
      if (TEMPORARY.test(object.key)) add(report.temporary, object.bytes);
      else { queue.push(object); add(report.total, object.bytes); }
    }
    log(`${verifyOnly ? 'verifying' : 'copying'} ${count(report.total)} from ${options.root} to ${bucket} (${concurrency} at a time)`);
  }

  const memory = weightedSemaphore(memoryBytes);
  let done = 0, doneBytes = 0;
  const progress = () => log(`progress: ${done}/${report.total.count} objects, ${formatBytes(doneBytes)}/${formatBytes(report.total.bytes)};`
    + ` copied ${report.copied.count}, skipped ${report.skipped.count}, mismatched ${report.mismatched.count},`
    + ` missing ${report.missing.count}, failed ${report.failed.count}`);
  const timer = setInterval(progress, options.progressEveryMs ?? 10_000);
  timer.unref();

  const readLocal = async (file: string) => {
    try { return await fs.promises.readFile(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  };
  const local = new LocalObjectStore(options.root);
  // Bucket to local: the same comparison, with the roles swapped.
  const restore = async (remote: { key: string; bytes: number; etag?: string }) => {
    const key = remoteKey(remote.key);
    const data = await readLocal(path.join(options.root, remote.key));
    let stored: Buffer | undefined;
    if (data && data.length === remote.bytes) {
      if (remote.etag === md5(data)) return add(report.skipped, data.length);
      stored = await retrying(() => target.get(key));
      if (sha256(stored) === sha256(data)) return add(report.skipped, data.length);
    }
    if (data) add(report.mismatched, remote.bytes, remote.key);
    else if (verifyOnly) add(report.missing, remote.bytes, remote.key);
    if (verifyOnly) return;
    stored ??= await retrying(() => target.get(key));
    await local.put(remote.key, stored);
    add(report.copied, stored.length);
  };

  const migrate = async (object: { key: string; bytes: number; file?: string }) => {
    const key = remoteKey(object.key);
    const data = await readLocal(object.file!);
    if (!data) return add(report.vanished, object.bytes);
    const remote = await retrying(() => target.head(key));
    if (!remote) {
      if (verifyOnly) return add(report.missing, data.length, object.key);
      await retrying(() => target.put(key, data));
      return add(report.copied, data.length);
    }
    if (remote.bytes === data.length) {
      if (remote.etag === md5(data)) return add(report.skipped, data.length);
      // A multipart or SSE-KMS ETag is not the MD5 of the content: compare the bytes.
      const stored = await retrying(() => target.get(key));
      if (sha256(stored) === sha256(data)) return add(report.skipped, data.length);
    }
    add(report.mismatched, data.length, object.key);
    if (verifyOnly) return;
    await retrying(() => target.put(key, data));
    add(report.copied, data.length);
  };

  let next = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (next < queue.length) {
        const object = queue[next++]!;
        const release = await memory.acquire(object.bytes);
        try { await (options.fromS3 ? restore(object) : migrate(object)); }
        catch (error) {
          add(report.failed, object.bytes, object.key);
          log(`failed ${object.key}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          release();
          done++; doneBytes += object.bytes;
        }
      }
    }));
  } finally { clearInterval(timer); }
  for (const line of formatMigration(report)) log(line);
  return report;
}

/** Whether the run left anything for the operator to fix. */
export function migrationFailed(report: MigrationReport): boolean {
  return report.failed.count > 0 || (report.verifyOnly && (report.missing.count > 0 || report.mismatched.count > 0));
}

export function formatMigration(report: MigrationReport): string[] {
  const lines = report.verifyOnly
    ? [`verified ${count(report.skipped)} match`]
    : [`copied ${count(report.copied)}`, `skipped ${count(report.skipped)} already present`];
  if (report.mismatched.count || report.verifyOnly)
    lines.push(`mismatched ${count(report.mismatched)}${report.verifyOnly ? '' : ' (copied again)'}${keyList(report.mismatched)}`);
  if (report.missing.count || report.verifyOnly) lines.push(`missing ${count(report.missing)}${keyList(report.missing)}`);
  if (report.failed.count) lines.push(`failed ${count(report.failed)}; run again to retry${keyList(report.failed)}`);
  if (report.vanished.count) lines.push(`vanished ${count(report.vanished)} (deleted locally while running)`);
  if (report.temporary.count) lines.push(`ignored ${count(report.temporary)}: unfinished temporary writes`);
  return lines;
}

// ---------------------------------------------------------------------------
// Inventory: which objects does the database still reference?

export interface ReferenceDatabase { query(sql: string): Promise<Array<Record<string, unknown>>>; close(): Promise<void> }

/**
 * Open the app's database for reading only: PostgreSQL in a read-only session
 * (`default_transaction_read_only`), SQLite read-only. Unlike `Store.create`
 * it runs no migrations, so it never writes to production.
 */
export function openReferenceDatabase(target: string): ReferenceDatabase {
  let url = target;
  if (isPostgresTarget(target)) {
    const parsed = new URL(target);
    const options = parsed.searchParams.get('options');
    parsed.searchParams.set('options', `${options ? `${options} ` : ''}-c default_transaction_read_only=on`);
    url = parsed.href;
  }
  const db: SqlDatabase = openSqlDatabase(url, { readOnly: true });
  return { query: async (sql) => (await db.prepare(sql).all()) as Array<Record<string, unknown>>, close: () => db.close() };
}

// ---------------------------------------------------------------------------

function count(tally: Tally): string {
  return `${tally.count} object${tally.count === 1 ? '' : 's'} (${formatBytes(tally.bytes)})`;
}

function keyList(tally: KeyedTally): string {
  if (!tally.count) return '';
  return `:\n${tally.keys.map((key) => `  ${key}`).join('\n')}${tally.count > tally.keys.length ? `\n  … ${tally.count - tally.keys.length} more` : ''}`;
}

function md5(data: Buffer): string { return crypto.createHash('md5').update(data).digest('hex'); }
function sha256(data: Buffer): string { return crypto.createHash('sha256').update(data).digest('hex'); }

/** Three attempts with backoff: a transient 5xx or a dropped connection
 * should not fail one object of thousands. */
async function retrying<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      const status = /failed \((\d{3})\)/.exec(error instanceof Error ? error.message : '')?.[1];
      const permanent = status !== undefined && Number(status) < 500 && status !== '429';
      if (attempt >= attempts || permanent) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * 4 ** (attempt - 1)));
    }
  }
}

/** Hold at most `limit` bytes; an object larger than the limit runs alone. */
function weightedSemaphore(limit: number) {
  let used = 0;
  const waiting: Array<() => void> = [];
  return {
    async acquire(bytes: number): Promise<() => void> {
      const weight = Math.min(Math.max(bytes, 1), limit);
      while (used > 0 && used + weight > limit) await new Promise<void>((resolve) => waiting.push(resolve));
      used += weight;
      return () => { used -= weight; for (const wake of waiting.splice(0)) wake(); };
    },
  };
}
