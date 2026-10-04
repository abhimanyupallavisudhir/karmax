import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isPostgresTarget, openSqlDatabase, type SqlDatabase } from '../store/sql.js';
import { LocalObjectStore, type ObjectInfo } from '../store/objects.js';

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
// Inventory: which local objects does the database still reference?

export interface ObjectReferences {
  /** `<organization>/<chunk id>` of managed chunks with references. */
  chunks: Set<string>;
  manifests: Set<string>;
  attachments: Set<string>;
  checkpoints: Set<string>;
  /** Checkpoint objects queued for deletion (`checkpoint-gc:` entries). */
  pendingCheckpointGc: Set<string>;
  artifacts: Set<string>;
  uploadParts: Set<string>;
  conversationExports: Set<string>;
  /** Object keys of resource repository files (restic) in the managed store. */
  repositoryFiles: Set<string>;
}

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

export async function loadObjectReferences(db: Pick<ReferenceDatabase, 'query'>): Promise<ObjectReferences> {
  const json = (value: unknown): any => { try { return JSON.parse(String(value)); } catch { return undefined; } };
  const references: ObjectReferences = { chunks: new Set(), manifests: new Set(), attachments: new Set(), checkpoints: new Set(),
    pendingCheckpointGc: new Set(), artifacts: new Set(), uploadParts: new Set(), conversationExports: new Set(), repositoryFiles: new Set() };
  for (const row of await db.query('SELECT organizationId, chunkId, storageLocationId FROM resource_snapshot_chunks WHERE refs > 0')) {
    const location = row.storageLocationId == null ? '' : String(row.storageLocationId);
    if (!location || location.startsWith('storage-managed-')) references.chunks.add(`${row.organizationId}/${row.chunkId}`);
  }
  for (const row of await db.query('SELECT sealedRef FROM resource_revisions')) {
    const key = json(row.sealedRef)?.objectKey;
    if (typeof key === 'string') references.manifests.add(key);
  }
  for (const row of await db.query('SELECT id FROM resource_attachments')) references.attachments.add(String(row.id));
  for (const row of await db.query("SELECT repository, kind, name, storageLocationId FROM resource_repository_files WHERE kind<>'locks'")) {
    const location = row.storageLocationId == null ? '' : String(row.storageLocationId);
    if (location && !location.startsWith('storage-managed-')) continue;
    const [attachment, place] = String(row.repository).split('@');
    references.repositoryFiles.add(`resource-repositories/${attachment}/${place}/${row.kind === 'config' ? 'config' : `${row.kind}/${row.name}`}`);
  }
  for (const row of await db.query('SELECT manifest FROM world_checkpoints')) {
    const key = json(row.manifest)?.filesystemDelta?.objectKey;
    if (typeof key === 'string') references.checkpoints.add(key);
  }
  for (const row of await db.query("SELECT v FROM kv WHERE k LIKE 'checkpoint-gc:%'")) {
    const key = json(row.v)?.objectKey;
    if (typeof key === 'string') references.pendingCheckpointGc.add(key);
  }
  for (const row of await db.query('SELECT objectKey FROM promoted_artifacts')) references.artifacts.add(String(row.objectKey));
  for (const row of await db.query('SELECT objectKey FROM conversation_exports')) references.conversationExports.add(String(row.objectKey));
  for (const row of await db.query("SELECT v FROM kv WHERE k LIKE 'resource-upload:%'")) {
    for (const file of Object.values(json(row.v)?.files ?? {}) as Array<{ parts?: Array<{ objectKey?: unknown }> } | undefined>)
      for (const part of file?.parts ?? []) if (typeof part?.objectKey === 'string') references.uploadParts.add(part.objectKey);
  }
  return references;
}

export interface FamilyReport {
  family: string;
  referenced: Tally;
  unreferenced: Tally;
  /** Families no table indexes (conversation imports, unknown keys). */
  untracked: Tally;
  reasons: Record<string, Tally>;
  /** Unreferenced bytes per organization, for the families keyed by one. */
  organizations: Record<string, Tally>;
  /** Modification times of the oldest and newest unreferenced object. */
  unreferencedSpan?: { oldest: number; newest: number };
}

export interface InventoryReport { families: FamilyReport[]; total: Tally; unreferenced: Tally; untracked: Tally }

/** Classify objects by key family and whether the database references them. */
export function inventoryObjects(objects: Iterable<{ key: string; bytes: number; modifiedAt?: number }>,
  references: ObjectReferences): InventoryReport {
  const families = new Map<string, FamilyReport>();
  const report: InventoryReport = { families: [], total: { count: 0, bytes: 0 }, unreferenced: { count: 0, bytes: 0 },
    untracked: { count: 0, bytes: 0 } };
  const add = (into: Tally, bytes: number) => { into.count++; into.bytes += bytes; };
  for (const object of objects) {
    if (TEMPORARY.test(object.key)) continue;
    const { family, organization, state } = classify(object.key, references);
    let entry = families.get(family);
    if (!entry) families.set(family, entry = { family, referenced: { count: 0, bytes: 0 }, unreferenced: { count: 0, bytes: 0 },
      untracked: { count: 0, bytes: 0 }, reasons: {}, organizations: {} });
    add(report.total, object.bytes);
    if (state === 'referenced') add(entry.referenced, object.bytes);
    else if (state === 'untracked') { add(entry.untracked, object.bytes); add(report.untracked, object.bytes); }
    else {
      add(entry.unreferenced, object.bytes);
      add(report.unreferenced, object.bytes);
      add(entry.reasons[state] ??= { count: 0, bytes: 0 }, object.bytes);
      if (organization) add(entry.organizations[organization] ??= { count: 0, bytes: 0 }, object.bytes);
      if (object.modifiedAt !== undefined) {
        const span = entry.unreferencedSpan ??= { oldest: object.modifiedAt, newest: object.modifiedAt };
        span.oldest = Math.min(span.oldest, object.modifiedAt);
        span.newest = Math.max(span.newest, object.modifiedAt);
      }
    }
  }
  report.families = [...families.values()].sort((a, b) => b.unreferenced.bytes - a.unreferenced.bytes || a.family.localeCompare(b.family));
  return report;
}

function classify(key: string, references: ObjectReferences): { family: string; organization?: string; state: string } {
  const parts = key.split('/');
  const organization = parts[1];
  if (parts[0] === 'resources' && parts[2] === 'chunks') {
    const chunk = parts[3]?.replace(/\.bin$/, '');
    return { family: 'resource chunk', organization,
      state: references.chunks.has(`${organization}/${chunk}`) ? 'referenced' : 'no live chunk row' };
  }
  if (parts[0] === 'resources' && parts[2] === 'manifests') {
    return { family: 'resource manifest', organization, state: references.manifests.has(key) ? 'referenced'
      : references.attachments.has(parts[3] ?? '') ? 'attachment exists, no revision' : 'attachment deleted' };
  }
  if (parts[0] === 'resource-repositories') {
    return { family: 'resource repository', state: references.repositoryFiles.has(key) ? 'referenced'
      : references.attachments.has(parts[1] ?? '') ? 'no repository file row' : 'attachment deleted' };
  }
  if (parts[0] === 'checkpoints') {
    return { family: 'checkpoint', organization, state: references.checkpoints.has(key) ? 'referenced'
      : references.pendingCheckpointGc.has(key) ? 'pending checkpoint GC' : 'no checkpoint row' };
  }
  if (parts[0] === 'artifacts')
    return { family: 'artifact', organization, state: references.artifacts.has(key) ? 'referenced' : 'no artifact row' };
  if (parts[0] === 'resource-uploads')
    return { family: 'resource upload part', organization, state: references.uploadParts.has(key) ? 'referenced' : 'no upload session' };
  if (parts[0] === 'conversation-exports')
    return { family: 'conversation export', state: references.conversationExports.has(key) ? 'referenced' : 'no export row' };
  if (parts[0] === 'conversation-imports') return { family: 'conversation import', state: 'untracked' };
  return { family: 'unknown', state: 'untracked' };
}

export function formatInventory(report: InventoryReport): string {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const lines = [`Unreferenced local objects: ${count(report.unreferenced)} of ${count(report.total)} are not referenced by the database`];
  for (const family of report.families) {
    const parts = [`referenced ${count(family.referenced)}`, `unreferenced ${count(family.unreferenced)}`];
    if (family.untracked.count) parts.push(`not indexed by any table ${count(family.untracked)}`);
    lines.push(`  ${family.family}: ${parts.join(', ')}`);
    for (const [reason, tally] of Object.entries(family.reasons).sort(([, a], [, b]) => b.bytes - a.bytes))
      lines.push(`    ${reason}: ${count(tally)}`);
    const organizations = Object.entries(family.organizations).sort(([, a], [, b]) => b.bytes - a.bytes);
    if (organizations.length)
      lines.push(`    by organization: ${organizations.slice(0, 5).map(([id, tally]) => `${id} ${formatBytes(tally.bytes)}`).join(', ')}`
        + (organizations.length > 5 ? `, … ${organizations.length - 5} more` : ''));
    if (family.unreferencedSpan) lines.push(`    written ${day(family.unreferencedSpan.oldest)} … ${day(family.unreferencedSpan.newest)}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------

function count(tally: Tally): string {
  return `${tally.count} object${tally.count === 1 ? '' : 's'} (${formatBytes(tally.bytes)})`;
}

function keyList(tally: KeyedTally): string {
  if (!tally.count) return '';
  return `:\n${tally.keys.map((key) => `  ${key}`).join('\n')}${tally.count > tally.keys.length ? `\n  … ${tally.count - tally.keys.length} more` : ''}`;
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${unit ? value.toFixed(1) : value} ${units[unit]}`;
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
