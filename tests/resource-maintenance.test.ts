import { afterEach, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ObjectSnapshotEngine, ProjectResourceService } from '../src/world/resources.js';
import { repositoryName } from '../src/world/resource-repository.js';
import { legacyRevision } from './helpers/legacy-resources.js';

const DAY = 24 * 3_600_000;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-resource-maintenance-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = await Store.create(':memory:');
  cleanups.push(() => store.close());
  const project = await store.createProject('Maintenance');
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  const objects = new LocalObjectStore(path.join(dir, 'objects'));
  const resources = new ProjectResourceService(store, new WorldRegistry(), new ObjectSnapshotEngine(objects, broker), broker);
  const attachment = await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
    name: 'Corpus', driver: 'volume@1', target: { kind: 'path', path: 'corpus' }, access: 'write', isolation: 'fork',
    source: {}, credentialHandles: [], publish: 'review' });
  const repository = repositoryName(attachment.id);
  const snapshots = async () => (await store.listRepositoryFiles(repository, 'snapshots')).map((file) => file.name);
  const packBytes = async () => (await store.listRepositoryFiles(repository, 'data')).reduce((sum, file) => sum + file.bytes, 0);
  const chunkFiles = () => {
    const chunks = path.join(dir, 'objects', 'resources', project.organizationId!, 'chunks');
    return fs.existsSync(chunks) ? fs.readdirSync(chunks).length : 0;
  };
  return { dir, store, project, broker, objects, resources, attachment, snapshots, packBytes, chunkFiles };
}

it('forgets a day-old snapshot no version names, keeps the rest, and prunes its data', async () => {
  const f = await fixture();
  const kept = await f.resources.importFiles(f.attachment.id, [{ path: 'a.bin', data: crypto.randomBytes(200_000) }]);
  // A save no revision records (its task was cancelled, or its candidate discarded).
  const source = fs.mkdtempSync(path.join(f.dir, 'orphan-'));
  fs.writeFileSync(path.join(source, 'b.bin'), crypto.randomBytes(300_000));
  const orphan = await f.resources.restic.backupDirectory(source, await f.resources.restic.current(f.attachment), { quota: false });
  expect(await f.snapshots()).toHaveLength(2);
  const before = await f.packBytes();

  // Under a day old it may still be a save in progress: left alone.
  expect(await f.resources.maintainRepositories(Date.now())).toMatchObject({ forgotten: 0 });
  expect(await f.snapshots()).toHaveLength(2);

  expect(await f.resources.maintainRepositories(Date.now() + 2 * DAY)).toMatchObject({ forgotten: 1, pruned: 1 });
  expect(await f.snapshots()).toEqual([kept.rootDigest]);
  expect(await f.snapshots()).not.toContain(orphan.snapshot);
  expect(await f.packBytes()).toBeLessThan(before - 250_000);
  expect((await f.resources.verifyRevision(f.project.id, f.attachment.id, kept.id)).status).toBe('complete');
  // Nothing left to do.
  expect(await f.resources.maintainRepositories(Date.now() + 2 * DAY)).toEqual({ forgotten: 0, pruned: 0, converted: 0 });
});

it('converts versions saved before restic in place, current first, and releases their chunks', async () => {
  const f = await fixture();
  const older = await legacyRevision(f.store, f.broker, f.objects, f.attachment,
    [{ path: 'pages/1.txt', data: Buffer.from('first page') }, { path: 'big.bin', data: crypto.randomBytes(5 * 1024 * 1024) }]);
  const current = await legacyRevision(f.store, f.broker, f.objects, f.attachment,
    [{ path: 'pages/1.txt', data: Buffer.from('first page, revised') }, { path: 'empty', data: Buffer.alloc(0) }],
    { parentRevisionId: older.id });
  await f.store.promoteResourceRevision(f.attachment.id, current.id, undefined);
  const expected = async (revisionId: string) =>
    (await f.resources.verifyRevision(f.project.id, f.attachment.id, revisionId, 0, 1000)).files;
  const before = { older: await expected(older.id), current: await expected(current.id) };
  expect(f.chunkFiles()).toBeGreaterThan(0);

  // A small budget converts the current version only.
  expect((await f.resources.maintainRepositories(Date.now(), { convertBytes: 1 })).converted).toBe(1);
  expect((await f.store.getResourceRevision(current.id))).toMatchObject({ id: current.id, engine: 'restic@1', parentRevisionId: older.id });
  expect((await f.store.getResourceRevision(older.id))?.engine).toBe('object-snapshot@1');

  expect((await f.resources.maintainRepositories(Date.now())).converted).toBe(1);
  for (const [revision, files] of [[older, before.older], [current, before.current]] as const) {
    expect(await f.store.getResourceRevision(revision.id)).toMatchObject({ engine: 'restic@1', bytes: revision.bytes, files: revision.files });
    expect(await expected(revision.id)).toEqual(files);
  }
  // Their old chunks and manifests are released.
  expect(f.chunkFiles()).toBe(0);
  expect(await f.store.legacyResourceRevisions(10)).toEqual([]);
  expect((await f.resources.maintainRepositories(Date.now())).converted).toBe(0);
});
