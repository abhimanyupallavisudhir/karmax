// Media generation on the compute credit (wiki features/media-generation):
// images, video and speech from OpenRouter's models, paid with the
// organization's own OpenRouter key or its key on tavya's account, whose spend
// is booked to the credit.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { organizationScope } from '../src/autonomy/vault-keys.js';
import { saveIncludedModel } from '../src/agent/included-model.js';
import { ComputeCreditExhausted, computeCredit, startComputeTrial } from '../src/world/managed-compute.js';
import { MEDIA_DEFAULT_MODELS, MediaRequestError, MediaUnavailable, generateMedia, mediaJob, mediaJobContent, mediaModels,
  parseMediaRequest, resetMediaCaches } from '../src/agent/media.js';
import { mediaPath, platformToolHandlers, SDK_CONTROL_TOOL_NAMES, TOOL_SCHEMAS } from '../src/agent/tools.js';
import { routeCapability } from '../src/gateway/server.js';
import { TOOL_CAPABILITY } from '../src/platform/capabilities.js';
import { createPlatformMcpServer, type PlatformOps } from '../src/platform/mcp.js';
import { REMOTE_MCP_TOOLS } from '../src/platform/remote-mcp.js';
import { MemoryWorldProvider } from '../src/world/memory.js';
import type { World } from '../src/world/types.js';

const PNG = Buffer.from('89504e470d0a1a0a-not-really-a-png');
const MP3 = Buffer.from('ID3-mp3-bytes');
const MP4 = Buffer.from('ftypmp4-video-bytes');

/** OpenRouter as far as tavya uses it: key management, and the media APIs. */
const keys = new Map<string, { key: string; limit: number | null; usage: number }>();
const calls: Array<{ method: string; path: string; body?: any; auth?: string }> = [];
const jobs = new Map<string, { status: string; polls: number; cost: number }>();
/** Make the next media call answer with this status and error. */
let refuse: { status: number; message: string } | undefined;
let server: http.Server;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const url = req.url!;
      calls.push({ method: req.method!, path: url, body, auth: req.headers.authorization });
      const send = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      // Public catalogues.
      if (url === '/models?output_modalities=speech') return send(200, { data: [
        { id: 'elevenlabs/eleven-flash-v2.5', name: 'Eleven Flash', pricing: { prompt: '0.00004' }, supported_voices: ['george', 'sarah'] }] });
      if (url === '/videos/models') return send(200, { data: [
        { id: 'bytedance/seedance-2.0-fast', supported_durations: [4, 5], supported_resolutions: ['480p'], pricing_skus: { video_tokens: '0.0000042' } }] });
      if (url === '/images/models') return send(200, { data: [
        { id: 'google/gemini-3.1-flash-image', supported_parameters: { aspect_ratio: { type: 'enum', values: ['1:1'] } } }] });
      // Key management, with the management key.
      if (url.startsWith('/keys')) {
        if (req.headers.authorization !== 'Bearer mgmt-key') return send(401, { error: { message: 'bad key' } });
        if (req.method === 'POST') {
          const id = `hash${keys.size + 1}`;
          keys.set(id, { key: `sk-or-${id}`, limit: body.limit ?? null, usage: 0 });
          return send(201, { data: { hash: id }, key: `sk-or-${id}` });
        }
        const key = keys.get(url.split('/')[2]!);
        if (!key) return send(404, { error: { message: 'not found' } });
        if (req.method === 'PATCH') Object.assign(key, body);
        return send(200, { data: { usage: key.usage, limit: key.limit } });
      }
      // Media, with an inference key: a tavya key spends its usage.
      const spender = [...keys.values()].find((key) => `Bearer ${key.key}` === req.headers.authorization);
      if (!spender && req.headers.authorization !== 'Bearer sk-or-own') return send(401, { error: { message: 'bad key' } });
      if (refuse) { const r = refuse; refuse = undefined; return send(r.status, { error: { message: r.message, code: r.status } }); }
      if (req.method === 'POST' && url === '/images') {
        if (spender) spender.usage += 0.04 * (body.n ?? 1);
        return send(200, { created: 0, data: Array.from({ length: body.n ?? 1 }, () => ({ b64_json: PNG.toString('base64'), media_type: 'image/png' })),
          usage: { cost: 0.04 * (body.n ?? 1) } });
      }
      if (req.method === 'POST' && url === '/audio/speech') {
        if (spender) spender.usage += 0.001;
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'x-generation-id': 'gen-tts-1' });
        return res.end(MP3);
      }
      if (req.method === 'POST' && url === '/videos') {
        const id = `gen-vid-${jobs.size + 1}`;
        jobs.set(id, { status: 'pending', polls: 0, cost: 0.3 });
        return send(202, { id, polling_url: `/api/v1/videos/${id}`, status: 'pending' });
      }
      const video = url.match(/^\/videos\/([^/?]+)(\/content)?/);
      if (video && req.method === 'GET') {
        const job = jobs.get(video[1]!);
        if (!job) return send(404, { error: { message: 'not found' } });
        if (video[2]) { res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end(MP4); }
        // Rendered on its second poll.
        if (++job.polls >= 2 && job.status !== 'completed') { job.status = 'completed'; if (spender) spender.usage += job.cost; }
        return send(200, { id: video[1], status: job.status,
          ...(job.status === 'completed' ? { unsigned_urls: [`/videos/${video[1]}/content?index=0`], usage: { cost: job.cost } } : {}) });
      }
      send(404, { error: { message: `no route ${req.method} ${url}` } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  process.env.KARMAX_OPENROUTER_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { delete process.env.KARMAX_OPENROUTER_API_URL; await new Promise((resolve) => server.close(resolve)); });

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  keys.clear(); jobs.clear(); calls.length = 0; refuse = undefined; resetMediaCaches();
});

const T = Date.now();

async function fixture(options: { hosted?: boolean; included?: boolean; credit?: boolean; ownKey?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-media-'));
  const store = await Store.create(':memory:', { hosted: options.hosted ?? true });
  cleanups.push(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const broker = new CredentialBroker(new Vault(dir));
  const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
  if (options.included !== false) await saveIncludedModel(store, broker, { managementKey: 'mgmt-key' });
  if (options.credit !== false) await startComputeTrial(store, organization.id, 'owner', T - 1000);
  if (options.ownKey) await broker.registerHandle(`openrouter:${organization.id}:main`, 'sk-or-own', organizationScope(organization.id));
  return { store, broker, organization, deps: { store, broker } };
}

const mediaCalls = () => calls.filter((call) => !call.path.startsWith('/keys') && !call.path.startsWith('/models'));

describe('media requests', () => {
  it('are checked before anything is spent', () => {
    expect(() => parseMediaRequest({ kind: 'sculpture', prompt: 'x' })).toThrow(/kind must be one of image, video, speech/);
    expect(() => parseMediaRequest({ kind: 'image', prompt: '  ' })).toThrow(/prompt is required/);
    expect(() => parseMediaRequest({ kind: 'image', prompt: 'x', model: 'not a model' })).toThrow(/OpenRouter model id/);
    expect(() => parseMediaRequest({ kind: 'image', prompt: 'x', count: 11 })).toThrow(/count must be an integer from 1 to 10/);
    expect(() => parseMediaRequest({ kind: 'speech', prompt: 'x', format: 'ogg' })).toThrow(/mp3 or pcm/);
    expect(() => parseMediaRequest({ kind: 'video', prompt: 'x', references: [{ url: 'file:///etc/passwd' }] })).toThrow(/https: or base64 data: URL/);
    expect(() => parseMediaRequest({ kind: 'video', prompt: 'x', references: [{ url: 'https://a.example/x.png', role: 'middle' }] })).toThrow(/first_frame, last_frame or reference/);
    expect(parseMediaRequest({ kind: 'video', prompt: ' a cat ', duration: '5', audio: false, model: '',
      references: ['https://a.example/x.png', { url: 'data:image/png;base64,AAAA', role: 'last_frame' }] })).toEqual({
      kind: 'video', prompt: 'a cat', duration: 5, audio: false,
      references: [{ url: 'https://a.example/x.png' }, { url: 'data:image/png;base64,AAAA', role: 'last_frame' }] });
  });
});

describe('media generation', () => {
  it('makes an image on the organization\'s credit, through its key on tavya\'s account, and books what it cost', async () => {
    const f = await fixture();
    const result = await generateMedia(f.deps, f.organization.id, { kind: 'image', prompt: 'a red circle', aspectRatio: '1:1', count: 2 },
      { taskId: 'task_1', projectId: 'proj_1' });
    expect(result).toMatchObject({ kind: 'image', model: MEDIA_DEFAULT_MODELS.image, status: 'completed', funding: 'credit', costUsd: 0.08 });
    expect(result.files).toEqual([{ mediaType: 'image/png', base64: PNG.toString('base64') }, { mediaType: 'image/png', base64: PNG.toString('base64') }]);
    const call = mediaCalls()[0]!;
    expect(call).toMatchObject({ method: 'POST', path: '/images', auth: 'Bearer sk-or-hash1',
      body: { model: MEDIA_DEFAULT_MODELS.image, prompt: 'a red circle', aspect_ratio: '1:1', n: 2, provider: { data_collection: 'deny' } } });
    // $0.08 at OpenRouter's prices is $0.16 of credit, booked to the task.
    const credit = await computeCredit(f.store, f.organization.id);
    expect(credit.byProvider).toEqual([{ provider: 'openrouter', usedMicros: 160_000, seconds: 0 }]);
  });

  it('makes speech in the model\'s first voice unless one is named', async () => {
    const f = await fixture();
    const result = await generateMedia(f.deps, f.organization.id, { kind: 'speech', prompt: 'Hello from tavya.' });
    expect(result).toMatchObject({ status: 'completed', model: 'elevenlabs/eleven-flash-v2.5', files: [{ mediaType: 'audio/mpeg', base64: MP3.toString('base64') }] });
    expect(mediaCalls()[0]).toMatchObject({ path: '/audio/speech', body: { input: 'Hello from tavya.', voice: 'george', response_format: 'mp3' } });
    await generateMedia(f.deps, f.organization.id, { kind: 'speech', prompt: 'Hi', voice: 'sarah', format: 'pcm' });
    expect(mediaCalls()[1]!.body).toMatchObject({ voice: 'sarah', response_format: 'pcm' });
  });

  it('starts a video, reports it rendering, then completed with its bytes; frames and references go where OpenRouter wants them', async () => {
    const f = await fixture();
    const started = await generateMedia(f.deps, f.organization.id, { kind: 'video', prompt: 'the flower sways', duration: 5,
      references: [{ url: 'https://a.example/first.png', role: 'first_frame' }, { url: 'https://a.example/style.png' }] }, { taskId: 'task_v' });
    expect(started).toMatchObject({ kind: 'video', status: 'pending', jobId: 'gen-vid-1', model: MEDIA_DEFAULT_MODELS.video });
    expect(mediaCalls()[0]!.body).toMatchObject({ duration: 5,
      frame_images: [{ type: 'image_url', image_url: { url: 'https://a.example/first.png' }, frame_type: 'first_frame' }],
      input_references: [{ type: 'image_url', image_url: { url: 'https://a.example/style.png' } }] });
    expect(await mediaJob(f.deps, f.organization.id, 'gen-vid-1')).toMatchObject({ status: 'pending' });
    const done = await mediaJob(f.deps, f.organization.id, 'gen-vid-1', { content: true });
    expect(done).toMatchObject({ status: 'completed', costUsd: 0.3, outputs: 1, files: [{ mediaType: 'video/mp4', base64: MP4.toString('base64') }] });
    expect(Buffer.from(await (await mediaJobContent(f.deps, f.organization.id, 'gen-vid-1')).arrayBuffer())).toEqual(MP4);
    expect((await computeCredit(f.store, f.organization.id)).byProvider).toEqual([{ provider: 'openrouter', usedMicros: 600_000, seconds: 0 }]);
    // Another organization cannot see the job.
    const other = await f.store.createOrganization({ name: 'Other', ownerUserId: 'owner' });
    await startComputeTrial(f.store, other.id, 'owner', T - 1000);
    await expect(mediaJob(f.deps, other.id, 'gen-vid-1')).rejects.toMatchObject({ name: 'MediaRequestError', status: 404 });
    await expect(mediaJobContent(f.deps, other.id, 'gen-vid-1')).rejects.toBeInstanceOf(MediaRequestError);
  });

  it('uses the organization\'s own OpenRouter key first, books nothing on the credit, and works where tavya offers no included model', async () => {
    const f = await fixture({ ownKey: true, credit: false });
    const result = await generateMedia(f.deps, f.organization.id, { kind: 'image', prompt: 'x' });
    expect(result.funding).toBe('own');
    expect(mediaCalls()[0]!.auth).toBe('Bearer sk-or-own');
    expect(keys.size).toBe(0);
    const self = await fixture({ hosted: false, included: false, credit: false, ownKey: true });
    expect((await generateMedia(self.deps, self.organization.id, { kind: 'image', prompt: 'x' })).funding).toBe('own');
  });

  it('says what is missing when nothing can pay, and waits as Out of compute when the credit is spent', async () => {
    const none = await fixture({ included: false, credit: false });
    await expect(generateMedia(none.deps, none.organization.id, { kind: 'image', prompt: 'x' }))
      .rejects.toThrow(MediaUnavailable);
    const broke = await fixture({ credit: false });
    await expect(generateMedia(broke.deps, broke.organization.id, { kind: 'image', prompt: 'x' })).rejects.toBeInstanceOf(ComputeCreditExhausted);
    expect(mediaCalls()).toHaveLength(0);
    // The key's limit (which follows the credit) refuses mid-way: OpenRouter's 402.
    const f = await fixture();
    refuse = { status: 402, message: 'Key limit exceeded' };
    await expect(generateMedia(f.deps, f.organization.id, { kind: 'image', prompt: 'x' })).rejects.toBeInstanceOf(ComputeCreditExhausted);
    refuse = { status: 400, message: 'duration must be one of 4, 5' };
    await expect(generateMedia(f.deps, f.organization.id, { kind: 'video', prompt: 'x', duration: 9 }))
      .rejects.toThrow(/OpenRouter: duration must be one of 4, 5/);
  });

  it('lists each kind\'s models with what they support and cost, marking the default', async () => {
    expect(await mediaModels('video')).toEqual([{ id: 'bytedance/seedance-2.0-fast', pricing: { video_tokens: '0.0000042' },
      durations: [4, 5], resolutions: ['480p'], default: true }]);
    expect((await mediaModels('speech'))[0]).toMatchObject({ voices: ['george', 'sarah'], default: true });
    expect((await mediaModels('image'))[0]).toMatchObject({ parameters: { aspect_ratio: { values: ['1:1'] } }, default: true });
  });
});

describe('the generate_media tool', () => {
  const tool = (world: World, platformRequest: (method: string, path: string, body?: any) => Promise<unknown>) =>
    platformToolHandlers(world as any, { platformRequest, emit: () => {} } as any).generate_media!;

  it('is a turn-local tool that needs connection:use, offered on tavya\'s /mcp too', () => {
    expect(SDK_CONTROL_TOOL_NAMES.has('generate_media')).toBe(true);
    expect(TOOL_SCHEMAS.find((schema) => schema.name === 'generate_media')?.parameters.required).toEqual(['organization_id', 'path']);
    expect(TOOL_CAPABILITY.generate_media).toBe('connection:use');
    expect(routeCapability('POST', '/api/organizations/org_1/media')).toBe('connection:use');
    expect(routeCapability('GET', '/api/organizations/org_1/media/gen-vid-1/content')).toBe('connection:use');
    expect(routeCapability('GET', '/api/media/models')).toBe('none');
    expect(REMOTE_MCP_TOOLS.has('generate_media')).toBe(true);
  });

  it('names the files it saves after the path asked for', () => {
    expect(mediaPath('assets/hero.png', 'image/png', 0, 1)).toBe('assets/hero.png');
    expect(mediaPath('assets/hero', 'image/webp', 0, 1)).toBe('assets/hero.webp');
    expect(mediaPath('assets/hero.png', 'image/png', 2, 3)).toBe('assets/hero-3.png');
    expect(mediaPath('out.d/voice', 'audio/mpeg', 0, 1)).toBe('out.d/voice.mp3');
  });

  it('saves images into the world, sending input images from it as data URLs', async () => {
    const world = await new MemoryWorldProvider().create({ taskId: 'media-images', base: 'main' });
    await world.writeFile('in/logo.png', 'PNGDATA');
    const requests: any[] = [];
    const result = JSON.parse(await tool(world, async (method, requestPath, body) => {
      requests.push({ method, requestPath, body });
      return { status: 'completed', model: 'm/x', costUsd: 0.04, funding: 'credit',
        files: [{ mediaType: 'image/png', base64: PNG.toString('base64') }, { mediaType: 'image/png', base64: PNG.toString('base64') }] };
    })({ organization_id: 'org_1', kind: 'image', prompt: 'edit it', path: 'out/pic.png', count: 2,
      references: [{ path: 'in/logo.png' }, { url: 'https://a.example/b.png' }] }));
    expect(result).toEqual({ status: 'completed', model: 'm/x', costUsd: 0.04, paidFrom: 'credit', saved: ['out/pic.png', 'out/pic-2.png'] });
    expect(await world.readFileBuffer('out/pic-2.png')).toEqual(PNG);
    expect(requests[0]).toMatchObject({ method: 'POST', requestPath: '/api/organizations/org_1/media', body: { kind: 'image', count: 2,
      references: [{ url: `data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}` }, { url: 'https://a.example/b.png' }] } });
  });

  it('waits for a video and saves it, or hands back its job to collect later', async () => {
    process.env.KARMAX_MEDIA_POLL_MS = '1';
    cleanups.push(() => { delete process.env.KARMAX_MEDIA_POLL_MS; });
    const world = await new MemoryWorldProvider().create({ taskId: 'media-video', base: 'main' });
    let polls = 0;
    const request = async (method: string, requestPath: string) => {
      if (method === 'POST') return { status: 'pending', jobId: 'gen-vid-9', model: 'v/x', funding: 'credit' };
      expect(requestPath).toBe('/api/organizations/org_1/media/gen-vid-9?content=1');
      return ++polls < 3 ? { status: 'in_progress', jobId: 'gen-vid-9', model: 'v/x' }
        : { status: 'completed', jobId: 'gen-vid-9', model: 'v/x', costUsd: 0.3, files: [{ mediaType: 'video/mp4', base64: MP4.toString('base64') }] };
    };
    expect(JSON.parse(await tool(world, request)({ organization_id: 'org_1', kind: 'video', prompt: 'p', path: 'clip' })))
      .toMatchObject({ status: 'completed', saved: ['clip.mp4'], costUsd: 0.3 });
    expect(await world.readFileBuffer('clip.mp4')).toEqual(MP4);
    polls = 0;
    expect(JSON.parse(await tool(world, request)({ organization_id: 'org_1', kind: 'video', prompt: 'p', path: 'clip2.mp4', wait_minutes: 0 })))
      .toMatchObject({ status: 'pending', job_id: 'gen-vid-9', next: expect.stringMatching(/call generate_media again with this job_id/) });
    expect(JSON.parse(await tool(world, request)({ organization_id: 'org_1', job_id: 'gen-vid-9', path: 'clip2.mp4' })))
      .toMatchObject({ status: 'completed', saved: ['clip2.mp4'] });
  });
});

describe('generate_media on tavya\'s /mcp', () => {
  it('answers with the image or audio itself, and a video\'s download address once rendered', async () => {
    const answers: Record<string, unknown> = {
      'POST /api/organizations/org_1/media': { status: 'completed', kind: 'image', model: 'm/x', files: [{ mediaType: 'image/png', base64: 'AAAA' }] },
      'GET /api/organizations/org_1/media/gen-vid-1': { status: 'completed', kind: 'video', jobId: 'gen-vid-1', outputs: 1 },
    };
    const ops = { platformRequest: async (method: string, requestPath: string) => answers[`${method} ${requestPath}`] } as unknown as PlatformOps;
    const server = createPlatformMcpServer(ops, { tools: REMOTE_MCP_TOOLS });
    const handler = (server as any)._registeredTools.generate_media.handler ?? (server as any)._registeredTools.generate_media.callback;
    const image = await handler({ organizationId: 'org_1', kind: 'image', prompt: 'x' }, {});
    expect(image.content[0]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' });
    expect(JSON.parse(image.content[1].text)).toEqual({ status: 'completed', kind: 'image', model: 'm/x' });
    const video = await handler({ organizationId: 'org_1', jobId: 'gen-vid-1' }, {});
    expect(JSON.parse(video.content[0].text).downloads).toEqual(['/api/organizations/org_1/media/gen-vid-1/content?index=0']);
    // Inside a task, karmax_control's tool saves into the world instead.
    expect((createPlatformMcpServer(ops) as any)._registeredTools.generate_media).toBeUndefined();
  });
});

describe('the media routes', () => {
  it('generate for an agent of the organization with connection:use, stream a video, and refuse anyone else', async () => {
    const { Gateway } = await import('../src/gateway/server.js');
    const { KarmaxApi } = await import('../src/platform/api.js');
    const { TokenAuthority } = await import('../src/platform/tokens.js');
    const { KarmaxBus } = await import('../src/contrib/bus.js');
    const { ContributionRegistry } = await import('../src/contrib/registry.js');
    const { Overlays } = await import('../src/store/overlays.js');
    const { WorldRegistry } = await import('../src/world/registry.js');
    const { findFreePortFrom } = await import('../src/util/ports.js');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'media-gateway-'));
    const store = await Store.create(':memory:');
    const tokens = new TokenAuthority();
    const broker = new CredentialBroker(new Vault(path.join(home, 'vault')));
    const org = (await store.createOrganization({ name: 'Team', ownerUserId: 'alice' })).id;
    const otherOrg = (await store.createOrganization({ name: 'Other', ownerUserId: 'eve' })).id;
    const project = (await store.createProject('Project', {}, org)).id;
    const task = await store.createTask({ projectId: project, title: 'Make a video', workflow: 'just-do', workflowVersion: '1.0.0',
      params: { prompt: 'x' }, createdBy: { kind: 'user', userId: 'alice' } });
    await broker.registerHandle(`openrouter:${org}:main`, 'sk-or-own', organizationScope(org));
    const mint = async (caps: string[]) => (await tokens.mint({ taskId: task.id, profileId: 'developer', role: 'do', executionId: 'turn',
      executionAttempt: 1, principal: 'user:alice', projectId: project, organizationId: org, ceiling: caps, grantorCaps: caps })).token;
    const agent = await mint(['task:read', 'connection:use']);
    const reader = await mint(['task:read']);
    const client = { workflow: { getHandle: () => ({ signal: async () => {}, query: async () => ({}) }) } } as any;
    const worlds = new WorldRegistry();
    const api = new KarmaxApi({ store, tokens, client, worlds, taskQueue: 'test', contentDir: home });
    const gateway = await Gateway.create({ store, tokens, api, client, worlds, broker,
      bus: new KarmaxBus(), contributions: new ContributionRegistry(), overlays: new Overlays(),
      taskQueue: 'test', staticDir: home, agentInfo: { provider: 'mock', reason: 'test' },
      identity: { sessionActive: async () => false, connectOrganizationNames: () => {}, listUsers: () => [], session: async () => undefined } as any,
      authorization: { capabilitiesAsync: async () => [], audit: () => {} } as any });
    const running = await gateway.listen(await findFreePortFrom(49_400));
    cleanups.push(async () => { await running.close(); await store.close(); fs.rmSync(home, { recursive: true, force: true }); });
    const call = (p: string, token: string, body?: unknown) => fetch(running.url + p, { method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) });

    const image = await call(`/api/organizations/${org}/media`, agent, { kind: 'image', prompt: 'a red circle' });
    expect(image.status).toBe(200);
    expect(await image.json()).toMatchObject({ status: 'completed', funding: 'own', files: [{ mediaType: 'image/png' }] });
    expect((await call(`/api/organizations/${org}/media`, agent, { kind: 'image', prompt: '' })).status).toBe(400);
    expect((await call(`/api/organizations/${org}/media`, reader, { kind: 'image', prompt: 'x' })).status).toBe(403);
    expect((await call(`/api/organizations/${otherOrg}/media`, agent, { kind: 'image', prompt: 'x' })).status).toBe(403);

    const started = await call(`/api/organizations/${org}/media`, agent, { kind: 'video', prompt: 'the flower sways' });
    expect(started.status).toBe(202);
    const { jobId } = await started.json() as { jobId: string };
    expect(JSON.parse((await store.kvGet(`media-job:${jobId}`))!)).toMatchObject({ organizationId: org, taskId: task.id, projectId: project });
    expect(await (await call(`/api/organizations/${org}/media/${jobId}`, agent)).json()).toMatchObject({ status: 'pending' });
    expect(await (await call(`/api/organizations/${org}/media/${jobId}`, agent)).json()).toMatchObject({ status: 'completed', outputs: 1 });
    const content = await call(`/api/organizations/${org}/media/${jobId}/content?index=0`, agent);
    expect(content.headers.get('content-type')).toBe('video/mp4');
    expect(Buffer.from(await content.arrayBuffer())).toEqual(MP4);
    expect((await call(`/api/organizations/${org}/media/gen-vid-404`, agent)).status).toBe(404);
    const models = await fetch(`${running.url}/api/media/models?kind=speech`, { headers: { authorization: `Bearer ${reader}` } });
    expect(await models.json()).toMatchObject({ kind: 'speech', models: [{ id: 'elevenlabs/eleven-flash-v2.5' }] });
  });
});
