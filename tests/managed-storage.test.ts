import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { StorageLocationService } from '../src/store/storage-locations.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { ObjectSnapshotEngine, ProjectResourceService } from '../src/world/resources.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ManagedStorageService, STORAGE_POLICY, type StorageNotice } from '../src/world/managed-storage.js';
import { storageNotifier } from '../src/world/storage-notices.js';
import crypto from 'node:crypto';
import { repositoryName } from '../src/world/resource-repository.js';

const DAY = 24 * 60 * 60 * 1000;
/** Above two 40 kB versions and restic's metadata, below three. */
const QUOTA = 100_000;
const dirs: string[] = [];
const stores: Store[] = [];
// The same suite runs on PostgreSQL (production's database) when
// KARMAX_TEST_POSTGRES_URL points at a disposable database.
const postgresUrl = process.env.KARMAX_TEST_POSTGRES_URL;
const admin = postgresUrl ? new Pool({ connectionString: postgresUrl }) : undefined;
const BACKENDS = ['sqlite', ...(postgresUrl ? ['postgres'] : [])];
let backend = 'sqlite';
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
afterAll(async () => { await admin?.end(); });

async function fixture(options: { hosted?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-managed-storage-')); dirs.push(dir);
  if (backend === 'postgres') await admin!.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const store = (await Store.create(backend === 'postgres' ? postgresUrl! : ':memory:', { hosted: options.hosted ?? false }));
  stores.push(store);
  const project = (await store.createProject('Data'));
  const organizationId = project.organizationId!;
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  const objectsDir = path.join(dir, 'objects');
  const objects = new LocalObjectStore(objectsDir);
  const locations = new StorageLocationService(store, objects, broker);
  const engine = new ObjectSnapshotEngine(objects, broker, locations);
  const resources = new ProjectResourceService(store, new WorldRegistry(), engine, broker, undefined, locations);
  const managed = (await locations.ensureManaged(organizationId));
  const checkpoints = { async collectGarbage() {
    for (const entry of (await store.kvEntries('checkpoint-gc:'))) {
      await objects.delete(JSON.parse(entry.value).objectKey);
      (await store.completeCheckpointDeletion(entry.key.slice('checkpoint-gc:'.length)));
    }
  } };
  const notices: StorageNotice[] = [];
  const service = new ManagedStorageService({ store, resources, checkpoints, objects, notify: async (notice) => { notices.push(notice); } });
  const attachment = (name: string) => store.createResourceAttachment({ organizationId, projectId: project.id, name,
    driver: 'volume@1', target: { kind: 'path', path: name }, access: 'write', isolation: 'fork', source: {},
    credentialHandles: [], storageLocationId: managed.id, publish: 'review' });
  /** A park-time capture of a task's private copy, as ProjectResourceService.checkpoint saves it. */
  const checkpointRevision = async (attachmentId: string, data: Buffer, createdAt: number) => {
    const source = fs.mkdtempSync(path.join(dir, 'capture-'));
    fs.writeFileSync(path.join(source, 'file.bin'), data);
    const repository = await resources.restic.current((await store.getResourceAttachment(attachmentId))!);
    const capture = await resources.restic.backupDirectory(source, repository, { quota: false });
    return store.saveResourceRevision({ attachmentId, ...resources.restic.revisionFields(capture, repository),
      metadata: { checkpoint: true }, createdAt });
  };
  const task = async (status: string, completedAt?: number) => {
    const created = (await store.createTask({ projectId: project.id, title: status, workflow: 'just-do',
      workflowVersion: '1.0.0', params: { prompt: status } as any }));
    (await store.db.prepare('UPDATE tasks SET lastView=?, completedAt=? WHERE id=?')
      .run(JSON.stringify({ status }), completedAt ?? null, created.id));
    return created;
  };
  const worldCheckpoint = async (worldId: string, createdAt: number, extra: Record<string, unknown> = {}) => {
    const id = `checkpoint-${worldId}-${createdAt}`;
    const objectKey = `checkpoints/${organizationId}/${project.id}/${worldId}/${id}.bin`;
    await objects.put(objectKey, Buffer.alloc(100, 1));
    (await store.saveWorldCheckpoint({ id, worldId, generation: 1, projectId: project.id, repos: [],
      filesystemDelta: { objectKey, sha256: 'x', bytes: 100 }, createdAt, ...extra } as any));
    return { id, objectKey: path.join(objectsDir, objectKey) };
  };
  const world = async (worldId: string, state: 'ready' | 'parked' | 'hibernated' | 'released') => {
    const handle = (await store.registerWorld({ id: worldId, kind: 'e2b', generation: 1 } as any, project.id));
    (await store.setWorldState(handle, state));
  };
  const usage = async () => (await store.storageLocationUsage(managed.id));
  const snapshots = async (attachmentId: string) => (await store.listRepositoryFiles(repositoryName(attachmentId, managed.id), 'snapshots')).map((file) => file.name);
  return { store, project, organizationId, managed, resources, service, notices, attachment, checkpointRevision, snapshots,
    task, worldCheckpoint, world, usage, objects };
}

describe.each(BACKENDS)('%s', (name) => {
  beforeEach(() => { backend = name; });

  describe('managed storage retention', () => {
    it('deletes checkpoint revisions nothing references once they are a day old', async () => {
      const f = (await fixture());
      const now = Date.now();
      const old = now - 2 * DAY;
      const data = (await f.attachment('data'));
      (await f.resources.importFiles(data.id, [{ path: 'file.bin', data: Buffer.alloc(64, 1) }]));
      const leaked = (await f.checkpointRevision(data.id, Buffer.alloc(64, 2), old));
      const byCheckpoint = (await f.checkpointRevision(data.id, Buffer.alloc(64, 3), old));
      const byBaseline = (await f.checkpointRevision(data.id, Buffer.alloc(64, 4), old));
      const recent = (await f.checkpointRevision(data.id, Buffer.alloc(64, 5), now - 60_000));
      const doing = (await f.task('waiting'));
      (await f.worldCheckpoint(doing.id, now, { resources: [{ attachmentId: data.id, revisionId: byCheckpoint.id }] }));
      (await f.store.kvSet(`resource-checkpoint:${doing.id}:${data.id}`, JSON.stringify({ leaseId: 'lease', revisionId: byBaseline.id })));
      expect(await f.snapshots(data.id)).toHaveLength(5);

      const result = (await f.service.run(now));

      expect(result.deletedRevisions).toBe(1);
      expect((await f.store.getResourceRevision(leaked.id))).toBeUndefined();
      for (const kept of [byCheckpoint, byBaseline, recent]) expect((await f.store.getResourceRevision(kept.id))).toBeDefined();
      expect((await f.store.listResourceRevisions(data.id))).toHaveLength(4);
      // Its snapshot is forgotten and its data pruned.
      expect(await f.snapshots(data.id)).not.toContain(leaked.rootDigest);
      expect(await f.snapshots(data.id)).toHaveLength(4);
      expect(await f.store.kvEntries('restic-prune:')).toEqual([]);
    });

    it('expires the saved workspaces of done and cancelled tasks after 30 days, and nothing else', async () => {
      const f = (await fixture());
      const now = Date.now();
      const old = now - STORAGE_POLICY.finishedTaskCheckpointMs - DAY;
      const done = (await f.task('done', old));
      const cancelled = (await f.task('cancelled'));
      const recentlyDone = (await f.task('done', now - DAY));
      const failed = (await f.task('failed', old));
      const waiting = (await f.task('waiting'));
      const doneButParked = (await f.task('done', old));
      const forked = (await f.task('done', old));
      const expired = [(await f.worldCheckpoint(done.id, old)), (await f.worldCheckpoint(done.id, old - 1)),
        (await f.worldCheckpoint(cancelled.id, old))];
      const kept = [(await f.worldCheckpoint(recentlyDone.id, now - DAY)), (await f.worldCheckpoint(failed.id, old)),
        (await f.worldCheckpoint(waiting.id, old)), (await f.worldCheckpoint(doneButParked.id, old)),
        (await f.worldCheckpoint(forked.id, old))];
      (await f.world(doneButParked.id, 'parked'));
      (await f.world(done.id, 'released'));
      (await f.store.pinWorldCheckpointForFork('fork-task', kept[4]!.id));

      const result = (await f.service.run(now));

      expect(result.expiredCheckpoints).toBe(3);
      for (const checkpoint of expired) {
        expect((await f.store.getWorldCheckpoint(checkpoint.id))).toBeUndefined();
        expect(fs.existsSync(checkpoint.objectKey)).toBe(false);
      }
      for (const checkpoint of kept) expect((await f.store.getWorldCheckpoint(checkpoint.id))).toBeDefined();
    });

    it('stops counting a checkpoint once it is queued for deletion', async () => {
      const f = (await fixture());
      const done = (await f.task('done', 1));
      (await f.worldCheckpoint(done.id, 1));
      expect((await f.usage()).retainedBytes).toBe(100);
      (await f.store.expireFinishedWorldCheckpoints(Date.now()));
      expect((await f.usage()).retainedBytes).toBe(0);
    });
  });

  describe('over-quota policy', () => {
    async function overQuota() {
      const f = (await fixture());
      const now = Date.now();
      const older = (await f.attachment('older'));
      // Random, so restic cannot compress it; the quota leaves room for its own metadata.
      (await f.resources.importFiles(older.id, [{ path: 'a.bin', data: crypto.randomBytes(40_000) }]));
      (await f.resources.importFiles(older.id, [{ path: 'a.bin', data: crypto.randomBytes(40_000) }]));
      const current = (await f.attachment('current'));
      (await f.resources.importFiles(current.id, [{ path: 'b.bin', data: crypto.randomBytes(40_000) }]));
      (await f.store.saveStorageLocation({ ...f.managed, quotaBytes: QUOTA }));
      return { ...f, now, older, current };
    }

    it('records when it went over, notices once per stage, and clears when back under', async () => {
      const f = (await overQuota());
      expect((await f.usage()).retainedBytes).toBeGreaterThan(QUOTA);
      (await f.service.enforceQuota(f.organizationId, f.now));
      (await f.service.enforceQuota(f.organizationId, f.now + DAY));
      expect(f.notices.map((notice) => notice.stage)).toEqual(['over']);
      expect(f.notices[0]).toMatchObject({ overSince: f.now, deleteAt: f.now + STORAGE_POLICY.overQuotaDeletionMs, quotaBytes: QUOTA });

      (await f.service.enforceQuota(f.organizationId, f.now + 336 * DAY));
      (await f.service.enforceQuota(f.organizationId, f.now + 359 * DAY));
      expect(f.notices.map((notice) => notice.stage)).toEqual(['over', '30d', '7d']);
      expect((await f.store.listResourceRevisions(f.older.id))).toHaveLength(2);

      (await f.store.saveStorageLocation({ ...f.managed, quotaBytes: 10 * QUOTA }));
      (await f.service.enforceQuota(f.organizationId, f.now + 360 * DAY));
      expect((await f.store.storageOverQuota(f.organizationId))).toBeUndefined();
    });

    it('is read-only for new data while over, but still saves work in progress', async () => {
      const f = (await overQuota());
      await expect(f.resources.importFiles(f.current.id, [{ path: 'c.bin', data: Buffer.alloc(10, 9) }]))
        .rejects.toThrow(/quota/);
      await expect(f.store.reserveStorageUpload('upload', f.organizationId, f.managed.id, 10, f.now + 60_000))
        .rejects.toThrow(/quota exceeded/);
      (await f.store.reserveStorageUpload('checkpoint', f.organizationId, f.managed.id, 10, f.now + 60_000, { enforceQuota: false }));
      expect((await f.checkpointRevision(f.current.id, Buffer.alloc(10, 7), f.now)).id).toBeTruthy();
    });

    it('deletes older versions first, after 12 months, only until the organization fits', async () => {
      const f = (await overQuota());
      (await f.service.enforceQuota(f.organizationId, f.now));
      (await f.service.enforceQuota(f.organizationId, f.now + STORAGE_POLICY.overQuotaDeletionMs));

      expect(f.notices.map((notice) => notice.stage)).toEqual(['over', 'deleted']);
      const olderRevisions = (await f.store.listResourceRevisions(f.older.id));
      expect(olderRevisions.map((revision) => revision.id)).toEqual([(await f.store.getResourceAttachment(f.older.id))!.currentRevisionId]);
      expect((await f.store.listResourceRevisions(f.current.id))).toHaveLength(1);
      expect((await f.usage()).retainedBytes).toBeLessThanOrEqual(QUOTA);
      expect((await f.store.storageOverQuota(f.organizationId))).toBeUndefined();
    });

    it('then deletes current data oldest first, but never data a task is using', async () => {
      const f = (await overQuota());
      (await f.store.saveStorageLocation({ ...f.managed, quotaBytes: 100 }));
      const inUse = (await f.store.getResourceAttachment(f.current.id))!.currentRevisionId!;
      (await f.store.db.prepare(`INSERT INTO resource_leases (id, attachmentId, revisionId, taskId, worldId, worldGeneration,
        access, state, createdAt) VALUES ('lease', ?, ?, 'task', 'world', 1, 'write', 'active', ?)`).run(f.current.id, inUse, f.now));

      (await f.service.enforceQuota(f.organizationId, f.now));
      (await f.service.enforceQuota(f.organizationId, f.now + STORAGE_POLICY.overQuotaDeletionMs));

      expect((await f.store.listResourceRevisions(f.older.id))).toHaveLength(0);
      expect((await f.store.getResourceAttachment(f.older.id))!.currentRevisionId).toBeUndefined();
      expect((await f.store.getResourceRevision(inUse))).toBeDefined();
      expect((await f.store.storageOverQuota(f.organizationId))).toBeDefined();
    });
  });

    describe('owner notices', () => {
      it('puts one current notice in each owner\'s inbox, emails them, and withdraws it once resolved', async () => {
        const f = (await fixture());
        (await f.store.setOrganizationMembership(f.organizationId, 'owner-1', 'owner'));
        (await f.store.setOrganizationMembership(f.organizationId, 'member-1', 'member'));
        const sent: Array<{ to: string; subject: string; text: string }> = [];
        const notify = storageNotifier({ store: f.store, publicUrl: 'https://tavya.test/',
          email: { configured: async () => true, send: async (message) => { sent.push(message); } },
          userEmail: async (userId) => `${userId}@example.com`, siteName: async () => 'tavya' });
        const notice = (stage: StorageNotice['stage']): StorageNotice => ({ organizationId: f.organizationId, stage,
          retainedBytes: 6 * 1024 ** 3, quotaBytes: 5 * 1024 ** 3, overSince: Date.parse('2026-10-01T00:00:00Z'),
          deleteAt: Date.parse('2027-10-01T00:00:00Z') });

        await notify(notice('over'));
        await notify(notice('30d'));
        const inbox = (await f.store.listInbox('owner-1', f.organizationId));
        expect(inbox).toHaveLength(1);
        expect(inbox[0]!.subject).toMatchObject({ kind: 'storage', stage: '30d', deleteAt: Date.parse('2027-10-01T00:00:00Z') });
        expect((await f.store.listInbox('member-1', f.organizationId))).toHaveLength(0);
        expect(sent.map((message) => message.to)).toEqual(['owner-1@example.com', 'owner-1@example.com']);
        expect(sent[1]).toMatchObject({ subject: expect.stringMatching(/over its tavya storage limit/) });
        expect(sent[1]!.text).toMatch(/6\.0 GB of 5\.0 GB[\s\S]*before on 2027-10-01 \(30 days\)[\s\S]*https:\/\/tavya\.test\/settings/);

        await notify(notice('resolved'));
        expect((await f.store.listInbox('owner-1', f.organizationId))).toHaveLength(0);
        expect(sent).toHaveLength(2);
      });
    });

  describe('storage page', () => {
    it('groups what an organization stores by project and lets an owner clear history', async () => {
      const f = (await fixture());
      const data = (await f.attachment('data'));
      (await f.resources.importFiles(data.id, [{ path: 'a.bin', data: Buffer.alloc(300, 1) }]));
      (await f.resources.importFiles(data.id, [{ path: 'a.bin', data: Buffer.alloc(200, 2) }]));
      const done = (await f.task('done', Date.now()));
      (await f.worldCheckpoint(done.id, Date.now()));

      const view = (await f.service.contents(f.organizationId));
      expect(view.projects).toEqual([expect.objectContaining({ projectId: f.project.id, name: 'Data', bytes: 600,
        resources: [{ id: data.id, name: 'data', currentBytes: 200, olderVersions: 1, olderBytes: 300, taskCopies: 0, taskCopyBytes: 0 }],
        checkpoints: { count: 1, bytes: 100, finishedCount: 1, finishedBytes: 100 } })]);
      expect(view.policy).toEqual({ finishedTaskCheckpointDays: 30, overQuotaDeletionDays: 365 });

      expect((await f.service.deleteOlderVersions(data.id))).toEqual({ deleted: 1, bytes: 300 });
      expect((await f.service.deleteFinishedWorkspaces(f.organizationId, f.project.id))).toEqual({ queued: 1 });
      const after = (await f.service.contents(f.organizationId));
      expect(after.projects[0]).toMatchObject({ bytes: 200, checkpoints: { count: 0 } });
    });
  });
});
