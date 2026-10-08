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

  const task = async (title: string, revisions: Record<string, string> = {}, parentTaskId?: string) => {
    const record = await store.createTask({ projectId: project.id, title, workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: title }, ...(parentTaskId ? { parentTaskId } : {}) });
    return { task: record, world: await worldFor(record.id, revisions) };
  };
  /** A sub-task, started from its parent's copies as prepareChildTask starts it. */
  const subTask = async (title: string, parent: { task: { id: string }; world: World }) =>
    task(title, await resources.snapshotForks(parent.world.handle), parent.task.id);
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
  return { store, resources, data, first, task, subTask, worldFor, write, remove, inWorld, current, published, publish, lease };
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

  it('starts sub-tasks from the parent\'s copy and hands their output to it; the parent publishes once', async () => {
    const f = await fixture({ 'index.txt': 'v1' });
    const parent = await f.task('Integrator');
    await f.write(parent.world, 'parent/plan.txt', 'mine');
    const ocr = await f.subTask('W2 OCR', parent);
    const translations = await f.subTask('W7 translations', parent);
    // Each sees the parent's unpublished work, as it sees the parent's branch.
    expect(f.inWorld(ocr.world)).toEqual({ 'index.txt': 'v1', 'parent/plan.txt': 'mine' });

    await f.write(ocr.world, 'ocr/page-1.txt', 'ocr 1');
    await f.write(ocr.world, 'index.txt', 'v2');
    await f.write(translations.world, 'translations/page-1.txt', 'translated 1');
    await f.write(translations.world, 'index.txt', 'v2');
    await f.write(parent.world, 'parent/more.txt', 'meanwhile');
    // A sub-task's Review shows its own changes only.
    expect(await f.resources.summarize(ocr.task.id, f.data.id)).toMatchObject({ added: 1, modified: 1, deleted: 0 });
    await f.publish(ocr.task.id, 'w2');
    await f.publish(translations.task.id, 'w7');

    // Nothing reached the project: the parent's Review decides.
    expect((await f.current()).id).toBe(f.first.id);
    const kept = (await f.store.listResourceRevisions(f.data.id)).filter((revision) => revision.metadata?.deliveredTo === parent.task.id);
    expect(kept.map((revision) => revision.createdByTaskId).sort()).toEqual([ocr.task.id, translations.task.id].sort());

    const taken = await f.resources.takeDeliveries(parent.task.id);
    expect(taken.map(({ added, modified, deleted, conflicts }) => ({ added, modified, deleted, conflicts })))
      .toEqual([{ added: 1, modified: 1, deleted: 0, conflicts: undefined }, { added: 1, modified: 0, deleted: 0, conflicts: undefined }]);
    const combined = { 'index.txt': 'v2', 'ocr/page-1.txt': 'ocr 1', 'translations/page-1.txt': 'translated 1',
      'parent/plan.txt': 'mine', 'parent/more.txt': 'meanwhile' };
    expect(f.inWorld(parent.world)).toEqual(combined);
    expect(await f.resources.takeDeliveries(parent.task.id)).toEqual([]);

    await f.publish(parent.task.id, 'integrator');
    const published = await f.current();
    expect(published).toMatchObject({ parentRevisionId: f.first.id, createdByTaskId: parent.task.id });
    expect(await f.published()).toEqual(combined);
  }, 240_000);

  it('applies a delivery still waiting when the parent is confirmed', async () => {
    const f = await fixture({ 'index.txt': 'v1' });
    const parent = await f.task('Integrator');
    const child = await f.subTask('Worker', parent);
    await f.write(child.world, 'out.txt', 'from worker');
    await f.publish(child.task.id, 'worker');
    await f.publish(parent.task.id, 'integrator');
    expect(await f.published()).toEqual({ 'index.txt': 'v1', 'out.txt': 'from worker' });
  }, 180_000);

  it('hands a sub-task\'s proposed output to its parent, whose Review adopts it', async () => {
    const f = await fixture({ 'index.txt': 'v1' });
    const parent = await f.task('Integrator');
    const child = await f.subTask('Worker', parent);
    fs.mkdirSync(path.join(child.world.handle.root, 'translations'));
    fs.writeFileSync(path.join(child.world.handle.root, 'translations/a.txt'), 'translated');
    const { candidate, attachment } = await f.resources.proposePath(child.task.id,
      { path: 'translations', name: 'Translations', target: { kind: 'path', path: 'translations' } });
    await f.resources.stageCandidates(child.task.id, { final: true });
    await f.publish(child.task.id, 'worker');

    expect((await f.store.getResourceAttachment(attachment.id))?.enabled).toBe(false);
    expect((await f.store.getResourceCandidate(candidate.id))).toMatchObject({ state: 'pending', taskId: parent.task.id });
    const [taken] = await f.resources.takeDeliveries(parent.task.id);
    expect(taken).toMatchObject({ name: 'Translations', path: 'translations', added: 1 });
    expect(fs.readFileSync(path.join(parent.world.handle.root, 'translations/a.txt'), 'utf8')).toBe('translated');

    await f.resources.stageCandidates(parent.task.id, { final: true });
    await f.publish(parent.task.id, 'integrator');
    expect((await f.store.getResourceCandidate(candidate.id))?.state).toBe('adopted');
    expect((await f.store.getResourceAttachment(attachment.id))?.enabled).toBe(true);
  }, 180_000);

  it('keeps a delivery that conflicts with the parent\'s copy waiting, and blocks the parent\'s publication until resolved', async () => {
    const f = await fixture({ 'index.txt': 'v1' });
    const parent = await f.task('Integrator');
    const child = await f.subTask('Worker', parent);
    await f.write(child.world, 'index.txt', 'worker');
    await f.write(child.world, 'out.txt', 'from worker');
    await f.write(parent.world, 'index.txt', 'parent');
    await f.publish(child.task.id, 'worker');

    const [conflicted] = await f.resources.takeDeliveries(parent.task.id);
    expect(conflicted).toMatchObject({ name: 'raw_data', conflicts: ['index.txt'] });
    expect(f.inWorld(parent.world)).toEqual({ 'index.txt': 'parent' });
    await expect(f.publish(parent.task.id, 'integrator')).rejects.toThrow(/changed both by this task and in a sub-task \(index\.txt\)/);
    expect((await f.current()).id).toBe(f.first.id);

    await f.write(parent.world, 'index.txt', 'worker'); // keep the sub-task's version
    await f.publish(parent.task.id, 'integrator-again');
    expect(await f.published()).toEqual({ 'index.txt': 'worker', 'out.txt': 'from worker' });
  }, 180_000);

  it('builds a sub-task\'s second delivery on its first, so the parent\'s edits to it do not conflict', async () => {
    const f = await fixture({ 'index.txt': 'v1' });
    const parent = await f.task('Integrator');
    const child = await f.subTask('Worker', parent);
    await f.write(child.world, 'a.txt', 'draft');
    await f.publish(child.task.id, 'first');
    await f.resources.takeDeliveries(parent.task.id);
    await f.write(parent.world, 'a.txt', 'draft, corrected by the parent');
    // A follow-up: the worker adds more and is confirmed again.
    await f.write(child.world, 'b.txt', 'more');
    await f.publish(child.task.id, 'second');
    const [taken] = await f.resources.takeDeliveries(parent.task.id);
    expect(taken).toMatchObject({ added: 1, modified: 0, deleted: 0 });
    expect(taken!.conflicts).toBeUndefined();
    expect(f.inWorld(parent.world)).toEqual({ 'index.txt': 'v1', 'a.txt': 'draft, corrected by the parent', 'b.txt': 'more' });
  }, 180_000);

  it('publishes a sub-task straight to the project when its parent holds no copy', async () => {
    const f = await fixture({ 'index.txt': 'v1' });
    // A parent without a world (an orchestrating task, say) has nothing to receive output in.
    const parent = await f.store.createTask({ projectId: f.data.projectId, title: 'Planner', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'plan' } });
    const child = await f.task('Worker', {}, parent.id);
    await f.write(child.world, 'out.txt', 'from worker');
    await f.publish(child.task.id, 'worker');
    expect(await f.published()).toEqual({ 'index.txt': 'v1', 'out.txt': 'from worker' });
  }, 180_000);
});
