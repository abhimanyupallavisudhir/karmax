import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store/db.js';
import { LocalObjectStore, type ObjectStore } from '../src/store/objects.js';
import { StorageLocationService } from '../src/store/storage-locations.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { GRANT_REQUESTS_PER_MINUTE, GrantLimits, REPOSITORY_ROUTE, RepositoryTokens, ResourceRepositoryServer, repositoryName,
  repositoryPassword, type RepositoryAccess } from '../src/world/resource-repository.js';
import { RESTIC_VERSION, runHostRestic, worldResticBinary } from '../src/world/restic.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** A store that hands out presigned URLs, served by a tiny HTTP server, as R2 does. */
async function presigning(objects: LocalObjectStore): Promise<ObjectStore & { gets: number }> {
  const server = http.createServer(async (req, res) => {
    const key = decodeURIComponent(new URL(req.url!, 'http://x').pathname.slice(1));
    let body: Buffer;
    try { body = await objects.get(key); } catch { res.writeHead(404).end(); return; }
    wrapped.gets++;
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      const start = Number(range[1]); const end = range[2] ? Number(range[2]) : body.length - 1;
      res.writeHead(206, { 'content-length': String(end - start + 1) }).end(body.subarray(start, end + 1));
    } else res.writeHead(200, { 'content-length': String(body.length) }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  const wrapped = {
    gets: 0,
    put: (key: string, data: Buffer) => objects.put(key, data),
    get: (key: string) => objects.get(key),
    delete: (key: string) => objects.delete(key),
    presign: async (method: 'GET' | 'PUT', key: string) => {
      if (method !== 'GET') throw new Error('only reads are redirected');
      return `http://127.0.0.1:${port}/${encodeURIComponent(key)}`;
    },
  };
  return wrapped;
}

async function fixture(options: { presign?: boolean; quotaBytes?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-repository-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = await Store.create(':memory:');
  cleanups.push(() => store.close());
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  const local = new LocalObjectStore(path.join(dir, 'objects'));
  const objects = options.presign ? await presigning(local) : local;
  const locations = new StorageLocationService(store, objects, broker, options.quotaBytes);
  const project = await store.createProject('Data');
  const managed = await locations.ensureManaged(project.organizationId!);
  const attachment = await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
    name: 'raw', driver: 'volume@1', target: { kind: 'path', path: 'raw' }, access: 'write', isolation: 'fork', source: {},
    credentialHandles: [], storageLocationId: managed.id, publish: 'review' });
  const tokens = new RepositoryTokens(broker);
  const repositories = new ResourceRepositoryServer({ store, tokens, objects: async () => objects });
  const repository = repositoryName(attachment.id, managed.id);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    if (!url.pathname.startsWith(REPOSITORY_ROUTE)) { res.writeHead(404).end(); return; }
    void repositories.handle(req, res, url.pathname.slice(REPOSITORY_ROUTE.length) + url.search);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${REPOSITORY_ROUTE}`;
  const password = await repositoryPassword(broker, attachment, true);
  const grant = (access: RepositoryAccess, extra: { quota?: boolean; repository?: string; expiresAt?: number } = {}) =>
    tokens.mint({ repository: extra.repository ?? repository, access, quota: extra.quota ?? false, expiresAt: extra.expiresAt ?? Date.now() + 60_000 });
  const restic = async (access: RepositoryAccess, args: string[], cwd?: string) => runHostRestic(['--json', '--no-cache', ...args], {
    RESTIC_REPOSITORY: `rest:${base}${repository}/`, RESTIC_REST_USERNAME: 'tavya', RESTIC_REST_PASSWORD: await grant(access),
    RESTIC_PASSWORD: password }, { cwd });
  const http_ = async (method: string, file: string, access: RepositoryAccess, body?: Buffer) => fetch(`${base}${repository}/${file}`, {
    method, headers: { authorization: `Basic ${Buffer.from(`tavya:${await grant(access)}`).toString('base64')}` },
    ...(body ? { body: new Uint8Array(body) } : {}) });
  const source = path.join(dir, 'source');
  fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(source, 'nested', 'small.txt'), 'hello');
  fs.writeFileSync(path.join(source, 'big.bin'), crypto.randomBytes(3 * 1024 * 1024));
  return { dir, store, attachment, repository, managed, objects, restic, http: http_, grant, base, source, locations };
}

const snapshotOf = (stdout: string) => JSON.parse(stdout.trim().split('\n').pop()!).snapshot_id as string;

describe('resource repository server (restic REST protocol)', () => {
  for (const presign of [false, true]) {
    it(`backs up and restores a tree with real restic${presign ? ', reads redirected to the store' : ''}`, async () => {
      const f = await fixture({ presign });
      expect((await f.restic('admin', ['init'])).code).toBe(0);
      const backup = await f.restic('append', ['backup', '--host', 'tavya', '.'], f.source);
      expect(backup.code, backup.stderr).toBe(0);
      const snapshot = snapshotOf(backup.stdout);
      const target = path.join(f.dir, 'restored');
      const restore = await f.restic('read', ['restore', snapshot, '--target', target, '--no-lock']);
      expect(restore.code, restore.stderr).toBe(0);
      expect(fs.readFileSync(path.join(target, 'nested', 'small.txt'), 'utf8')).toBe('hello');
      expect(fs.readFileSync(path.join(target, 'big.bin')).equals(fs.readFileSync(path.join(f.source, 'big.bin')))).toBe(true);
      if (presign) expect((f.objects as { gets: number }).gets).toBeGreaterThan(0);
      // The listing, not the object store, is what restic sees; locks are gone.
      const files = await f.store.listRepositoryFiles(f.repository);
      expect(files.some((file) => file.kind === 'locks')).toBe(false);
      expect(files.filter((file) => file.kind === 'snapshots').map((file) => file.name)).toEqual([snapshot]);
      const usage = await f.store.storageLocationUsage(f.managed.id);
      expect(usage.retainedBytes).toBe(files.reduce((sum, file) => sum + file.bytes, 0));
    });
  }

  it('lets a world add to the repository but never delete or replace what is there', async () => {
    const f = await fixture();
    await f.restic('admin', ['init']);
    const snapshot = snapshotOf((await f.restic('append', ['backup', '--host', 'tavya', '.'], f.source)).stdout);
    expect((await f.http('DELETE', `snapshots/${snapshot}`, 'append')).status).toBe(403);
    expect((await f.restic('append', ['forget', snapshot])).code).not.toBe(0);
    const key = (await f.store.listRepositoryFiles(f.repository, 'keys'))[0]!;
    expect((await f.http('DELETE', `keys/${key.name}`, 'append')).status).toBe(403);
    // A file must hash to its name, so nothing can stand in for real content.
    const fake = Buffer.from('not what the name says');
    expect((await f.http('POST', `data/${'0'.repeat(64)}`, 'append', fake)).status).toBe(400);
    const good = crypto.randomBytes(100);
    const name = crypto.createHash('sha256').update(good).digest('hex');
    expect((await f.http('POST', `keys/${name}`, 'append', good)).status).toBe(403);
    expect((await f.http('POST', 'config', 'append', good)).status).toBe(403);
    expect((await f.http('POST', `data/${name}`, 'append', good)).status).toBe(200);
    expect((await f.http('POST', `data/${name}`, 'append', good)).status).toBe(200); // a retried upload
    expect((await f.http('POST', `data/${name}`, 'read', good)).status).toBe(403);
    expect((await f.http('DELETE', `data/${name}`, 'read')).status).toBe(403);
    // The snapshot is intact and still restores.
    const restore = await f.restic('read', ['restore', snapshot, '--target', path.join(f.dir, 'again'), '--no-lock']);
    expect(restore.code, restore.stderr).toBe(0);
  });

  it('refuses tokens for another repository, expired or forged ones', async () => {
    const f = await fixture();
    await f.restic('admin', ['init']);
    const call = (token: string) => fetch(`${f.base}${f.repository}/config`, { method: 'HEAD',
      headers: { authorization: `Basic ${Buffer.from(`tavya:${token}`).toString('base64')}` } });
    expect((await call(await f.grant('read'))).status).toBe(200);
    expect((await call(await f.grant('read', { repository: 'resource_other' }))).status).toBe(401);
    expect((await call(await f.grant('read', { expiresAt: Date.now() - 1 }))).status).toBe(401);
    const [body] = (await f.grant('read')).split('.');
    const forged = Buffer.from(JSON.stringify({ repository: f.repository, access: 'admin', quota: false, expiresAt: Date.now() + 60_000 })).toString('base64url');
    expect((await call(`${forged}.${(await f.grant('read')).split('.')[1]}`)).status).toBe(401);
    expect((await call(`${body}.`)).status).toBe(401);
    expect((await fetch(`${f.base}${f.repository}/config`, { method: 'HEAD' })).status).toBe(401);
  });

  it('lets the worker forget and prune, which deletes the objects nothing needs', async () => {
    const f = await fixture();
    await f.restic('admin', ['init']);
    const first = snapshotOf((await f.restic('append', ['backup', '--host', 'tavya', '.'], f.source)).stdout);
    fs.rmSync(path.join(f.source, 'big.bin'));
    fs.writeFileSync(path.join(f.source, 'other.bin'), crypto.randomBytes(2 * 1024 * 1024));
    const second = snapshotOf((await f.restic('append', ['backup', '--host', 'tavya', '.'], f.source)).stdout);
    const before = (await f.store.storageLocationUsage(f.managed.id)).retainedBytes;
    expect((await f.restic('admin', ['forget', first])).code).toBe(0);
    const prune = await f.restic('admin', ['prune', '--max-unused', '0']);
    expect(prune.code, prune.stderr).toBe(0);
    const after = (await f.store.storageLocationUsage(f.managed.id)).retainedBytes;
    expect(after).toBeLessThan(before - 2 * 1024 * 1024);
    // What is left is exactly what the listing records, and still restores.
    const data = await f.store.listRepositoryFiles(f.repository, 'data');
    for (const file of data) expect(fs.existsSync(path.join(f.dir, 'objects', 'resource-repositories', f.attachment.id, f.managed.id, 'data', file.name))).toBe(true);
    expect(fs.readdirSync(path.join(f.dir, 'objects', 'resource-repositories', f.attachment.id, f.managed.id, 'data')).sort())
      .toEqual(data.map((file) => file.name).sort());
    const restore = await f.restic('read', ['restore', second, '--target', path.join(f.dir, 'second'), '--no-lock']);
    expect(restore.code, restore.stderr).toBe(0);
    expect(fs.existsSync(path.join(f.dir, 'second', 'other.bin'))).toBe(true);
    expect((await f.restic('admin', ['check', '--read-data'])).code).toBe(0);
  });

  it('refuses new data over the storage quota when the grant enforces it', async () => {
    const f = await fixture({ quotaBytes: 1024 * 1024 });
    await f.restic('admin', ['init']);
    const env = await f.grant('append', { quota: true });
    const over = await runHostRestic(['--json', '--no-cache', 'backup', '--host', 'tavya', '.'], {
      RESTIC_REPOSITORY: `rest:${f.base}${f.repository}/`, RESTIC_REST_USERNAME: 'tavya', RESTIC_REST_PASSWORD: env,
      RESTIC_PASSWORD: await repositoryPassword(new CredentialBroker(new Vault(path.join(f.dir, 'vault'))), f.attachment, true) }, { cwd: f.source });
    expect(over.code).not.toBe(0);
    // restic shows the status, not the message: the engine names the quota (resticFailure).
    expect(over.stdout + over.stderr).toMatch(/507/);
    // Work in progress (a parked task's private copy) is counted, never refused.
    expect((await f.restic('append', ['backup', '--host', 'tavya', '.'], f.source)).code).toBe(0);
  });
});

/** `count` calls of `call`, `width` at a time; their statuses. */
async function burst(count: number, width: number, call: () => Promise<Response>): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < count; i += width)
    statuses.push(...await Promise.all(Array.from({ length: Math.min(width, count - i) }, async () => {
      const response = await call(); await response.arrayBuffer(); return response.status;
    })));
  return statuses;
}

describe('resource repository request budgets', () => {
  // Every remote world reaches the server through the Cloudflare edge, so all
  // of them arrive from a few shared addresses: the budget follows the grant.
  const as = (base: string, repository: string, token: string, headers: Record<string, string> = {}) => () =>
    fetch(`${base}${repository}/locks/`, { headers: { authorization: `Basic ${Buffer.from(`tavya:${token}`).toString('base64')}`, ...headers } });

  it('serves many worlds saving at once from one address, and refuses only the grant that floods', async () => {
    const f = await fixture();
    // A 1.27 GB save made 228 edge subrequests in a minute; 20 such saves at once.
    const worlds = await Promise.all(Array.from({ length: 20 }, () => f.grant('append')));
    const served = (await Promise.all(worlds.map((token) => burst(250, 25, as(f.base, f.repository, token))))).flat();
    expect(served.filter((status) => status !== 200)).toEqual([]);

    const flood = await f.grant('append');
    expect(new Set(await burst(GRANT_REQUESTS_PER_MINUTE, 50, as(f.base, f.repository, flood)))).toEqual(new Set([200]));
    const refused = await as(f.base, f.repository, flood)();
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(Number(refused.headers.get('retry-after'))).toBeLessThanOrEqual(60);
    // Looking like the edge, or like another peer, earns the flood nothing.
    for (const headers of [{ 'x-tavya-edge': 'intent' }, { 'x-forwarded-for': '172.71.146.192' }, { 'cf-connecting-ip': '198.51.100.7' }])
      expect((await as(f.base, f.repository, flood, headers)()).status).toBe(429);
    // Everyone else is untouched, from the same address at the same moment.
    expect((await as(f.base, f.repository, worlds[0]!)()).status).toBe(200);
    expect((await as(f.base, f.repository, await f.grant('read'))()).status).toBe(200);
  });

  it('serves the restic binary only to a grant', async () => {
    const f = await fixture();
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const url = `${f.base}restic/${RESTIC_VERSION}/linux-${arch}`;
    expect((await fetch(url)).status).toBe(401);
    const granted = await fetch(url, { headers: { authorization: `Basic ${Buffer.from(`tavya:${await f.grant('read')}`).toString('base64')}` } });
    expect(granted.status).toBe(worldResticBinary(arch) ? 200 : 404);
    await granted.arrayBuffer();
  });

  it("starts a grant's budget again each minute and forgets idle grants", () => {
    const limits = new GrantLimits(3);
    expect([0, 1, 2].map((i) => limits.take('a', 1_000 + i))).toEqual([0, 0, 0]);
    expect(limits.take('a', 31_000)).toBe(30_000);
    expect(limits.take('b', 31_000)).toBe(0);
    expect(limits.take('a', 61_000)).toBe(0);
    limits.take('c', 200_000);
    expect(limits.size).toBe(1);
  });
});
