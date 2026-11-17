// generate's other providers (wiki features/generate § Other providers):
// fal.ai and Unifically, each off until the operator saves a key and turns
// it on; quoted (fal's pricing API, Unifically's dry run), held on the
// credit, polled, their files downloaded, and settled at what they cost.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { ComputeCreditExhausted, computeCredit, computeMonth, startComputeTrial } from '../src/world/managed-compute.js';
import { GenerationRequestError, GenerationUnavailable, generate, generationJob, parseGenerationRequest, providerModels } from '../src/agent/generation.js';
import { falQuote, outputFiles, saveTaskProvider, taskProvidersView, removeTaskProvider } from '../src/agent/generation-providers.js';

const MP3 = Buffer.from('ID3-song');
const PNG = Buffer.from('png-bytes');
const calls: Array<{ method: string; path: string; body?: any; headers: http.IncomingHttpHeaders }> = [];
const jobs = new Map<string, number>();
let refuse: { status: number; body: unknown } | undefined;
let server: http.Server;
let origin = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const url = req.url!;
      calls.push({ method: req.method!, path: url, body, headers: req.headers });
      const send = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (url === '/files/song-1.mp3' || url === '/files/song-2.mp3') { res.writeHead(200, { 'content-type': 'audio/mpeg' }); return res.end(MP3); }
      if (url === '/files/cat.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
      // fal.ai
      if (url.startsWith('/fal-api/models/pricing')) return send(200, { prices: [{ endpoint_id: 'fal-ai/flux/dev', unit_price: 0.03, unit: 'image', currency: 'USD' }] });
      if (url.startsWith('/fal-api/models/billing-events')) return send(200, { billing_events: [{ request_id: 'req-1', quantity: 2, unit_price: 0.0275, cost_total: 0.055 }] });
      if (url.startsWith('/fal-api/models')) return send(200, { models: [{ endpoint_id: 'fal-ai/minimax-music/v2', metadata: { display_name: 'MiniMax Music', category: 'text-to-audio' } }] });
      if (url.startsWith('/fal-queue/')) {
        if (req.headers.authorization !== 'Key fal-key') return send(401, { detail: 'bad key' });
        if (refuse) { const r = refuse; refuse = undefined; return send(r.status, r.body); }
        if (req.method === 'POST') { jobs.set('req-1', 0); return send(200, { request_id: 'req-1', status: 'IN_QUEUE',
          status_url: `${origin}/fal-queue/fal-ai/flux/requests/req-1/status`, response_url: `${origin}/fal-queue/fal-ai/flux/requests/req-1` }); }
        if (url.endsWith('/status')) { const polls = (jobs.get('req-1') ?? 0) + 1; jobs.set('req-1', polls); return send(200, { status: polls >= 2 ? 'COMPLETED' : 'IN_PROGRESS' }); }
        return send(200, { images: [{ url: `${origin}/files/cat.png`, content_type: 'image/png' }, { url: `${origin}/files/cat.png` }], seed: 7 });
      }
      // Unifically
      if (url.startsWith('/unifically/')) {
        if (req.headers.authorization !== 'Bearer uni-key') return send(401, { success: false, code: 401, data: { message: 'bad key' } });
        if (refuse) { const r = refuse; refuse = undefined; return send(r.status, r.body); }
        if (req.method === 'POST' && body?.dry_run) return send(200, { code: 200, success: true, data: { cost: 0.06 } });
        if (req.method === 'POST') { jobs.set('t-1', 0); return send(200, { code: 200, success: true, data: { task_id: 't-1', status: 'processing' } }); }
        if (url === '/unifically/v1/models') return send(200, { object: 'list', data: [{ id: 'suno-ai/music', display_name: 'Suno Music', category: 'audio' },
          { id: 'openai/gpt-6-sol', category: 'llm' }] });
        if (url === '/unifically/v1/tasks/t-1') {
          const polls = (jobs.get('t-1') ?? 0) + 1; jobs.set('t-1', polls);
          return send(200, { code: 200, success: true, data: polls < 2 ? { task_id: 't-1', status: 'processing', output: null }
            : { task_id: 't-1', status: 'completed', cost: 0.06, input: { secret: 'not echoed' },
              output: { audio_url1: `${origin}/files/song-1.mp3`, audio_url2: `${origin}/files/song-2.mp3`,
                clips: [{ id: 'c1', audio_url: `${origin}/files/song-1.mp3`, title: 'Morning' }, { id: 'c2', audio_url: `${origin}/files/song-2.mp3`, title: 'Morning' }] } } });
        }
      }
      send(404, { detail: `no route ${req.method} ${url}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.KARMAX_FAL_QUEUE_URL = `${origin}/fal-queue`;
  process.env.KARMAX_FAL_API_URL = `${origin}/fal-api`;
  process.env.KARMAX_UNIFICALLY_API_URL = `${origin}/unifically`;
});
afterAll(async () => {
  for (const name of ['KARMAX_FAL_QUEUE_URL', 'KARMAX_FAL_API_URL', 'KARMAX_UNIFICALLY_API_URL']) delete process.env[name];
  await new Promise((resolve) => server.close(resolve));
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); calls.length = 0; jobs.clear(); refuse = undefined; });

/** Files our mock serves over http; real providers serve https. */
const https = (value: string) => value.replace(/^http:/, 'https:');

async function fixture(options: { credit?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-generate-providers-'));
  const store = await Store.create(':memory:', { hosted: true });
  cleanups.push(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const broker = new CredentialBroker(new Vault(dir));
  const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
  if (options.credit !== false) await startComputeTrial(store, organization.id, 'owner', Date.now() - 1000);
  return { store, broker, organization, deps: { store, broker } };
}

describe('generation provider settings', () => {
  it('lists fal.ai and Unifically off with no key; a first key turns fal on and leaves Unifically off', async () => {
    const f = await fixture();
    const month = computeMonth(Date.now());
    expect((await taskProvidersView(f.store, f.broker, month)).map(({ id, enabled, keyConfigured }) => ({ id, enabled, keyConfigured })))
      .toEqual([{ id: 'fal', enabled: false, keyConfigured: false }, { id: 'unifically', enabled: false, keyConfigured: false }]);
    await expect(saveTaskProvider(f.store, f.broker, 'unifically', { enabled: true })).rejects.toThrow(/needs an API key/);
    await expect(saveTaskProvider(f.store, f.broker, 'midjourney', { apiKey: 'x' })).rejects.toThrow(/no generation provider/);
    await saveTaskProvider(f.store, f.broker, 'fal', { apiKey: 'fal-key' });
    await saveTaskProvider(f.store, f.broker, 'unifically', { apiKey: 'uni-key' });
    const view = await taskProvidersView(f.store, f.broker, month);
    expect(view.map(({ id, enabled, keyConfigured }) => ({ id, enabled, keyConfigured })))
      .toEqual([{ id: 'fal', enabled: true, keyConfigured: true }, { id: 'unifically', enabled: false, keyConfigured: true }]);
    expect(view[1]!.tip).toMatch(/Suno’s terms forbid/);
    expect(JSON.stringify(view)).not.toContain('uni-key');
    // Off, it cannot be used.
    await expect(generate(f.deps, f.organization.id, parseGenerationRequest({ provider: 'unifically', model: 'suno-ai/music', input: { mv: 'chirp-hawk' } })))
      .rejects.toThrow(GenerationUnavailable);
    await removeTaskProvider(f.store, f.broker, 'fal');
    expect((await taskProvidersView(f.store, f.broker, month))[0]).toMatchObject({ enabled: false, keyConfigured: false });
  });

  it('takes a model id and the model\'s own input; a bare prompt becomes {prompt}', () => {
    expect(parseGenerationRequest({ provider: 'fal', model: 'fal-ai/flux/dev', prompt: 'a cat' }))
      .toMatchObject({ provider: 'fal', model: 'fal-ai/flux/dev', input: { prompt: 'a cat' } });
    expect(() => parseGenerationRequest({ provider: 'fal', prompt: 'x' })).toThrow(/model is required/);
    expect(() => parseGenerationRequest({ provider: 'fal', model: 'fal-ai/flux/dev', input: [1] })).toThrow(/input must be/);
    expect(() => parseGenerationRequest({ provider: 'replicate', model: 'a/b' })).toThrow(/provider must be one of/);
  });
});

describe('quotes and outputs', () => {
  it('prices a fal request from its unit price × what the input asks for', () => {
    expect(falQuote([{ unit_price: 0.03, unit: 'image' }], { num_images: 3 })).toMatchObject({ basis: 'price-list' });
    expect(falQuote([{ unit_price: 0.03, unit: 'image' }], { num_images: 3 }).usd).toBeCloseTo(0.09);
    expect(falQuote([{ unit_price: 0.15 / 60, unit: 'seconds' }], { duration: '120' }).usd).toBeCloseTo(0.3);
    expect(falQuote([{ unit_price: 0.15, unit: 'minute' }], { music_length_ms: 60_000 }).usd).toBeCloseTo(0.15);
    expect(falQuote([{ unit_price: 0.0011, unit: 'gpu_second' }], {}).basis).toBe('ceiling');
  });

  it('finds the files an output names, once each', () => {
    expect(outputFiles({ audio_url1: 'https://cdn/a.mp3', audio_url2: 'https://cdn/b.mp3', clips: [{ audio_url: 'https://cdn/a.mp3', title: 'x' }],
      images: [{ url: 'https://cdn/c.png' }], page: 'https://suno.com/song/1', mesh: { url: 'https://cdn/m.glb' } }))
      .toEqual(['https://cdn/a.mp3', 'https://cdn/b.mp3', 'https://cdn/c.png', 'https://cdn/m.glb']);
  });
});

describe('a fal.ai request', () => {
  it('is quoted, held, run on the queue without storing its data, downloaded, and booked at what fal billed', async () => {
    const f = await fixture();
    await saveTaskProvider(f.store, f.broker, 'fal', { apiKey: 'fal-key' });
    const started = await generate(f.deps, f.organization.id, parseGenerationRequest({ provider: 'fal', model: 'fal-ai/flux/dev',
      input: { prompt: 'a cat', num_images: 2 } }), { taskId: 'task_1', projectId: 'proj_1' });
    expect(started).toMatchObject({ provider: 'fal', status: 'pending', jobId: 'fal.req-1', quoteUsd: 0.06, quoteBasis: 'price-list', funding: 'credit' });
    const submit = calls.find((call) => call.method === 'POST')!;
    expect(submit).toMatchObject({ path: '/fal-queue/fal-ai/flux/dev', body: { prompt: 'a cat', num_images: 2 } });
    expect(submit.headers['x-fal-store-io']).toBe('0');
    expect((await computeCredit(f.store, f.organization.id)).heldMicros).toBe(120_000);
    expect(await generationJob(f.deps, f.organization.id, 'fal.req-1')).toMatchObject({ status: 'in_progress' });
    // fal's mock serves files over http: real ones are https.
    const record = JSON.parse((await f.store.kvGet('generation-job:fal.req-1'))!);
    expect(record).toMatchObject({ provider: 'fal', taskId: 'task_1', job: { ref: 'req-1' } });
    const done = await generationJob(f.deps, f.organization.id, 'fal.req-1', { content: false });
    expect(done).toMatchObject({ status: 'completed', costUsd: 0.055 });
    expect((await computeCredit(f.store, f.organization.id))).toMatchObject({ heldMicros: 0,
      byProvider: [{ provider: 'fal', usedMicros: 110_000, seconds: 0 }] });
  });

  it('refuses a quote above maxCostUsd, and a 402 is the operator\'s fal balance, not the customer\'s credit', async () => {
    const f = await fixture();
    await saveTaskProvider(f.store, f.broker, 'fal', { apiKey: 'fal-key' });
    await expect(generate(f.deps, f.organization.id, parseGenerationRequest({ provider: 'fal', model: 'fal-ai/flux/dev',
      input: { num_images: 4 }, maxCostUsd: 0.05 }))).rejects.toThrow(/may cost up to \$0\.120, above maxCostUsd/);
    refuse = { status: 402, body: { detail: 'User is locked. Reason: Exhausted balance.' } };
    const refused = await generate(f.deps, f.organization.id, parseGenerationRequest({ provider: 'fal', model: 'fal-ai/flux/dev', input: { prompt: 'x' } }))
      .catch((error) => error);
    expect(refused).toBeInstanceOf(GenerationUnavailable);
    expect(refused.message).toMatch(/fal\.ai balance has run out, not your credit: nothing was charged/);
    expect((await computeCredit(f.store, f.organization.id)).heldMicros).toBe(0);
    refuse = { status: 422, body: { detail: [{ msg: 'field required: prompt' }] } };
    await expect(generate(f.deps, f.organization.id, parseGenerationRequest({ provider: 'fal', model: 'fal-ai/flux/dev', input: {} })))
      .rejects.toBeInstanceOf(GenerationRequestError);
  });

  it('is refused before anything runs when the credit cannot cover the quote', async () => {
    const f = await fixture({ credit: false });
    await saveTaskProvider(f.store, f.broker, 'fal', { apiKey: 'fal-key' });
    await expect(generate(f.deps, f.organization.id, parseGenerationRequest({ provider: 'fal', model: 'fal-ai/flux/dev', input: { prompt: 'x' } })))
      .rejects.toBeInstanceOf(ComputeCreditExhausted);
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('lists fal models by search', async () => {
    const f = await fixture();
    expect(await providerModels(f.deps, 'fal', 'music')).toEqual([{ id: 'fal-ai/minimax-music/v2', name: 'MiniMax Music', category: 'text-to-audio',
      docs: 'https://fal.ai/models/fal-ai/minimax-music/v2/api' }]);
    expect(calls.at(-1)!.path).toBe('/fal-api/models?limit=50&q=music');
  });
});

describe('a Unifically request', () => {
  it('is priced by a dry run, polled, and both songs downloaded once each; it is booked at the task\'s cost', async () => {
    const f = await fixture();
    await saveTaskProvider(f.store, f.broker, 'unifically', { apiKey: 'uni-key', enabled: true });
    const started = await generate(f.deps, f.organization.id, parseGenerationRequest({ provider: 'unifically', model: 'suno-ai/music',
      input: { mv: 'chirp-hawk', custom: false, gpt_description_prompt: 'a calm morning song' } }));
    expect(started).toMatchObject({ jobId: 'unifically.t-1', quoteUsd: 0.06, status: 'in_progress' });
    expect(calls.filter((call) => call.method === 'POST').map((call) => call.body.dry_run)).toEqual([true, undefined]);
    expect(await generationJob(f.deps, f.organization.id, 'unifically.t-1')).toMatchObject({ status: 'in_progress' });
    // The mock's files are http; the download step only takes https from real providers.
    const done = await generationJob(f.deps, f.organization.id, 'unifically.t-1');
    expect(done).toMatchObject({ status: 'completed', costUsd: 0.06 });
    expect(JSON.stringify(done.output)).not.toContain('not echoed');
    expect((await computeCredit(f.store, f.organization.id)).byProvider).toEqual([{ provider: 'unifically', usedMicros: 120_000, seconds: 0 }]);
    // Polled again, it is not booked twice.
    await generationJob(f.deps, f.organization.id, 'unifically.t-1');
    expect((await computeCredit(f.store, f.organization.id)).byProvider).toEqual([{ provider: 'unifically', usedMicros: 120_000, seconds: 0 }]);
    // Another organization cannot see it.
    const other = await f.store.createOrganization({ name: 'Other', ownerUserId: 'eve' });
    await expect(generationJob(f.deps, other.id, 'unifically.t-1')).rejects.toMatchObject({ status: 404 });
  });

  it('lists its models with the operator\'s key, without the language models', async () => {
    const f = await fixture();
    await saveTaskProvider(f.store, f.broker, 'unifically', { apiKey: 'uni-key', enabled: true });
    expect(await providerModels(f.deps, 'unifically', 'suno')).toEqual([{ id: 'suno-ai/music', name: 'Suno Music', category: 'audio', docs: 'https://docs.unifically.com/llms.txt' }]);
  });
});

describe('downloading a finished job\'s files', () => {
  it('saves each distinct file', async () => {
    const f = await fixture();
    await saveTaskProvider(f.store, f.broker, 'unifically', { apiKey: 'uni-key', enabled: true });
    await generate(f.deps, f.organization.id, parseGenerationRequest({ provider: 'unifically', model: 'suno-ai/music', input: { mv: 'chirp-hawk' } }));
    await generationJob(f.deps, f.organization.id, 'unifically.t-1');
    // outputFiles keeps only https URLs: serve the mock's under that name.
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: any, init?: any) => realFetch(String(input).replace(/^https:\/\/127\.0\.0\.1/, 'http://127.0.0.1'), init)) as typeof fetch;
    cleanups.push(() => { globalThis.fetch = realFetch; });
    origin = https(origin);
    try {
      const done = await generationJob(f.deps, f.organization.id, 'unifically.t-1', { content: true });
      expect(done.files).toEqual([{ mediaType: 'audio/mpeg', base64: MP3.toString('base64') }, { mediaType: 'audio/mpeg', base64: MP3.toString('base64') }]);
      expect(done.outputs).toBe(2);
    } finally { origin = origin.replace(/^https:/, 'http:'); }
  });
});
