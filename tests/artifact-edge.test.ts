import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { signArtifactEdgeToken, type ArtifactEdgeClaims } from '../src/edge/artifact-edge-token.js';
import { ARTIFACT_EDGE_MARKER, type ArtifactBucket } from '../src/edge/artifact-worker.js';
import { ARTIFACT_EDGE_SCRIPT, bundleArtifactEdge, deployArtifactEdge, r2Jurisdiction } from '../src/ops/artifact-edge-deploy.js';
import { artifactEdge, artifactEdgeKey } from '../src/gateway/artifact-urls.js';
import { consoleContentSecurityPolicy } from '../src/gateway/static-assets.js';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { WorldRegistry } from '../src/world/registry.js';
import { Gateway } from '../src/gateway/server.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { preserveReviewArtifacts } from '../src/store/review-artifacts.js';
import type { TaskView } from '../src/domain/types.js';

/**
 * Saved Review files (the launch video of task #820 above all) are served by a
 * Cloudflare Worker that reads them from the R2 bucket at the location nearest
 * the viewer, instead of relaying every byte through tavya's one server: it
 * started 1.4 s after the click from Oregon, at 7 MB/s, where Cloudflare's edge
 * delivers the same 23 MB in 0.3–1.1 s (2026-11-04, wiki features/review-artifacts).
 */

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});

const KEY = Buffer.from(crypto.randomBytes(32)).toString('base64url');
const VIDEO = crypto.randomBytes(256 * 1024 + 17);
const SHA = crypto.createHash('sha256').update(VIDEO).digest('hex');
const ORIGIN = 'https://tavya.example';

/** R2's binding, in memory: `get` with a range returns that slice, `size` is always the object's. */
function bucket(objects: Record<string, Buffer>): ArtifactBucket & { reads: Array<{ key: string; range?: unknown }> } {
  const reads: Array<{ key: string; range?: unknown }> = [];
  return {
    reads,
    head: async (key) => objects[key] ? { size: objects[key]!.length } : null,
    get: async (key, options) => {
      reads.push({ key, ...(options?.range ? { range: options.range } : {}) });
      const data = objects[key];
      if (!data) return null;
      const range = options?.range;
      const bytes = range ? data.subarray(range.offset, range.offset + range.length) : data;
      // In chunks, as R2 streams it.
      const chunks = Array.from({ length: Math.ceil(bytes.length / 65_536) }, (_, i) => bytes.subarray(i * 65_536, (i + 1) * 65_536));
      return { size: data.length, body: new ReadableStream({ pull(controller) {
        const next = chunks.shift();
        if (next) controller.enqueue(new Uint8Array(next)); else controller.close();
      } }) };
    },
  };
}

// workerd's streaming SHA-256, for Node.
class DigestStream extends WritableStream<Uint8Array> {
  digest: Promise<ArrayBuffer>;
  constructor(algorithm: string) {
    const hash = crypto.createHash(algorithm.replace('-', '').toLowerCase());
    let done!: (value: ArrayBuffer) => void;
    const digest = new Promise<ArrayBuffer>((resolve) => { done = resolve; });
    super({ write: (chunk) => { hash.update(chunk); }, close: () => { const out = hash.digest(); done(out.buffer.slice(out.byteOffset, out.byteOffset + out.length)); } });
    this.digest = digest;
  }
}

let worker: { fetch(request: Request, env: unknown): Promise<Response> };
beforeAll(async () => {
  Object.defineProperty(globalThis.crypto, 'DigestStream', { value: DigestStream, configurable: true });
  const code = await bundleArtifactEdge();
  // One web-standard module, as Cloudflare runs it.
  expect(code).toMatch(/export\s*\{[^}]*as default/);
  expect(code).not.toMatch(/\bfrom\s*["']node:|\brequire\(/);
  worker = (await import(`data:text/javascript,${encodeURIComponent(code)}`)).default;
});

const claims = (overrides: Partial<ArtifactEdgeClaims> = {}): ArtifactEdgeClaims => ({ key: 'artifacts/o/p/t/review-1/u', bytes: VIDEO.length,
  sha256: SHA, type: 'video/mp4', disposition: 'inline', csp: "sandbox; default-src 'none'", name: 'launch.mp4',
  expiresAt: Date.now() + 3_600_000, ...overrides });

function edge(objects: Record<string, Buffer> = { 'artifacts/o/p/t/review-1/u': VIDEO }) {
  const store = bucket(objects);
  const env = { BUCKET: store, URL_KEY: KEY, ORIGIN: `${ORIGIN}/` };
  const request = (url: string, init?: RequestInit) => worker.fetch(new Request(url.startsWith('https://') ? url : `https://edge.test${url}`, init), env);
  return { store, request };
}

describe('the artifact edge Worker', () => {
  it('says it is live at /', async () => {
    expect(await (await edge().request('/')).text()).toBe(`${ARTIFACT_EDGE_MARKER}\n`);
  });

  it('serves a saved file in byte ranges, as the gateway does', async () => {
    const { request, store } = edge();
    const url = `/${await signArtifactEdgeToken(claims(), KEY)}/launch.mp4`;
    const size = VIDEO.length;
    const full = await request(url);
    expect(full.status).toBe(200);
    expect(Object.fromEntries(full.headers)).toMatchObject({ 'accept-ranges': 'bytes', 'content-length': String(size),
      'content-type': 'video/mp4', 'content-disposition': 'inline; filename="launch.mp4"',
      'content-security-policy': "sandbox; default-src 'none'", 'x-content-type-options': 'nosniff', etag: `"${SHA}"`,
      'access-control-allow-origin': ORIGIN });
    expect(full.headers.get('cache-control')).toMatch(/^private, max-age=(35\d\d|3600), immutable$/);
    expect(Buffer.from(await full.arrayBuffer()).equals(VIDEO)).toBe(true);

    // A range reads only that range from the bucket.
    const middle = await request(url, { headers: { range: 'bytes=1000-1999' } });
    expect(middle.status).toBe(206);
    expect(middle.headers.get('content-range')).toBe(`bytes 1000-1999/${size}`);
    expect(middle.headers.get('content-length')).toBe('1000');
    expect(Buffer.from(await middle.arrayBuffer()).equals(VIDEO.subarray(1000, 2000))).toBe(true);
    expect(store.reads.at(-1)).toEqual({ key: claims().key, range: { offset: 1000, length: 1000 } });

    const open = await request(url, { headers: { range: `bytes=${size - 10}-` } });
    expect(open.status).toBe(206);
    expect(Buffer.from(await open.arrayBuffer()).equals(VIDEO.subarray(size - 10))).toBe(true);
    const suffix = await request(url, { headers: { range: 'bytes=-7' } });
    expect(Buffer.from(await suffix.arrayBuffer()).equals(VIDEO.subarray(size - 7))).toBe(true);

    const unsatisfiable = await request(url, { headers: { range: `bytes=${size}-` } });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get('content-range')).toBe(`bytes */${size}`);
    const multi = await request(url, { headers: { range: 'bytes=0-1,5-6' } });
    expect(multi.status).toBe(200);
    await multi.arrayBuffer();
    // A range for another version of the file is not served as part of this one.
    const stale = await request(url, { headers: { range: 'bytes=0-9', 'if-range': '"other"' } });
    expect(stale.status).toBe(200);
    await stale.arrayBuffer();

    const head = await request(url, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(size));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  it('saves to disk when asked, since a link to another origin cannot say `download`', async () => {
    const { request } = edge();
    const response = await request(`/${await signArtifactEdgeToken(claims({ name: 'a"b.mp4' }), KEY)}/x?download=1`);
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="a_b.mp4"');
    await response.arrayBuffer();
  });

  it('lets the console read a text file and ask for ranges', async () => {
    const preflight = await edge().request('/anything', { method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(preflight.headers.get('access-control-allow-headers')).toBe('range');
    expect((await edge().request('/anything', { method: 'POST' })).status).toBe(405);
  });

  it('opens nothing with a forged, tampered, foreign or expired URL', async () => {
    const { request, store } = edge();
    const token = await signArtifactEdgeToken(claims(), KEY);
    const [body, signature] = token.split('.');
    const other = JSON.parse(Buffer.from(body!, 'base64url').toString());
    const tampered = Buffer.from(JSON.stringify({ ...other, k: 'artifacts/someone-else' })).toString('base64url');
    for (const url of [`/${tampered}.${signature}/x`, `/${body}.${'A'.repeat(signature!.length)}/x`, `/${body}/x`, '/x.y.z/x',
      `/${await signArtifactEdgeToken(claims(), Buffer.from(crypto.randomBytes(32)).toString('base64url'))}/x`,
      `/${await signArtifactEdgeToken(claims({ expiresAt: Date.now() - 1 }), KEY)}/x`]) {
      const response = await request(url);
      expect(response.status, url).toBe(403);
    }
    expect(store.reads).toEqual([]);
  });

  it('refuses an object of the wrong size, and fails a whole download whose bytes differ', async () => {
    const short = edge({ [claims().key]: VIDEO.subarray(1) });
    expect((await short.request(`/${await signArtifactEdgeToken(claims(), KEY)}/x`)).status).toBe(502);
    expect((await short.request(`/${await signArtifactEdgeToken(claims(), KEY)}/x`, { method: 'HEAD' })).status).toBe(502);
    expect((await edge({}).request(`/${await signArtifactEdgeToken(claims(), KEY)}/x`)).status).toBe(404);

    const corrupt = Buffer.from(VIDEO);
    corrupt[corrupt.length - 1]! ^= 1;
    const response = await edge({ [claims().key]: corrupt }).request(`/${await signArtifactEdgeToken(claims(), KEY)}/x`);
    expect(response.status).toBe(200);
    // Every byte but the held-back last chunk arrives, then the stream fails.
    const reader = response.body!.getReader();
    let received = 0;
    await expect((async () => { for (;;) { const { done, value } = await reader.read(); if (done) return; received += value.length; } })())
      .rejects.toThrow(/integrity/);
    expect(received).toBeLessThan(corrupt.length);
  });
});

describe('the gateway hands out edge URLs for saved files', () => {
  async function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-edge-'));
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = await Store.create(path.join(root, 'state.sqlite'));
    cleanup.push(() => store.close());
    const objects = new LocalObjectStore(path.join(root, 'objects'));
    const project = await store.createProject('Artifact edge');
    const task = await store.createTask({ projectId: project.id, title: 'Video', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'v' } });
    const worlds = new WorldRegistry();
    const world = await worlds.create('memory', { taskId: task.id, base: 'main' });
    cleanup.push(() => world.destroy());
    const info = { actions: [{ kind: 'open' as const, label: 'Watch', target: 'out/launch.mp4' },
      { kind: 'open' as const, label: 'Report', target: 'report.html' }, { kind: 'open' as const, label: 'Draft', target: 'draft.mp4' }] };
    const view: TaskView = { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'review', status: 'waiting',
      state: {}, messages: [], actions: [], updatedAt: 1, world: world.handle, reviewInfo: info };
    await store.saveView(task.id, view);
    await world.writeFileBuffer!('out/launch.mp4', VIDEO);
    await world.writeFile('report.html', '<h1>Report</h1>');
    await preserveReviewArtifacts(store, objects, world, task.id, { actions: info.actions.slice(0, 2) });
    await world.writeFileBuffer!('draft.mp4', VIDEO);
    const tokens = new TokenAuthority();
    const caps = ['task:read', 'task:review:execute'];
    const token = (await tokens.mint({ taskId: task.id, profileId: 'test', principal: `task:${task.id}`,
      organizationId: project.organizationId, ceiling: caps, grantorCaps: caps })).token;
    const client = { workflow: { getHandle: () => ({ query: async () => (await store.getTask(task.id))?.lastView }) } } as any;
    const api = new KarmaxApi({ store, tokens, client, worlds, taskQueue: 'test' });
    const gateway = await Gateway.create({ api, store, tokens, client, worlds, objects, taskQueue: 'test',
      bus: new KarmaxBus(), contributions: new ContributionRegistry(), overlays: new Overlays(),
      staticDir: 'web', agentInfo: { provider: 'mock', reason: 'test' } });
    const server = await gateway.listen(await findFreePortFrom(49_950));
    cleanup.push(() => server.close());
    const resolve = async (index: number) => (await (await fetch(`${server.url}/api/tasks/${task.id}/review-action`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ index }) })).json()) as { url: string; mediaType: string };
    // The Worker's bucket is the managed store.
    const r2: ArtifactBucket = {
      head: async (key) => ({ size: (await objects.getStream!(key)).bytes }),
      get: async (key, options) => {
        const stream = await objects.getStream!(key, options?.range ? { start: options.range.offset, end: options.range.offset + options.range.length - 1 } : undefined);
        return { size: stream.bytes, body: ReadableStream.from(stream.body) as ReadableStream<Uint8Array> };
      },
    };
    return { resolve, r2, server };
  }

  it('signs a URL the Worker serves the saved bytes for, with the headers tavya chose', async () => {
    vi.stubEnv('KARMAX_AUTH_SECRET', 'a'.repeat(48));
    vi.stubEnv('KARMAX_OBJECT_STORE', 's3');
    vi.stubEnv('KARMAX_ARTIFACT_EDGE_URL', 'https://tavya-review-artifacts.tavya.workers.dev/');
    const f = await fixture();
    const env = { BUCKET: f.r2, URL_KEY: artifactEdgeKey(), ORIGIN };
    const video = await f.resolve(0);
    expect(video.mediaType).toBe('video/mp4');
    expect(video.url).toMatch(/^https:\/\/tavya-review-artifacts\.tavya\.workers\.dev\/[^/]+\/launch\.mp4$/);
    const played = await worker.fetch(new Request(video.url, { headers: { range: 'bytes=10-19' } }), env);
    expect(played.status).toBe(206);
    expect(Buffer.from(await played.arrayBuffer()).equals(VIDEO.subarray(10, 20))).toBe(true);
    const whole = await worker.fetch(new Request(video.url), env);
    expect(Buffer.from(await whole.arrayBuffer()).equals(VIDEO)).toBe(true);

    // Agent HTML keeps its sandbox on the edge too.
    const page = await worker.fetch(new Request((await f.resolve(1)).url), env);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('content-security-policy')).toMatch(/^sandbox allow-scripts/);
    expect(await page.text()).toBe('<h1>Report</h1>');

    // A file not saved yet still comes from the world, through tavya.
    expect((await f.resolve(2)).url).toMatch(/^\/api\/artifact-content\//);
  });

  it('serves from tavya itself without an edge, a key, or an R2 store', async () => {
    vi.stubEnv('KARMAX_AUTH_SECRET', 'a'.repeat(48));
    vi.stubEnv('KARMAX_OBJECT_STORE', 'local');
    vi.stubEnv('KARMAX_ARTIFACT_EDGE_URL', 'https://tavya-review-artifacts.tavya.workers.dev');
    expect((await (await fixture()).resolve(0)).url).toMatch(/^\/api\/artifact-content\//);
    expect(artifactEdge({ KARMAX_OBJECT_STORE: 's3', KARMAX_ARTIFACT_EDGE_URL: 'https://edge.test' })).toBeUndefined();
    expect(artifactEdge({ KARMAX_OBJECT_STORE: 's3', KARMAX_AUTH_SECRET: 'a'.repeat(48) })).toBeUndefined();
    expect(artifactEdge({ KARMAX_OBJECT_STORE: 's3', KARMAX_AUTH_SECRET: 'a'.repeat(48), KARMAX_ARTIFACT_EDGE_URL: "https://x; script-src *" })).toBeUndefined();
    // The Worker's key is its own: not the auth secret, and the same on every gateway.
    expect(artifactEdgeKey({ KARMAX_AUTH_SECRET: 'a'.repeat(48) })).toBe(artifactEdgeKey({ KARMAX_AUTH_SECRET: 'a'.repeat(48) }));
    expect(artifactEdgeKey({ KARMAX_AUTH_SECRET: 'a'.repeat(48) })).not.toContain('aaaa');
  });

  it('lets the console play, frame and read files from the edge, and from nowhere else', () => {
    const directives = (policy: string) => Object.fromEntries(policy.split('; ').map((d) => { const [name, ...values] = d.split(' '); return [name, values]; }));
    const withEdge = directives(consoleContentSecurityPolicy(undefined, 'https://tavya-review-artifacts.tavya.workers.dev'));
    for (const name of ['media-src', 'frame-src', 'connect-src'])
      expect(withEdge[name], name).toContain('https://tavya-review-artifacts.tavya.workers.dev');
    const without = directives(consoleContentSecurityPolicy(undefined, undefined));
    expect(without['media-src']).toEqual(["'self'", 'blob:']);
    expect(without['frame-src']).toEqual(["'self'", 'blob:']);
    expect(without['connect-src']).toEqual(["'self'"]);
  });
});

describe('deploying the artifact edge', () => {
  const ACCOUNT = '35e42bcea7b0b9f09dce2860d587d418';

  it('reads the bucket\'s jurisdiction from the R2 endpoint', () => {
    expect(r2Jurisdiction(`https://${ACCOUNT}.eu.r2.cloudflarestorage.com`)).toBe('eu');
    expect(r2Jurisdiction(`https://${ACCOUNT}.r2.cloudflarestorage.com`)).toBeUndefined();
  });

  it('binds the bucket, keeps the key secret, and serves it on workers.dev once live', async () => {
    const calls: Array<{ method: string; path: string; body?: any }> = [];
    const fake: typeof fetch = async (input, init) => {
      if (String(input) === `https://${ARTIFACT_EDGE_SCRIPT}.tavya.workers.dev/`) return new Response(`${ARTIFACT_EDGE_MARKER}\n`);
      const route = String(input).replace(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers`, '');
      let body: any;
      if (init?.body instanceof FormData) body = { metadata: JSON.parse(await (init.body.get('metadata') as Blob).text()),
        module: await (init.body.get('worker.js') as Blob).text() };
      else if (typeof init?.body === 'string') body = JSON.parse(init.body);
      calls.push({ method: init?.method ?? 'GET', path: route, ...(body ? { body } : {}) });
      return Response.json({ success: true, result: route === '/subdomain' ? { subdomain: 'tavya' } : {} });
    };
    const url = await deployArtifactEdge({ apiToken: 't', accountId: ACCOUNT, origin: 'https://tavya.io/', bucket: 'tavya-storage',
      jurisdiction: 'eu', secret: KEY, fetch: fake, readyIntervalMs: 1 });
    expect(url).toBe(`https://${ARTIFACT_EDGE_SCRIPT}.tavya.workers.dev`);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([`PUT /scripts/${ARTIFACT_EDGE_SCRIPT}`, 'GET /subdomain',
      `POST /scripts/${ARTIFACT_EDGE_SCRIPT}/subdomain`]);
    expect(calls[0]!.body.metadata.bindings).toEqual([
      { type: 'r2_bucket', name: 'BUCKET', bucket_name: 'tavya-storage', jurisdiction: 'eu' },
      { type: 'plain_text', name: 'ORIGIN', text: 'https://tavya.io' },
      { type: 'secret_text', name: 'URL_KEY', text: KEY },
    ]);
    expect(calls[0]!.body.module).toContain(ARTIFACT_EDGE_MARKER);
    await expect(deployArtifactEdge({ apiToken: 't', accountId: ACCOUNT, origin: 'https://tavya.io', bucket: 'b', secret: '', fetch: fake }))
      .rejects.toThrow(/no auth secret/);
  });

  const deployDir = path.join(process.cwd(), 'deploy');
  it('forwards the edge URL to the app in both deployment profiles', () => {
    for (const file of ['compose.turnkey.yml', 'compose.hosted.yml']) {
      const compose = parse(fs.readFileSync(path.join(deployDir, file), 'utf8')) as { services: { app: { environment: Record<string, string> } } };
      expect(compose.services.app.environment.KARMAX_ARTIFACT_EDGE_URL, file).toBe('${KARMAX_ARTIFACT_EDGE_URL:-}');
    }
  });

  function deployEdge(seed: string, printed: string, token = 'cf-token') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-deploy-'));
    try {
      fs.writeFileSync(path.join(dir, '.turnkey.env'), seed);
      const log = path.join(dir, 'calls');
      let status = 0;
      try {
        execFileSync('sh', ['-c', `. "${path.join(deployDir, 'karmax')}" >/dev/null 2>&1 || true\n`
          + `DEPLOY_DIR="${dir}"; ENV_FILE="${dir}/.turnkey.env"\n`
          + `need_docker() { :; }; wait_ready() { echo ready >> "${log}"; }\n`
          + `dc() { echo "$*" >> "${log}"; case "$1" in run) printf 'bundling\\n%s\\n' '${printed}';; esac; }\n`
          + 'cmd_deploy_artifact_edge'], { encoding: 'utf8', env: { ...process.env, CLOUDFLARE_API_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) { status = (error as { status: number }).status; }
      return { status, env: fs.readFileSync(path.join(dir, '.turnkey.env'), 'utf8'),
        calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [] };
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  it('deploys from a one-off app container, records the URL and restarts the app with it', () => {
    const url = `https://${ARTIFACT_EDGE_SCRIPT}.tavya.workers.dev`;
    const run = deployEdge('KARMAX_DOMAIN=tavya.io\n', url);
    expect(run).toMatchObject({ status: 0, env: `KARMAX_DOMAIN=tavya.io\nKARMAX_ARTIFACT_EDGE_URL=${url}\n` });
    expect(run.calls).toEqual(['run --rm --no-deps -T -e CLOUDFLARE_API_TOKEN -e CLOUDFLARE_ACCOUNT_ID app npm run --silent deploy-artifact-edge',
      'up -d --no-build app', 'ready']);
    expect(deployEdge(`KARMAX_ARTIFACT_EDGE_URL=${url}\n`, url).calls).toHaveLength(1);
    expect(deployEdge('KARMAX_DOMAIN=tavya.io\n', url, '')).toMatchObject({ status: 1, env: 'KARMAX_DOMAIN=tavya.io\n', calls: [] });
    expect(deployEdge('KARMAX_DOMAIN=tavya.io\n', 'deploy-artifact-edge: no bucket')).toMatchObject({ status: 1, env: 'KARMAX_DOMAIN=tavya.io\n' });
  });
});
