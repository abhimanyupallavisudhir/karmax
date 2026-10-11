import crypto from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { DeferredDeleteObjectStore } from '../src/store/deferred-delete.js';
import type { ListedObject, ObjectStore } from '../src/store/objects.js';
import {
  inventoryObjects, loadObjectReferences, ObjectReconciler, readReconciliation, reconcileMode,
} from '../src/store/object-reconciliation.js';

const DAY = 24 * 60 * 60_000;
const START = Date.parse('2026-10-10T00:00:00Z');

/** An in-memory bucket that remembers when each object was written. */
class Bucket implements ObjectStore {
  objects = new Map<string, { data: Buffer; modifiedAt: number }>();
  /** Runs once the listing has been read to its end. */
  afterList?: () => Promise<void>;
  constructor(private clock: () => number) {}
  async put(key: string, data: Buffer) { this.objects.set(key, { data, modifiedAt: this.clock() }); }
  async get(key: string) {
    const object = this.objects.get(key);
    if (!object) throw new Error(`missing ${key}`);
    return object.data;
  }
  async delete(key: string) { this.objects.delete(key); }
  async presign(method: 'PUT' | 'GET', key: string) { return `https://bucket/${method}/${key}`; }
  async *list(prefix = ''): AsyncGenerator<ListedObject> {
    for (const [key, object] of [...this.objects].sort(([a], [b]) => a.localeCompare(b)))
      if (key.startsWith(prefix)) yield { key, bytes: object.data.length, etag: '', modifiedAt: object.modifiedAt };
    await this.afterList?.();
  }
  /** An upload that reaches the bucket without passing through tavya (a presigned PUT). */
  land(key: string, bytes: number) { this.objects.set(key, { data: Buffer.alloc(bytes), modifiedAt: this.clock() }); }
}

const targets = ['sqlite', ...(process.env.KARMAX_TEST_POSTGRES_URL ? ['postgres'] : [])] as const;

describe.each(targets)('managed storage reconciliation (%s)', (target) => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

  async function openStore(): Promise<Store> {
    if (target === 'sqlite') {
      const store = await Store.create(':memory:');
      cleanup.push(() => store.close());
      return store;
    }
    const schema = `reconcile_${crypto.randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: process.env.KARMAX_TEST_POSTGRES_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.KARMAX_TEST_POSTGRES_URL!);
    url.searchParams.set('options', `-csearch_path=${schema}`);
    const store = await Store.create(url.href);
    cleanup.push(async () => { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); });
    cleanup.push(() => store.close());
    return store;
  }

  async function setup(mode: 'report' | 'delete' = 'report') {
    const store = await openStore();
    let now = START;
    const clock = () => now;
    const bucket = new Bucket(clock);
    const objects = new DeferredDeleteObjectStore(bucket, store, { delayMs: 30 * DAY, now: clock });
    const reconciler = new ObjectReconciler({ store, objects, mode, now: clock });
    return { store, bucket, objects, reconciler, now: clock, advance: (ms: number) => { now += ms; } };
  }

  const repositoryKey = (name: string) => `resource-repositories/att_a/storage-managed-org_a/data/${name}`;
  const recordPack = (store: Store, name: string, bytes: number) => store.recordRepositoryFile({ repository: 'att_a@storage-managed-org_a',
    attachmentId: 'att_a', organizationId: 'org_a', storageLocationId: 'storage-managed-org_a', kind: 'data', name, bytes });

  it('deletes an upload whose record never came once its grace period has passed, through the delayed delete', async () => {
    const { store, bucket, objects, reconciler, advance } = await setup();
    // An edge upload: tavya handed out the URL, the world stored the pack, then `stored` never came.
    await objects.presign!('PUT', repositoryKey('a'.repeat(64)), 900);
    bucket.land(repositoryKey('a'.repeat(64)), 16);
    // A relayed pack that was recorded, and a checkpoint whose row never followed its put.
    await objects.put(repositoryKey('b'.repeat(64)), Buffer.alloc(16));
    await recordPack(store, 'b'.repeat(64), 16);
    await objects.put('checkpoints/org_a/proj/task/lost.bin', Buffer.alloc(8));

    advance(DAY - 1);
    expect(await reconciler.resolvePendingWrites()).toEqual({ confirmed: 0, abandoned: 0 });
    advance(2);
    expect(await reconciler.resolvePendingWrites()).toEqual({ confirmed: 1, abandoned: 2 });
    expect(await store.pendingObjectWrites(Number.MAX_SAFE_INTEGER, 10)).toEqual([]);
    // Queued for deletion, still readable until the delay passes (a backup restore may need it).
    expect(await store.objectTombstone(repositoryKey('a'.repeat(64)))).toBeDefined();
    expect(await store.objectTombstone('checkpoints/org_a/proj/task/lost.bin')).toBeDefined();
    expect(await store.objectTombstone(repositoryKey('b'.repeat(64)))).toBeUndefined();
    expect(bucket.objects.size).toBe(3);
    advance(30 * DAY);
    expect(await objects.purgeDue()).toEqual({ purged: 2, failed: 0 });
    expect([...bucket.objects.keys()]).toEqual([repositoryKey('b'.repeat(64))]);
  });

  it('keeps an upload recorded late, and one written again since it was recorded as pending', async () => {
    const { store, bucket, objects, reconciler, advance, now } = await setup();
    await objects.presign!('PUT', repositoryKey('c'.repeat(64)), 900);
    bucket.land(repositoryKey('c'.repeat(64)), 16);
    advance(DAY + 1);
    await recordPack(store, 'c'.repeat(64), 16);
    await objects.put('artifacts/org_a/proj/task/art/one', Buffer.alloc(4));
    const started = now();
    advance(DAY + 1);
    // Rewritten (same key) just before its old pending write is settled: that newer write is not forgotten.
    const batch = await store.pendingObjectWrites(now(), 10);
    await objects.put('artifacts/org_a/proj/task/art/one', Buffer.alloc(4));
    await store.deletePendingObjectWrite('artifacts/org_a/proj/task/art/one', started);
    expect(batch.map((write) => write.key)).toContain('artifacts/org_a/proj/task/art/one');
    expect(await store.pendingObjectWrite('artifacts/org_a/proj/task/art/one')).toBe(now());
    expect(await reconciler.resolvePendingWrites()).toEqual({ confirmed: 1, abandoned: 0 });
    expect(await store.objectTombstone(repositoryKey('c'.repeat(64)))).toBeUndefined();
  });

  it('reports what the bucket holds per organization, and deletes nothing by default', async () => {
    const { store, bucket, objects, reconciler, advance, now } = await setup();
    await objects.put(repositoryKey('d'.repeat(64)), Buffer.alloc(100));
    await recordPack(store, 'd'.repeat(64), 100);
    await objects.put('resources/org_a/chunks/released.bin', Buffer.alloc(50));
    await objects.delete('resources/org_a/chunks/released.bin');
    const purgeAt = now() + 30 * DAY;
    await objects.put('resources/org_b/chunks/lost.bin', Buffer.alloc(30));
    await objects.put('conversation-imports/proj_b/upload.json', Buffer.alloc(7));
    advance(2 * DAY);
    await objects.put('checkpoints/org_b/proj/task/fresh.bin', Buffer.alloc(9));

    const report = await reconciler.reconcile();
    expect(report).toMatchObject({ mode: 'report', listed: { count: 5, bytes: 196 }, live: { count: 1, bytes: 100 },
      pendingDelete: { count: 1, bytes: 50 }, pendingWrite: { count: 1, bytes: 9 }, orphans: { count: 1, bytes: 30 },
      untracked: { count: 2, bytes: 37 }, deleted: { count: 0, bytes: 0 } });
    expect(report.organizations.org_a).toEqual({ live: 100, pendingDelete: 50, pendingDeleteUntil: purgeAt, untracked: 0 });
    expect(report.organizations.org_b).toEqual({ live: 0, pendingDelete: 0, untracked: 30 });
    expect(report.sample).toEqual([{ key: 'resources/org_b/chunks/lost.bin', bytes: 30 }]);
    expect(await store.objectTombstone('resources/org_b/chunks/lost.bin')).toBeUndefined();
    expect(bucket.objects.size).toBe(5);
    expect(await readReconciliation(store)).toEqual(report);
  });

  it('in delete mode queues orphans for the delayed delete, never what a record names by then', async () => {
    const { store, bucket, objects, reconciler, advance } = await setup('delete');
    await objects.put('resources/org_b/chunks/lost.bin', Buffer.alloc(30));
    await objects.put('resources/org_b/chunks/retained.bin', Buffer.alloc(30));
    await objects.put('conversation-imports/proj_b/upload.json', Buffer.alloc(7));
    advance(2 * DAY);
    await reconciler.resolvePendingWrites(); // the two chunks' writes are settled: abandoned
    await store.deleteObjectTombstone('resources/org_b/chunks/lost.bin');
    await store.deleteObjectTombstone('resources/org_b/chunks/retained.bin');
    // A capture retains one of them while the bucket is being listed.
    bucket.afterList = () => store.retainResourceChunks('org_b', [{ id: 'retained', bytes: 30 }]);
    const report = await reconciler.reconcile();
    expect(report).toMatchObject({ mode: 'delete', orphans: { count: 2, bytes: 60 }, deleted: { count: 1, bytes: 30 } });
    expect(await store.objectTombstone('resources/org_b/chunks/lost.bin')).toBeDefined();
    expect(await store.objectTombstone('resources/org_b/chunks/retained.bin')).toBeUndefined();
    // A family no table records is reported, never deleted.
    expect(await store.objectTombstone('conversation-imports/proj_b/upload.json')).toBeUndefined();
    expect(bucket.objects.size).toBe(3);
    // A dry run in delete mode deletes nothing.
    await objects.put('resources/org_b/chunks/later.bin', Buffer.alloc(1));
    await store.deletePendingObjectWrite('resources/org_b/chunks/later.bin');
    advance(2 * DAY);
    expect(await reconciler.reconcile({ dryRun: true })).toMatchObject({ mode: 'report', deleted: { count: 0 } });
    expect(await store.objectTombstone('resources/org_b/chunks/later.bin')).toBeUndefined();
  });

  it('agrees with the per-key check on what every record references', async () => {
    const { store } = await setup();
    const run = (sql: string, ...params: unknown[]) => store.db.prepare(sql).run(...params);
    const project = await store.createProject('P', {});
    const task = await store.createTask({ projectId: project.id, title: 'T', workflow: 'software-dev', workflowVersion: '1.26.0', params: { prompt: 'T' } });
    const exported = `conversation-exports/${task.id}/do/x.json`;
    await run(`INSERT INTO resource_attachments (id, organizationId, projectId, name, driver, target, access, isolation, source,
      credentialHandles, publish, enabled, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'att_live', 'org_personal', project.id, 'data', 'object', 'data', 'write', 'fork', '{}', '[]', '{}', 1, 1, 1);
    await run(`INSERT INTO resource_revisions (id, attachmentId, engine, sealedRef, rootDigest, bytes, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      'rev_1', 'att_live', 'object', JSON.stringify({ objectKey: 'resources/org_personal/manifests/att_live/snap_1.bin' }), 'r', 4, 1);
    await run(`INSERT INTO world_checkpoints (id, worldId, generation, projectId, manifest, createdAt) VALUES (?, ?, ?, ?, ?, ?)`,
      'cp_1', 'task_a', 1, project.id, JSON.stringify({ filesystemDelta: { objectKey: 'checkpoints/org_personal/p/task_a/cp_1.bin' } }), 1);
    await run(`INSERT INTO promoted_artifacts (id, organizationId, projectId, taskId, objectKey, sha256, bytes, mediaType, name, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 'art_1', 'org_personal', project.id, 'task_a', 'artifacts/org_personal/p/task_a/art_1', 'x', 1, 'text/plain', 'a', 1);
    await run(`INSERT INTO conversation_exports (objectKey, organizationId, projectId, taskId, role, exportId, bytes, createdAt, usedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, exported, 'org_personal', project.id, task.id, 'do', 'x', 5, 1, 1);
    await store.kvSet('resource-upload:up_1', JSON.stringify({ files: { f: { parts: [{ objectKey: 'resource-uploads/org_personal/up_1/f/0.bin' }] } } }));
    await store.retainResourceChunks('org_personal', [{ id: 'chunk_1', bytes: 3 }]);
    await store.recordRepositoryFile({ repository: 'att_live@storage-managed-org_personal', attachmentId: 'att_live',
      organizationId: 'org_personal', storageLocationId: 'storage-managed-org_personal', kind: 'config', name: 'config', bytes: 1 });
    const referenced = ['resources/org_personal/manifests/att_live/snap_1.bin', 'checkpoints/org_personal/p/task_a/cp_1.bin',
      'artifacts/org_personal/p/task_a/art_1', exported, 'resource-uploads/org_personal/up_1/f/0.bin',
      'resources/org_personal/chunks/chunk_1.bin', 'resource-repositories/att_live/storage-managed-org_personal/config'];
    const unreferenced = ['resources/org_personal/manifests/att_live/snap_2.bin', 'checkpoints/org_personal/p/task_a/cp_2.bin',
      'artifacts/org_personal/p/task_a/art_2', `conversation-exports/${task.id}/do/y.json`, 'resource-uploads/org_personal/up_2/f/0.bin',
      'resources/org_personal/chunks/chunk_2.bin', 'resource-repositories/att_live/storage-managed-org_personal/keys/' + 'e'.repeat(64)];
    const references = await loadObjectReferences({ query: async (sql) => (await store.db.prepare(sql).all()) as Array<Record<string, unknown>> });
    const report = inventoryObjects([...referenced, ...unreferenced].map((key) => ({ key, bytes: 1 })), references, { now: START });
    expect(report.referenced.count).toBe(referenced.length);
    expect(report.unreferenced.count).toBe(unreferenced.length);
    for (const key of referenced) expect(await store.objectKeyReferenced(key), key).toBe(true);
    for (const key of unreferenced) expect(await store.objectKeyReferenced(key), key).toBe(false);
    // Attributed to the organization that owns each object.
    expect(report.organizations.org_personal!.live).toBe(referenced.length);
  });

  it('runs hourly: settles pending writes every time, lists the bucket once a day', async () => {
    const { bucket, objects, reconciler, advance } = await setup();
    let listings = 0;
    bucket.afterList = async () => { listings++; };
    await objects.put('checkpoints/org_a/p/t/x.bin', Buffer.alloc(1));
    await reconciler.run();
    advance(60 * 60_000);
    await reconciler.run();
    expect(listings).toBe(1);
    advance(DAY);
    await reconciler.run();
    expect(listings).toBe(2);
    expect((await reconciler.report())!.orphans).toEqual({ count: 0, bytes: 0 }); // its pending write was settled: now queued for deletion
    expect((await reconciler.report())!.pendingDelete).toEqual({ count: 1, bytes: 1 });
  });
});

it('deletes orphans only when the operator turns it on', () => {
  expect(reconcileMode({})).toBe('report');
  expect(reconcileMode({ KARMAX_STORAGE_RECONCILE: 'report' })).toBe('report');
  expect(reconcileMode({ KARMAX_STORAGE_RECONCILE: 'delete' })).toBe('delete');
});
