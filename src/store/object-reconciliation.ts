/**
 * What the managed object store holds against what the database accounts for
 * (wiki features/managed-storage, "Reconciliation").
 *
 * Every object tavya writes is recorded before its bytes reach the store
 * (`pending_object_writes`, by DeferredDeleteObjectStore), and its own record
 * (a repository file, a chunk, a checkpoint, an artifact…) then accounts for
 * it. Two jobs keep that true:
 *
 * - `resolvePendingWrites` (hourly, database only): a write whose record never
 *   followed within the grace period (an edge upload whose `stored` never came,
 *   a process that died between its put and its row) is deleted through the
 *   delayed-delete path.
 * - `reconcile` (daily): list the bucket and classify every object: live
 *   (a record names it), pending deletion (a tombstone, purged after
 *   `KARMAX_OBJECT_DELETE_DELAY_DAYS`), pending write (younger than the grace
 *   period), or untracked. Untracked objects of families tavya owns are
 *   orphans; with `KARMAX_STORAGE_RECONCILE=delete` they are deleted, again
 *   through the delayed-delete path so a restored backup still finds them.
 *   The report, per organization, feeds Installation → Service limits and
 *   the organization's storage page.
 *
 * Nothing a record names is ever deleted: every deletion re-checks
 * `Store.objectKeyReferenced` first, and the purge checks it again.
 */
import type { Store } from './db.js';
import type { ListedObject, ObjectStore } from './objects.js';

const DAY = 24 * 60 * 60_000;
/** How long a write may go unrecorded before it counts as abandoned: an edge
 * upload URL lives 15 minutes, a relayed upload a few seconds. */
export const RECONCILE_GRACE_MS = DAY;
const RECONCILE_EVERY_MS = DAY;
export const RECONCILIATION_REPORT_KEY = 'storage-reconciliation:report';
/** The local store's unfinished writes are not objects yet. */
const TEMPORARY = /\.[0-9a-f]{12}\.tmp$/;

export interface Tally { count: number; bytes: number }
const tally = (): Tally => ({ count: 0, bytes: 0 });
const add = (into: Tally, bytes: number) => { into.count++; into.bytes += bytes; };

// ─── References ──────────────────────────────────────────────────────────────

export interface ObjectReferences {
  /** `<organization>/<chunk id>` of managed chunks with references. */
  chunks: Set<string>;
  manifests: Set<string>;
  /** Resource attachments and their organizations. */
  attachments: Map<string, string>;
  checkpoints: Set<string>;
  /** Checkpoint objects queued for deletion (`checkpoint-gc:` entries). */
  pendingCheckpointGc: Set<string>;
  artifacts: Set<string>;
  uploadParts: Set<string>;
  conversationExports: Set<string>;
  /** Object keys of resource repository files (restic) in the managed store. */
  repositoryFiles: Set<string>;
  /** Deleted objects awaiting their purge (`object_tombstones`), and when. */
  tombstones: Map<string, number>;
  /** Writes recorded but not yet accounted for (`pending_object_writes`), and when they began. */
  pendingWrites: Map<string, number>;
  /** Owners of keys named after a task or a project. */
  taskOrganizations: Map<string, string>;
  projectOrganizations: Map<string, string>;
}

/** Read every reference to a managed object, in a handful of queries. */
export async function loadObjectReferences(db: { query(sql: string): Promise<Array<Record<string, unknown>>> }): Promise<ObjectReferences> {
  const json = (value: unknown): any => { try { return JSON.parse(String(value)); } catch { return undefined; } };
  const references: ObjectReferences = { chunks: new Set(), manifests: new Set(), attachments: new Map(), checkpoints: new Set(),
    pendingCheckpointGc: new Set(), artifacts: new Set(), uploadParts: new Set(), conversationExports: new Set(), repositoryFiles: new Set(),
    tombstones: new Map(), pendingWrites: new Map(), taskOrganizations: new Map(), projectOrganizations: new Map() };
  for (const row of await db.query('SELECT organizationId, chunkId, storageLocationId FROM resource_snapshot_chunks WHERE refs > 0')) {
    const location = row.storageLocationId == null ? '' : String(row.storageLocationId);
    if (!location || location.startsWith('storage-managed-')) references.chunks.add(`${row.organizationId}/${row.chunkId}`);
  }
  for (const row of await db.query('SELECT sealedRef FROM resource_revisions')) {
    const key = json(row.sealedRef)?.objectKey;
    if (typeof key === 'string') references.manifests.add(key);
  }
  for (const row of await db.query('SELECT id, organizationId FROM resource_attachments'))
    references.attachments.set(String(row.id), String(row.organizationId));
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
  for (const row of await db.query('SELECT objectKey, purgeAfter FROM object_tombstones'))
    references.tombstones.set(String(row.objectKey), Number(row.purgeAfter));
  // Absent from a database older than this release, which the read-only dry run may be given.
  for (const row of await db.query('SELECT objectKey, startedAt FROM pending_object_writes').catch(() => []))
    references.pendingWrites.set(String(row.objectKey), Number(row.startedAt));
  for (const row of await db.query('SELECT id, organizationId FROM projects'))
    references.projectOrganizations.set(String(row.id), String(row.organizationId));
  for (const row of await db.query('SELECT t.id AS id, p.organizationId AS organizationId FROM tasks t JOIN projects p ON p.id=t.projectId'))
    references.taskOrganizations.set(String(row.id), String(row.organizationId));
  return references;
}

// ─── Classification ──────────────────────────────────────────────────────────

/**
 * A key's family, and whether tavya owns that family: an owned object that no
 * record names is an orphan, which the reconciliation may delete. Objects of
 * other families (conversation imports, which only a task's parameters name,
 * and anything unknown) are reported, never deleted.
 */
export function objectFamily(key: string): { family: string; owned: boolean } {
  const parts = key.split('/');
  if (parts[0] === 'resources' && parts[2] === 'chunks') return { family: 'resource chunk', owned: true };
  if (parts[0] === 'resources' && parts[2] === 'manifests') return { family: 'resource manifest', owned: true };
  if (parts[0] === 'resource-repositories') return { family: 'resource repository', owned: true };
  if (parts[0] === 'checkpoints') return { family: 'checkpoint', owned: true };
  if (parts[0] === 'artifacts') return { family: 'artifact', owned: true };
  if (parts[0] === 'resource-uploads') return { family: 'resource upload part', owned: true };
  if (parts[0] === 'conversation-exports') return { family: 'conversation export', owned: true };
  if (parts[0] === '.karmax-connection-test') return { family: 'connection probe', owned: true };
  if (parts[0] === 'conversation-imports') return { family: 'conversation import', owned: false };
  return { family: 'unknown', owned: false };
}

/** The organization an object belongs to, when its key tells. */
export function objectOrganization(key: string, references: Pick<ObjectReferences, 'attachments' | 'taskOrganizations'
  | 'projectOrganizations'>): string | undefined {
  const parts = key.split('/');
  if (['resources', 'checkpoints', 'artifacts', 'resource-uploads'].includes(parts[0]!)) return parts[1] || undefined;
  if (parts[0] === 'resource-repositories')
    return parts[2]?.startsWith('storage-managed-') ? parts[2].slice('storage-managed-'.length) : references.attachments.get(parts[1] ?? '');
  if (parts[0] === 'conversation-exports') return references.taskOrganizations.get(parts[1] ?? '');
  if (parts[0] === 'conversation-imports') return references.projectOrganizations.get(parts[1] ?? '');
  return undefined;
}

/** Why an owned object no record names is unreferenced, or `referenced`. */
function referenceState(key: string, references: ObjectReferences): string {
  const parts = key.split('/');
  const organization = parts[1];
  if (parts[0] === 'resources' && parts[2] === 'chunks')
    return references.chunks.has(`${organization}/${parts[3]?.replace(/\.bin$/, '')}`) ? 'referenced' : 'no live chunk row';
  if (parts[0] === 'resources' && parts[2] === 'manifests') return references.manifests.has(key) ? 'referenced'
    : references.attachments.has(parts[3] ?? '') ? 'attachment exists, no revision' : 'attachment deleted';
  if (parts[0] === 'resource-repositories') return references.repositoryFiles.has(key) ? 'referenced'
    : references.attachments.has(parts[1] ?? '') ? 'no repository file row' : 'attachment deleted';
  if (parts[0] === 'checkpoints') return references.checkpoints.has(key) ? 'referenced' : 'no checkpoint row';
  if (parts[0] === 'artifacts') return references.artifacts.has(key) ? 'referenced' : 'no artifact row';
  if (parts[0] === 'resource-uploads') return references.uploadParts.has(key) ? 'referenced' : 'no upload session';
  if (parts[0] === 'conversation-exports') return references.conversationExports.has(key) ? 'referenced' : 'no export row';
  if (parts[0] === '.karmax-connection-test') return 'left by a connection check';
  return 'not indexed by any table';
}

export interface FamilyReport {
  family: string;
  referenced: Tally;
  /** Deleted, kept until the delayed delete purges it (or queued for checkpoint GC). */
  pendingDelete: Tally;
  /** Not accounted for yet, but younger than the grace period. */
  pendingWrite: Tally;
  /** Owned by tavya and named by no record: orphans. */
  unreferenced: Tally;
  /** Families no table indexes (conversation imports, unknown keys). */
  untracked: Tally;
  reasons: Record<string, Tally>;
  /** Unreferenced bytes per organization. */
  organizations: Record<string, Tally>;
  /** Modification times of the oldest and newest unreferenced object. */
  unreferencedSpan?: { oldest: number; newest: number };
}

/** What one organization has in the store, in bytes. */
export interface OrganizationObjects {
  live: number;
  pendingDelete: number;
  /** When the last of its pending deletions is purged. */
  pendingDeleteUntil?: number;
  /** Orphans and objects of untracked families: in the store, accounted for by nothing. */
  untracked: number;
}

export interface InventoryReport {
  families: FamilyReport[];
  total: Tally;
  referenced: Tally;
  pendingDelete: Tally;
  pendingWrite: Tally;
  unreferenced: Tally;
  untracked: Tally;
  /** By organization; objects no key attributes are under `''`. */
  organizations: Record<string, OrganizationObjects>;
  /** Orphans past the grace period, which the reconciliation may delete, up to the `keep` limit. */
  orphans: Array<{ key: string; bytes: number; organization?: string }>;
}

/**
 * Classify objects by key family against the database, one at a time (a
 * bucket's listing is streamed through `add`). An object is live when a
 * record names it; otherwise pending deletion when tombstoned; otherwise a
 * pending write when written (or recorded as pending) within `graceMs`;
 * otherwise unreferenced (an orphan) or, for families tavya does not own,
 * untracked.
 */
export class ObjectInventory {
  private families = new Map<string, FamilyReport>();
  private result: InventoryReport = { families: [], total: tally(), referenced: tally(), pendingDelete: tally(), pendingWrite: tally(),
    unreferenced: tally(), untracked: tally(), organizations: {}, orphans: [] };

  constructor(private references: ObjectReferences, private options: { now?: number; graceMs?: number; keep?: number } = {}) {}

  add(object: { key: string; bytes: number; modifiedAt?: number }): void {
    if (TEMPORARY.test(object.key)) return;
    const { key, bytes } = object;
    const { family, owned } = objectFamily(key);
    const organization = objectOrganization(key, this.references);
    let entry = this.families.get(family);
    if (!entry) this.families.set(family, entry = { family, referenced: tally(), pendingDelete: tally(), pendingWrite: tally(),
      unreferenced: tally(), untracked: tally(), reasons: {}, organizations: {} });
    const owner = this.result.organizations[organization ?? ''] ??= { live: 0, pendingDelete: 0, untracked: 0 };
    add(this.result.total, bytes);
    const state = owned ? referenceState(key, this.references) : 'untracked';
    if (state === 'referenced') {
      add(entry.referenced, bytes); add(this.result.referenced, bytes); owner.live += bytes;
      return;
    }
    const purgeAfter = this.references.tombstones.get(key);
    if (purgeAfter !== undefined || this.references.pendingCheckpointGc.has(key)) {
      add(entry.pendingDelete, bytes); add(this.result.pendingDelete, bytes); owner.pendingDelete += bytes;
      if (purgeAfter !== undefined) owner.pendingDeleteUntil = Math.max(owner.pendingDeleteUntil ?? 0, purgeAfter);
      return;
    }
    const now = this.options.now ?? Date.now();
    const graceMs = this.options.graceMs ?? RECONCILE_GRACE_MS;
    const started = Math.max(this.references.pendingWrites.get(key) ?? 0, object.modifiedAt ?? 0);
    if (started > now - graceMs) {
      add(entry.pendingWrite, bytes); add(this.result.pendingWrite, bytes);
      return;
    }
    owner.untracked += bytes;
    if (state === 'untracked') { add(entry.untracked, bytes); add(this.result.untracked, bytes); return; }
    add(entry.unreferenced, bytes);
    add(this.result.unreferenced, bytes);
    add(entry.reasons[state] ??= tally(), bytes);
    if (organization) add(entry.organizations[organization] ??= tally(), bytes);
    if (object.modifiedAt !== undefined) {
      const span = entry.unreferencedSpan ??= { oldest: object.modifiedAt, newest: object.modifiedAt };
      span.oldest = Math.min(span.oldest, object.modifiedAt);
      span.newest = Math.max(span.newest, object.modifiedAt);
    }
    if (this.result.orphans.length < (this.options.keep ?? 1_000))
      this.result.orphans.push({ key, bytes, ...(organization ? { organization } : {}) });
  }

  report(): InventoryReport {
    this.result.families = [...this.families.values()]
      .sort((a, b) => b.unreferenced.bytes - a.unreferenced.bytes || a.family.localeCompare(b.family));
    return this.result;
  }
}

export function inventoryObjects(objects: Iterable<{ key: string; bytes: number; modifiedAt?: number }>,
  references: ObjectReferences, options?: { now?: number; graceMs?: number; keep?: number }): InventoryReport {
  const inventory = new ObjectInventory(references, options);
  for (const object of objects) inventory.add(object);
  return inventory.report();
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${unit ? value.toFixed(1) : value} ${units[unit]}`;
}

function count(tally: Tally): string {
  return `${tally.count} object${tally.count === 1 ? '' : 's'} (${formatBytes(tally.bytes)})`;
}

export function formatInventory(report: InventoryReport): string {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const lines = [`Unreferenced objects: ${count(report.unreferenced)} of ${count(report.total)} are not referenced by the database`,
    `  live ${count(report.referenced)}, awaiting deletion ${count(report.pendingDelete)}, written in the last day ${count(report.pendingWrite)}`
      + (report.untracked.count ? `, not indexed by any table ${count(report.untracked)}` : '')];
  for (const family of report.families) {
    const parts = [`referenced ${count(family.referenced)}`, `unreferenced ${count(family.unreferenced)}`];
    if (family.pendingDelete.count) parts.push(`awaiting deletion ${count(family.pendingDelete)}`);
    if (family.pendingWrite.count) parts.push(`written in the last day ${count(family.pendingWrite)}`);
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
  const organizations = Object.entries(report.organizations).sort(([, a], [, b]) => b.live + b.pendingDelete - a.live - a.pendingDelete);
  if (organizations.length) lines.push('By organization (live / awaiting deletion, purged by / untracked):');
  for (const [id, entry] of organizations)
    lines.push(`  ${id || '(unattributed)'}: ${formatBytes(entry.live)} / ${formatBytes(entry.pendingDelete)}`
      + `${entry.pendingDeleteUntil ? `, by ${day(entry.pendingDeleteUntil)}` : ''} / ${formatBytes(entry.untracked)}`);
  return lines.join('\n');
}

// ─── The reconciliation ──────────────────────────────────────────────────────

export type ReconcileMode = 'report' | 'delete';

/** `KARMAX_STORAGE_RECONCILE=delete` lets the daily reconciliation delete
 * orphans; by default it only reports them. */
export function reconcileMode(env: NodeJS.ProcessEnv = process.env): ReconcileMode {
  return env.KARMAX_STORAGE_RECONCILE?.trim() === 'delete' ? 'delete' : 'report';
}

export interface StorageReconciliation {
  at: number;
  mode: ReconcileMode;
  durationMs: number;
  listed: Tally;
  live: Tally;
  pendingDelete: Tally;
  pendingWrite: Tally;
  /** In the store, accounted for by nothing: orphans plus untracked families. */
  untracked: Tally;
  /** Orphans past the grace period: deleted (queued for the delayed delete) in delete mode, else what would be. */
  orphans: Tally;
  deleted: Tally;
  organizations: Record<string, OrganizationObjects>;
  families: Array<{ family: string; live: Tally; pendingDelete: Tally; pendingWrite: Tally; unreferenced: Tally; untracked: Tally;
    reasons: Record<string, Tally> }>;
  /** A few orphan keys, for the operator to look at. */
  sample: Array<{ key: string; bytes: number }>;
}

export class ObjectReconciler {
  private running?: Promise<unknown>;

  constructor(private deps: {
    store: Store;
    /** The managed store (DeferredDeleteObjectStore): its deletes are delayed. */
    objects: ObjectStore;
    mode?: ReconcileMode;
    graceMs?: number;
    /** Orphans deleted per reconciliation at most. */
    maxDeletes?: number;
    now?: () => number;
    log?: (line: string) => void;
  }) {}

  private get graceMs() { return this.deps.graceMs ?? RECONCILE_GRACE_MS; }
  private now() { return this.deps.now?.() ?? Date.now(); }

  /**
   * Settle every write recorded more than the grace period ago: one that a
   * record now accounts for (or that was deleted since) is done; one nothing
   * names was abandoned, and its object is deleted through the delayed-delete
   * path. A write of a family tavya doesn't own is only forgotten.
   */
  async resolvePendingWrites(now = this.now()): Promise<{ confirmed: number; abandoned: number }> {
    const { store, objects } = this.deps;
    let confirmed = 0, abandoned = 0;
    for (let round = 0; round < 20; round++) {
      const batch = await store.pendingObjectWrites(now - this.graceMs, 500);
      for (const { key, startedAt } of batch) {
        if (objectFamily(key).owned && !(await store.objectKeyReferenced(key)) && !(await store.objectTombstone(key))) {
          await objects.delete(key);
          abandoned++;
        } else confirmed++;
        await store.deletePendingObjectWrite(key, startedAt);
      }
      if (batch.length < 500) break;
    }
    if (abandoned) this.deps.log?.(`[storage] deleted ${abandoned} upload${abandoned === 1 ? '' : 's'} never recorded`);
    return { confirmed, abandoned };
  }

  /** List the store and compare it with the database; in delete mode (and
   * not `dryRun`), delete orphans past the grace period. Saves the report. */
  async reconcile(options: { now?: number; dryRun?: boolean } = {}): Promise<StorageReconciliation> {
    const { store, objects } = this.deps;
    if (!objects.list) throw new Error('the managed object store cannot list its objects');
    const started = Date.now();
    const now = options.now ?? this.now();
    const mode = this.deps.mode ?? 'report';
    const maxDeletes = this.deps.maxDeletes ?? 10_000;
    const references = await loadObjectReferences({ query: async (sql) => (await store.db.prepare(sql).all()) as Array<Record<string, unknown>> });
    const inventory = new ObjectInventory(references, { now, graceMs: this.graceMs, keep: maxDeletes });
    for await (const object of objects.list('') as AsyncIterable<ListedObject>) inventory.add(object);
    const report = inventory.report();
    const deleted = tally();
    if (mode === 'delete' && !options.dryRun) {
      for (const orphan of report.orphans) {
        // The listing is a moment ago: a record, a tombstone or a new write since then keeps the object.
        if (await store.objectKeyReferenced(orphan.key) || await store.objectTombstone(orphan.key)) continue;
        const pending = await store.pendingObjectWrite(orphan.key);
        if (pending !== undefined && pending > now - this.graceMs) continue;
        await objects.delete(orphan.key);
        add(deleted, orphan.bytes);
      }
      if (deleted.count) this.deps.log?.(`[storage] queued ${deleted.count} orphaned objects (${formatBytes(deleted.bytes)}) for deletion`);
    }
    const result: StorageReconciliation = {
      at: now, mode: options.dryRun ? 'report' : mode, durationMs: Date.now() - started,
      listed: report.total, live: report.referenced, pendingDelete: report.pendingDelete, pendingWrite: report.pendingWrite,
      untracked: { count: report.unreferenced.count + report.untracked.count, bytes: report.unreferenced.bytes + report.untracked.bytes },
      orphans: report.unreferenced, deleted, organizations: report.organizations,
      families: report.families.map((family) => ({ family: family.family, live: family.referenced, pendingDelete: family.pendingDelete,
        pendingWrite: family.pendingWrite, unreferenced: family.unreferenced, untracked: family.untracked, reasons: family.reasons })),
      sample: report.orphans.slice(0, 20).map(({ key, bytes }) => ({ key, bytes })),
    };
    (await store.kvSet(RECONCILIATION_REPORT_KEY, JSON.stringify(result)));
    return result;
  }

  async report(): Promise<StorageReconciliation | undefined> {
    return readReconciliation(this.deps.store);
  }

  /** The hourly step: settle pending writes, and reconcile once a day. */
  run(now = this.now()): Promise<unknown> {
    return this.running ??= (async () => {
      await this.resolvePendingWrites(now);
      if (!this.deps.objects.list) return;
      const last = await this.report();
      if (!last || now - last.at >= RECONCILE_EVERY_MS) await this.reconcile({ now });
    })().finally(() => { this.running = undefined; });
  }
}

export async function readReconciliation(store: Pick<Store, 'kvGet'>): Promise<StorageReconciliation | undefined> {
  try { return JSON.parse((await store.kvGet(RECONCILIATION_REPORT_KEY)) ?? 'null') ?? undefined; } catch { return undefined; }
}
