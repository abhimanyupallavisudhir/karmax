import { afterEach, describe, expect, it } from 'vitest';
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
import { resticRef } from '../src/world/restic-engine.js';
import { ensureIdentity, git, gitOrThrow } from '../src/world/git.js';
import type { World } from '../src/world/types.js';

// pramana#3 (2026-10-07): sub-tasks W2 (OCR) and W7 (translations, $510 of
// model calls) each forked `raw_data` and added their own files. Whichever
// published second was refused ("resource baseline changed"), its workflow
// failed, and its output was left in its kept world: raw-data saves could
// not be combined, and the parent never received them.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function fixture(initial: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-resource-merge-'));
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
    name: 'raw_data', driver: 'volume@1', target: { kind: 'path', path: 'resources/raw_data' }, access: 'write',
    isolation: 'fork', source: {}, credentialHandles: [], publish: 'review' });
  const first = await resources.importFiles(data.id, Object.entries(initial).map(([file, text]) => ({ path: file, data: Buffer.from(text) })));
  const opened: World[] = [];
  cleanups.push(async () => {
    for (const world of opened) { await resources.release(world.handle).catch(() => undefined); await world.destroy().catch(() => undefined); }
    await store.close(); fs.rmSync(dir, { recursive: true, force: true });
  });

  const task = async (title: string, revisions: Record<string, string> = {}) => {
    const record = await store.createTask({ projectId: project.id, title, workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: title } });
    return { task: record, world: await worldFor(record.id, revisions) };
  };
  const worldFor = async (taskId: string, revisions: Record<string, string> = {}, generation = 1) => {
    const world = await worlds.create('worktree', { taskId, repo, base: 'main' });
    world.handle = await resources.materialize(project.id, taskId, world, generation, revisions);
    world.handle = (await store.registerWorld(world.handle, project.id)) as typeof world.handle;
    opened.push(world);
    return world;
  };
  const write = async (world: World, file: string, text: string) => {
    const full = path.join(world.handle.root, 'resources/raw_data', file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  };
  const remove = (world: World, file: string) => fs.rmSync(path.join(world.handle.root, 'resources/raw_data', file), { recursive: true });
  /** A directory's files and contents. */
  const tree = (root: string) => {
    const out: Record<string, string> = {};
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else out[path.relative(root, full)] = fs.readFileSync(full, 'utf8');
      }
    };
    walk(root);
    return out;
  };
  const inWorld = (world: World) => tree(path.join(world.handle.root, 'resources/raw_data'));
  const current = async () => (await store.getResourceRevision((await store.getResourceAttachment(data.id))!.currentRevisionId!))!;
  /** What the project's current version holds, as a new task would see it. */
  const published = async () => inWorld((await task('Reader')).world);
  const publish = async (taskId: string, review: string) => {
    await resources.beginReview(taskId, review);
    await resources.settleReview(taskId);
  };
  const lease = async (world: World) => (await store.listResourceLeases(world.handle.id, world.handle.generation ?? 1))
    .find((candidate) => candidate.attachmentId === data.id && candidate.state === 'active')!;
  return { store, resources, data, first, task, worldFor, write, remove, inWorld, current, published, publish, lease };
}

describe('combining publications of one resource', () => {
  it('merges sibling sub-tasks\' outputs, file by file, into one version and into the later world', async () => {
    const f = await fixture({ 'index.txt': 'v1', 'old/x.txt': 'x', 'old/y.txt': 'y' });
    const ocr = await f.task('W2 OCR');
    const translations = await f.task('W7 translations');

    await f.write(ocr.world, 'ocr/page-1.txt', 'ocr 1');
    await f.write(ocr.world, 'index.txt', 'v2');
    f.remove(ocr.world, 'old');
    // Names restic's include patterns would otherwise read as globs, variables or trimmed space.
    const awkward = 'translations/p [1]*?$HOME \\ .txt ';
    await f.write(translations.world, awkward, 'odd');
    await f.write(translations.world, 'translations/page-1.txt', 'translated 1');
    await f.write(translations.world, 'index.txt', 'v2'); // the same edit on both sides is no conflict

    await f.publish(ocr.task.id, 'w2');
    const afterOcr = await f.current();
    await f.publish(translations.task.id, 'w7');
    const combined = await f.current();

    expect(combined.parentRevisionId).toBe(afterOcr.id);
    expect(combined.createdByTaskId).toBe(translations.task.id);
    const expected = { 'index.txt': 'v2', 'ocr/page-1.txt': 'ocr 1', 'translations/page-1.txt': 'translated 1', [awkward]: 'odd' };
    expect(await f.published()).toEqual(expected);
    // The later world now holds what it published, removed directory included.
    expect(f.inWorld(translations.world)).toEqual(expected);
    expect(fs.existsSync(path.join(translations.world.handle.root, 'resources/raw_data/old'))).toBe(false);
  }, 180_000);

  it('refuses a file both changed differently, naming it and touching nothing', async () => {
    const f = await fixture({ 'index.txt': 'v1', 'keep.txt': 'k' });
    const one = await f.task('One');
    const two = await f.task('Two');
    await f.write(one.world, 'index.txt', 'one');
    await f.write(one.world, 'from-one.txt', '1');
    await f.write(two.world, 'index.txt', 'two');
    await f.write(two.world, 'from-two.txt', '2');
    f.remove(two.world, 'keep.txt');
    await f.write(one.world, 'keep.txt', 'edited'); // deleted on one side, edited on the other
    await f.publish(one.task.id, 'one');
    const head = await f.current();

    const refused = await f.publish(two.task.id, 'two').then(() => undefined, (error) => error);
    expect(refused).toBeInstanceOf(ResourceConflictError);
    expect((refused as ResourceConflictError).paths.sort()).toEqual(['index.txt', 'keep.txt']);
    expect((refused as Error).message).toMatch(/2 files were changed both by this task and in a newer published version/);
    expect((await f.current()).id).toBe(head.id);
    expect(f.inWorld(two.world)).toEqual({ 'index.txt': 'two', 'from-two.txt': '2' });

    // Keeping one version resolves it.
    await f.write(two.world, 'index.txt', 'one');
    await f.write(two.world, 'keep.txt', 'edited');
    await f.publish(two.task.id, 'two-again');
    expect(await f.published()).toEqual({ 'index.txt': 'one', 'keep.txt': 'edited', 'from-one.txt': '1', 'from-two.txt': '2' });
  }, 180_000);

  it('publishes a copy restored from a park, which starts from a checkpoint capture', async () => {
    const f = await fixture({ 'index.txt': 'v1' });
    const worker = await f.task('Worker');
    await f.write(worker.world, 'out/a.txt', 'a');
    // The task parks; its world is restored later from that checkpoint.
    const parked = await f.resources.checkpoint(worker.world.handle);
    await f.resources.release(worker.world.handle);
    await worker.world.destroy();
    const restored = await f.worldFor(worker.task.id, Object.fromEntries(parked.map((ref) => [ref.attachmentId, ref.revisionId])), 2);
    expect((await f.store.getResourceRevision((await f.lease(restored)).revisionId!))?.metadata?.checkpoint).toBe(true);
    expect(f.inWorld(restored)).toEqual({ 'index.txt': 'v1', 'out/a.txt': 'a' });
    // Meanwhile another task published.
    const other = await f.task('Other');
    await f.write(other.world, 'out/b.txt', 'b');
    await f.publish(other.task.id, 'other');

    await f.publish(worker.task.id, 'worker');
    expect(await f.published()).toEqual({ 'index.txt': 'v1', 'out/a.txt': 'a', 'out/b.txt': 'b' });
  }, 180_000);

  it('brings what sub-tasks published into the parent\'s world, keeping the parent\'s own work', async () => {
    const f = await fixture({ 'index.txt': 'v1' });
    const parent = await f.task('Parent');
    await f.write(parent.world, 'parent/notes.txt', 'mine');
    expect(await f.resources.refreshForks(parent.task.id)).toEqual([]);

    const child = await f.task('Child');
    await f.write(child.world, 'child/out.txt', 'from child');
    await f.write(child.world, 'index.txt', 'v2');
    await f.publish(child.task.id, 'child');
    const childVersion = await f.current();

    const refreshed = await f.resources.refreshForks(parent.task.id);
    expect(refreshed).toEqual([{ attachmentId: f.data.id, name: 'raw_data', path: 'resources/raw_data',
      revisionId: childVersion.id, added: 1, modified: 1, deleted: 0 }]);
    expect(f.inWorld(parent.world)).toEqual({ 'index.txt': 'v2', 'child/out.txt': 'from child', 'parent/notes.txt': 'mine' });
    expect((await f.lease(parent.world)).revisionId).toBe(childVersion.id);
    // Up to date: nothing more to do.
    expect(await f.resources.refreshForks(parent.task.id)).toEqual([]);
    // Review shows, and Confirm publishes, only the parent's own change.
    expect(await f.resources.summarize(parent.task.id, f.data.id)).toMatchObject({ added: 1, modified: 0, deleted: 0 });
    await f.publish(parent.task.id, 'parent');
    expect((await f.current()).parentRevisionId).toBe(childVersion.id);
    expect(await f.published()).toEqual({ 'index.txt': 'v2', 'child/out.txt': 'from child', 'parent/notes.txt': 'mine' });

    // A conflict leaves the parent's copy and baseline as they were, and says which files.
    const second = await f.task('Second child');
    await f.write(second.world, 'parent/notes.txt', 'theirs');
    await f.publish(second.task.id, 'second');
    await f.write(parent.world, 'parent/notes.txt', 'mine, edited');
    const baseline = (await f.lease(parent.world)).revisionId;
    const [conflicted] = await f.resources.refreshForks(parent.task.id);
    expect(conflicted).toMatchObject({ name: 'raw_data', conflicts: ['parent/notes.txt'] });
    expect(f.inWorld(parent.world)['parent/notes.txt']).toBe('mine, edited');
    expect((await f.lease(parent.world)).revisionId).toBe(baseline);
    expect(resticRef(await f.current()).snapshot).toBeTruthy();
  }, 240_000);
});
