import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
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

async function fixture(initial: Record<string, string | Buffer>) {
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
  const first = await resources.importFiles(data.id, Object.entries(initial).map(([file, text]) => ({ path: file, data: Buffer.isBuffer(text) ? text : Buffer.from(text) })));
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
  /** What a merge left for the world's agent. */
  const mergeFolder = (world: World) => path.join(world.handle.root, '.karmax-injection/resource-merge', data.id);
  return { store, resources, data, first, task, subTask, worldFor, write, remove, inWorld, current, published, publish, lease, mergeFolder };
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

  // pramana#3 (2026-10-09): 7,854 OCR pages were added both by the published
  // version and by the task, differently (two runs of the same LLM cleanup).
  // The only way out was to remove the task's copy, though its copy was the
  // one its database had been built from.
  it('publishes this task\'s version of files both changed when asked, and everything else merged as usual', async () => {
    const f = await fixture({ 'index.txt': 'v1', 'keep.txt': 'k' });
    const one = await f.task('One');
    const two = await f.task('Two');
    await f.write(one.world, 'pages/p1.txt', 'run one');
    await f.write(one.world, 'from-one.txt', '1');
    await f.write(two.world, 'pages/p1.txt', 'run two');
    await f.write(two.world, 'index.txt', 'v2');
    await f.publish(one.task.id, 'one');
    await expect(f.publish(two.task.id, 'two')).rejects.toBeInstanceOf(ResourceConflictError);

    await f.resources.beginReview(two.task.id, 'two-keep');
    await f.resources.settleReview(two.task.id, { keepOwn: true });
    const expected = { 'index.txt': 'v2', 'keep.txt': 'k', 'from-one.txt': '1', 'pages/p1.txt': 'run two' };
    expect(await f.published()).toEqual(expected);
    expect(f.inWorld(two.world)).toEqual(expected);
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

// pramana#56 (2026-10-16): two tasks forked raw_data; one published OCR
// verdicts, the other had rewritten the same verdicts file as a side effect.
// The second publication was refused, and its Retry re-saved 13 GB to be
// refused the same way: nothing combined the file or asked the agent to.
describe('combining files both sides changed', () => {
  const lines = (...values: string[]) => values.map((value) => `${value}\n`).join('');

  it('merges a text file both edited in different places, line by line', async () => {
    const f = await fixture({ 'notes.txt': lines('a', 'b', 'c', 'd', 'e') });
    const one = await f.task('One');
    const two = await f.task('Two');
    await f.write(one.world, 'notes.txt', lines('A', 'b', 'c', 'd', 'e'));
    await f.write(two.world, 'notes.txt', lines('a', 'b', 'c', 'd', 'E'));
    await f.write(two.world, 'two.txt', '2');
    await f.publish(one.task.id, 'one');
    await f.publish(two.task.id, 'two');
    const expected = { 'notes.txt': lines('A', 'b', 'c', 'd', 'E'), 'two.txt': '2' };
    expect(await f.published()).toEqual(expected);
    expect(f.inWorld(two.world)).toEqual(expected);
    expect(fs.existsSync(f.mergeFolder(two.world))).toBe(false);
  }, 180_000);

  it('combines lines both only appended to a log, the published ones first, gzipped too', async () => {
    const f = await fixture({ 'ledger.jsonl': lines('{"id":1}'), 'cache.jsonl.gz': zlib.gzipSync(lines('{"k":1}')) });
    const one = await f.task('One');
    const two = await f.task('Two');
    const gz = (world: World, text: string) => fs.writeFileSync(path.join(world.handle.root, 'resources/raw_data/cache.jsonl.gz'), zlib.gzipSync(text));
    await f.write(one.world, 'ledger.jsonl', lines('{"id":1}', '{"id":2}'));
    gz(one.world, lines('{"k":1}', '{"k":2}'));
    // Two repeats the line one appended, then adds its own: the repeat goes once.
    await f.write(two.world, 'ledger.jsonl', lines('{"id":1}', '{"id":2}', '{"id":3}'));
    gz(two.world, lines('{"k":1}', '{"k":3}'));
    await f.publish(one.task.id, 'one');
    await f.publish(two.task.id, 'two');
    const reader = (await f.task('Reader')).world;
    const root = path.join(reader.handle.root, 'resources/raw_data');
    expect(fs.readFileSync(path.join(root, 'ledger.jsonl'), 'utf8')).toBe(lines('{"id":1}', '{"id":2}', '{"id":3}'));
    expect(zlib.gunzipSync(fs.readFileSync(path.join(root, 'cache.jsonl.gz'))).toString()).toBe(lines('{"k":1}', '{"k":2}', '{"k":3}'));
  }, 180_000);

  it('hands what it cannot merge to the agent, both versions beside it, and publishes the agent\'s result', async () => {
    const f = await fixture({ 'index.txt': lines('v1'), 'keep.txt': 'k' });
    const one = await f.task('One');
    const two = await f.task('Two');
    await f.write(one.world, 'index.txt', lines('one'));
    await f.write(one.world, 'keep.txt', 'edited');
    await f.write(one.world, 'from-one.txt', '1');
    await f.write(two.world, 'index.txt', lines('two'));
    f.remove(two.world, 'keep.txt'); // deleted here, edited there
    await f.write(two.world, 'from-two.txt', '2');
    await f.publish(one.task.id, 'one');
    const head = await f.current();

    const refused = await f.publish(two.task.id, 'two').then(() => undefined, (error) => error) as ResourceConflictError;
    expect(refused).toBeInstanceOf(ResourceConflictError);
    expect(refused.paths.sort()).toEqual(['index.txt', 'keep.txt']);
    expect(refused.message).toBe('raw_data: 2 files were changed both by this task and in a newer published version (index.txt, keep.txt).');
    const folder = f.mergeFolder(two.world);
    expect(refused.guide).toContain('- index.txt (both edited it; the line merge conflicts)');
    expect(refused.guide).toContain('- keep.txt (this task deleted it, a newer published version changed it)');
    expect(refused.guide).toContain(`In ${folder}: base/ holds each file as both started`);
    expect(refused.guide).toContain(`remove its line from ${folder}/unresolved`);
    const read = (file: string) => fs.readFileSync(path.join(folder, file), 'utf8');
    expect([read('base/index.txt'), read('other/index.txt'), read('base/keep.txt'), read('other/keep.txt')])
      .toEqual([lines('v1'), lines('one'), 'k', 'edited']);
    expect(read('conflicts/index.txt')).toBe(lines('<<<<<<< this task', 'two', '||||||| started from', 'v1', '=======', 'one', '>>>>>>> published'));
    expect(read('unresolved').split('\n').filter(Boolean).sort()).toEqual(['index.txt', 'keep.txt']);
    // Nothing published, nothing in the resource touched.
    expect((await f.current()).id).toBe(head.id);
    expect(f.inWorld(two.world)).toEqual({ 'index.txt': lines('two'), 'from-two.txt': '2' });

    // The agent combines index.txt, takes the published keep.txt, and says so.
    await f.write(two.world, 'index.txt', lines('one', 'two'));
    fs.copyFileSync(path.join(folder, 'other/keep.txt'), path.join(two.world.handle.root, 'resources/raw_data/keep.txt'));
    fs.writeFileSync(path.join(folder, 'unresolved'), '');
    await f.publish(two.task.id, 'two-again');
    const expected = { 'index.txt': lines('one', 'two'), 'keep.txt': 'edited', 'from-one.txt': '1', 'from-two.txt': '2' };
    expect(await f.published()).toEqual(expected);
    expect(f.inWorld(two.world)).toEqual(expected);
    expect(fs.existsSync(folder)).toBe(false);
  }, 180_000);

  it('names files the disk has no room to copy, and leaves a script that fetches them', async () => {
    const f = await fixture({ 'index.txt': lines('v1') });
    const one = await f.task('One');
    const two = await f.task('Two');
    await f.write(one.world, 'index.txt', lines('one'));
    await f.write(two.world, 'index.txt', lines('two'));
    await f.publish(one.task.id, 'one');
    // A full disk: df reports 1 KiB available.
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-full-disk-'));
    fs.writeFileSync(path.join(bin, 'df'), '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted"\necho "full 100 99 1 99% /"\n', { mode: 0o755 });
    const PATH = process.env.PATH;
    process.env.PATH = `${bin}:${PATH}`;
    let refused: ResourceConflictError;
    try { refused = await f.publish(two.task.id, 'two').then(() => undefined, (error) => error) as ResourceConflictError; }
    finally { process.env.PATH = PATH; fs.rmSync(bin, { recursive: true, force: true }); }
    const folder = f.mergeFolder(two.world);
    expect(refused!.guide).toContain(`- index.txt (both edited it; 4 B, no room for copies: free space, then run ${folder}/fetch)`);
    expect(fs.existsSync(path.join(folder, 'other/index.txt'))).toBe(false);
    expect(fs.statSync(path.join(folder, 'fetch')).mode & 0o777).toBe(0o700);
    // Asynchronously: the repository server it reads from runs in this process.
    const fetched = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(path.join(folder, 'fetch'));
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (code) => resolve({ code, stderr }));
    });
    expect(fetched.code, fetched.stderr).toBe(0);
    expect(fs.readFileSync(path.join(folder, 'base/index.txt'), 'utf8')).toBe(lines('v1'));
    expect(fs.readFileSync(path.join(folder, 'other/index.txt'), 'utf8')).toBe(lines('one'));
  }, 180_000);

  it('keeps the agent\'s copy of a file it marked resolved, even one it left as it was', async () => {
    const f = await fixture({ 'index.txt': lines('v1') });
    const one = await f.task('One');
    const two = await f.task('Two');
    await f.write(one.world, 'index.txt', lines('one'));
    await f.write(two.world, 'index.txt', lines('two'));
    await f.publish(one.task.id, 'one');
    await expect(f.publish(two.task.id, 'two')).rejects.toBeInstanceOf(ResourceConflictError);
    // A file still listed stays a conflict.
    await expect(f.publish(two.task.id, 'two-unchanged')).rejects.toBeInstanceOf(ResourceConflictError);
    fs.writeFileSync(path.join(f.mergeFolder(two.world), 'unresolved'), '');
    await f.publish(two.task.id, 'two-kept');
    expect(await f.published()).toEqual({ 'index.txt': lines('two') });
  }, 180_000);

  it('does not apply a resolution made for an older published version', async () => {
    const f = await fixture({ 'index.txt': lines('v1') });
    const one = await f.task('One');
    const two = await f.task('Two');
    await f.write(one.world, 'index.txt', lines('one'));
    await f.write(two.world, 'index.txt', lines('two'));
    await f.publish(one.task.id, 'one');
    await expect(f.publish(two.task.id, 'two')).rejects.toBeInstanceOf(ResourceConflictError);
    fs.writeFileSync(path.join(f.mergeFolder(two.world), 'unresolved'), '');
    // Before two publishes again, three does, changing index.txt again.
    const three = await f.task('Three');
    await f.write(three.world, 'index.txt', lines('three'));
    await f.publish(three.task.id, 'three');
    const refused = await f.publish(two.task.id, 'two-again').then(() => undefined, (error) => error) as ResourceConflictError;
    expect(refused?.paths).toEqual(['index.txt']);
    expect(fs.readFileSync(path.join(f.mergeFolder(two.world), 'other/index.txt'), 'utf8')).toBe(lines('three'));
  }, 240_000);
});

// pramana: generated and binary files (compressed staged records, caches,
// SQLite side files) were merged line by line and conflicted on nearly every
// sub-task; the same conflict came back with each finished sub-task; and the
// merge folder was sometimes gone or replaced before the agent looked at it.
describe('files that need no merge, and conflicts told once', () => {
  const lines = (...values: string[]) => values.map((value) => `${value}\n`).join('');
  const setTime = (world: World, file: string, seconds: number) =>
    fs.utimesSync(path.join(world.handle.root, 'resources/raw_data', file), seconds, seconds);

  it('settles files its .tavyamerge names: theirs, mine, newest, and never saves skipped ones', async () => {
    const f = await fixture({ 'staged/a.zst': 'v1', 'notes.md': lines('v1'), 'cache/old.bin': 'v1', 'cache/new.bin': 'v1',
      '.tavyamerge': ['# generated', 'staged/*.zst theirs', 'notes.md mine', 'cache/ newest', '*.sqlite-shm skip'].join('\n') });
    const one = await f.task('One');
    const two = await f.task('Two');
    await f.write(one.world, 'staged/a.zst', '\u0000one');
    await f.write(one.world, 'notes.md', lines('one'));
    await f.write(one.world, 'cache/old.bin', 'one, older'); setTime(one.world, 'cache/old.bin', 1_000);
    await f.write(one.world, 'cache/new.bin', 'one, newer'); setTime(one.world, 'cache/new.bin', 3_000);
    await f.write(one.world, 'db.sqlite-shm', 'one');
    // Seconds apart, as real edits are: one kernel clock tick and one size
    // is the same file to a save (backupArgs).
    setTime(one.world, 'staged/a.zst', 1_000);
    await f.write(two.world, 'staged/a.zst', '\u0000two'); setTime(two.world, 'staged/a.zst', 2_000);
    await f.write(two.world, 'notes.md', lines('two'));
    await f.write(two.world, 'cache/old.bin', 'two, newer'); setTime(two.world, 'cache/old.bin', 2_000);
    await f.write(two.world, 'cache/new.bin', 'two, older'); setTime(two.world, 'cache/new.bin', 2_000);
    await f.write(two.world, 'db.sqlite-shm', 'two');
    await f.publish(one.task.id, 'one');
    await f.publish(two.task.id, 'two');
    const published = await f.published();
    expect(published).toMatchObject({ 'staged/a.zst': '\u0000one', 'notes.md': lines('two'), 'cache/old.bin': 'two, newer', 'cache/new.bin': 'one, newer' });
    expect(published['db.sqlite-shm']).toBeUndefined();
    // Two's own side file stays in its world, as it was.
    expect(f.inWorld(two.world)['db.sqlite-shm']).toBe('two');
  }, 240_000);

  it('keeps one conflict\'s folder while a second sub-task waits, tells each conflict once, and resolves in one step', async () => {
    const f = await fixture({ 'index.bin': '\u0000v1' });
    const parent = await f.task('Integrator');
    const first = await f.subTask('A2', parent);
    const second = await f.subTask('A3', parent);
    await f.write(first.world, 'index.bin', '\u0000first');
    await f.write(second.world, 'index.bin', '\u0000second');
    await f.write(parent.world, 'index.bin', '\u0000parent');
    await f.publish(first.task.id, 'a2');
    await f.publish(second.task.id, 'a3');

    const taken = await f.resources.takeDeliveries(parent.task.id);
    // The first conflicts; the second waits behind it rather than replacing its folder.
    expect(taken).toHaveLength(1);
    expect(taken[0]).toMatchObject({ conflicts: ['index.bin'] });
    expect(taken[0]!.again).toBeUndefined();
    expect(taken[0]!.guide).toContain('/resolve theirs [file…]');
    expect(taken[0]!.guide).toContain('.tavyamerge');
    const folder = f.mergeFolder(parent.world);
    const theirs = fs.readFileSync(path.join(folder, 'other/index.bin'), 'utf8');
    expect(['\u0000first', '\u0000second']).toContain(theirs);
    // Nothing changed: the next pass says nothing new.
    const again = await f.resources.takeDeliveries(parent.task.id);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ again: true, conflicts: ['index.bin'] });
    expect(fs.readFileSync(path.join(folder, 'other/index.bin'), 'utf8')).toBe(theirs);

    // One step: take the sub-task's version.
    const run = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(path.join(folder, 'resolve'), ['theirs']);
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { out += chunk; });
      child.on('close', (code) => resolve({ code, out }));
    });
    expect(run.code, run.out).toBe(0);
    expect(run.out).toContain('index.bin: theirs');
    expect(f.inWorld(parent.world)['index.bin']).toBe(theirs);
    // That delivery comes in; the other then conflicts with it, and is told.
    const next = await f.resources.takeDeliveries(parent.task.id);
    expect(next[0]!.conflicts).toBeUndefined();
    expect(next[1]).toMatchObject({ conflicts: ['index.bin'] });
    expect(next[1]!.again).toBeUndefined();
  }, 300_000);
});

// The same merge before Review, as a branch takes in its target before its
// pull request: Review then shows the copy as it would be published.
describe('merging newer published versions in before Review', () => {
  const lines = (...values: string[]) => values.map((value) => `${value}\n`).join('');

  async function twoTasks() {
    const f = await fixture({ 'notes.txt': lines('a', 'b', 'c', 'd', 'e') });
    const one = await f.task('One');
    const two = await f.task('Two');
    await f.write(one.world, 'notes.txt', lines('A', 'b', 'c', 'd', 'e'));
    await f.write(one.world, 'from-one.txt', '1');
    await f.write(two.world, 'notes.txt', lines('a', 'b', 'c', 'd', 'E'));
    await f.write(two.world, 'from-two.txt', '2');
    await f.publish(one.task.id, 'one');
    return { f, one, two, afterOne: await f.current() };
  }
  const combined = { 'notes.txt': lines('A', 'b', 'c', 'd', 'E'), 'from-one.txt': '1', 'from-two.txt': '2' };

  it('merges it into the copy, whose Review then shows only its own changes, and publishes on top of it', async () => {
    const { f, two, afterOne } = await twoTasks();
    expect(await f.resources.integratePublished(two.task.id)).toEqual([expect.objectContaining({ name: 'raw_data',
      path: 'resources/raw_data', revisionId: afterOne.id, added: 1, modified: 0, deleted: 0 })]);
    expect(f.inWorld(two.world)).toEqual(combined);
    expect(await f.resources.summarize(two.task.id, f.data.id)).toMatchObject({ baseRevisionId: afterOne.id, added: 1, modified: 1, deleted: 0 });
    // Nothing newer: nothing to do.
    expect(await f.resources.integratePublished(two.task.id)).toEqual([]);
    await f.publish(two.task.id, 'two');
    expect(await f.current()).toMatchObject({ parentRevisionId: afterOne.id, createdByTaskId: two.task.id });
    expect(await f.published()).toEqual(combined);
  }, 180_000);

  it('still measures from the merged version after the world is parked and restored', async () => {
    const { f, two, afterOne } = await twoTasks();
    await f.resources.integratePublished(two.task.id);
    await f.write(two.world, 'after.txt', 'later');
    const parked = await f.resources.checkpoint(two.world.handle);
    await f.resources.release(two.world.handle);
    await two.world.destroy();
    const restored = await f.worldFor(two.task.id, Object.fromEntries(parked.map((ref) => [ref.attachmentId, ref.revisionId])), 2);
    expect(f.inWorld(restored)).toEqual({ ...combined, 'after.txt': 'later' });
    expect(await f.resources.summarize(two.task.id, f.data.id)).toMatchObject({ baseRevisionId: afterOne.id, added: 2, modified: 1, deleted: 0 });
    await f.publish(two.task.id, 'two');
    expect(await f.published()).toEqual({ ...combined, 'after.txt': 'later' });
  }, 180_000);

  it('reports a conflict for the agent and leaves the copy as it was, then merges once the agent has combined it', async () => {
    const f = await fixture({ 'index.txt': lines('v1') });
    const one = await f.task('One');
    const two = await f.task('Two');
    await f.write(one.world, 'index.txt', lines('one'));
    await f.write(one.world, 'from-one.txt', '1');
    await f.write(two.world, 'index.txt', lines('two'));
    await f.publish(one.task.id, 'one');
    const [report] = await f.resources.integratePublished(two.task.id);
    expect(report).toMatchObject({ name: 'raw_data', conflicts: ['index.txt'] });
    expect(report!.guide).toContain('- index.txt (both edited it; the line merge conflicts)');
    expect(f.inWorld(two.world)).toEqual({ 'index.txt': lines('two') });
    expect(await f.resources.summarize(two.task.id, f.data.id)).toMatchObject({ baseRevisionId: f.first.id });

    await f.write(two.world, 'index.txt', lines('one', 'two'));
    fs.writeFileSync(path.join(f.mergeFolder(two.world), 'unresolved'), '');
    const [merged] = await f.resources.integratePublished(two.task.id);
    expect(merged!.conflicts).toBeUndefined();
    expect(f.inWorld(two.world)).toEqual({ 'index.txt': lines('one', 'two'), 'from-one.txt': '1' });
    await f.publish(two.task.id, 'two');
    expect(await f.published()).toEqual({ 'index.txt': lines('one', 'two'), 'from-one.txt': '1' });
  }, 180_000);

  it('leaves a sub-task\'s copy of its parent\'s resource to the parent', async () => {
    const f = await fixture({ 'index.txt': lines('v1') });
    const parent = await f.task('Integrator');
    const child = await f.subTask('Worker', parent);
    const other = await f.task('Other');
    await f.write(other.world, 'other.txt', 'o');
    await f.publish(other.task.id, 'other');
    expect(await f.resources.integratePublished(child.task.id)).toEqual([]);
    expect(f.inWorld(child.world)).toEqual({ 'index.txt': lines('v1') });
  }, 180_000);
});
