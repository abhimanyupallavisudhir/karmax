import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import { LocalObjectStore, S3ObjectStore, type ObjectStore } from '../src/store/objects.js';
import { WorldRegistry } from '../src/world/registry.js';
import { Gateway } from '../src/gateway/server.js';
import { ArtifactUrls } from '../src/gateway/artifact-urls.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { findFreePortFrom } from '../src/util/ports.js';
import type { TaskView } from '../src/domain/types.js';
import type { World } from '../src/world/types.js';
import { preserveReviewArtifacts, savedReviewArtifact } from '../src/store/review-artifacts.js';

/**
 * Review artifacts are served as a stream, never loaded whole into the
 * gateway (a 91.5 MB video once was, per request, and never opened), with
 * byte ranges so a video plays and seeks before it has downloaded. The Review
 * viewer reaches them through a short-lived signed URL, since an `<video src>`
 * cannot send an Authorization header.
 */

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const VIDEO = crypto.randomBytes(3 * 1024 * 1024 + 17);

async function fixture(options: { objects?: (local: LocalObjectStore) => ObjectStore; world?: (world: World) => World } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-stream-'));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = (await Store.create(path.join(root, 'state.sqlite')));
  cleanup.push(async () => (await store.close()));
  const local = new LocalObjectStore(path.join(root, 'objects'));
  const objects = options.objects ? options.objects(local) : local;
  const project = (await store.createProject('Artifact streaming'));
  const task = (await store.createTask({ projectId: project.id, title: 'Video', workflow: 'just-do',
    workflowVersion: '1.0.0', params: { prompt: 'video' } }));
  const worlds = new WorldRegistry();
  const world = await worlds.create('memory', { taskId: task.id, base: 'main' });
  cleanup.push(() => world.destroy());
  if (options.world) {
    const wrapped = options.world(world);
    vi.spyOn(worlds, 'open').mockResolvedValue(wrapped);
  }
  const info = { actions: [
    { kind: 'open' as const, label: 'Watch the video', target: 'out/explainer.mp4' },
    { kind: 'open' as const, label: 'Read notes', target: 'notes.md' },
    { kind: 'open' as const, label: 'Download data', target: 'data.bin' },
  ] };
  const view: TaskView = { taskId: task.id, title: task.title, workflow: task.workflow,
    stage: 'review', status: 'waiting', state: {}, messages: [], actions: [], updatedAt: 1,
    world: world.handle, reviewInfo: info };
  (await store.saveView(task.id, view));
  await world.writeFileBuffer!('out/explainer.mp4', VIDEO);
  await world.writeFile('notes.md', '# Notes');
  await world.writeFileBuffer!('data.bin', Buffer.from([0, 1, 2, 3]));
  const tokens = new TokenAuthority();
  const caps = ['task:read', 'task:review:execute'];
  const token = (await tokens.mint({ taskId: task.id, profileId: 'test', principal: `task:${task.id}`,
    organizationId: project.organizationId, ceiling: caps, grantorCaps: caps })).token;
  const client = { workflow: { getHandle: () => ({ query: async () => (await store.getTask(task.id))?.lastView }) } } as any;
  const api = new KarmaxApi({ store, tokens, client, worlds, taskQueue: 'test' });
  const gateway = (await Gateway.create({ api, store, tokens, client, worlds, objects, taskQueue: 'test',
    bus: new KarmaxBus(), contributions: new ContributionRegistry(), overlays: new Overlays(),
    staticDir: 'web', agentInfo: { provider: 'mock', reason: 'test' } }));
  const server = await gateway.listen(await findFreePortFrom(49_900));
  cleanup.push(() => server.close());
  const authorized = (url: string, init: RequestInit = {}) => fetch(`${server.url}${url}`, {
    ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers as Record<string, string> },
  });
  /** What the Review "open" button gets back for action `index`. */
  const resolve = async (index: number) => {
    const response = await authorized(`/api/tasks/${task.id}/review-action`, { method: 'POST', body: JSON.stringify({ index }) });
    expect(response.status).toBe(200);
    return await response.json() as { kind: string; url: string; name: string; mediaType: string; bytes?: number; external: boolean };
  };
  /** A request with no credentials at all, as a `<video src>` makes it. */
  const anonymous = (url: string, init: RequestInit = {}) => fetch(`${server.url}${url}`, init);
  const save = () => preserveReviewArtifacts(store, local, world, task.id, info);
  return { root, store, local, objects, task, project, world, worlds, view, info, authorized, anonymous, resolve, save, server };
}

async function expectRanges(f: Awaited<ReturnType<typeof fixture>>, url: string, request = f.anonymous) {
  const size = VIDEO.length;
  const full = await request(url);
  expect(full.status).toBe(200);
  expect(full.headers.get('accept-ranges')).toBe('bytes');
  expect(full.headers.get('content-length')).toBe(String(size));
  expect(full.headers.get('content-type')).toBe('video/mp4');
  expect(Buffer.from(await full.arrayBuffer()).equals(VIDEO)).toBe(true);

  const middle = await request(url, { headers: { range: 'bytes=1000-1999' } });
  expect(middle.status).toBe(206);
  expect(middle.headers.get('content-range')).toBe(`bytes 1000-1999/${size}`);
  expect(middle.headers.get('content-length')).toBe('1000');
  expect(Buffer.from(await middle.arrayBuffer()).equals(VIDEO.subarray(1000, 2000))).toBe(true);

  // What a browser asks for first, and when it seeks.
  const open = await request(url, { headers: { range: `bytes=${size - 10}-` } });
  expect(open.status).toBe(206);
  expect(open.headers.get('content-range')).toBe(`bytes ${size - 10}-${size - 1}/${size}`);
  expect(Buffer.from(await open.arrayBuffer()).equals(VIDEO.subarray(size - 10))).toBe(true);

  const suffix = await request(url, { headers: { range: 'bytes=-7' } });
  expect(suffix.status).toBe(206);
  expect(Buffer.from(await suffix.arrayBuffer()).equals(VIDEO.subarray(size - 7))).toBe(true);

  // A range running past the end is cut to it.
  const past = await request(url, { headers: { range: `bytes=${size - 3}-${size + 100}` } });
  expect(past.status).toBe(206);
  expect(past.headers.get('content-range')).toBe(`bytes ${size - 3}-${size - 1}/${size}`);

  const unsatisfiable = await request(url, { headers: { range: `bytes=${size}-` } });
  expect(unsatisfiable.status).toBe(416);
  expect(unsatisfiable.headers.get('content-range')).toBe(`bytes */${size}`);
  await unsatisfiable.arrayBuffer();

  // A malformed or multi-part range is ignored: the whole file, as RFC 9110 allows.
  const multi = await request(url, { headers: { range: 'bytes=0-1,5-6' } });
  expect(multi.status).toBe(200);
  expect(multi.headers.get('content-length')).toBe(String(size));
  await multi.arrayBuffer();

  const head = await request(url, { method: 'HEAD' });
  expect(head.status).toBe(200);
  expect(head.headers.get('content-length')).toBe(String(size));
  expect(head.headers.get('accept-ranges')).toBe('bytes');
  expect((await head.arrayBuffer()).byteLength).toBe(0);
}

describe('review artifact streaming', () => {
  it('serves a saved artifact in byte ranges', async () => {
    const f = await fixture();
    await f.save();
    await expectRanges(f, `/api/tasks/${f.task.id}/artifact?path=out/explainer.mp4`, f.authorized);
    const saved = (await savedReviewArtifact(f.store, f.task.id, 'out/explainer.mp4'))!;
    // A promoted artifact's own URL behaves the same.
    await expectRanges(f, `/api/artifacts/${saved.id}`, f.authorized);
  });

  it('serves an unsaved artifact from the world in byte ranges', async () => {
    const f = await fixture();
    await expectRanges(f, `/api/tasks/${f.task.id}/artifact?path=out/explainer.mp4`, f.authorized);
  });

  it('streams from a remote world without reading the whole file', async () => {
    // A cloud sandbox: no host path, a stream that honours ranges, a size.
    const reads: Array<{ start: number; end: number } | undefined> = [];
    const f = await fixture({ world: (inner) => {
      const root = path.join(os.tmpdir(), 'not-on-this-host', crypto.randomUUID());
      const file = (rel: string) => path.join(inner.handle.root, rel);
      return {
        ...inner,
        handle: { ...inner.handle, root },
        readFileBuffer: async () => { throw new Error('read whole'); },
        readFilePrefix: async () => { throw new Error('read whole'); },
        fileSize: async (rel: string) => (await fs.promises.stat(file(rel))).size,
        readFileStream: (rel: string, range?: { start: number; end: number }) => {
          reads.push(range);
          return fs.createReadStream(file(rel), range ? { start: range.start, end: range.end } : {});
        },
      } as World;
    } });
    await expectRanges(f, `/api/tasks/${f.task.id}/artifact?path=out/explainer.mp4`, f.authorized);
    expect(reads).toContainEqual({ start: 1000, end: 1999 });
  });

  it('starts sending a saved artifact before the object store has delivered all of it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const whole = vi.fn();
    const f = await fixture({ objects: (local) => ({
      put: (key, data) => local.put(key, data),
      delete: (key) => local.delete(key),
      get: async (key) => { whole(); return local.get(key); },
      async getStream(key, range) {
        const data = await local.get(key);
        const start = range?.start ?? 0;
        const end = range?.end ?? data.length - 1;
        // Two chunks, then a wait: the whole-object hash holds back only the
        // latest chunk, so the first must already be on its way.
        async function* body() {
          yield data.subarray(start, start + 64 * 1024);
          yield data.subarray(start + 64 * 1024, start + 128 * 1024);
          await gate;
          yield data.subarray(start + 128 * 1024, end + 1);
        }
        return { bytes: data.length, body: body() };
      },
    }) });
    await f.save();
    whole.mockClear();
    const response = await f.authorized(`/api/tasks/${f.task.id}/artifact?path=out/explainer.mp4`);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.value!.byteLength).toBeGreaterThan(0);
    release();
    let received = first.value!.byteLength;
    for (;;) { const { done, value } = await reader.read(); if (done) break; received += value.byteLength; }
    expect(received).toBe(VIDEO.length);
    expect(whole).not.toHaveBeenCalled();
  });

  it('refuses a stored object whose size differs from what was saved, and cuts one whose bytes differ', async () => {
    const f = await fixture();
    await f.save();
    const saved = (await savedReviewArtifact(f.store, f.task.id, 'out/explainer.mp4'))!;
    const url = `/api/tasks/${f.task.id}/artifact?path=out/explainer.mp4`;
    await f.local.put(saved.objectKey, VIDEO.subarray(1));
    const shorter = await f.authorized(url);
    expect(shorter.status).toBe(502);
    expect(await shorter.text()).toContain('integrity');

    // Same size, different bytes: the last chunk is withheld until the hash
    // matches, so the download fails instead of completing with wrong bytes.
    const tampered = Buffer.from(VIDEO); tampered[tampered.length - 1]! ^= 0xff;
    await f.local.put(saved.objectKey, tampered);
    const corrupt = await f.authorized(url);
    expect(corrupt.status).toBe(200);
    await expect(corrupt.arrayBuffer()).rejects.toThrow();
    // A range that is not the whole object is checked by size alone.
    const part = await f.authorized(url, { headers: { range: 'bytes=0-99' } });
    expect(part.status).toBe(206);
    expect((await part.arrayBuffer()).byteLength).toBe(100);
  });

  it('reads S3 objects with a Range request and reports the total size', async () => {
    const seen: Array<Record<string, string>> = [];
    const objects = new S3ObjectStore({ endpoint: 'https://r2.example', bucket: 'b', region: 'auto',
      accessKeyId: 'id', secretAccessKey: 'secret', fetch: (async (_url: URL, init: RequestInit) => {
        const headers = init.headers as Record<string, string>;
        seen.push(headers);
        const range = /^bytes=(\d+)-(\d+)$/.exec(headers.range ?? '');
        if (!range) return new Response(VIDEO, { headers: { 'content-length': String(VIDEO.length) } });
        const [start, end] = [Number(range[1]), Number(range[2])];
        return new Response(VIDEO.subarray(start, end + 1), { status: 206,
          headers: { 'content-range': `bytes ${start}-${end}/${VIDEO.length}`, 'content-length': String(end - start + 1) } });
      }) as typeof fetch });
    const part = await objects.getStream('a/b', { start: 10, end: 19 });
    expect(seen[0]!.range).toBe('bytes=10-19');
    expect(part!.bytes).toBe(VIDEO.length);
    const chunks: Buffer[] = [];
    for await (const chunk of part!.body) chunks.push(chunk);
    expect(Buffer.concat(chunks).equals(VIDEO.subarray(10, 20))).toBe(true);
    const whole = await objects.getStream('a/b');
    expect(whole!.bytes).toBe(VIDEO.length);
    expect(seen[1]!.range).toBeUndefined();
  });
});

describe('signed review artifact URLs', () => {
  it('lets the Review viewer play a video with no credentials, scoped to that artifact', async () => {
    const f = await fixture();
    await f.save();
    const opened = await f.resolve(0);
    expect(opened).toMatchObject({ kind: 'open', external: false, name: 'explainer.mp4', mediaType: 'video/mp4', bytes: VIDEO.length });
    expect(opened.url).toMatch(/^\/api\/artifact-content\/[^/]+\/explainer\.mp4$/);
    await expectRanges(f, opened.url);
    const response = await f.anonymous(opened.url);
    // Still the console origin, so the untrusted-content isolation still applies.
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toContain('private');
    await response.arrayBuffer();

    // Tampering with the token, or pointing it elsewhere, opens nothing.
    const token = opened.url.split('/')[3]!;
    const [body, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), p: 'notes.md' })).toString('base64url');
    expect((await f.anonymous(`/api/artifact-content/${forged}.${signature}/notes.md`)).status).toBe(403);
    expect((await f.anonymous(`/api/artifact-content/${body}.${'A'.repeat(signature!.length)}/x`)).status).toBe(403);
  });

  it('works for unsaved artifacts too, and names the served type for the viewer', async () => {
    const f = await fixture();
    const video = await f.resolve(0);
    expect(video.mediaType).toBe('video/mp4');
    expect(video.bytes).toBeUndefined();
    await expectRanges(f, video.url);
    // Markdown is served as a download (it is not an inert type); the viewer reads it by name.
    const notes = await f.resolve(1);
    expect(notes).toMatchObject({ name: 'notes.md', mediaType: 'application/octet-stream' });
    expect(await (await f.anonymous(notes.url)).text()).toBe('# Notes');
    const data = await f.resolve(2);
    expect(data.mediaType).toBe('application/octet-stream');
    const download = await f.anonymous(data.url);
    expect(download.headers.get('content-disposition')).toMatch(/^attachment; filename="data\.bin"/);
    await download.arrayBuffer();
  });

  it('expires', async () => {
    const urls = new ArtifactUrls();
    const now = Date.now();
    const token = await urls.mint({ taskId: 'task_1', path: 'a.mp4' }, now);
    expect(await urls.verify(token, now + 60_000)).toEqual({ taskId: 'task_1', path: 'a.mp4' });
    expect(await urls.verify(token, now + ArtifactUrls.TTL_MS + 1)).toBeUndefined();
    expect(await new ArtifactUrls().verify(token, now)).toBeUndefined();
  });
});
