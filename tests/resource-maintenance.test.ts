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

  // A world saving or restoring a resource goes first: conversion waits for the next run.
  await f.store.kvSet('restic-job:world:save:0', JSON.stringify({ job: 'job-00000000', at: Date.now() }));
  expect((await f.resources.maintainRepositories(Date.now())).converted).toBe(0);
  // A record left by a save that died long ago does not hold it up.
  await f.store.kvSet('restic-job:world:save:0', JSON.stringify({ job: 'job-00000000', at: Date.now() - 7 * 3_600_000 }));

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

it('saves to one repository one at a time, so parallel saves of the same new data store it once', async () => {
  const f = await fixture();
  const repository = await f.resources.restic.current(f.attachment);
  const data = crypto.randomBytes(24 * 1024 * 1024);
  const sources = [0, 1].map((n) => {
    const source = fs.mkdtempSync(path.join(f.dir, `parallel-${n}-`));
    fs.writeFileSync(path.join(source, 'rebuilt.db'), data);
    return source;
  });
  // Two worlds that rebuilt the same file save at once: without taking turns,
  // each restic loads an index without the other's packs and uploads it all.
  const saves = await Promise.all(sources.map((source) => f.resources.restic.backupDirectory(source, repository, { quota: false })));
  expect(saves.map((save) => save.snapshot)).toHaveLength(2);
  expect(await f.packBytes()).toBeLessThan(data.length * 1.2);
});

it('a save waits for another save holding the repository, and takes over from one that stopped renewing', async () => {
  const f = await fixture();
  const repository = await f.resources.restic.current(f.attachment);
  await f.resources.restic.prepare(repository);
  const source = fs.mkdtempSync(path.join(f.dir, 'waiting-'));
  fs.writeFileSync(path.join(source, 'a.bin'), crypto.randomBytes(100_000));
  const lease = `restic-save:${repository.name}`;
  await f.store.kvSet(lease, JSON.stringify({ owner: 'another-save', at: Date.now() }));
  let done = false;
  const save = f.resources.restic.backupDirectory(source, repository, { quota: false }).then((capture) => { done = true; return capture; });
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(done).toBe(false);
  expect(await f.snapshots()).toEqual([]);
  // The other save finishes.
  await f.store.kvDelete(lease);
  await save;
  expect(await f.snapshots()).toHaveLength(1);
  // Released when done.
  expect(await f.store.kvGet(lease)).toBeUndefined();

  // A holder that died (no renewal for minutes) does not block saves for good.
  await f.store.kvSet(lease, JSON.stringify({ owner: 'dead-save', at: Date.now() - 10 * 60_000 }));
  fs.writeFileSync(path.join(source, 'b.bin'), crypto.randomBytes(100_000));
  await f.resources.restic.backupDirectory(source, repository, { quota: false });
  expect(await f.snapshots()).toHaveLength(2);
  expect(await f.store.kvGet(lease)).toBeUndefined();
});

// restic's locks (pramana, 2026-10-12…16: dozens of "repository is already
// locked … (restic exit 11)"). A save met the server's forget or prune and
// failed at once; a forget met a world's save and failed the park, hibernation
// or sub-task around it; and a lock its process died holding (a deploy, a
// sandbox gone) stays until `restic unlock`, which nothing ran.
async function locks(f: Awaited<ReturnType<typeof fixture>>) {
  const repository = await f.resources.restic.current(f.attachment);
  const recorded: Array<{ exclusive: boolean; row: Parameters<Store['recordRepositoryFile']>[0] }> = [];
  let exclusive = false;
  const record = f.store.recordRepositoryFile.bind(f.store);
  f.store.recordRepositoryFile = async (file) => {
    if (file.kind === 'locks') recorded.push({ exclusive, row: file });
    return record(file);
  };
  // One real lock of each kind, as restic wrote them.
  const source = fs.mkdtempSync(path.join(f.dir, 'locks-'));
  fs.writeFileSync(path.join(source, 'a.bin'), crypto.randomBytes(50_000));
  const orphan = await f.resources.restic.backupDirectory(source, repository, { quota: false });
  exclusive = true;
  await f.resources.restic.forget(repository, [orphan.snapshot]);
  f.store.recordRepositoryFile = record;
  const held = (kind: boolean) => recorded.find((lock) => lock.exclusive === kind)!.row;
  const place = async (kind: boolean, ageMs = 0) => {
    const row = held(kind);
    await f.store.recordRepositoryFile(row);
    if (ageMs) await (f.store as any).db.prepare('UPDATE resource_repository_files SET createdAt=? WHERE repository=? AND kind=? AND name=?')
      .run(Date.now() - ageMs, row.repository, 'locks', row.name);
    return () => f.store.deleteRepositoryFile(row.repository, 'locks', row.name);
  };
  const lockFiles = async () => (await f.store.listRepositoryFiles(repository.name, 'locks')).length;
  return { repository, place, lockFiles, source };
}

it('a save waits for an exclusive lock to be released instead of failing', async () => {
  const f = await fixture();
  await f.resources.importFiles(f.attachment.id, [{ path: 'a.bin', data: crypto.randomBytes(100_000) }]);
  const l = await locks(f);
  const release = await l.place(true);
  fs.writeFileSync(path.join(l.source, 'b.bin'), crypto.randomBytes(100_000));
  let done = false;
  const save = f.resources.restic.backupDirectory(l.source, l.repository, { quota: false }).then((capture) => { done = true; return capture; });
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(done).toBe(false);
  await release();
  expect((await save).snapshot).toMatch(/^[0-9a-f]{64}$/);
}, 120_000);

it('a lock its process stopped refreshing expires, as restic itself counts it stale', async () => {
  const f = await fixture();
  await f.resources.importFiles(f.attachment.id, [{ path: 'a.bin', data: crypto.randomBytes(100_000) }]);
  const l = await locks(f);
  // An exclusive lock 40 minutes old: its prune died with a deploy.
  await l.place(true, 40 * 60_000);
  fs.writeFileSync(path.join(l.source, 'b.bin'), crypto.randomBytes(100_000));
  const started = Date.now();
  await f.resources.restic.backupDirectory(l.source, l.repository, { quota: false });
  expect(Date.now() - started).toBeLessThan(15_000);
  expect(await l.lockFiles()).toBe(0);
  // A lock refreshed recently is a live process's: kept.
  await l.place(false, 20 * 60_000);
  await f.resources.restic.backupDirectory(l.source, l.repository, { quota: false });
  expect(await l.lockFiles()).toBe(1);
}, 120_000);

it('dropping a save’s leftover snapshot never fails the save: upkeep forgets it later', async () => {
  const f = await fixture();
  const data = crypto.randomBytes(100_000);
  const kept = await f.resources.importFiles(f.attachment.id, [{ path: 'a.bin', data }]);
  const l = await locks(f);
  // The same content saved again (a laptop's push of nothing new) while a
  // world's save holds the repository.
  const same = fs.mkdtempSync(path.join(f.dir, 'same-'));
  fs.writeFileSync(path.join(same, 'a.bin'), data);
  const again = await f.resources.restic.backupDirectory(same, l.repository, { quota: false });
  const release = await l.place(false);
  const adopted = await f.resources.adoptWorkspaceSnapshot(f.attachment.id, again.snapshot, kept.id, 'user:test')
    .then((result) => result, (error) => error);
  expect(adopted).toMatchObject({ unchanged: true });
  // Upkeep waits while the repository is busy with a save, then forgets it.
  await f.store.kvSet(`restic-save:${l.repository.name}`, JSON.stringify({ owner: 'a-world', at: Date.now() }));
  expect((await f.resources.maintainRepositories()).forgotten).toBe(0);
  await f.store.kvDelete(`restic-save:${l.repository.name}`);
  await release();
  expect(await f.snapshots()).toContain(again.snapshot);
  expect((await f.resources.maintainRepositories()).forgotten).toBe(1);
  expect(await f.snapshots()).not.toContain(again.snapshot);
  expect(await f.snapshots()).toContain(kept.rootDigest);
}, 120_000);
