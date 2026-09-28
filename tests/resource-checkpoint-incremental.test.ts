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
/** Stamps younger than the listing's timestamp tick are never trusted. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 2_100));
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** A parked world with a writable resource of `count` files, instrumented to
 * count sandbox commands and object-store uploads per checkpoint. */
async function fixture(count: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-resource-incremental-'));
  const store = await Store.create(':memory:');
  cleanups.push(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const project = await store.createProject('Incremental');
  const task = await store.createTask({ projectId: project.id, title: 'Parked', workflow: 'software-dev',
    workflowVersion: '1.0.0', params: { prompt: 'fixture' } });
  const worlds = new WorldRegistry();
  worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
  const objects = new LocalObjectStore(path.join(dir, 'objects'));
  let puts = 0;
  const put = objects.put.bind(objects);
  objects.put = async (key, data) => { puts++; return put(key, data); };
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  const resources = new ProjectResourceService(store, worlds, new ObjectSnapshotEngine(objects, broker), broker);
  const attachment = await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
    name: 'Runs', driver: 'volume@1', target: { kind: 'path', path: 'runs' }, access: 'write',
    isolation: 'fork', source: {}, credentialHandles: [], publish: 'review' });
  await resources.importFiles(attachment.id, Array.from({ length: count }, (_, i) =>
    ({ path: `run-${i}.json`, data: Buffer.from(`result ${i}\n`) })));
  const world = await worlds.create('worktree', { taskId: task.id, base: 'main' });
  cleanups.push(() => world.destroy());
  world.handle = await resources.materialize(project.id, task.id, world);
  const handle = (await store.registerWorld(world.handle, project.id)) as WorldHandle;
  let execs = 0;
  const open = worlds.open.bind(worlds);
  worlds.open = async (h) => {
    const opened = await open(h);
    const exec = opened.exec.bind(opened);
    opened.exec = async (...args) => { execs++; return exec(...args); };
    return opened;
  };
  const measure = async () => {
    execs = 0; puts = 0;
    const [ref] = await resources.checkpoint(handle);
    return { revisionId: ref!.revisionId, execs, puts };
  };
  return { store, project, resources, attachment, world, handle, measure };
}

it('re-reads and re-uploads only what changed since the last checkpoint (LT-11)', async () => {
  const f = await fixture(40);
  await f.world.writeFile('runs/run-0.json', 'changed by the task\n');
  await settle();
  const first = await f.measure();
  expect(await f.resources.verifyRevision(f.project.id, f.attachment.id, first.revisionId))
    .toMatchObject({ status: 'complete', verifiedFiles: 40 });

  // Parked again with nothing touched: no file is read, nothing is uploaded,
  // and the previous revision is reused rather than duplicated.
  const idle = await f.measure();
  expect(idle.revisionId).toBe(first.revisionId);
  expect(idle.puts).toBe(0);
  expect(idle.execs).toBeLessThanOrEqual(2);

  // One changed file costs one read and one chunk, not the whole resource.
  await f.world.writeFile('runs/run-7.json', 'another result\n');
  const changed = await f.measure();
  expect(changed.revisionId).not.toBe(first.revisionId);
  expect(changed.puts).toBe(2);
  expect(changed.execs).toBeLessThanOrEqual(4);
  expect(await f.resources.verifyRevision(f.project.id, f.attachment.id, changed.revisionId))
    .toMatchObject({ status: 'complete', verifiedFiles: 40 });
});

it('keeps an untouched writable resource on its published revision (LT-11)', async () => {
  const f = await fixture(5);
  await settle();
  const idle = await f.measure();
  expect(idle.revisionId).toBe((await f.store.getResourceAttachment(f.attachment.id))!.currentRevisionId);
  expect(idle.puts).toBe(0);
});

it('re-reads a same-size rewrite and a file deleted then recreated (LT-11)', async () => {
  const f = await fixture(3);
  await settle();
  await f.measure();
  const file = path.join(f.world.handle.root, 'runs/run-1.json');
  const { mtime } = fs.statSync(file);
  // Same size and the old mtime restored: only ctime/inode reveal the edit.
  fs.writeFileSync(file, 'RESULT 1\n');
  fs.utimesSync(file, mtime, mtime);
  fs.rmSync(path.join(f.world.handle.root, 'runs/run-2.json'));
  fs.writeFileSync(path.join(f.world.handle.root, 'runs/run-2.json'), 'result 2\n');
  await settle();
  const next = await f.measure();
  const manifest = await (f.resources as any).engine.manifest(await f.store.getResourceRevision(next.revisionId));
  const digest = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
  expect(manifest.files.find((entry: any) => entry.path === 'run-1.json').sha256).toBe(digest('RESULT 1\n'));
  expect(manifest.files).toHaveLength(3);
});
