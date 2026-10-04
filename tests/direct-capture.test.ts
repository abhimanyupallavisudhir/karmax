import { describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Store } from '../src/store/db.js';
import { LocalObjectStore, type ObjectStore } from '../src/store/objects.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { ObjectSnapshotEngine, ProjectResourceService } from '../src/world/resources.js';
import { DirectTransfer } from '../src/world/direct-transfer.js';
import { ensureIdentity, git, gitOrThrow } from '../src/world/git.js';
import { openRandom, organizationKey } from '../src/world/chunk-store.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/** A local object store with presigned URLs served over HTTP, as R2's are. */
async function presigningStore(root: string) {
  const local = new LocalObjectStore(root);
  const file = (key: string) => path.join(root, key);
  const signed = new Set<string>();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url!, 'http://x');
    const key = decodeURIComponent(url.pathname.slice(1));
    // Only a URL the store signed, for its method, works.
    if (!signed.has(`${request.method} ${key} ${url.searchParams.get('signature')}`)) { response.writeHead(403).end(); request.resume(); return; }
    const parts: Buffer[] = [];
    request.on('data', (part) => parts.push(part));
    request.on('end', async () => {
      if (request.method === 'PUT') { await local.put(key, Buffer.concat(parts)); response.writeHead(200).end(); }
      else if (request.method === 'GET') {
        const data = await local.get(key).catch(() => undefined);
        if (data) response.writeHead(200).end(data); else response.writeHead(404).end();
      } else response.writeHead(405).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const store: ObjectStore & Required<Pick<ObjectStore, 'presign' | 'head'>> = {
    put: (key, data) => local.put(key, data),
    get: (key) => local.get(key),
    delete: (key) => local.delete(key),
    presign: async (method, key) => {
      const signature = crypto.randomBytes(12).toString('hex');
      signed.add(`${method} ${key} ${signature}`);
      return `http://127.0.0.1:${port}/${encodeURIComponent(key)}?signature=${signature}`;
    },
    head: async (key) => fs.existsSync(file(key)) ? { bytes: fs.statSync(file(key)).size, etag: '' } : undefined,
  };
  return { store, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function fixture(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `karmax-direct-${name}-`));
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  await gitOrThrow(repo, ['init', '-q', '-b', 'main']); await ensureIdentity(repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'raw/\n');
  await git(repo, ['add', '-A']); await gitOrThrow(repo, ['commit', '-q', '-m', 'base']);
  const store = await Store.create(':memory:');
  const project = await store.createProject('Direct', { repos: [repo] });
  const task = await store.createTask({ projectId: project.id, title: 'Build data', workflow: 'software-dev',
    workflowVersion: '1.26.0', params: { prompt: 'build it' } });
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  const worlds = new WorldRegistry();
  worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
  const objectsDir = path.join(dir, 'objects');
  const presigning = await presigningStore(objectsDir);
  const engine = new ObjectSnapshotEngine(presigning.store, broker);
  const resources = new ProjectResourceService(store, worlds, engine, broker);
  resources.directTransfer = () => true;
  const world = await worlds.create('worktree', { taskId: task.id, repo, base: 'main' });
  world.handle = (await store.registerWorld(world.handle, project.id)) as typeof world.handle;
  const root = world.handle.workdir ?? world.handle.root;
  const expected = new Map<string, Buffer>();
  const write = (name: string, data: Buffer) => {
    fs.mkdirSync(path.dirname(path.join(root, 'raw', name)), { recursive: true });
    fs.writeFileSync(path.join(root, 'raw', name), data);
    expected.set(name, data);
  };
  for (let i = 0; i < 300; i++) write(`pages/p-${String(i).padStart(4, '0')}.txt`, Buffer.from(`page ${i}\n`.repeat(i % 9 + 1)));
  write('large.bin', crypto.randomBytes(9 * 1024 * 1024 + 7));
  write('scans/mid.bin', crypto.randomBytes(2.5 * 1024 * 1024));
  const db = new DatabaseSync(path.join(root, 'raw', 'library.db'));
  db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept')"); db.close();
  const cleanup = async () => { await world.destroy(); await presigning.close(); await store.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { store, task, project, resources, engine, broker, world, root, expected, objectsDir, cleanup, repo, worlds };
}

async function restore(f: Awaited<ReturnType<typeof fixture>>, attachmentId: string) {
  const revision = (await f.store.getResourceRevision((await f.store.getResourceAttachment(attachmentId))!.currentRevisionId!))!;
  const files = new Map<string, Buffer>();
  await f.engine.restore(revision, async (name, bytes, offset) => {
    files.set(name, offset ? Buffer.concat([files.get(name)!, bytes]) : bytes);
  });
  return { revision, files };
}

const chunkFiles = (dir: string) => fs.existsSync(path.join(dir, 'resources'))
  ? fs.readdirSync(path.join(dir, 'resources'), { recursive: true }).map(String).filter((name) => name.includes('chunks/')) : [];

describe('direct resource capture', () => {
  it('lets the world read, encrypt and upload a corpus itself, under a key made for this task', async () => {
    const f = await fixture('corpus');
    try {
      const raw = await f.resources.proposePath(f.task.id, { path: 'raw', name: 'Raw', target: { kind: 'path', path: 'raw' } });
      const exec = f.world.exec.bind(f.world);
      vi.spyOn(f.resources['worlds'], 'open').mockResolvedValue(f.world);
      const calls = vi.spyOn(f.world, 'exec').mockImplementation(exec);
      const streamed = vi.spyOn(f.world, 'readFileStream');
      const runs = vi.spyOn(DirectTransfer.prototype, 'run');
      expect(await f.resources.stageCandidates(f.task.id, { final: true })).toEqual({ staged: [raw.candidate.id], failed: [] });
      // Files below a pack's size go in packs; only the large file and the database take runs of their own,
      // and a file read in one run needs no separate hash.
      expect(runs.mock.calls.filter(([operation]) => operation === 'chunks').map(([, input]) => (input as { path: string }).path).sort())
        .toEqual(['large.bin', 'library.db']);
      expect(runs.mock.calls.filter(([operation]) => operation === 'hash')).toEqual([]);
      runs.mockRestore();
      // No bytes came through the worker: no batched reads, no streams, no dd.
      expect(calls.mock.calls.some(([command, args]) => command === 'node' && String(args?.[1]).includes('readSync'))).toBe(false);
      expect(calls.mock.calls.some(([, args]) => String(args?.[1]).includes('dd '))).toBe(false);
      expect(streamed).not.toHaveBeenCalled();
      // The key went over stdin only, never in a command line.
      const { revision, files } = await restore(f, raw.attachment.id);
      const key = await organizationKey(f.broker, f.project.organizationId!);
      const manifest = JSON.parse(openRandom(key, fs.readFileSync(path.join(f.objectsDir,
        JSON.parse(revision.sealedRef).objectKey))).toString('utf8'));
      expect(manifest.version).toBe(3);
      const keys = Object.values(manifest.keys) as Array<{ key: string; task: string }>;
      expect(keys).toEqual([{ key: expect.any(String), task: f.task.id }]);
      expect(calls.mock.calls.flatMap(([, args]) => args ?? []).some((arg) => String(arg).includes(keys[0]!.key))).toBe(false);
      // Everything restores, byte for byte, the database consistently.
      for (const [name, data] of f.expected) expect(files.get(name)?.equals(data)).toBe(true);
      const copy = path.join(f.root, '..', 'restored.db'); fs.writeFileSync(copy, files.get('library.db')!);
      const db = new DatabaseSync(copy); expect(db.prepare('SELECT v FROM t').all()).toEqual([{ v: 'kept' }]); db.close();
      expect(await f.engine.verify(revision, 0, 1000)).toMatchObject({ status: 'complete', verifiedFiles: f.expected.size + 1 });
      // Each stored object is held once, counted at its stored size.
      const rows = await f.store.db.prepare('SELECT chunkId, refs, bytes FROM resource_snapshot_chunks').all() as Array<{ chunkId: string; refs: number; bytes: number }>;
      expect(rows.length).toBe(chunkFiles(f.objectsDir).length);
      for (const row of rows) {
        expect(Number(row.refs)).toBe(1);
        expect(Number(row.bytes)).toBe(fs.statSync(path.join(f.objectsDir, 'resources', f.project.organizationId!, 'chunks', `${row.chunkId}.bin`)).size);
      }
      // Nothing is left staged in the world.
      expect(fs.readdirSync(path.join(f.world.handle.root, '.karmax-injection', 'resource-staging'))).toEqual([]);
      // A refresh with one file changed uploads only that file's objects, under the same key.
      await new Promise((resolve) => setTimeout(resolve, 2_200));
      await f.resources.stageCandidates(f.task.id, { final: true });
      fs.writeFileSync(path.join(f.root, 'raw', 'pages', 'p-0007.txt'), 'rescanned');
      const before = new Set(chunkFiles(f.objectsDir));
      expect(await f.resources.stageCandidates(f.task.id, { final: true })).toEqual({ staged: [raw.candidate.id], failed: [] });
      const added = chunkFiles(f.objectsDir).filter((file) => !before.has(file));
      expect(added).toHaveLength(1); // one new pack
      const second = await restore(f, raw.attachment.id);
      expect(second.files.get('pages/p-0007.txt')!.toString()).toBe('rescanned');
      await f.resources.discardCandidate(f.task.id, raw.candidate.id, 'user:reviewer');
      expect(chunkFiles(f.objectsDir)).toEqual([]);
    } finally { vi.restoreAllMocks(); await f.cleanup(); }
  }, 60_000);

  it('restores into the world directly, with only the keys of the objects it fetches, and relays the rest', async () => {
    const f = await fixture('restore');
    try {
      const raw = await f.resources.proposePath(f.task.id, { path: 'raw', name: 'Raw', target: { kind: 'path', path: 'raw' } });
      vi.spyOn(f.resources['worlds'], 'open').mockResolvedValue(f.world);
      await f.resources.stageCandidates(f.task.id, { final: true });
      const revision = (await f.store.getResourceRevision((await f.store.getResourceAttachment(raw.attachment.id))!.currentRevisionId!))!;
      const into = path.join(f.world.handle.root, 'restored');
      const transfer = new DirectTransfer(f.world);
      const relayed: string[] = [];
      const runs = vi.spyOn(transfer, 'run');
      await f.engine.restore(revision, async (file) => { relayed.push(file); },
        { direct: { transfer, path: (file) => path.posix.join(into, file) } });
      expect(relayed).toEqual([]);
      for (const [name, data] of f.expected) expect(fs.readFileSync(path.join(into, name)).equals(data)).toBe(true);
      // Each batch carried only the key its objects are under.
      const restores = runs.mock.calls.filter(([operation]) => operation === 'restore');
      expect(restores.length).toBeGreaterThan(0);
      for (const [, input] of restores) expect(Object.keys((input as { keys: object }).keys)).toHaveLength(1);
      // A world that cannot run the transfer gets every file through the worker.
      vi.spyOn(f.world, 'exec').mockImplementation(async () => ({ code: 127, stdout: '', stderr: 'node: not found' }));
      const fallback = new DirectTransfer(f.world);
      await f.engine.restore(revision, async (file) => { relayed.push(file); }, { direct: { transfer: fallback, path: (file) => file } });
      expect([...new Set(relayed)].sort()).toEqual([...f.expected.keys(), 'library.db'].sort());
    } finally { vi.restoreAllMocks(); await f.cleanup(); }
  }, 60_000);

  it('publishes a writable resource directly, uploading only the files that changed', async () => {
    const f = await fixture('publish');
    try {
      const volume = await f.store.createResourceAttachment({ organizationId: f.project.organizationId!, projectId: f.project.id,
        name: 'Corpus', driver: 'object-tree@1', target: { kind: 'path', path: 'corpus' }, access: 'write',
        isolation: 'fork', source: {}, credentialHandles: [], publish: 'review' });
      const pages = Array.from({ length: 50 }, (_, i) => ({ path: `p-${i}.txt`, data: Buffer.from(`page ${i}\n`.repeat(i + 1)) }));
      const big = { path: 'big.bin', data: crypto.randomBytes(5 * 1024 * 1024) };
      await f.resources.importFiles(volume.id, [...pages, big]);
      // A task whose world starts from that revision.
      const task = await f.store.createTask({ projectId: f.project.id, title: 'Edit corpus', workflow: 'software-dev',
        workflowVersion: '1.26.0', params: { prompt: 'edit it' } });
      const world = await f.worlds.create('worktree', { taskId: task.id, repo: f.repo, base: 'main' });
      world.handle = await f.resources.materialize(f.project.id, task.id, world, 1);
      world.handle = (await f.store.registerWorld(world.handle, f.project.id)) as typeof world.handle;
      vi.spyOn(f.resources['worlds'], 'open').mockResolvedValue(world);
      const corpus = path.join(world.handle.workdir ?? world.handle.root, 'corpus');
      fs.writeFileSync(path.join(corpus, 'p-3.txt'), 'rewritten page');
      const before = new Set(chunkFiles(f.objectsDir));
      const runs = vi.spyOn(DirectTransfer.prototype, 'run');
      const published = await f.resources.promote(task.id, volume.id);
      // The world packed and uploaded the one changed page; the large file was only hashed in place.
      expect(runs.mock.calls.map(([operation]) => operation)).toContain('pack');
      expect(runs.mock.calls.filter(([operation]) => operation === 'chunks')).toEqual([]);
      expect(chunkFiles(f.objectsDir).filter((file) => !before.has(file))).toHaveLength(1);
      const restored = new Map<string, Buffer>();
      await f.engine.restore(published.revision, async (name, bytes, offset) => {
        restored.set(name, offset ? Buffer.concat([restored.get(name)!, bytes]) : bytes);
      });
      expect(restored.get('p-3.txt')!.toString()).toBe('rewritten page');
      expect(restored.get('big.bin')!.equals(big.data)).toBe(true);
      expect(restored.get('p-7.txt')!.equals(pages[7]!.data)).toBe(true);
    } finally { vi.restoreAllMocks(); await f.cleanup(); }
  }, 60_000);

  it('resumes after an interrupted upload without uploading what was saved again', async () => {
    const f = await fixture('resume');
    try {
      await new Promise((resolve) => setTimeout(resolve, 2_200));
      const raw = await f.resources.proposePath(f.task.id, { path: 'raw', name: 'Raw', target: { kind: 'path', path: 'raw' } });
      const exec = f.world.exec.bind(f.world);
      vi.spyOn(f.resources['worlds'], 'open').mockResolvedValue(f.world);
      let now = Date.now();
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      let uploads = 0;
      const uploaded: string[] = [];
      vi.spyOn(f.world, 'exec').mockImplementation(async (command, args, options) => {
        if (command === 'node' && args?.[1] === 'upload') {
          now += 11_000;
          if (++uploads === 3) return { code: 1, stdout: '', stderr: 'upload failed (network)' };
          uploaded.push(...JSON.parse(options!.input!).items.map((item: { file: string }) => path.basename(item.file)));
        }
        return exec(command, args, options);
      });
      await expect(f.resources.stageCandidates(f.task.id)).rejects.toThrow('upload failed (network)');
      const firstUploads = [...uploaded];
      expect(firstUploads.length).toBeGreaterThan(0);
      uploaded.length = 0;
      expect(await f.resources.stageCandidates(f.task.id, { final: true })).toEqual({ staged: [raw.candidate.id], failed: [] });
      expect(uploaded.filter((file) => firstUploads.includes(file))).toEqual([]);
      const { files } = await restore(f, raw.attachment.id);
      for (const [name, data] of f.expected) expect(files.get(name)?.equals(data)).toBe(true);
      const rows = await f.store.db.prepare('SELECT refs FROM resource_snapshot_chunks').all() as Array<{ refs: number }>;
      expect(rows.every((row) => Number(row.refs) === 1)).toBe(true);
    } finally { vi.restoreAllMocks(); await f.cleanup(); }
  }, 60_000);

  it('falls back to reading through the worker when the world cannot run the transfer', async () => {
    const f = await fixture('fallback');
    try {
      const raw = await f.resources.proposePath(f.task.id, { path: 'raw', name: 'Raw', target: { kind: 'path', path: 'raw' } });
      const exec = f.world.exec.bind(f.world);
      vi.spyOn(f.resources['worlds'], 'open').mockResolvedValue(f.world);
      vi.spyOn(f.world, 'exec').mockImplementation(async (command, args, options) =>
        command === 'node' && String(args?.[0]).includes('resource-transfer-')
          ? { code: 127, stdout: '', stderr: 'node: not found' } : exec(command, args, options));
      expect(await f.resources.stageCandidates(f.task.id, { final: true })).toEqual({ staged: [raw.candidate.id], failed: [] });
      const { revision, files } = await restore(f, raw.attachment.id);
      for (const [name, data] of f.expected) expect(files.get(name)?.equals(data)).toBe(true);
      const key = await organizationKey(f.broker, f.project.organizationId!);
      expect(JSON.parse(openRandom(key, fs.readFileSync(path.join(f.objectsDir, JSON.parse(revision.sealedRef).objectKey))).toString()).version).toBe(2);
    } finally { vi.restoreAllMocks(); await f.cleanup(); }
  }, 60_000);

  it('refuses an upload the store does not hold as reported', async () => {
    const f = await fixture('tamper');
    try {
      await f.resources.proposePath(f.task.id, { path: 'raw', name: 'Raw', target: { kind: 'path', path: 'raw' } });
      vi.spyOn(f.resources['worlds'], 'open').mockResolvedValue(f.world);
      const engine = f.engine as unknown as { objects: ObjectStore };
      const head = engine.objects.head!.bind(engine.objects);
      engine.objects.head = async (key) => { const info = await head(key); return info && { ...info, bytes: info.bytes - 1 }; };
      await expect(f.resources.stageCandidates(f.task.id, { final: true })).resolves.toMatchObject({ staged: [],
        failed: [expect.objectContaining({ error: expect.stringContaining('does not hold what the world reported') })] });
      expect(chunkFiles(f.objectsDir)).toEqual([]);
    } finally { vi.restoreAllMocks(); await f.cleanup(); }
  }, 60_000);
});
