import { afterEach, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store/db.js';
import { DeferredDeleteObjectStore } from '../src/store/deferred-delete.js';
import { StorageLocationService } from '../src/store/storage-locations.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { ObjectSnapshotEngine, ProjectResourceService } from '../src/world/resources.js';
import { REPOSITORY_ROUTE } from '../src/world/resource-repository.js';
import { SYSTEM_JOB_ROOT } from '../src/world/jobs.js';
import edge, { type EdgeEnv } from '../src/edge/resource-repository-worker.js';
import { fakeS3 } from './helpers/fake-s3.js';
import { ensureIdentity, gitOrThrow } from '../src/world/git.js';

const sha256 = (data: Buffer) => crypto.createHash('sha256').update(data).digest('hex');
/** The rest.connections of every save the world ran as a platform job. */
function savesConnections(root: string): string[] {
  const jobs = path.join(root, SYSTEM_JOB_ROOT);
  return [...new Set(fs.readdirSync(jobs).map((id) => fs.readFileSync(path.join(jobs, id, 'command'), 'utf8'))
    .filter((command) => /\bbackup\b/.test(command)).map((command) => /rest\.connections=(\d+)/.exec(command)?.[1] ?? ''))];
}
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function fixture(options: { verifiesChecksums?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-repository-edge-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  await gitOrThrow(repo, ['init', '-q', '-b', 'main']); await ensureIdentity(repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'data/\n');
  await gitOrThrow(repo, ['add', '-A']); await gitOrThrow(repo, ['commit', '-qm', 'base']);
  const store = await Store.create(':memory:');
  cleanups.push(() => store.close());
  const project = await store.createProject('Edge', { repos: [repo] });
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  // The managed store: an S3 bucket that verifies checksums, as R2 does, unless told not to.
  const s3 = await fakeS3(options);
  cleanups.push(() => s3.close());
  const objects = s3.client;
  const locations = new StorageLocationService(store, objects, broker);
  const managed = await locations.ensureManaged(project.organizationId!);
  const worlds = new WorldRegistry();
  worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
  let edgeUrl = '';
  const resources = new ProjectResourceService(store, worlds, new ObjectSnapshotEngine(objects, broker, locations), broker,
    undefined, locations, { objects, edge: () => edgeUrl, world: () => 'http://unused.invalid' });
  // tavya's public route, counting the bytes uploaded to it (locks are a few hundred).
  const origin = { uploadBytes: 0 };
  const originUrl = await listen((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!url.pathname.startsWith(REPOSITORY_ROUTE)) { res.writeHead(404).end(); return; }
    if (req.method === 'POST' && !req.headers['x-tavya-edge']) origin.uploadBytes += Number(req.headers['content-length'] ?? 0);
    void resources.repositoryServer.handle(req, res, url.pathname.slice(REPOSITORY_ROUTE.length) + url.search);
  });
  // The Worker, knowing only tavya's URL.
  const env: EdgeEnv = { ORIGIN: originUrl };
  edgeUrl = await listen(async (req, res) => {
    // Buffered: workerd forwards a body of known length with its content-length, where Node's fetch would stream it chunked.
    const chunks: Buffer[] = [];
    if (req.method !== 'GET' && req.method !== 'HEAD') for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks);
    const request = new Request(`http://edge${req.url}`, { method: req.method, headers: req.headers as Record<string, string>,
      ...(body ? { body: new Uint8Array(body) } : {}) });
    const response = await edge.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body as any).pipe(res); else res.end();
  });
  const attachment = await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
    name: 'Data', driver: 'volume@1', target: { kind: 'path', path: 'data' }, access: 'write', isolation: 'fork', source: {},
    credentialHandles: [], storageLocationId: managed.id, publish: 'review' });
  /** A world that says it is a remote sandbox, running here: restic runs in it as a job and talks to the edge. */
  const sandbox = async () => {
    const task = await store.createTask({ projectId: project.id, title: 'Edge', workflow: 'software-dev', workflowVersion: '1.26.0',
      params: { prompt: 'edge' } });
    const world = await worlds.create('worktree', { taskId: task.id, repo, base: 'main' });
    cleanups.push(() => world.destroy());
    world.handle = { ...world.handle, kind: 'e2b' };
    vi.spyOn(worlds, 'open').mockResolvedValue(world);
    return { task, world };
  };
  return { dir, store, project, managed, objects, s3, resources, attachment, sandbox, origin, edgeUrl, originUrl, env };
}

it('saves from a world straight into the store through the edge, its bytes never passing through tavya, and restores', async () => {
  const f = await fixture();
  const corpus = [{ path: 'big.bin', data: crypto.randomBytes(6 * 1024 * 1024) },
    ...Array.from({ length: 30 }, (_, i) => ({ path: `pages/${i}.txt`, data: crypto.randomBytes(2000) }))];
  const first = await f.resources.importFiles(f.attachment.id, corpus);
  const { task, world } = await f.sandbox();
  world.handle = await f.resources.materialize(f.project.id, task.id, world, 1);
  world.handle = (await f.store.registerWorld(world.handle, f.project.id)) as typeof world.handle;
  expect(sha256(fs.readFileSync(path.join(world.handle.root, 'data/big.bin')))).toBe(sha256(corpus[0]!.data));

  const changed = crypto.randomBytes(3 * 1024 * 1024);
  fs.writeFileSync(path.join(world.handle.root, 'data/big.bin'), changed);
  const before = { origin: f.origin.uploadBytes, direct: f.s3.counters.presignedBytes };
  const promoted = await f.resources.promote(task.id, f.attachment.id);
  expect(promoted.revision).toMatchObject({ engine: 'restic@1', parentRevisionId: first.id });
  // The new data went from the edge into the store, through URLs bound to its content; tavya received none of it.
  expect(f.s3.counters.presignedBytes - before.direct).toBeGreaterThan(changed.length);
  expect(f.origin.uploadBytes - before.origin).toBeLessThan(4096); // its locks
  // With more connections than the relay allows: each upload waits on tavya twice.
  expect(savesConnections(world.handle.root)).toEqual(['32']);
  // Recorded by tavya (listing, quota) and readable through the edge (redirects to the store).
  const verified = await f.resources.verifyRevision(f.project.id, f.attachment.id, promoted.revision.id, 0, 1000);
  expect(verified.status).toBe('complete');
  expect(verified.files.find((file) => file.path === 'big.bin')?.sha256).toBe(sha256(changed));
});

it('lets the edge store only what tavya allows, and only what matches its name', async () => {
  const f = await fixture();
  await f.resources.importFiles(f.attachment.id, [{ path: 'a.txt', data: Buffer.from('a') }]);
  const repository = await f.resources.restic.current(f.attachment);
  const tokens = (f.resources.restic as any).deps.tokens;
  const grant = async (access: string, repo = repository.name) => `Basic ${Buffer.from(`tavya:${await tokens.mint({ repository: repo,
    access, quota: false, expiresAt: Date.now() + 60_000 })}`).toString('base64')}`;
  const body = crypto.randomBytes(1000);
  const name = sha256(body);
  const post = async (file: string, authorization: string, data: Buffer) => fetch(`${f.edgeUrl}${REPOSITORY_ROUTE}${repository.name}/${file}`,
    { method: 'POST', headers: { authorization, 'content-length': String(data.length) }, body: new Uint8Array(data) });
  expect((await post(`data/${name}`, await grant('append', 'resource_other@storage-managed-x'), body)).status).toBe(401);
  expect((await post(`data/${name}`, await grant('read'), body)).status).toBe(403);
  // Content that does not hash to its name is refused by the store and never recorded.
  expect((await post(`data/${'0'.repeat(64)}`, await grant('append'), body)).status).toBe(400);
  expect(await f.store.repositoryFile(repository.name, 'data', '0'.repeat(64))).toBeUndefined();
  expect((await post(`data/${name}`, await grant('append'), body)).status).toBe(200);
  expect(await f.store.repositoryFile(repository.name, 'data', name)).toEqual({ bytes: 1000 });
  expect((await post(`data/${name}`, await grant('append'), body)).status).toBe(200); // a retried upload
  // Deleting is tavya's to refuse: the edge passes it on.
  const remove = await fetch(`${f.edgeUrl}${REPOSITORY_ROUTE}${repository.name}/data/${name}`,
    { method: 'DELETE', headers: { authorization: await grant('append') } });
  expect(remove.status).toBe(403);
  // tavya records a file only once the store holds exactly what was announced.
  const fake = await fetch(`${f.originUrl}${REPOSITORY_ROUTE}${repository.name}/data/${'1'.repeat(64)}`, { method: 'POST',
    headers: { authorization: await grant('append'), 'x-tavya-edge': 'stored', 'x-tavya-length': '10' } });
  expect(fake.status).toBe(409);
  expect(await f.store.repositoryFile(repository.name, 'data', '1'.repeat(64))).toBeUndefined();
});

it('refuses an upload over the storage quota before any byte is stored', async () => {
  const f = await fixture();
  await f.resources.importFiles(f.attachment.id, [{ path: 'a.txt', data: Buffer.from('a') }]);
  await f.store.saveStorageLocation({ ...f.managed, quotaBytes: 1 });
  const repository = await f.resources.restic.current(f.attachment);
  const token = await (f.resources.restic as any).deps.tokens.mint({ repository: repository.name, access: 'append', quota: true,
    expiresAt: Date.now() + 60_000 });
  const body = crypto.randomBytes(1000);
  const before = f.s3.counters.presignedBytes;
  const response = await fetch(`${f.edgeUrl}${REPOSITORY_ROUTE}${repository.name}/data/${sha256(body)}`,
    { method: 'POST', headers: { authorization: `Basic ${Buffer.from(`tavya:${token}`).toString('base64')}`, 'content-length': '1000' },
      body: new Uint8Array(body) });
  expect(response.status).toBe(507);
  expect(f.s3.counters.presignedBytes).toBe(before);
});

it('keeps a file written again through the edge while its earlier delete was pending', async () => {
  const f = await fixture();
  await f.resources.importFiles(f.attachment.id, [{ path: 'a.txt', data: Buffer.from('a') }]);
  const repository = await f.resources.restic.current(f.attachment);
  const token = await (f.resources.restic as any).deps.tokens.mint({ repository: repository.name, access: 'append', quota: false,
    expiresAt: Date.now() + 60_000 });
  const body = crypto.randomBytes(1000);
  const key = `resource-repositories/${repository.name.replace('@', '/')}/data/${sha256(body)}`;
  // Pruned earlier and due for purging, then saved again by a world.
  await f.store.recordObjectTombstone(key, Date.now() - 2, Date.now() - 1);
  const response = await fetch(`${f.edgeUrl}${REPOSITORY_ROUTE}${repository.name}/data/${sha256(body)}`, { method: 'POST',
    headers: { authorization: `Basic ${Buffer.from(`tavya:${token}`).toString('base64')}`, 'content-length': '1000' },
    body: new Uint8Array(body) });
  expect(response.status).toBe(200);
  expect(await new DeferredDeleteObjectStore(f.objects, f.store, { delayMs: 1 }).purgeDue()).toEqual({ purged: 0, failed: 0 });
  expect(await f.objects.head(key)).toMatchObject({ bytes: 1000 });
});

it('sends uploads through tavya for a store that does not verify checksums', async () => {
  // Some S3-compatible stores ignore the checksum header: a URL could then store anything under a name.
  const f = await fixture({ verifiesChecksums: false });
  await f.resources.importFiles(f.attachment.id, [{ path: 'seed.txt', data: Buffer.from('seed') }]);
  const { world } = await f.sandbox();
  fs.mkdirSync(path.join(world.handle.root, 'data'), { recursive: true });
  const data = crypto.randomBytes(2 * 1024 * 1024);
  fs.writeFileSync(path.join(world.handle.root, 'data/big.bin'), data);
  const repository = await f.resources.restic.current(f.attachment);
  const saved = await f.resources.restic.backup({ world, path: path.join(world.handle.root, 'data') }, repository, { key: 'relay', quota: false });
  expect(saved.files).toBe(1);
  expect(f.s3.counters.presignedBytes).toBe(0);
  expect(f.origin.uploadBytes).toBeGreaterThan(data.length);
  expect(savesConnections(world.handle.root)).toEqual(['8']);
  // The edge is not trusted with such a store even when asked directly.
  const token = await (f.resources.restic as any).deps.tokens.mint({ repository: repository.name, access: 'append', quota: false,
    expiresAt: Date.now() + 60_000 });
  const intent = await fetch(`${f.originUrl}${REPOSITORY_ROUTE}${repository.name}/data/${sha256(data)}`, { method: 'POST',
    headers: { authorization: `Basic ${Buffer.from(`tavya:${token}`).toString('base64')}`, 'x-tavya-edge': 'intent', 'x-tavya-length': '1' } });
  expect(intent.status).toBe(409);
  expect(intent.headers.get('x-tavya-upload-url')).toBeNull();
});
