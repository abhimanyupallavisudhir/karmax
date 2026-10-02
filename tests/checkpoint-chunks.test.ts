import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { StorageLocationService } from '../src/store/storage-locations.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { CHECKPOINT_KEY_HANDLE, WorldCheckpointService } from '../src/world/checkpoint.js';
import { ObjectSnapshotEngine, ProjectResourceService } from '../src/world/resources.js';
import { gitOrThrow, ensureIdentity } from '../src/world/git.js';
import type { World } from '../src/world/types.js';

const MiB = 1024 * 1024;
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A repositoryless task world (every file is output) whose execs are observed. */
async function fixture(options: { quotaBytes?: number; repo?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-chunks-')); dirs.push(dir);
  let repo: string | undefined;
  if (options.repo) {
    repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
    await gitOrThrow(repo, ['init', '-qb', 'main']); await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'tracked\n');
    await gitOrThrow(repo, ['add', '.']); await gitOrThrow(repo, ['commit', '-qm', 'init']);
  }
  const store = await Store.create(':memory:');
  const project = await store.createProject('Chunked', { ...(repo ? { repos: [repo] } : {}), defaultBase: 'main', worldProvider: 'worktree' });
  const organizationId = project.organizationId!;
  const task = await store.createTask({ projectId: project.id, title: 'Chunked', workflow: 'software-dev',
    workflowVersion: '1.0.0', params: { prompt: 'test' } });
  const worlds = new WorldRegistry(); worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  const objects = new LocalObjectStore(path.join(dir, 'objects'));
  const locations = new StorageLocationService(store, objects, broker, options.quotaBytes);
  await locations.ensureManaged(organizationId);
  const resources = new ProjectResourceService(store, worlds, new ObjectSnapshotEngine(objects, broker, locations), broker, undefined, locations);
  const service = new WorldCheckpointService(store, worlds, objects, broker, undefined, resources);
  const world = await worlds.create('worktree', { taskId: task.id, ...(repo ? { repos: [repo] } : {}), base: 'main' });
  world.handle.meta = { projectId: project.id };
  world.handle = await store.registerWorld(world.handle, project.id) as typeof world.handle;
  const observed = observe(world);
  vi.spyOn(worlds, 'open').mockResolvedValue(world);
  const write = (file: string, data: string | Buffer, mode?: number) => {
    const target = path.join(world.handle.root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    if (mode !== undefined) fs.chmodSync(target, mode);
  };
  const chunkObjects = () => {
    const root = path.join(dir, 'objects', 'resources', organizationId, 'chunks');
    return fs.existsSync(root) ? fs.readdirSync(root) : [];
  };
  const restoreFresh = async (checkpointId: string) => {
    vi.mocked(worlds.open).mockRestore();
    await world.destroy();
    const handle = await service.restore(checkpointId, 'worktree');
    return handle.root;
  };
  return { dir, store, project, organizationId, task, worlds, broker, objects, locations, resources, service, world,
    observed, write, chunkObjects, restoreFresh };
}

/** Counts the bytes each sandbox exec returns, and lets a test act before a file read. */
function observe(world: World) {
  const original = world.exec.bind(world);
  const state = { maxStdout: 0, reads: 0, stats: 0, beforeRead: undefined as undefined | (() => void),
    beforeStat: undefined as undefined | (() => void) };
  world.exec = async (command, args, options) => {
    const isRead = command === 'node' && String(args[1]).includes('readSync');
    const isStat = command === 'node' && String(args[1]).includes("['missing'");
    if (isRead) { state.reads++; state.beforeRead?.(); }
    if (isStat) { state.stats++; state.beforeStat?.(); }
    const result = await original(command, args, options);
    if (isRead) state.maxStdout = Math.max(state.maxStdout, result.stdout.length);
    return result;
  };
  return state;
}

const digest = (value: Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const settle = () => new Promise(resolve => setTimeout(resolve, 2100));
const chunkRows = async (store: Store) => ((await (store as any).db.prepare('SELECT chunkId, refs FROM resource_snapshot_chunks').all()) as Array<{ chunkId: string; refs: number }>);

describe('chunked world checkpoints', () => {
  it('streams files past the old whole-document caps in bounded reads and restores them exactly', async () => {
    const f = await fixture();
    const big = crypto.randomBytes(41 * MiB);
    big.write('PLAINTEXT-MARKER-big', 7 * MiB);
    f.write('data/big.bin', big);
    f.write('bin/tool.sh', '#!/bin/sh\necho PLAINTEXT-MARKER-small\n', 0o755);
    f.write('empty', '');
    let sources = 0;
    for (let i = 0; i < 50; i++) {
      const source = `export const value${i} = ${i};\n`;
      f.write(`src/file-${i}.ts`, source); sources += source.length;
    }
    const checkpoint = await f.service.checkpoint(f.world.handle);
    expect(checkpoint.filesystemDelta).toMatchObject({ format: 2, files: 53,
      contentBytes: big.length + '#!/bin/sh\necho PLAINTEXT-MARKER-small\n'.length + sources });
    // No single sandbox round trip carries more than one 4 MiB chunk.
    expect(f.observed.maxStdout).toBeLessThanOrEqual(Math.ceil(4 * MiB / 3) * 4 + 1024);
    expect(f.chunkObjects()).toHaveLength(11 + 1); // 41 MiB in 4 MiB chunks, one pack
    for (const name of (fs.readdirSync(path.join(f.dir, 'objects'), { recursive: true }) as string[])) {
      const file = path.join(f.dir, 'objects', name);
      if (fs.statSync(file).isFile()) expect(fs.readFileSync(file).toString('latin1')).not.toContain('PLAINTEXT-MARKER');
    }
    const root = await f.restoreFresh(checkpoint.id);
    expect(digest(fs.readFileSync(path.join(root, 'data/big.bin')))).toBe(digest(big));
    expect(fs.statSync(path.join(root, 'bin/tool.sh')).mode & 0o111).toBe(0o111);
    expect(fs.statSync(path.join(root, 'src/file-3.ts')).mode & 0o111).toBe(0);
    expect(fs.readFileSync(path.join(root, 'empty'))).toHaveLength(0);
    expect(fs.readFileSync(path.join(root, 'src/file-49.ts'), 'utf8')).toBe('export const value49 = 49;\n');
  });

  it('reuses unchanged files from the previous checkpoint without reading or uploading them again', async () => {
    const f = await fixture();
    const big = crypto.randomBytes(9 * MiB);
    f.write('model.bin', big);
    f.write('notes/a.md', 'first');
    f.write('notes/b.md', 'unchanged');
    await settle(); // older than the racy-clean window
    const first = await f.service.checkpoint(f.world.handle);
    const put = vi.spyOn(f.objects, 'put');
    f.observed.reads = 0;
    const second = await f.service.checkpoint(f.world.handle);
    expect(f.observed.reads).toBe(0);
    expect(put.mock.calls.map(([key]) => key)).toEqual([second.filesystemDelta!.objectKey]);
    expect(second.id).not.toBe(first.id);

    put.mockClear();
    f.write('notes/a.md', 'second');
    const third = await f.service.checkpoint(f.world.handle);
    expect(f.observed.reads).toBe(1);
    // One new pack for the changed file, then the manifest; the model's chunks are kept.
    expect(put.mock.calls.map(([key]) => key.split('/')[2])).toEqual(['chunks', f.project.id]);
    expect(await f.store.getWorldCheckpoint(first.id)).toBeUndefined(); // only the two newest are kept
    const rows = await chunkRows(f.store);
    expect(rows.every(row => row.refs >= 1)).toBe(true);
    const root = await f.restoreFresh(third.id);
    expect(digest(fs.readFileSync(path.join(root, 'model.bin')))).toBe(digest(big));
    expect(fs.readFileSync(path.join(root, 'notes/a.md'), 'utf8')).toBe('second');
    expect(fs.readFileSync(path.join(root, 'notes/b.md'), 'utf8')).toBe('unchanged');
  });

  it('keeps a checkpoint over the storage quota, counts it, and names the largest files', async () => {
    // Work in progress is never refused for quota (wiki features/managed-storage):
    // a world that cannot checkpoint cannot park.
    const f = await fixture({ quotaBytes: 2 * MiB });
    f.write('dataset.bin', crypto.randomBytes(3 * MiB));
    f.write('small.txt', 'small');
    const checkpoint = await f.service.checkpoint(f.world.handle);
    expect((await f.store.latestWorldCheckpoint(f.task.id))?.id).toBe(checkpoint.id);
    expect((await chunkRows(f.store)).length).toBeGreaterThan(0);
    const notice = await f.service.takeNotice(f.task.id);
    expect(notice).toMatch(/^Your organization's storage is over its quota/);
    expect(notice).toContain('This checkpoint was kept');
    expect(notice).toContain('- dataset.bin (3.0 MiB)');
    expect(notice).toContain('.gitignore');
    // While the large checkpoint is still kept (the two newest are), the
    // organization stays over its quota and the notice stays.
    fs.rmSync(path.join(f.world.handle.root, 'dataset.bin'));
    await f.service.checkpoint(f.world.handle);
    expect(await f.service.takeNotice(f.task.id)).toMatch(/over its quota/);
    // Once it is pruned and its chunks freed, the notice clears.
    await f.store.kvSet(`checkpoint-notice:${f.task.id}`, 'stale');
    await f.service.checkpoint(f.world.handle);
    expect(await f.store.getWorldCheckpoint(checkpoint.id)).toBeUndefined();
    expect(await f.service.takeNotice(f.task.id)).toBeUndefined();
  });

  it('retries a file that changes while it is read, and refuses one that never settles', async () => {
    const f = await fixture();
    f.write('log.txt', 'line 1\n');
    let writes = 0;
    f.observed.beforeRead = () => { if (writes++ === 0) fs.appendFileSync(path.join(f.world.handle.root, 'log.txt'), 'line 2\n'); };
    const settled = await f.service.checkpoint(f.world.handle);
    expect(f.observed.reads).toBe(2);
    f.observed.beforeRead = () => fs.appendFileSync(path.join(f.world.handle.root, 'log.txt'), 'more\n');
    await expect(f.service.checkpoint(f.world.handle)).rejects.toThrow('log.txt keeps changing while the world is checkpointed');
    expect(await f.service.takeNotice(f.task.id)).toContain('- log.txt — keeps changing');
    f.observed.beforeRead = undefined;
    const root = await f.restoreFresh(settled.id);
    expect(fs.readFileSync(path.join(root, 'log.txt'), 'utf8')).toBe('line 1\nline 2\n');
  });

  it('moves a small file that grows past the pack size during capture to chunked reads', async () => {
    const f = await fixture();
    const grown = crypto.randomBytes(6 * MiB);
    f.write('growing.bin', 'tiny');
    let first = true;
    f.observed.beforeRead = () => { if (first) { first = false; fs.writeFileSync(path.join(f.world.handle.root, 'growing.bin'), grown); } };
    const checkpoint = await f.service.checkpoint(f.world.handle);
    expect(f.observed.maxStdout).toBeLessThanOrEqual(Math.ceil(4 * MiB / 3) * 4 + 1024);
    const root = await f.restoreFresh(checkpoint.id);
    expect(digest(fs.readFileSync(path.join(root, 'growing.bin')))).toBe(digest(grown));
  });

  it('records files deleted after Git listed them as deletions', async () => {
    const f = await fixture({ repo: true });
    f.write('tracked.txt', 'edited\n');
    f.write('temporary.txt', 'scratch');
    f.write('kept.txt', 'kept');
    f.observed.beforeStat = () => {
      for (const file of ['tracked.txt', 'temporary.txt']) fs.rmSync(path.join(f.world.handle.root, file), { force: true });
    };
    const checkpoint = await f.service.checkpoint(f.world.handle);
    f.observed.beforeStat = undefined;
    const root = await f.restoreFresh(checkpoint.id);
    expect(fs.existsSync(path.join(root, 'tracked.txt'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'temporary.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'kept.txt'), 'utf8')).toBe('kept');
  });

  it('leaves out an untracked nested repository instead of failing, and says so', async () => {
    const f = await fixture({ repo: true });
    const nested = path.join(f.world.handle.root, 'vendor/lib');
    fs.mkdirSync(nested, { recursive: true });
    await gitOrThrow(nested, ['init', '-qb', 'main']);
    fs.writeFileSync(path.join(nested, 'code.c'), 'int main() {}\n');
    f.write('tracked.txt', 'edited\n');
    const checkpoint = await f.service.checkpoint(f.world.handle);
    expect(checkpoint.omitted).toEqual([{ path: 'vendor/lib/', reason: 'nested repository' }]);
    expect(await f.service.takeNotice(f.task.id)).toContain('- vendor/lib/ — nested repository');
    const root = await f.restoreFresh(checkpoint.id);
    expect(fs.readFileSync(path.join(root, 'tracked.txt'), 'utf8')).toBe('edited\n');
  });

  it('still restores and forks legacy whole-document checkpoints', async () => {
    const f = await fixture();
    vi.mocked(f.worlds.open).mockRestore();
    const delta = { version: 1, files: [
      { repo: '', path: 'legacy.txt', data: Buffer.from('from the old format').toString('base64') },
      { repo: '', path: 'link', symlink: true, data: Buffer.from('legacy.txt').toString('base64') },
    ] };
    if (!f.broker.hasHandle(CHECKPOINT_KEY_HANDLE)) await f.broker.ensureHandle(CHECKPOINT_KEY_HANDLE, crypto.randomBytes(32).toString('base64'));
    const key = Buffer.from(f.broker.resolve(CHECKPOINT_KEY_HANDLE, { caps: [`use-credential:${CHECKPOINT_KEY_HANDLE}`] }), 'base64');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(zlib.gzipSync(JSON.stringify(delta))), cipher.final()]);
    const encrypted = Buffer.concat([Buffer.from('KMX1'), iv, cipher.getAuthTag(), body]);
    const objectKey = `checkpoints/${f.organizationId}/${f.project.id}/${f.task.id}/legacy.bin`;
    await f.objects.put(objectKey, encrypted);
    await f.store.saveWorldCheckpoint({ id: 'checkpoint_legacy', worldId: f.task.id, generation: 1, projectId: f.project.id,
      runnerPoolId: 'local', environmentDigest: 'karmax-local', repos: [], createdAt: Date.now(),
      filesystemDelta: { objectKey, sha256: digest(encrypted), bytes: encrypted.length } });
    await f.world.destroy();
    const restored = await f.service.restore('checkpoint_legacy', 'worktree');
    expect(fs.readFileSync(path.join(restored.root, 'legacy.txt'), 'utf8')).toBe('from the old format');
    expect(fs.readlinkSync(path.join(restored.root, 'link'))).toBe('legacy.txt');
    const fork = await f.worlds.create('worktree', { taskId: 'legacy-fork', base: 'main' });
    await f.service.applyFork('checkpoint_legacy', fork, f.project.id);
    expect(fs.readFileSync(path.join(fork.handle.root, 'legacy.txt'), 'utf8')).toBe('from the old format');
    await fork.destroy();
  });

  it('releases chunks exactly once on project deletion, keeping those a resource still holds', async () => {
    const f = await fixture();
    const shared = crypto.randomBytes(5 * MiB);
    f.write('weights.bin', shared);
    f.write('notes.txt', 'notes');
    const attachment = await f.store.createResourceAttachment({ organizationId: f.organizationId, projectId: f.project.id,
      name: 'Weights', driver: 'volume@1', target: { kind: 'path', path: 'weights' }, access: 'read', isolation: 'fork',
      source: {}, credentialHandles: [], publish: 'discard' });
    const revision = await f.resources.importFiles(attachment.id, [{ path: 'weights.bin', data: shared }]);
    const resourceChunks = f.chunkObjects();
    expect(resourceChunks).toHaveLength(2);
    const checkpoint = await f.service.checkpoint(f.world.handle);
    expect(f.chunkObjects()).toHaveLength(3); // the weights are stored once, plus a pack
    expect((await chunkRows(f.store)).filter(row => row.refs === 2)).toHaveLength(2);
    await Promise.all([f.service.deleteProject(f.project.id), f.service.deleteProject(f.project.id)]);
    expect(await f.store.listProjectCheckpoints(f.project.id)).toEqual([]);
    await expect(f.objects.get(checkpoint.filesystemDelta!.objectKey)).rejects.toThrow();
    expect(f.chunkObjects().sort()).toEqual(resourceChunks.sort());
    expect((await chunkRows(f.store)).map(row => row.refs)).toEqual([1, 1]);
    expect((await f.resources.verifyRevision(f.project.id, attachment.id, revision.id)).status).toBe('complete');
  });

  it('collects an obsolete checkpoint once even when sweeps in two processes race', async () => {
    const f = await fixture();
    f.write('shared.bin', crypto.randomBytes(2 * MiB)); // one chunk all three checkpoints hold
    f.write('a.txt', 'a');
    const oldest = await f.service.checkpoint(f.world.handle);
    f.write('a.txt', 'b');
    await f.service.checkpoint(f.world.handle);
    f.write('a.txt', 'c');
    // Keep the third checkpoint from collecting the first itself.
    const collect = vi.spyOn(f.service, 'collectGarbage').mockResolvedValueOnce();
    await f.service.checkpoint(f.world.handle);
    collect.mockRestore();
    expect(await f.store.getWorldCheckpoint(oldest.id)).toBeUndefined();
    const before = await chunkRows(f.store);
    // A second worker process: its own registry, so no shared in-process lock.
    const otherWorlds = new WorldRegistry(); otherWorlds.register(new WorktreeProvider(path.join(f.dir, 'worlds')));
    const other = new WorldCheckpointService(f.store, otherWorlds, f.objects, f.broker, undefined, f.resources);
    // Both have read the manifest before either claims the deletion.
    const claim = f.store.completeCheckpointDeletion.bind(f.store);
    let arrived = 0, release!: () => void;
    const both = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(f.store, 'completeCheckpointDeletion').mockImplementation(async (id) => {
      if (++arrived === 2) release();
      await Promise.race([both, new Promise(resolve => setTimeout(resolve, 2000))]);
      return claim(id);
    });
    await Promise.all([f.service.collectGarbage(), other.collectGarbage()]);
    expect(arrived).toBe(2);
    const after = await chunkRows(f.store);
    expect(before.map(row => row.refs).sort()).toEqual([1, 1, 1, 3]);
    expect(after.map(row => row.refs).sort()).toEqual([1, 1, 2]);
    expect(await f.store.kvEntries('checkpoint-gc:')).toEqual([]);
  });

  it('stores checkpoints in the organization\'s own S3 location', async () => {
    const f = await fixture();
    const bucket = new Map<string, Buffer>();
    vi.stubGlobal('fetch', vi.fn(async (input: URL | string, init?: RequestInit) => {
      const key = new URL(String(input)).pathname;
      const method = init?.method ?? 'GET';
      if (method === 'PUT') { bucket.set(key, Buffer.from(init!.body as Uint8Array)); return new Response('', { status: 200 }); }
      if (method === 'DELETE') { bucket.delete(key); return new Response(null, { status: 204 }); }
      const value = bucket.get(key);
      return value ? new Response(value) : new Response('missing', { status: 404 });
    }));
    const location = await f.locations.connectS3(f.organizationId, { name: 'Customer bucket', endpoint: 'https://objects.example',
      bucket: 'customer-data', accessKeyId: 'key', secretAccessKey: 'secret', prefix: 'tenant' });
    await f.locations.test(f.organizationId, location.id);
    await f.locations.setDefault(f.organizationId, location.id);
    f.write('report.pdf', crypto.randomBytes(5 * MiB));
    const checkpoint = await f.service.checkpoint(f.world.handle);
    expect(checkpoint.filesystemDelta?.storageLocationId).toBe(location.id);
    expect([...bucket.keys()].every(key => key.startsWith('/customer-data/tenant/'))).toBe(true);
    expect([...bucket.keys()].filter(key => key.includes('/chunks/'))).toHaveLength(2);
    expect(f.chunkObjects()).toEqual([]);
    await expect(f.locations.delete(f.organizationId, location.id)).rejects.toThrow(/task checkpoints/);
    const root = await f.restoreFresh(checkpoint.id);
    expect(fs.statSync(path.join(root, 'report.pdf')).size).toBe(5 * MiB);
  });
});
