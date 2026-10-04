import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { ObjectSnapshotEngine, ProjectResourceService } from '../src/world/resources.js';
import type { WorldHandle } from '../src/world/types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** A parked world with a writable resource of `count` files of `size` random
 * bytes, instrumented to measure what each checkpoint uploads. */
async function fixture(count: number, size = 1024) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-resource-incremental-'));
  const store = await Store.create(':memory:');
  cleanups.push(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const project = await store.createProject('Incremental');
  const task = await store.createTask({ projectId: project.id, title: 'Parked', workflow: 'software-dev',
    workflowVersion: '1.0.0', params: { prompt: 'fixture' } });
  const worlds = new WorldRegistry();
  worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
  const objects = new LocalObjectStore(path.join(dir, 'objects'));
  let uploaded = 0;
  const put = objects.put.bind(objects);
  objects.put = async (key, data) => { if (key.includes('/data/')) uploaded += data.length; return put(key, data); };
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  const resources = new ProjectResourceService(store, worlds, new ObjectSnapshotEngine(objects, broker), broker);
  const attachment = await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
    name: 'Runs', driver: 'volume@1', target: { kind: 'path', path: 'runs' }, access: 'write',
    isolation: 'fork', source: {}, credentialHandles: [], publish: 'review' });
  await resources.importFiles(attachment.id, Array.from({ length: count }, (_, i) =>
    ({ path: `run-${i}.json`, data: crypto.randomBytes(size) })));
  const world = await worlds.create('worktree', { taskId: task.id, base: 'main' });
  cleanups.push(() => world.destroy());
  world.handle = await resources.materialize(project.id, task.id, world);
  const handle = (await store.registerWorld(world.handle, project.id)) as WorldHandle;
  /** One park: the revision it resolved to and the pack bytes it uploaded. */
  const measure = async () => {
    uploaded = 0;
    const [ref] = await resources.checkpoint(handle);
    return { revisionId: ref!.revisionId, uploaded };
  };
  const contentOf = async (revisionId: string) => {
    const verified = await resources.verifyRevision(project.id, attachment.id, revisionId, 0, 1000);
    expect(verified.status).toBe('complete');
    return new Map(verified.files.map((file) => [file.path, file.sha256]));
  };
  return { store, project, resources, attachment, world, handle, measure, contentOf, data: count * size };
}

const digest = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');

it('uploads only what changed since the last checkpoint (LT-11)', async () => {
  const f = await fixture(40, 16 * 1024);
  await f.world.writeFile('runs/run-0.json', 'changed by the task\n');
  const first = await f.measure();
  expect((await f.contentOf(first.revisionId)).get('run-0.json')).toBe(digest('changed by the task\n'));

  // Parked again with nothing touched: the previous revision is reused, and
  // no file data is uploaded again (only restic's small directory metadata).
  const idle = await f.measure();
  expect(idle.revisionId).toBe(first.revisionId);
  expect(idle.uploaded).toBeLessThan(f.data / 10);

  // One changed file costs about that file, not the whole resource.
  await f.world.writeFile('runs/run-7.json', 'another result\n');
  const changed = await f.measure();
  expect(changed.revisionId).not.toBe(first.revisionId);
  expect(changed.uploaded).toBeLessThan(f.data / 10);
  const content = await f.contentOf(changed.revisionId);
  expect(content.size).toBe(40);
  expect(content.get('run-7.json')).toBe(digest('another result\n'));
});

it('keeps an untouched writable resource on its published revision (LT-11)', async () => {
  const f = await fixture(5, 64 * 1024);
  const idle = await f.measure();
  expect(idle.revisionId).toBe((await f.store.getResourceAttachment(f.attachment.id))!.currentRevisionId);
  // A restored world is not read and uploaded again.
  expect(idle.uploaded).toBeLessThan(f.data / 10);
});

it('sees a same-size rewrite and a file deleted then recreated (LT-11)', async () => {
  const f = await fixture(3, 9);
  await f.measure();
  fs.writeFileSync(path.join(f.world.handle.root, 'runs/run-1.json'), 'RESULT 1\n');
  fs.rmSync(path.join(f.world.handle.root, 'runs/run-2.json'));
  fs.writeFileSync(path.join(f.world.handle.root, 'runs/run-2.json'), 'result 2\n');
  const next = await f.measure();
  const content = await f.contentOf(next.revisionId);
  expect(content.get('run-1.json')).toBe(digest('RESULT 1\n'));
  expect(content.get('run-2.json')).toBe(digest('result 2\n'));
  expect(content.size).toBe(3);
});

it('captures a single-file resource whose path is a symlink (LT-11)', async () => {
  const f = await fixture(1);
  const ledger = await f.store.createResourceAttachment({ organizationId: f.project.organizationId!, projectId: f.project.id,
    name: 'Ledger', driver: 'object-tree@1', target: { kind: 'path', path: 'ledger.json' }, access: 'write',
    isolation: 'fork', source: { shape: 'file' }, credentialHandles: [], publish: 'review' });
  await f.resources.importFiles(ledger.id, [{ path: 'ledger.json', data: Buffer.from('original\n') }]);
  await f.store.createResourceLease({ attachmentId: ledger.id, revisionId: (await f.store.getResourceAttachment(ledger.id))!.currentRevisionId,
    taskId: f.handle.id, worldId: f.handle.id, worldGeneration: f.handle.generation ?? 1, access: 'write', state: 'active' });
  // The agent replaced the file with a link to the real ledger.
  fs.writeFileSync(path.join(f.world.handle.root, 'real-ledger.json'), 'linked ledger\n');
  fs.rmSync(path.join(f.world.handle.root, 'ledger.json'), { force: true });
  fs.symlinkSync('real-ledger.json', path.join(f.world.handle.root, 'ledger.json'));
  const refs = await f.resources.checkpoint(f.handle);
  const ref = refs.find((entry) => entry.attachmentId === ledger.id)!;
  const verified = await f.resources.verifyRevision(f.project.id, ledger.id, ref.revisionId);
  expect(verified.files).toEqual([expect.objectContaining({ sha256: digest('linked ledger\n') })]);
});

it('keeps parking a restored, untouched resource cheap (LT-11)', async () => {
  // The common case: a restored resource the task never touches.
  const f = await fixture(40, 16 * 1024);
  const first = await f.measure();
  const second = await f.measure();
  const third = await f.measure();
  expect(second.revisionId).toBe(first.revisionId);
  expect(third.revisionId).toBe(first.revisionId);
  for (const park of [first, second, third]) expect(park.uploaded).toBeLessThan(f.data / 10);
});
