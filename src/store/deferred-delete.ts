import type { Store } from './db.js';
import type { ObjectRequestOptions, ObjectStore } from './objects.js';

const DAY_MS = 24 * 60 * 60_000;
const RESOURCE_CHUNK = /^resources\/([^/]+)\/chunks\/([^/]+)\.bin$/;

/** The store's own timeout aborts the request; this also bounds a store that
 *  ignores it, since the caller holds a lock until it returns. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * How long a deleted managed object stays in the store: `KARMAX_OBJECT_DELETE_DELAY_DAYS`.
 *
 * Backups (`deploy/karmax backup`, the `predeploy-*` snapshots) copy the local
 * object directory, but skip an external S3 store, and Cloudflare R2 has no
 * object versioning or object lock. So a database restored from a backup would
 * point at every object the app deleted since. Keeping deleted objects for 30
 * days makes any backup younger than that restorable with its objects: an
 * object deleted after a backup at B is purged no earlier than B + 30 days.
 * That outlasts the automatic local backups (the newest 10 `predeploy-*`, which
 * span a few days at the usual deploy rate, and the old updater's bare-stamp
 * ones, kept 14 days) and one.com's 4-day server image; restoring an older
 * backup may miss objects. It is also the recovery window for cleanups that
 * delete in bulk. The local store defaults to immediate deletion because its
 * backups already hold the objects.
 */
export function objectDeleteDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = env.KARMAX_OBJECT_DELETE_DELAY_DAYS?.trim();
  if (!configured) return env.KARMAX_OBJECT_STORE === 's3' ? 30 * DAY_MS : 0;
  const days = Number(configured);
  if (!Number.isFinite(days) || days < 0)
    throw new Error(`KARMAX_OBJECT_DELETE_DELAY_DAYS must be a number of days, not ${JSON.stringify(configured)}`);
  return Math.round(days * DAY_MS);
}

export interface DeferredDeleteOptions {
  delayMs: number;
  /** Tombstones purged per sweep; each holds a Store transaction around one delete. */
  batchSize?: number;
  /** Bound on one purge delete, which runs inside that transaction and so
   *  holds the installation-wide lock on PostgreSQL. */
  deleteTimeoutMs?: number;
  /** Scratch keys deleted at once: browser upload parts are copied into
   *  resource chunks and then deleted, so delaying them would keep every
   *  uploaded byte twice, and no backup restores an upload in progress. */
  immediatePrefixes?: string[];
  now?: () => number;
}

/**
 * The managed object store with delayed deletion. `delete` records a tombstone
 * (`object_tombstones`) and the lifecycle sweep purges due ones (`purgeDue`).
 * Until then the object is still readable.
 *
 * A key can come back: resource chunks are content-addressed, so the next
 * capture holding the same bytes writes the deleted chunk again. `put` clears
 * the tombstone before writing, and the purge re-checks it, deletes the
 * object and drops the row inside one `Store.transaction` (one global lock on
 * PostgreSQL, the write lock on SQLite). A `put` that finds a tombstone clears
 * it in its own transaction, so it either runs before the purge (which then
 * finds nothing to purge) or after it (and writes the object again).
 *
 * A capture also reuses a baseline chunk without writing it, only retaining
 * its row. So `retainResourceChunks` drops the chunk's tombstone in the same
 * transaction, and the purge keeps any chunk the database still references.
 */
export class DeferredDeleteObjectStore implements ObjectStore {
  private readonly batchSize: number;
  private readonly deleteTimeoutMs: number;
  private readonly immediatePrefixes: string[];
  private readonly now: () => number;

  constructor(private inner: ObjectStore, private store: Store, private options: DeferredDeleteOptions) {
    this.batchSize = options.batchSize ?? 50;
    this.deleteTimeoutMs = options.deleteTimeoutMs ?? 5_000;
    this.immediatePrefixes = options.immediatePrefixes ?? ['resource-uploads/'];
    this.now = options.now ?? Date.now;
    // A direct upload goes around put(): its object is retained first, and
    // retaining cancels a pending delete, so no tombstone can purge it.
    if (inner.presign) this.presign = (method, key, seconds) => inner.presign!(method, key, seconds);
    if (inner.head) this.head = (key, request) => inner.head!(key, request);
  }

  async put(key: string, data: Buffer, contentType?: string): Promise<void> {
    // Tombstones are rare, so look before taking the transaction. A purge in
    // progress has not dropped its row yet, so this still sees it and waits.
    if (await this.store.objectTombstone(key))
      await this.store.transaction(() => this.store.deleteObjectTombstone(key));
    await this.inner.put(key, data, contentType);
  }

  get(key: string): Promise<Buffer> { return this.inner.get(key); }
  readonly presign?: ObjectStore['presign'];
  readonly head?: ObjectStore['head'];

  async delete(key: string, options?: ObjectRequestOptions): Promise<void> {
    if (this.options.delayMs <= 0 || this.immediatePrefixes.some((prefix) => key.startsWith(prefix)))
      return this.inner.delete(key, options);
    const now = this.now();
    await this.store.recordObjectTombstone(key, now, now + this.options.delayMs);
  }

  /** Purge up to one batch of due tombstones, oldest first. A chunk the
   * database references again (a capture retained it after its release) is
   * kept and its tombstone dropped. The batch stops at the first failed or
   * timed-out delete: while the store is degraded, each sweep holds the lock
   * for one bounded attempt, and the rest wait for a later sweep. */
  async purgeDue(now = this.now()): Promise<{ purged: number; failed: number }> {
    let purged = 0;
    for (const key of await this.store.dueObjectTombstones(now, this.batchSize)) {
      try {
        const done = await this.store.transaction(async () => {
          const tombstone = await this.store.objectTombstone(key);
          if (!tombstone || tombstone.purgeAfter > now) return false; // resurrected or deleted again since
          const chunk = RESOURCE_CHUNK.exec(key);
          const referenced = !!chunk && await this.store.hasResourceChunk(chunk[1]!, chunk[2]!);
          if (!referenced) await withTimeout(this.inner.delete(key, { timeoutMs: this.deleteTimeoutMs }), this.deleteTimeoutMs);
          await this.store.deleteObjectTombstone(key);
          return !referenced;
        });
        if (done) purged++;
      } catch (error) {
        console.error(`[objects] could not purge ${key}: ${error instanceof Error ? error.message : String(error)}`);
        return { purged, failed: 1 };
      }
    }
    return { purged, failed: 0 };
  }
}
