import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { S3ObjectStore } from '../src/store/objects.js';
import {
  formatInventory, inventoryObjects, loadObjectReferences, localObjects, migrateObjects, openReferenceDatabase,
} from '../src/ops/object-store-migrate.js';

/** A minimal S3 endpoint holding objects in memory: PUT (checking Content-MD5),
 *  GET, HEAD, DELETE and ListObjectsV2. It counts concurrent requests and can
 *  pretend every object was a multipart upload, whose ETag is not an MD5. */
async function fakeS3(options: { multipartEtags?: boolean; delayMs?: number } = {}) {
  const objects = new Map<string, Buffer>();
  const requests: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const etag = (data: Buffer) => options.multipartEtags
    ? `"${crypto.createHash('md5').update(data).digest('hex').slice(0, 24)}-2"`
    : `"${crypto.createHash('md5').update(data).digest('hex')}"`;
  const server = http.createServer(async (req, res) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      const url = new URL(req.url!, 'http://s3');
      const [, bucket, ...rest] = url.pathname.split('/');
      const key = rest.map(decodeURIComponent).join('/');
      requests.push(`${req.method} ${key}`);
      if (!req.headers.authorization?.includes('/s3/aws4_request') || bucket !== 'bucket') { res.writeHead(403).end(); return; }
      if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        res.writeHead(200).end(`<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key><ETag>${etag(objects.get(k)!)}</ETag><Size>${objects.get(k)!.length}</Size></Contents>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`);
        return;
      }
      if (req.method === 'PUT') {
        const md5 = req.headers['content-md5'];
        if (md5 && md5 !== crypto.createHash('md5').update(body).digest('base64')) { res.writeHead(400).end('BadDigest'); return; }
        objects.set(key, body);
        res.writeHead(200, { etag: etag(body) }).end();
        return;
      }
      if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204).end(); return; }
      const data = objects.get(key);
      if (!data) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-length': data.length, etag: etag(data) });
      res.end(req.method === 'HEAD' ? undefined : data);
    } finally { inFlight--; }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = new S3ObjectStore({ endpoint, bucket: 'bucket', region: 'auto', accessKeyId: 'id', secretAccessKey: 'secret' });
  return { objects, requests, client, endpoint, maxInFlight: () => maxInFlight,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function objectsDir(files: Record<string, string | Buffer>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-objects-'));
  roots.push(root);
  for (const [key, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, key)), { recursive: true });
    fs.writeFileSync(path.join(root, key), data);
  }
  return root;
}

async function tracked(options?: Parameters<typeof fakeS3>[0]) {
  const s3 = await fakeS3(options);
  closers.push(s3.close);
  return s3;
}

const FILES = {
  'checkpoints/org_a/proj_a/task_a/checkpoint_1.bin': 'checkpoint one',
  'resources/org_a/chunks/aaaa.bin': crypto.randomBytes(5000),
  'resources/org_a/manifests/att_1/snapshot_1.bin': 'manifest',
  'artifacts/org_a/proj_a/task_a/art_1': 'artifact',
};

describe('object store migration', () => {
  it('copies every local object under the same key, then skips them all on a second run', async () => {
    const root = objectsDir(FILES);
    const s3 = await tracked();
    const lines: string[] = [];
    const first = await migrateObjects({ root, target: s3.client, log: (line) => lines.push(line) });
    expect(first.copied.count).toBe(4);
    expect(first.copied.bytes).toBe(Object.values(FILES).reduce((sum, data) => sum + Buffer.byteLength(data), 0));
    expect(first.skipped.count).toBe(0);
    for (const [key, data] of Object.entries(FILES)) expect(s3.objects.get(key)!.equals(Buffer.from(data))).toBe(true);
    expect(lines.join('\n')).toMatch(/copied 4 objects/);

    s3.requests.length = 0;
    const second = await migrateObjects({ root, target: s3.client, log: () => {} });
    expect(second).toMatchObject({ copied: { count: 0, bytes: 0 }, skipped: { count: 4 }, mismatched: { count: 0 } });
    // A matching single-part ETag is the local MD5: one HEAD per object, no download.
    expect(s3.requests.every((request) => request.startsWith('HEAD '))).toBe(true);
    // It never deletes anything, locally or remotely.
    for (const key of Object.keys(FILES)) expect(fs.existsSync(path.join(root, key))).toBe(true);
  });

  it('compares content when the ETag is not an MD5, and re-copies a remote copy that differs', async () => {
    const root = objectsDir(FILES);
    const s3 = await tracked({ multipartEtags: true });
    await migrateObjects({ root, target: s3.client, log: () => {} });
    s3.objects.set('resources/org_a/manifests/att_1/snapshot_1.bin', Buffer.from('MANIFEST')); // same size, other bytes
    s3.requests.length = 0;
    const report = await migrateObjects({ root, target: s3.client, log: () => {} });
    expect(report.skipped.count).toBe(3);
    expect(report.mismatched).toMatchObject({ count: 1, keys: ['resources/org_a/manifests/att_1/snapshot_1.bin'] });
    expect(report.copied.count).toBe(1);
    expect(s3.requests.filter((request) => request.startsWith('GET ')).length).toBe(4);
    expect(s3.objects.get('resources/org_a/manifests/att_1/snapshot_1.bin')!.toString()).toBe('manifest');
  });

  it('verifies without writing, reporting missing and mismatched objects', async () => {
    const root = objectsDir(FILES);
    const s3 = await tracked();
    await migrateObjects({ root, target: s3.client, log: () => {} });
    s3.objects.delete('artifacts/org_a/proj_a/task_a/art_1');
    s3.objects.set('resources/org_a/chunks/aaaa.bin', Buffer.from('truncated'));
    s3.requests.length = 0;
    const report = await migrateObjects({ root, target: s3.client, verifyOnly: true, log: () => {} });
    expect(report).toMatchObject({
      copied: { count: 0 }, skipped: { count: 2 },
      missing: { count: 1, keys: ['artifacts/org_a/proj_a/task_a/art_1'] },
      mismatched: { count: 1, keys: ['resources/org_a/chunks/aaaa.bin'] },
    });
    expect(s3.requests.some((request) => request.startsWith('PUT '))).toBe(false);
  });

  it('bounds parallel requests', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 24; i++) files[`resources/org/chunks/${i}.bin`] = `chunk ${i}`;
    const root = objectsDir(files);
    const s3 = await tracked({ delayMs: 20 });
    const report = await migrateObjects({ root, target: s3.client, concurrency: 3, log: () => {} });
    expect(report.copied.count).toBe(24);
    expect(s3.maxInFlight()).toBeLessThanOrEqual(3);
    expect(s3.maxInFlight()).toBeGreaterThan(1);
  });

  it('skips the local store\'s unfinished temporary files and reports them', async () => {
    const root = objectsDir({ ...FILES, 'resources/org_a/chunks/bbbb.bin.0123456789ab.tmp': 'partial' });
    const s3 = await tracked();
    const report = await migrateObjects({ root, target: s3.client, log: () => {} });
    expect(report.copied.count).toBe(4);
    expect(report.temporary).toEqual({ count: 1, bytes: 7 });
    expect([...s3.objects.keys()].some((key) => key.endsWith('.tmp'))).toBe(false);
  });

  it('writes under a prefix when asked, for a throwaway check in a shared bucket', async () => {
    const root = objectsDir(FILES);
    const s3 = await tracked();
    await migrateObjects({ root, target: s3.client, prefix: 'scratch/run-1', log: () => {} });
    expect([...s3.objects.keys()].sort()).toEqual(Object.keys(FILES).map((key) => `scratch/run-1/${key}`).sort());
  });

  // Rolling back to the local store after the app has written to the bucket.
  it('copies the bucket back into the local store, skipping what is already there', async () => {
    const root = objectsDir({ 'checkpoints/org_a/proj_a/task_a/checkpoint_1.bin': 'checkpoint one' });
    const s3 = await tracked();
    s3.objects.set('checkpoints/org_a/proj_a/task_a/checkpoint_1.bin', Buffer.from('checkpoint one'));
    s3.objects.set('artifacts/org_a/proj_a/task_b/new', Buffer.from('written after the cutover'));
    s3.objects.set('resources/org_a/chunks/cccc.bin', Buffer.from('local copy is stale'));
    fs.mkdirSync(path.join(root, 'resources/org_a/chunks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'resources/org_a/chunks/cccc.bin'), 'stale');
    s3.objects.set('.karmax-connection-test/abc', Buffer.from('probe'));
    const verify = await migrateObjects({ root, target: s3.client, fromS3: true, verifyOnly: true, log: () => {} });
    expect(verify).toMatchObject({ skipped: { count: 1 }, missing: { count: 1, keys: ['artifacts/org_a/proj_a/task_b/new'] },
      mismatched: { count: 1, keys: ['resources/org_a/chunks/cccc.bin'] } });
    expect(fs.existsSync(path.join(root, 'artifacts/org_a/proj_a/task_b/new'))).toBe(false);
    const report = await migrateObjects({ root, target: s3.client, fromS3: true, log: () => {} });
    expect(report).toMatchObject({ copied: { count: 2 }, skipped: { count: 1 }, mismatched: { count: 1 } });
    expect(fs.readFileSync(path.join(root, 'artifacts/org_a/proj_a/task_b/new'), 'utf8')).toBe('written after the cutover');
    expect(fs.readFileSync(path.join(root, 'resources/org_a/chunks/cccc.bin'), 'utf8')).toBe('local copy is stale');
    expect(fs.statSync(path.join(root, 'artifacts/org_a/proj_a/task_b/new')).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(root, '.karmax-connection-test'))).toBe(false);
    expect(s3.requests.some((request) => /^(PUT|DELETE) /.test(request))).toBe(false);
    const again = await migrateObjects({ root, target: s3.client, fromS3: true, log: () => {} });
    expect(again).toMatchObject({ copied: { count: 0 }, skipped: { count: 3 } });
  });

  it('lists local objects by key, not following symbolic links out of the store', async () => {
    const root = objectsDir(FILES);
    fs.symlinkSync('/etc', path.join(root, 'outside'));
    const keys = [];
    for await (const object of localObjects(root)) keys.push(object.key);
    expect(keys.sort()).toEqual(Object.keys(FILES).sort());
  });
});

describe('unreferenced object inventory', () => {
  async function referencedDatabase(): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-inventory-db-'));
    roots.push(dir);
    const file = path.join(dir, 'karmax.db');
    const store = await Store.create(file);
    const run = (sql: string, ...params: unknown[]) => store.db.prepare(sql).run(...params);
    await run(`INSERT INTO resource_snapshot_chunks (organizationId, chunkId, storageLocationId, refs, bytes) VALUES (?, ?, ?, ?, ?)`,
      'org_a', 'live', 'storage-managed-org_a', 2, 4);
    await run(`INSERT INTO resource_snapshot_chunks (organizationId, chunkId, storageLocationId, refs, bytes) VALUES (?, ?, ?, ?, ?)`,
      'org_a', 'customer', 'storage_customer', 1, 4);
    await run(`INSERT INTO resource_attachments (id, organizationId, projectId, name, driver, target, access, isolation, source,
      credentialHandles, publish, enabled, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'att_live', 'org_a', 'proj_a', 'data', 'object', 'data', 'write', 'fork', '{}', '[]', '{}', 1, 1, 1);
    await run(`INSERT INTO resource_revisions (id, attachmentId, engine, sealedRef, rootDigest, bytes, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      'rev_1', 'att_live', 'object', JSON.stringify({ objectKey: 'resources/org_a/manifests/att_live/snap_1.bin', sha256: 'x' }), 'r', 4, 1);
    await run(`INSERT INTO world_checkpoints (id, worldId, generation, projectId, manifest, createdAt) VALUES (?, ?, ?, ?, ?, ?)`,
      'checkpoint_live', 'task_a', 1, 'proj_a', JSON.stringify({ filesystemDelta: { objectKey: 'checkpoints/org_a/proj_a/task_a/checkpoint_live.bin' } }), 1);
    await store.kvSet('checkpoint-gc:checkpoint_pruned', JSON.stringify({ worldId: 'task_a', objectKey: 'checkpoints/org_a/proj_a/task_a/checkpoint_pruned.bin' }));
    await run(`INSERT INTO promoted_artifacts (id, organizationId, projectId, taskId, objectKey, sha256, bytes, mediaType, name, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 'art_live', 'org_a', 'proj_a', 'task_a', 'artifacts/org_a/proj_a/task_a/art_live', 'x', 1, 'text/plain', 'a', 1);
    await run(`INSERT INTO conversation_exports (objectKey, organizationId, projectId, taskId, role, exportId, bytes, createdAt, usedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, 'conversation-exports/task_a/do/x.json', 'org_a', 'proj_a', 'task_a', 'do', 'x', 5, 1, 1);
    await store.kvSet('resource-upload:upload_live', JSON.stringify({ id: 'upload_live', files: { f: { parts: [{ objectKey: 'resource-uploads/org_a/upload_live/f/0.bin' }] } } }));
    await store.close();
    return file;
  }

  it('classifies every local object by key family against the database', async () => {
    const database = await referencedDatabase();
    const db = openReferenceDatabase(database);
    const references = await loadObjectReferences(db).finally(() => db.close());
    const object = (key: string, bytes = 10) => ({ key, bytes });
    const report = inventoryObjects([
      object('resources/org_a/chunks/live.bin'),
      object('resources/org_a/chunks/released.bin', 100),
      object('resources/org_a/manifests/att_live/snap_1.bin'),
      object('resources/org_a/manifests/att_live/snap_aborted.bin', 20),
      object('resources/org_a/manifests/att_gone/snap_9.bin', 30),
      object('checkpoints/org_a/proj_a/task_a/checkpoint_live.bin'),
      object('checkpoints/org_a/proj_a/task_a/checkpoint_pruned.bin', 40),
      object('checkpoints/org_a/proj_a/task_a/checkpoint_lost.bin', 50),
      object('artifacts/org_a/proj_a/task_a/art_live'),
      object('artifacts/org_a/proj_a/task_a/art_expired', 60),
      object('resource-uploads/org_a/upload_live/f/0.bin'),
      object('resource-uploads/org_a/upload_old/f/0.bin', 70),
      object('conversation-exports/task_a/do/x.json', 5),
      object('conversation-exports/task_gone/do/y.json', 90),
      object('something-else/x', 80),
    ], references);
    const family = (name: string) => report.families.find((entry) => entry.family === name)!;
    expect(family('resource chunk')).toMatchObject({ referenced: { count: 1, bytes: 10 }, unreferenced: { count: 1, bytes: 100 } });
    expect(family('resource manifest')).toMatchObject({ referenced: { count: 1 }, unreferenced: { count: 2, bytes: 50 } });
    expect(family('resource manifest').reasons).toEqual({ 'attachment exists, no revision': { count: 1, bytes: 20 },
      'attachment deleted': { count: 1, bytes: 30 } });
    expect(family('checkpoint')).toMatchObject({ referenced: { count: 1 }, unreferenced: { count: 2, bytes: 90 } });
    expect(family('checkpoint').reasons).toEqual({ 'pending checkpoint GC': { count: 1, bytes: 40 }, 'no checkpoint row': { count: 1, bytes: 50 } });
    expect(family('artifact')).toMatchObject({ referenced: { count: 1 }, unreferenced: { count: 1, bytes: 60 } });
    expect(family('resource upload part')).toMatchObject({ referenced: { count: 1 }, unreferenced: { count: 1, bytes: 70 } });
    expect(family('conversation export')).toMatchObject({ referenced: { count: 1, bytes: 5 }, unreferenced: { count: 1, bytes: 90 } });
    expect(family('conversation export').reasons).toEqual({ 'no export row': { count: 1, bytes: 90 } });
    expect(family('unknown')).toMatchObject({ untracked: { count: 1, bytes: 80 } });
    expect(report.unreferenced).toEqual({ count: 8, bytes: 100 + 50 + 90 + 60 + 70 + 90 });
    // Chunks referenced from customer buckets live there, not in the managed store.
    expect(references.chunks.has('org_a/customer')).toBe(false);
    const text = formatInventory(report);
    expect(text).toContain('resource chunk');
    expect(text).toContain('attachment deleted');
  });

  it('runs end to end: copies, verifies and prints the inventory without changing the database', { timeout: 60_000 }, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-migrate-home-'));
    roots.push(home);
    const database = await referencedDatabase();
    fs.mkdirSync(path.join(home, 'state'));
    fs.copyFileSync(database, path.join(home, 'state', 'karmax.db'));
    const before = fs.readFileSync(path.join(home, 'state', 'karmax.db'));
    const objects = path.join(home, 'objects');
    for (const [key, data] of Object.entries({ ...FILES, 'resources/org_a/chunks/live.bin': 'live' })) {
      fs.mkdirSync(path.dirname(path.join(objects, key)), { recursive: true });
      fs.writeFileSync(path.join(objects, key), data);
    }
    const s3 = await tracked();
    const secrets = path.join(home, 'secret');
    fs.writeFileSync(secrets, 'secret\n');
    // Asynchronously: the fake S3 server answers from this process.
    const run = (args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/scripts/object-store-migrate.ts', ...args], {
        env: { ...process.env, KARMAX_HOME: home, KARMAX_DATABASE_URL: '', KARMAX_S3_ENDPOINT: s3.endpoint, KARMAX_S3_BUCKET: 'bucket',
          KARMAX_S3_REGION: 'auto', KARMAX_S3_ACCESS_KEY_ID: 'id', KARMAX_S3_SECRET_ACCESS_KEY: '', KARMAX_S3_SECRET_ACCESS_KEY_FILE: secrets },
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    const copy = await run(['--concurrency', '2']);
    expect(copy.status, copy.stderr).toBe(0);
    expect(copy.stdout).toMatch(/copied 5 objects/);
    expect(copy.stdout).toMatch(/Unreferenced local objects/);
    expect(s3.objects.size).toBe(5);
    const verify = await run(['--verify-only']);
    expect(verify.status, verify.stderr).toBe(0);
    expect(verify.stdout).toMatch(/verified 5 objects/);
    s3.objects.delete('resources/org_a/chunks/live.bin');
    const failed = await run(['--verify-only', '--no-inventory']);
    expect(failed.status).toBe(1);
    expect(failed.stdout).toMatch(/missing 1 object/);
    expect(failed.stdout).not.toMatch(/Unreferenced/);
    expect(fs.readFileSync(path.join(home, 'state', 'karmax.db')).equals(before)).toBe(true);
    expect(fs.existsSync(path.join(objects, 'resources/org_a/chunks/live.bin'))).toBe(true);
  });
});

describe('object store check (deploy/karmax doctor)', () => {
  it('names the local store and its delete delay without touching the network', async () => {
    const { checkObjectStore } = await import('../src/ops/object-store-check.js');
    const result = await checkObjectStore({ KARMAX_OBJECT_STORE: 'local', KARMAX_HOME: '/var/lib/karmax' });
    expect(result.ok).toBe(true);
    expect(result.lines.join('\n')).toBe('object store: local, /var/lib/karmax/objects; deletes immediately');
  });

  it('writes, reads back and deletes a probe object in an S3 store, leaving nothing behind', async () => {
    const { checkObjectStore } = await import('../src/ops/object-store-check.js');
    const s3 = await tracked();
    const result = await checkObjectStore({ KARMAX_OBJECT_STORE: 's3', KARMAX_S3_ENDPOINT: s3.endpoint, KARMAX_S3_BUCKET: 'bucket',
      KARMAX_S3_REGION: 'auto', KARMAX_S3_ACCESS_KEY_ID: 'id', KARMAX_S3_SECRET_ACCESS_KEY: 'secret' });
    expect(result.ok).toBe(true);
    expect(result.lines.join('\n')).toBe(`object store: s3, bucket bucket at ${s3.endpoint} (region auto); deletes after 30 days\n`
      + 'probe: PUT, GET and DELETE succeeded');
    expect(s3.requests.map((request) => request.split(' ')[0])).toEqual(['PUT', 'GET', 'DELETE']);
    expect(s3.requests[0]).toMatch(/^PUT \.karmax-connection-test\/[0-9a-f]{24}$/);
    expect(s3.objects.size).toBe(0);
  });

  it('reports a store that refuses the probe', async () => {
    const { checkObjectStore } = await import('../src/ops/object-store-check.js');
    const s3 = await tracked();
    const result = await checkObjectStore({ KARMAX_OBJECT_STORE: 's3', KARMAX_S3_ENDPOINT: s3.endpoint, KARMAX_S3_BUCKET: 'wrong',
      KARMAX_S3_ACCESS_KEY_ID: 'id', KARMAX_S3_SECRET_ACCESS_KEY: 'secret' });
    expect(result.ok).toBe(false);
    expect(result.lines.at(-1)).toMatch(/^probe failed: object store PUT failed \(403\)/);
  });

  it('reports missing S3 settings instead of throwing', async () => {
    const { checkObjectStore } = await import('../src/ops/object-store-check.js');
    const result = await checkObjectStore({ KARMAX_OBJECT_STORE: 's3', KARMAX_S3_BUCKET: 'b' });
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('KARMAX_S3_ENDPOINT is required');
  });
});
