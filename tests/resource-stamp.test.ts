// A writable resource nobody touched is not saved again (src/world/resource-stamp.ts).
// Before: every task of a project with a writable resource re-saved it at
// Confirm ("Saving launch-video-final · 88 MB of 88 MB", ~10 s each on E2B),
// at every park, and at every look at Review, though nothing had changed.
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { ObjectSnapshotEngine, ProjectResourceService } from '../src/world/resources.js';
import { ensureIdentity, git, gitOrThrow } from '../src/world/git.js';
import { stampKey } from '../src/world/resource-stamp.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 30)); // past the kernel's file clock

async function setup(shape: 'directory' | 'file') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-resource-stamp-'));
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  await gitOrThrow(repo, ['init', '-q', '-b', 'main']); await ensureIdentity(repo);
  fs.writeFileSync(path.join(repo, 'app.txt'), 'app\n');
  await git(repo, ['add', '-A']); await gitOrThrow(repo, ['commit', '-q', '-m', 'init']);
  const store = await Store.create(':memory:');
  const project = await store.createProject('Videos', { repos: [repo] });
  const task = await store.createTask({ projectId: project.id, title: 'Unrelated work', workflow: 'software-dev',
    workflowVersion: '1.0.0', params: { prompt: 'fix a typo' } });
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  const worlds = new WorldRegistry();
  worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
  const resources = new ProjectResourceService(store, worlds,
    new ObjectSnapshotEngine(new LocalObjectStore(path.join(dir, 'objects')), broker), broker);
  const file = shape === 'file';
  const video = await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
    name: 'Launch video', driver: 'volume@1', target: { kind: 'path', path: file ? 'launch.mp4' : 'launch-video' },
    access: 'write', isolation: 'fork', source: file ? { shape: 'file' } : {}, credentialHandles: [], publish: 'review' });
  const initial = await resources.importFiles(video.id, file ? [{ path: 'launch.mp4', data: Buffer.from('frames-v1') }]
    : [{ path: 'launch.mp4', data: Buffer.from('frames-v1') }, { path: 'cuts/intro.mp4', data: Buffer.from('intro') }]);
  const world = await worlds.create('worktree', { taskId: task.id, repo, base: 'main' });
  world.handle = await resources.materialize(project.id, task.id, world, 1);
  world.handle = (await store.registerWorld(world.handle, project.id)) as typeof world.handle;
  const lease = (await store.listResourceLeases(world.handle.id, 1)).find((l) => l.attachmentId === video.id)!;
  const current = async () => (await store.getResourceAttachment(video.id))!.currentRevisionId;
  const cleanup = async () => {
    await resources.release(world.handle); await world.destroy();
    await store.close(); fs.rmSync(dir, { recursive: true, force: true });
  };
  return { store, task, resources, video, initial, world, lease, current, cleanup,
    videoPath: file ? 'launch.mp4' : 'launch-video/launch.mp4', abs: (p: string) => path.join(world.handle.root, p) };
}

describe('writable resources nobody touched', () => {
  it.each(['directory', 'file'] as const)('are not saved again at Review, park or Confirm (%s)', async (shape) => {
    const t = await setup(shape);
    try {
      expect(await t.store.kvGet(stampKey(t.task.id, t.lease.id))).toContain(t.initial.id);
      const saves = vi.spyOn(t.resources.restic, 'backup');
      expect(await t.resources.summarize(t.task.id, t.video.id)).toMatchObject({ added: 0, modified: 0, deleted: 0 });
      expect(await t.resources.checkpoint(t.world.handle)).toEqual([{ attachmentId: t.video.id, revisionId: t.initial.id }]);
      await t.resources.beginReview(t.task.id);
      await t.resources.settleReview(t.task.id);
      expect(saves).not.toHaveBeenCalled();
      expect(await t.current()).toBe(t.initial.id);
      saves.mockRestore();
    } finally { await t.cleanup(); }
  }, 60_000);

  it('still sees an edit that keeps the size and puts the old modification time back', async () => {
    const t = await setup('directory');
    try {
      const file = t.abs(t.videoPath);
      const { atime, mtime } = fs.statSync(file);
      await tick();
      fs.writeFileSync(file, 'frames-v2'); // same size
      fs.utimesSync(file, atime, mtime);
      const saves = vi.spyOn(t.resources.restic, 'backup');
      expect(await t.resources.summarize(t.task.id, t.video.id)).toMatchObject({ modified: 1 });
      await t.resources.beginReview(t.task.id);
      await t.resources.settleReview(t.task.id);
      expect(saves).toHaveBeenCalled();
      const published = (await t.store.getResourceRevision((await t.current())!))!;
      expect(published.parentRevisionId).toBe(t.initial.id);
      saves.mockRestore();
    } finally { await t.cleanup(); }
  }, 60_000);

  it('sees a file added, deleted or renamed', async () => {
    const t = await setup('directory');
    try {
      const saves = vi.spyOn(t.resources.restic, 'backup');
      await tick();
      fs.renameSync(t.abs('launch-video/cuts/intro.mp4'), t.abs('launch-video/cuts/opening.mp4'));
      expect(await t.resources.summarize(t.task.id, t.video.id)).toMatchObject({ added: 1, deleted: 1 });
      expect(saves).toHaveBeenCalledTimes(1);
      saves.mockRestore();
    } finally { await t.cleanup(); }
  }, 60_000);

  it('saves a changed copy at its park once, then not again while it stays as parked', async () => {
    const t = await setup('directory');
    try {
      await tick();
      fs.writeFileSync(t.abs(t.videoPath), 'frames-v2 longer');
      const saves = vi.spyOn(t.resources.restic, 'backup');
      const [parked] = await t.resources.checkpoint(t.world.handle);
      expect(parked!.revisionId).not.toBe(t.initial.id);
      expect(saves).toHaveBeenCalledTimes(1);
      expect(await t.resources.checkpoint(t.world.handle)).toEqual([parked]);
      expect(saves).toHaveBeenCalledTimes(1);
      // Changed again after the park: saved again.
      await tick();
      fs.writeFileSync(t.abs('launch-video/cuts/intro.mp4'), 'intro, recut');
      const [again] = await t.resources.checkpoint(t.world.handle);
      expect(again!.revisionId).not.toBe(parked!.revisionId);
      expect(saves).toHaveBeenCalledTimes(2);
      // Review still measures from the version the copy forked, and publishes both edits.
      expect(await t.resources.summarize(t.task.id, t.video.id)).toMatchObject({ modified: 2 });
      await t.resources.beginReview(t.task.id);
      await t.resources.settleReview(t.task.id);
      expect(await t.current()).not.toBe(t.initial.id);
      saves.mockRestore();
    } finally { await t.cleanup(); }
  }, 60_000);

  it('saves as before when the copy has no stamp', async () => {
    const t = await setup('directory');
    try {
      await t.store.kvDelete(stampKey(t.task.id, t.lease.id));
      const saves = vi.spyOn(t.resources.restic, 'backup');
      expect(await t.resources.summarize(t.task.id, t.video.id)).toMatchObject({ added: 0, modified: 0, deleted: 0 });
      expect(saves).toHaveBeenCalledTimes(1);
      saves.mockRestore();
    } finally { await t.cleanup(); }
  }, 60_000);
});
