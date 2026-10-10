import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { ObjectSnapshotEngine, ProjectResourceService, ResourceConflictError } from '../src/world/resources.js';
import { storedRef } from '../src/world/restic-engine.js';
import { ensureIdentity, git, gitOrThrow } from '../src/world/git.js';
import type { World } from '../src/world/types.js';
import type { ResourceRevision } from '../src/domain/types.js';

// pramana#3 (2026-10): `raw_data` is 10.5 GB of per-source folders, and every
// world restored all of it. Ten sub-tasks filled their disks. An on-demand
// resource gives a world its listing; the agent fetches the folders it needs
// with `tavya-data`. Hardest invariant: a folder a world never fetched, or
// dropped again, is never published as deleted (pramana nearly published its
// paid OCR output as deleted).

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const RESOURCE = 'resources/raw_data';

async function fixture(initial: Record<string, string>, options: { onDemand?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-on-demand-'));
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  await gitOrThrow(repo, ['init', '-q', '-b', 'main']); await ensureIdentity(repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'resources/\n');
  await git(repo, ['add', '-A']); await gitOrThrow(repo, ['commit', '-q', '-m', 'init']);
  const store = await Store.create(':memory:');
  const project = await store.createProject('Corpus', { repos: [repo] });
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  const worlds = new WorldRegistry();
  worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
  const resources = new ProjectResourceService(store, worlds,
    new ObjectSnapshotEngine(new LocalObjectStore(path.join(dir, 'objects')), broker), broker);
  const data = await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
    name: 'raw_data', driver: 'volume@1', target: { kind: 'path', path: RESOURCE }, access: 'write',
    isolation: 'fork', source: {}, credentialHandles: [], publish: 'review', onDemand: options.onDemand ?? true });
  const first = await resources.importFiles(data.id, Object.entries(initial).map(([file, text]) => ({ path: file, data: Buffer.from(text) })));
  const opened: World[] = [];
  cleanups.push(async () => {
    for (const world of opened) {
      await resources.release(world.handle).catch(() => undefined);
      spawnSync('chmod', ['-R', 'u+w', world.handle.root]);
      await world.destroy().catch(() => undefined);
    }
    await store.close(); fs.rmSync(dir, { recursive: true, force: true });
  });

  const worldFor = async (taskId: string, revisions: Record<string, string> = {}, generation = 1) => {
    const world = await worlds.create('worktree', { taskId, repo, base: 'main' });
    world.handle = await resources.materialize(project.id, taskId, world, generation, revisions);
    world.handle = (await store.registerWorld(world.handle, project.id)) as typeof world.handle;
    opened.push(world);
    return world;
  };
  const task = async (title: string, revisions: Record<string, string> = {}, parentTaskId?: string) => {
    const record = await store.createTask({ projectId: project.id, title, workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: title }, ...(parentTaskId ? { parentTaskId } : {}) });
    return { task: record, world: await worldFor(record.id, revisions) };
  };
  const subTask = async (title: string, parent: { task: { id: string }; world: World }) =>
    task(title, await resources.snapshotForks(parent.world.handle), parent.task.id);
  const at = (world: World, file = '') => path.join(world.handle.root, RESOURCE, file);
  const write = (world: World, file: string, text: string) => {
    fs.mkdirSync(path.dirname(at(world, file)), { recursive: true });
    fs.writeFileSync(at(world, file), text);
  };
  const remove = (world: World, file: string) => fs.rmSync(at(world, file), { recursive: true });
  const inWorld = (world: World) => {
    const out: Record<string, string> = {};
    const walk = (current: string) => {
      if (!fs.existsSync(current)) return;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full); else out[path.relative(at(world), full)] = fs.readFileSync(full, 'utf8');
      }
    };
    walk(at(world));
    return out;
  };
  /** `tavya-data` as the agent runs it, from the working directory. */
  // Not spawnSync: its restic reaches the repository server in this very process.
  const tool = (world: World, ...args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(path.join(world.handle.root, '.karmax-injection/bin/tavya-data'), args, { cwd: world.handle.root });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  const current = async () => (await store.getResourceRevision((await store.getResourceAttachment(data.id))!.currentRevisionId!))!;
  /** Every file of a version and its SHA-256, read back from storage. */
  const version = async (revision: ResourceRevision) => {
    const verified = await resources.verifyRevision(project.id, data.id, revision.id, 0, 1000);
    expect(verified.status).toBe('complete');
    return Object.fromEntries(verified.files.map((file) => [file.path, file.sha256]));
  };
  const hashed = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).map(([file, text]) => [file, sha(text)]));
  const publish = async (taskId: string, review: string, keepOwn = false) => {
    await resources.beginReview(taskId, review);
    await resources.settleReview(taskId, { keepOwn });
  };
  const lease = async (world: World) => (await store.listResourceLeases(world.handle.id, world.handle.generation ?? 1))
    .find((candidate) => candidate.attachmentId === data.id && candidate.state === 'active')!;
  const parts = (revision: ResourceRevision) => storedRef(revision).parts!;
  return { store, resources, project, data, first, task, subTask, worldFor, write, remove, inWorld, tool, current, version,
    hashed, publish, lease, parts, at };
}

const CORPUS = { 'gretil/a.txt': 'gretil a', 'gretil/b.txt': 'gretil b', 'ocr/page-1.txt': 'paid ocr 1', 'ocr/page-2.txt': 'paid ocr 2',
  'mt/x.txt': 'mt x', 'README.md': 'readme' };

describe('on-demand resources', () => {
  it('saves a version as one snapshot per top-level folder, and gives a world its listing but none of its bytes', async () => {
    const f = await fixture(CORPUS);
    expect(Object.keys(f.parts(f.first)).sort()).toEqual(['.', 'gretil', 'mt', 'ocr']);
    expect(f.parts(f.first).ocr).toMatchObject({ files: 2, bytes: 20 });
    expect(f.first).toMatchObject({ files: 6, bytes: 46 });

    const { task, world } = await f.task('Reader');
    expect(f.inWorld(world)).toEqual({});
    expect((world.handle.meta?.resourceProjections as Record<string, unknown>)[f.data.id]).toMatchObject({ onDemand: true });
    const listed = await f.tool(world, 'ls');
    expect(listed.code).toBe(0);
    expect(listed.stdout).toMatch(/resources\/raw_data {2}46 B in 4 parts, 0 B on this disk/);
    expect(listed.stdout).toMatch(/ocr\/\s+20 B\s+2 files\n/);
    expect((await f.tool(world, 'ls', `${RESOURCE}/ocr`)).stdout).toMatch(/page-1\.txt\s+10 B/);

    const got = await f.tool(world, 'get', `${RESOURCE}/ocr`);
    expect(got.stderr).toBe('');
    expect(f.inWorld(world)).toEqual({ 'ocr/page-1.txt': 'paid ocr 1', 'ocr/page-2.txt': 'paid ocr 2' });
    expect((await f.tool(world, 'ls')).stdout).toMatch(/ocr\/\s+20 B\s+2 files {2}here/);
    expect(await f.tool(world, 'get', `${RESOURCE}/ocr/page-1.txt`)).toMatchObject({ code: 2, stderr: expect.stringMatching(/whole top-level folders: get resources\/raw_data\/ocr/) });
    await f.tool(world, 'get', `${RESOURCE}/.`);
    expect(f.inWorld(world)['README.md']).toBe('readme');
    // Nothing to publish: what it read is unchanged, and what it never fetched is not deleted.
    expect(await f.resources.summarize(task.id, f.data.id)).toMatchObject({ added: 0, modified: 0, deleted: 0 });
  }, 180_000);

  it('never publishes a part the world did not fetch, or dropped, as deleted; deleting fetched files does delete them', async () => {
    const f = await fixture(CORPUS);
    const before = await f.version(f.first);
    const { task, world } = await f.task('Translator');
    await f.tool(world, 'get', `${RESOURCE}/mt`, `${RESOURCE}/gretil`);
    f.write(world, 'mt/y.txt', 'mt y');
    f.write(world, 'mt/x.txt', 'mt x, revised');
    f.remove(world, 'gretil/b.txt'); // an explicit deletion of a fetched file
    f.write(world, 'translations/t.txt', 'new folder');
    expect(await f.resources.summarize(task.id, f.data.id)).toMatchObject({ added: 2, modified: 1, deleted: 1 });

    await f.publish(task.id, 'translator');
    const published = await f.current();
    expect(published.parentRevisionId).toBe(f.first.id);
    const after = await f.version(published);
    // The parts it never fetched are the same snapshots, byte for byte.
    expect(f.parts(published).ocr).toEqual(f.parts(f.first).ocr);
    expect(f.parts(published)['.']).toEqual(f.parts(f.first)['.']);
    const expected: Record<string, string> = { ...before, 'mt/x.txt': sha('mt x, revised'), 'mt/y.txt': sha('mt y'), 'translations/t.txt': sha('new folder') };
    delete expected['gretil/b.txt'];
    expect(after).toEqual(expected);
    expect(after['ocr/page-1.txt']).toBe(sha('paid ocr 1'));
  }, 180_000);

  it('keeps a dropped part, and refuses to drop unsaved changes unless discarded', async () => {
    const f = await fixture(CORPUS);
    const { task, world } = await f.task('Worker');
    await f.tool(world, 'get', `${RESOURCE}/ocr`, `${RESOURCE}/gretil`);
    f.write(world, 'ocr/page-3.txt', 'ocr 3');
    const refused = await f.tool(world, 'drop', `${RESOURCE}/ocr`);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toMatch(/changes that are not saved yet \(ocr\/page-3\.txt \(new\)\)/);
    expect((await f.tool(world, 'drop', `${RESOURCE}/gretil`)).stdout).toMatch(/dropped resources\/raw_data\/gretil: 16 B freed; it is still in the project/);
    expect(fs.existsSync(f.at(world, 'gretil'))).toBe(false);
    // A park saves the change; then the part can go.
    await f.resources.checkpoint(world.handle);
    expect((await f.tool(world, 'drop', `${RESOURCE}/ocr`)).code).toBe(0);
    expect(f.inWorld(world)).toEqual({});
    await f.publish(task.id, 'worker');
    expect(await f.version(await f.current())).toEqual(f.hashed({ ...CORPUS, 'ocr/page-3.txt': 'ocr 3' }));
  }, 180_000);

  it('keeps what a park saved and what the world held through a restore from it', async () => {
    const f = await fixture(CORPUS);
    const { task, world } = await f.task('Worker');
    await f.tool(world, 'get', `${RESOURCE}/ocr`);
    f.write(world, 'ocr/page-1.txt', 'corrected');
    const [parked] = await f.resources.checkpoint(world.handle);
    const capture = (await f.store.getResourceRevision(parked!.revisionId))!;
    expect(capture.metadata?.checkpoint).toBe(true);
    expect(f.parts(capture).gretil).toEqual(f.parts(f.first).gretil);
    expect(f.parts(capture).ocr!.snapshot).not.toBe(f.parts(f.first).ocr!.snapshot);
    // Parked again with nothing changed: the same capture.
    expect((await f.resources.checkpoint(world.handle))[0]!.revisionId).toBe(capture.id);
    await f.resources.release(world.handle);
    await world.destroy();

    const restored = await f.worldFor(task.id, { [f.data.id]: capture.id }, 2);
    expect(f.inWorld(restored)).toEqual({ 'ocr/page-1.txt': 'corrected', 'ocr/page-2.txt': 'paid ocr 2' });
    expect((await f.tool(restored, 'ls')).stdout).toMatch(/ocr\/\s+\d+ B\s+2 files {2}here/);
    expect(await f.resources.summarize(task.id, f.data.id)).toMatchObject({ added: 0, modified: 1, deleted: 0 });
    await f.publish(task.id, 'worker');
    expect(await f.version(await f.current())).toEqual(f.hashed({ ...CORPUS, 'ocr/page-1.txt': 'corrected' }));
  }, 180_000);

  it('adds files written into a part the world never fetched to that part, deleting nothing', async () => {
    const f = await fixture(CORPUS);
    const { task, world } = await f.task('Careless');
    // A script writes into raw_data/ocr without fetching it first.
    f.write(world, 'ocr/page-9.txt', 'ocr 9');
    f.write(world, 'ocr/page-2.txt', 'overwritten without fetching');
    f.write(world, 'NOTES.md', 'a top-level file');
    expect(await f.resources.summarize(task.id, f.data.id)).toMatchObject({ added: 2, modified: 1, deleted: 0 });
    // The world now holds those parts whole.
    expect(f.inWorld(world)).toMatchObject({ 'ocr/page-1.txt': 'paid ocr 1', 'README.md': 'readme' });
    await f.publish(task.id, 'careless');
    expect(await f.version(await f.current())).toEqual(f.hashed({ ...CORPUS, 'ocr/page-9.txt': 'ocr 9',
      'ocr/page-2.txt': 'overwritten without fetching', 'NOTES.md': 'a top-level file' }));
  }, 180_000);

  it('combines publications part by part: an unfetched part takes the newer snapshot, a shared one merges file by file', async () => {
    const f = await fixture(CORPUS);
    const ocr = await f.task('OCR');
    const mt = await f.task('MT');
    await f.tool(ocr.world, 'get', `${RESOURCE}/ocr`, `${RESOURCE}/mt`);
    f.write(ocr.world, 'ocr/page-3.txt', 'ocr 3');
    f.write(ocr.world, 'mt/from-ocr.txt', 'ocr side');
    await f.tool(mt.world, 'get', `${RESOURCE}/mt`);
    f.write(mt.world, 'mt/z.txt', 'mt z');
    await f.publish(ocr.task.id, 'ocr');
    const afterOcr = await f.current();
    // The MT world saves its copy, then drops mt: merging needs it again and fetches it.
    await f.resources.checkpoint(mt.world.handle);
    expect((await f.tool(mt.world, 'drop', `${RESOURCE}/mt`)).code).toBe(0);
    await f.publish(mt.task.id, 'mt');
    const combined = await f.current();
    expect(combined.parentRevisionId).toBe(afterOcr.id);
    expect(f.parts(combined).ocr).toEqual(f.parts(afterOcr).ocr);
    expect(await f.version(combined)).toEqual(f.hashed({ ...CORPUS, 'ocr/page-3.txt': 'ocr 3', 'mt/from-ocr.txt': 'ocr side', 'mt/z.txt': 'mt z' }));
    // The later world never fetched ocr, so it holds none of it; it does hold the merged mt.
    expect(fs.existsSync(f.at(mt.world, 'ocr'))).toBe(false);
    expect(f.inWorld(mt.world)).toEqual({ 'mt/x.txt': 'mt x', 'mt/z.txt': 'mt z', 'mt/from-ocr.txt': 'ocr side' });
  }, 240_000);

  it('refuses a file both changed differently, and keeps this task\'s version when asked', async () => {
    const f = await fixture(CORPUS);
    const one = await f.task('One');
    const two = await f.task('Two');
    await f.tool(one.world, 'get', `${RESOURCE}/ocr`);
    await f.tool(two.world, 'get', `${RESOURCE}/ocr`);
    f.write(one.world, 'ocr/page-1.txt', 'one');
    f.write(two.world, 'ocr/page-1.txt', 'two');
    f.write(two.world, 'ocr/page-4.txt', 'two adds');
    await f.publish(one.task.id, 'one');
    const head = await f.current();
    const refused = await f.publish(two.task.id, 'two').then(() => undefined, (error) => error);
    expect(refused).toBeInstanceOf(ResourceConflictError);
    expect((refused as ResourceConflictError).paths).toEqual(['ocr/page-1.txt']);
    expect((await f.current()).id).toBe(head.id);
    await f.publish(two.task.id, 'two-keep', true);
    expect(await f.version(await f.current())).toEqual(f.hashed({ ...CORPUS, 'ocr/page-1.txt': 'two', 'ocr/page-4.txt': 'two adds' }));
  }, 240_000);

  it('hands a sub-task\'s changes to its parent part by part; the parent publishes everything once', async () => {
    const f = await fixture(CORPUS);
    const parent = await f.task('Integrator');
    await f.tool(parent.world, 'get', `${RESOURCE}/gretil`);
    f.write(parent.world, 'gretil/c.txt', 'parent');
    const child = await f.subTask('W2 OCR', parent);
    // A sub-task starts with nothing on its disk, whatever its parent held.
    expect(f.inWorld(child.world)).toEqual({});
    await f.tool(child.world, 'get', `${RESOURCE}/ocr`);
    f.write(child.world, 'ocr/page-5.txt', 'ocr 5');
    f.remove(child.world, 'ocr/page-2.txt');
    expect(await f.resources.summarize(child.task.id, f.data.id)).toMatchObject({ added: 1, modified: 0, deleted: 1 });
    await f.publish(child.task.id, 'w2');
    expect((await f.current()).id).toBe(f.first.id);

    const [taken] = await f.resources.takeDeliveries(parent.task.id);
    expect(taken).toMatchObject({ added: 1, modified: 0, deleted: 1 });
    expect(taken!.conflicts).toBeUndefined();
    // The parent never fetched ocr: it received the part's snapshot, no files.
    expect(fs.existsSync(f.at(parent.world, 'ocr'))).toBe(false);
    expect((await f.tool(parent.world, 'ls')).stdout).toMatch(/ocr\/\s+\d+ B\s+2 files\n/);
    await f.tool(parent.world, 'get', `${RESOURCE}/ocr`);
    expect(f.inWorld(parent.world)).toMatchObject({ 'ocr/page-5.txt': 'ocr 5', 'ocr/page-1.txt': 'paid ocr 1' });
    await f.tool(parent.world, 'drop', `${RESOURCE}/ocr`);

    await f.publish(parent.task.id, 'integrator');
    const expected: Record<string, string> = { ...CORPUS, 'gretil/c.txt': 'parent', 'ocr/page-5.txt': 'ocr 5' };
    delete expected['ocr/page-2.txt'];
    expect(await f.version(await f.current())).toEqual(f.hashed(expected));
  }, 240_000);

  it('splits a resource saved whole when it becomes on demand, keeping the version', async () => {
    const f = await fixture(CORPUS, { onDemand: false });
    expect(storedRef(f.first).snapshot).toBeTruthy();
    const before = await f.version(f.first);
    await f.store.updateResourceAttachment(f.data.id, { onDemand: true });
    const { world } = await f.task('Reader');
    expect(f.inWorld(world)).toEqual({});
    const split = (await f.store.getResourceRevision(f.first.id))!;
    expect(Object.keys(f.parts(split)).sort()).toEqual(['.', 'gretil', 'mt', 'ocr']);
    expect(await f.version(split)).toEqual(before);
  }, 180_000);

  it('keeps every part a version names through garbage collection, and forgets only parts no version shares', async () => {
    const f = await fixture(CORPUS);
    const { task, world } = await f.task('Worker');
    await f.tool(world, 'get', `${RESOURCE}/ocr`);
    f.write(world, 'ocr/page-1.txt', 'v2');
    await f.publish(task.id, 'worker');
    await f.resources.release(world.handle);
    const second = await f.current();
    const repository = f.data.id;
    const unreferenced = await f.store.unreferencedRepositorySnapshots(Date.now() + 1);
    const named = [...Object.values(f.parts(f.first)), ...Object.values(f.parts(second))].map((part) => part.snapshot);
    expect(unreferenced.filter((snapshot) => named.includes(snapshot.name))).toEqual([]);
    await f.resources.maintainRepositories(Date.now() + 25 * 3_600_000);
    // The first version goes; the parts it shares with the second stay.
    await f.resources.deleteRevision(f.first.id);
    const snapshots = new Set((await f.store.listRepositoryFiles(`${repository}@default`, 'snapshots')).map((file) => file.name));
    for (const part of Object.values(f.parts(second))) expect(snapshots.has(part.snapshot)).toBe(true);
    expect(snapshots.has(f.parts(f.first).ocr!.snapshot)).toBe(false);
    expect(await f.version(second)).toEqual(f.hashed({ ...CORPUS, 'ocr/page-1.txt': 'v2' }));
  }, 180_000);

  it('leaves resources that are not on demand exactly as before: whole snapshots, restored whole', async () => {
    const f = await fixture(CORPUS, { onDemand: false });
    const { task, world } = await f.task('Full');
    expect(f.inWorld(world)).toEqual(CORPUS);
    expect(fs.existsSync(path.join(world.handle.root, '.karmax-injection/bin/tavya-data'))).toBe(false);
    f.remove(world, 'ocr');
    await f.publish(task.id, 'full');
    const published = await f.current();
    expect(storedRef(published).snapshot).toBeTruthy();
    expect(storedRef(published).parts).toBeUndefined();
    expect(Object.keys(await f.version(published)).sort()).toEqual(['README.md', 'gretil/a.txt', 'gretil/b.txt', 'mt/x.txt']);
  }, 180_000);
});
