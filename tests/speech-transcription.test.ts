// Server-side dictation (wiki features/push-and-voice § Server-side dictation):
// a phrase of audio → its words, through OpenRouter's transcription API on the
// organization's credit (held, then booked) or its own key, refused cleanly
// when the credit is spent, rate-limited per person, and never stored.
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
import { GenerationUnavailable } from '../src/agent/generation.js';
import { ComputeCreditExhausted, computeCredit, startComputeTrial } from '../src/world/managed-compute.js';
import { TRANSCRIPTION_FALLBACK_MODEL, TRANSCRIPTION_KEYTERMS, TRANSCRIPTION_MODEL, TranscriptionAdmission, checkAudio,
  resetTranscriptionCaches, transcribe, wavSeconds } from '../src/agent/transcription.js';
import { routeCapability } from '../src/gateway/server.js';
import { PLATFORM_API_CATALOG } from '../src/platform/catalog.js';

/** A recognizable phrase of "audio": the stub answers with the words it carries. */
const phrase = (words: string) => Buffer.concat([Buffer.from('\x1aE\xdf\xa3webm-opus:'), Buffer.from(words)]);
/** A WAV header for `seconds` of 16 kHz 16-bit mono, then that many bytes. */
function wav(seconds: number): Buffer {
  const data = Math.round(seconds * 32_000);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24); header.writeUInt32LE(32_000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data, 40);
  return Buffer.concat([header, Buffer.alloc(data)]);
}

const keys = new Map<string, { key: string; limit: number | null; usage: number }>();
const calls: Array<{ path: string; body?: any; auth?: string; heldMicros?: number | null }> = [];
/** The next transcription answers so (once per entry). */
const refusals: Array<{ status: number; message: string }> = [];
/** While a transcription runs: what the organization has on hold (the stub reads it). */
let holdProbe: (() => Promise<number | null>) | undefined;
let server: http.Server;
const COST = 0.0005; // what one phrase costs at OpenRouter
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const url = req.url!;
      const send = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (url === '/models?output_modalities=transcription') return send(200, { data: [
        // $0.005 a minute: 30 s is $0.0025.
        { id: TRANSCRIPTION_MODEL, pricing: { prompt: '0.0000833333', completion: '0' } },
        { id: TRANSCRIPTION_FALLBACK_MODEL, pricing: { prompt: '0.0000583333', completion: '0' } }] });
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
      if (req.method === 'POST' && url === '/audio/transcriptions') {
        calls.push({ path: url, body, auth: req.headers.authorization, heldMicros: holdProbe ? await holdProbe() : undefined });
        const spender = [...keys.values()].find((key) => `Bearer ${key.key}` === req.headers.authorization);
        if (!spender && req.headers.authorization !== 'Bearer sk-or-own') return send(401, { error: { message: 'bad key' } });
        const refusal = refusals.shift();
        if (refusal) return send(refusal.status, { error: { message: refusal.message, code: refusal.status } });
        if (spender) spender.usage += COST;
        const audio = Buffer.from(body.input_audio.data, 'base64').toString('latin1');
        return send(200, { text: ` ${audio.split('webm-opus:')[1] ?? ''} `, usage: { seconds: 4.2, cost: COST } });
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
  keys.clear(); calls.length = 0; refusals.length = 0; holdProbe = undefined; resetTranscriptionCaches();
});

const T = Date.now();
async function fixture(options: { included?: boolean; credit?: boolean; ownKey?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-speech-'));
  const store = await Store.create(':memory:', { hosted: true });
  cleanups.push(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const broker = new CredentialBroker(new Vault(dir));
  const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
  if (options.included !== false) await saveIncludedModel(store, broker, { managementKey: 'mgmt-key' });
  if (options.credit !== false) await startComputeTrial(store, organization.id, 'owner', T - 1000);
  if (options.ownKey) await broker.registerHandle(`openrouter:${organization.id}:main`, 'sk-or-own', organizationScope(organization.id));
  return { store, broker, dir, organization, deps: { store, broker } };
}
/** Booking happens after the words are answered: wait for it. */
async function settled(store: Store, organizationId: string) {
  for (let i = 0; i < 100; i++) {
    const credit = await computeCredit(store, organizationId);
    if (credit.heldMicros === 0 && credit.usedMicros > 0) return credit;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return computeCredit(store, organizationId);
}

describe('the audio', () => {
  it('is checked before anything is spent: format, size, length, language', () => {
    expect(checkAudio({ audio: phrase('x'), contentType: 'audio/webm;codecs=opus' })).toEqual({ format: 'webm' });
    expect(checkAudio({ audio: phrase('x'), contentType: 'audio/ogg; codecs=opus', language: 'en-GB' })).toEqual({ format: 'ogg', language: 'en' });
    expect(checkAudio({ audio: wav(3), contentType: 'audio/wav' })).toEqual({ format: 'wav' });
    expect(checkAudio({ audio: phrase('x'), contentType: 'audio/mp4' }).format).toBe('m4a');
    expect(() => checkAudio({ audio: phrase('x'), contentType: 'video/webm' })).toThrow(expect.objectContaining({ status: 415 }));
    expect(() => checkAudio({ audio: phrase('x'), contentType: '' })).toThrow(expect.objectContaining({ status: 415 }));
    expect(() => checkAudio({ audio: Buffer.alloc(0), contentType: 'audio/webm' })).toThrow(/body is empty/);
    expect(() => checkAudio({ audio: Buffer.alloc(1024 * 1024 + 1), contentType: 'audio/webm' })).toThrow(expect.objectContaining({ status: 413 }));
    expect(() => checkAudio({ audio: wav(31), contentType: 'audio/wav' })).toThrow(/at most 30 s/);
    expect(() => checkAudio({ audio: phrase('x'), contentType: 'audio/webm', language: 'english' })).toThrow(/language code/);
    expect(wavSeconds(wav(2.5))).toBeCloseTo(2.5);
    // A recorder that streams leaves the data size unknown: what came counts.
    const streamed = wav(4); streamed.writeUInt32LE(0xffffffff, 40);
    expect(wavSeconds(streamed)).toBeCloseTo(4);
    expect(wavSeconds(phrase('not a wav'))).toBeUndefined();
  });
});

describe('transcription', () => {
  it('returns the words, holding the most 30 s can cost on the credit while it runs, then books what it cost', async () => {
    const f = await fixture();
    await f.store.upsertRepository({ organizationId: f.organization.id, provider: 'github', owner: 'acme', name: 'rocket-shop',
      sshUrl: 'git@github.com:acme/rocket-shop.git', defaultBranch: 'main', private: true });
    await f.store.createProject('Lunar Lander', {}, f.organization.id);
    holdProbe = async () => (await computeCredit(f.store, f.organization.id)).heldMicros;
    const result = await transcribe(f.deps, f.organization.id, { audio: phrase('Open a PR on rocket-shop.'), contentType: 'audio/webm;codecs=opus', language: 'en-US' });
    expect(result).toMatchObject({ text: 'Open a PR on rocket-shop.', model: TRANSCRIPTION_MODEL, funding: 'credit', costUsd: COST, seconds: 4.2 });
    const call = calls[0]!;
    expect(call.auth).toBe('Bearer sk-or-hash1');
    expect(call.body).toMatchObject({ model: TRANSCRIPTION_MODEL, language: 'en', input_audio: { format: 'webm', data: phrase('Open a PR on rocket-shop.').toString('base64') },
      provider: { zdr: true, data_collection: 'deny' } });
    // tavya's jargon, then the organization's own names.
    expect(call.body.keyterms.slice(0, TRANSCRIPTION_KEYTERMS.length)).toEqual([...TRANSCRIPTION_KEYTERMS]);
    expect(call.body.keyterms).toEqual(expect.arrayContaining(['rocket-shop', 'Lunar Lander']));
    // Held while it ran: 30 s at $0.0000833/s = $0.0025, ×2 on the credit.
    expect(call.heldMicros).toBe(5_000);
    const credit = await settled(f.store, f.organization.id);
    expect(credit.heldMicros).toBe(0);
    expect(credit.byProvider).toEqual([{ provider: 'openrouter', usedMicros: 1_000, seconds: 0 }]);
  });

  it('writes tavya as tavya, which recognizers capitalise like a name', async () => {
    const f = await fixture({ ownKey: true, credit: false });
    const result = await transcribe(f.deps, f.organization.id, { audio: phrase('Tavya, ask TAVYA why tavya\'s Tavyan task failed.'), contentType: 'audio/webm' });
    expect(result.text).toBe('tavya, ask tavya why tavya\'s Tavyan task failed.');
  });

  it('pays with the organization\'s own OpenRouter key first, holding and booking nothing', async () => {
    const f = await fixture({ ownKey: true, credit: false });
    const result = await transcribe(f.deps, f.organization.id, { audio: phrase('Hello.'), contentType: 'audio/webm' });
    expect(result).toMatchObject({ text: 'Hello.', funding: 'own' });
    expect(calls[0]!.auth).toBe('Bearer sk-or-own');
    expect(keys.size).toBe(0);
  });

  it('refuses as Out of credits before sending anything when the credit is spent, and says what is missing when nothing can pay', async () => {
    const broke = await fixture({ credit: false });
    const spent = await transcribe(broke.deps, broke.organization.id, { audio: phrase('x'), contentType: 'audio/webm' }).catch((error) => error);
    expect(spent).toBeInstanceOf(ComputeCreditExhausted);
    expect(calls).toHaveLength(0);
    const none = await fixture({ included: false, credit: false });
    await expect(transcribe(none.deps, none.organization.id, { audio: phrase('x'), contentType: 'audio/webm' })).rejects.toBeInstanceOf(GenerationUnavailable);
  });

  it('tells tavya\'s own empty OpenRouter balance from the customer\'s credit, and releases the hold', async () => {
    const f = await fixture();
    refusals.push({ status: 402, message: 'Insufficient credits' });
    const error = await transcribe(f.deps, f.organization.id, { audio: phrase('x'), contentType: 'audio/webm' }).catch((caught) => caught);
    expect(error).toBeInstanceOf(GenerationUnavailable);
    expect(error.message).toMatch(/OpenRouter balance has run out, not your credit/);
    for (let i = 0; i < 50 && (await computeCredit(f.store, f.organization.id)).heldMicros; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await computeCredit(f.store, f.organization.id)).heldMicros).toBe(0);
  });

  it('falls back to the next model once when the first one\'s provider is down', async () => {
    const f = await fixture();
    refusals.push({ status: 503, message: 'provider unavailable' });
    const result = await transcribe(f.deps, f.organization.id, { audio: phrase('Still here.'), contentType: 'audio/webm' });
    expect(result).toMatchObject({ text: 'Still here.', model: TRANSCRIPTION_FALLBACK_MODEL });
    expect(calls.map((call) => call.body.model)).toEqual([TRANSCRIPTION_MODEL, TRANSCRIPTION_FALLBACK_MODEL]);
  });

  it('never stores the audio: nothing of it in the database, the vault or on disk', async () => {
    const f = await fixture();
    const marker = 'zebra-quokka-unique-words';
    const audio = phrase(marker);
    await transcribe(f.deps, f.organization.id, { audio, contentType: 'audio/webm' });
    await settled(f.store, f.organization.id);
    const everything = JSON.stringify(await f.store.kvEntries(''));
    expect(everything).not.toContain(marker);
    expect(everything).not.toContain(audio.toString('base64'));
    // Every row of every table.
    const tables = await (f.store as any).readRows("SELECT name FROM sqlite_master WHERE type='table'", []) as Array<{ name: string }>;
    for (const { name } of tables) {
      const rows = JSON.stringify(await (f.store as any).readRows(`SELECT * FROM "${name}"`, []));
      expect(rows, name).not.toContain(marker);
    }
    const files: string[] = [];
    (function walk(dir: string) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else files.push(full); } })(f.dir);
    for (const file of files) expect(fs.readFileSync(file).includes(marker), file).toBe(false);
  });

  it('admits a person a phrase every 1.5 s for a minute and 900 an hour; each person on their own', () => {
    const admission = new TranscriptionAdmission();
    const t = 1_000_000;
    for (let i = 0; i < 40; i++) expect(admission.admit('user:alice', t + i)).toBe(true);
    expect(admission.admit('user:alice', t + 41)).toBe(false);
    expect(admission.admit('user:bob', t + 41)).toBe(true);
    expect(admission.admit('user:alice', t + 60_001)).toBe(true);
    const hourly = new TranscriptionAdmission();
    let admitted = 0;
    for (let minute = 0; minute < 60; minute++) for (let i = 0; i < 40; i++) if (hourly.admit('user:carol', t + minute * 60_000 + i)) admitted++;
    expect(admitted).toBe(900);
  });
});

describe('POST /api/speech/transcriptions', () => {
  it('is in the API catalogue, for any member of the organization', () => {
    expect(routeCapability('POST', '/api/speech/transcriptions')).toBe('organization:read');
    expect(JSON.stringify(PLATFORM_API_CATALOG)).toContain('POST /api/speech/transcriptions');
  });

  it('turns a person\'s phrase into words on their organization\'s credit, and answers refusals with their own statuses', async () => {
    const { Gateway } = await import('../src/gateway/server.js');
    const { TokenAuthority } = await import('../src/platform/tokens.js');
    const { KarmaxBus } = await import('../src/contrib/bus.js');
    const { ContributionRegistry } = await import('../src/contrib/registry.js');
    const { Overlays } = await import('../src/store/overlays.js');
    const { WorldRegistry } = await import('../src/world/registry.js');
    const { findFreePortFrom } = await import('../src/util/ports.js');
    const f = await fixture();
    const broke = (await f.store.createOrganization({ name: 'Broke', ownerUserId: 'alice' })).id;
    const other = (await f.store.createOrganization({ name: 'Other', ownerUserId: 'eve' })).id;
    const tokens = new TokenAuthority();
    fs.writeFileSync(path.join(f.dir, 'index.html'), '<!doctype html>');
    const gateway = await Gateway.create({ store: f.store, tokens, api: {} as any, client: {} as any, worlds: new WorldRegistry(), broker: f.broker,
      bus: new KarmaxBus(), contributions: new ContributionRegistry(), overlays: new Overlays(),
      taskQueue: 'test', staticDir: f.dir, agentInfo: { provider: 'mock', reason: 'test' } } as any);
    const running = await gateway.listen(await findFreePortFrom(49_600));
    cleanups.push(async () => { await running.close(); });
    // A signed-in person: Alice reads her two organizations, nothing more.
    const alice = (await tokens.mintPrincipal('user:alice', ['organization:read'], undefined, undefined, f.organization.id)).token;
    const aliceBroke = (await tokens.mintPrincipal('user:alice', ['organization:read'], undefined, undefined, broke)).token;
    const post = (token: string, organizationId: string, audio: Buffer | string, type = 'audio/webm;codecs=opus', query = '') =>
      fetch(`${running.url}/api/speech/transcriptions?organizationId=${organizationId}${query}`, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': type }, body: audio });

    const words = await post(alice, f.organization.id, phrase('Merge the panagent branch.'), undefined, '&language=en-GB');
    expect(words.status).toBe(200);
    expect(await words.json()).toEqual({ text: 'Merge the panagent branch.', costUsd: COST, seconds: 4.2 });
    expect(calls[0]!.body).toMatchObject({ language: 'en' });
    expect((await post(alice, f.organization.id, phrase('x'), 'text/plain')).status).toBe(415);
    expect((await post(alice, f.organization.id, '')).status).toBe(400);
    expect((await post(alice, f.organization.id, Buffer.alloc(4 * 1024 * 1024), 'audio/wav')).status).toBe(413);
    expect((await post(alice, f.organization.id, wav(45), 'audio/wav')).status).toBe(413);
    // Not hers to spend.
    expect((await post(alice, other, phrase('x'))).status).toBe(403);
    const spent = await post(aliceBroke, broke, phrase('x'));
    expect(spent.status).toBe(402);
    expect(((await spent.json()) as { error: string }).error).toMatch(/Out of credits/);
    expect((await fetch(`${running.url}/api/speech/transcriptions?organizationId=${f.organization.id}`, { headers: { authorization: `Bearer ${alice}` } })).status).toBe(405);
    // 40 a minute per person, whichever organization pays: 6 so far (the 403 and 405 never reached it), 34 more, then refused.
    const answers: number[] = [];
    for (let i = 0; i < 35; i++) answers.push((await post(alice, f.organization.id, phrase(`phrase ${i}`))).status);
    expect(answers.slice(0, 34)).toEqual(Array(34).fill(200));
    expect(answers[34]).toBe(429);
  });
});
