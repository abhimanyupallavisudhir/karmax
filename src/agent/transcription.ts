/**
 * Dictation on the server (wiki features/push-and-voice § Server-side
 * dictation): where a browser or app has no speech recognizer of its own (the
 * desktop app's Electron, Firefox), the console records each phrase and posts
 * it to `POST /api/speech/transcriptions`, which returns its words.
 *
 * Paid like `generate` (generation.ts): the organization's own OpenRouter key
 * first, else its key on tavya's account, on the compute credit. The most a
 * request can cost (TRANSCRIPTION_MAX_SECONDS at the model's list price) is
 * held on the credit first, so parallel phrases cannot together pass it; what
 * the key spent is booked and the hold released once the words are back.
 *
 * The audio is never stored: it lives in this request's memory, goes to
 * OpenRouter and its provider with zero data retention asked for, and is
 * dropped. Nothing of it is logged, written to the store or the object store.
 */
import type { Store } from '../store/db.js';
import { BRAND } from '../domain/brand.js';
import { holdGeneration } from '../world/managed-compute.js';
import { GenerationRequestError, generationKey, openRouterFailure, settleGeneration, type GenerationDeps } from './generation.js';
import { openRouterApiBase } from './included-model.js';

/** Chosen by measurement (scripts/speech-eval, 2026-11-28; wiki
 * features/push-and-voice § Which model): of 14 OpenRouter transcription models
 * on 48 clips of English with tavya's jargon, the most accurate with a
 * zero-retention route (2.1% word errors, 98% of jargon right), and the fastest
 * (0.18 s median), silent on silence, $0.005 a minute. */
export const TRANSCRIPTION_MODEL = 'assemblyai/universal-3-6-pro';
/** When the first model's provider is down or busy: the next best with zero
 * retention (2.6%, 96%, 0.6 s, $0.0032 a minute). */
export const TRANSCRIPTION_FALLBACK_MODEL = 'mistralai/voxtral-mini-transcribe-3-0';
/** A phrase, not a recording: the console sends one at each pause. */
export const TRANSCRIPTION_MAX_SECONDS = 30;
/** 30 s of 48 kHz 16-bit mono WAV, and room for its header. */
export const TRANSCRIPTION_MAX_BYTES = 3 * 1024 * 1024;
/** Compressed audio (Opus, AAC, MP3): 30 s at up to 256 kb/s. */
const COMPRESSED_MAX_BYTES = 1024 * 1024;
/** A price list that cannot be read: what a request may cost at most. */
const QUOTE_CEILING_USD = 0.01;
const HOLD_MS = 2 * 60_000;
const TIMEOUT_MS = 20_000;
const MAX_KEYTERMS = 100;

/** The words a person dictating to tavya says that a recognizer gets wrong
 * without being told ("Tavia", "CarMax", "pan agent"). The organization's
 * own project and repository names are added (keyterms). */
export const TRANSCRIPTION_KEYTERMS: readonly string[] = [BRAND, 'karmax', 'krmax', 'panagent', 'PR', 'Postgres', 'E2B', 'OpenRouter', 'Temporal',
  'R2', 'CI', 'npm', 'GitHub', 'Claude Code', 'Codex', 'OpenCode', 'Hetzner', 'Fly.io', 'Daytona', 'README', 'wiki'];

/** The audio formats OpenRouter's recognizers take, by the request's content type. */
const FORMATS: Readonly<Record<string, string>> = {
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/wave': 'wav', 'audio/x-wav': 'wav', 'audio/vnd.wave': 'wav',
  'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/flac': 'flac',
};

export interface TranscriptionRequest {
  audio: Buffer;
  /** The request's Content-Type, e.g. `audio/webm;codecs=opus`. */
  contentType: string;
  /** A BCP 47 tag (`en-GB`) or ISO 639-1 code; its language is used. Default: detected. */
  language?: string;
}

export interface TranscriptionResult {
  text: string;
  model: string;
  funding: 'credit' | 'own';
  /** What OpenRouter charged, USD, when it says. */
  costUsd?: number;
  /** Seconds of audio it heard. */
  seconds?: number;
}

/** The audio's format, or a 415. */
export function audioFormat(contentType: string): string {
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  const format = FORMATS[type];
  if (!format) throw new GenerationRequestError(`send the audio as the request body with Content-Type audio/webm, audio/ogg, audio/wav, audio/mp4, audio/mpeg or audio/flac (got ${type || 'none'})`, 415);
  return format;
}

/** A WAV file's length in seconds from its header; undefined when it has none to read. */
export function wavSeconds(bytes: Buffer): number | undefined {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return undefined;
  let offset = 12, byteRate = 0;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 16 <= bytes.length) byteRate = bytes.readUInt32LE(offset + 16);
    // A recorder that streams writes a data size it does not know yet (0 or 0xFFFFFFFF): count what came.
    if (id === 'data') return byteRate ? Math.min(size || Infinity, bytes.length - offset - 8) / byteRate : undefined;
    offset += 8 + size + (size % 2);
  }
  return undefined;
}

/** Check the audio before anything is spent (the gateway's 400s, 413s and 415s). */
export function checkAudio(request: TranscriptionRequest): { format: string; language?: string } {
  const format = audioFormat(request.contentType);
  if (!request.audio.length) throw new GenerationRequestError('the request body is empty: send the audio as the body');
  const max = format === 'wav' || format === 'flac' ? TRANSCRIPTION_MAX_BYTES : COMPRESSED_MAX_BYTES;
  const seconds = format === 'wav' ? wavSeconds(request.audio) : undefined;
  if (request.audio.length > max || (seconds !== undefined && seconds > TRANSCRIPTION_MAX_SECONDS + 0.5))
    throw new GenerationRequestError(`send at most ${TRANSCRIPTION_MAX_SECONDS} s of audio a request (a phrase at a time)`, 413);
  const language = request.language?.trim().toLowerCase().split(/[-_]/)[0];
  if (language && !/^[a-z]{2}$/.test(language)) throw new GenerationRequestError('language must be a language code such as en or en-GB');
  return { format, ...(language ? { language } : {}) };
}

const PRICE_TTL_MS = 6 * 60 * 60_000;
let pricesPerSecond: { at: number; byId: Map<string, number> } | undefined;
/** USD a second of audio at OpenRouter's list price (its transcription
 * models are priced per second); undefined when it cannot be read. */
async function pricePerSecond(model: string, now = Date.now()): Promise<number | undefined> {
  if (!pricesPerSecond || now - pricesPerSecond.at > PRICE_TTL_MS) {
    const response = await fetch(`${openRouterApiBase()}/models?output_modalities=transcription`, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    const data = response?.ok ? ((await response.json().catch(() => ({}))) as { data?: any[] }).data ?? [] : [];
    if (!data.length) return undefined;
    // Priced per token as well (a model reading audio as tokens): not a per-second price.
    pricesPerSecond = { at: now, byId: new Map(data.filter((entry) => !(Number(entry?.pricing?.completion) > 0))
      .map((entry) => [String(entry.id), Number(entry?.pricing?.prompt)] as const).filter(([, price]) => Number.isFinite(price) && price >= 0)) };
  }
  return pricesPerSecond.byId.get(model);
}

/** Tests: forget cached prices and key terms. */
export function resetTranscriptionCaches(): void { pricesPerSecond = undefined; keytermsByOrganization.clear(); }

const KEYTERMS_TTL_MS = 10 * 60_000;
const keytermsByOrganization = new Map<string, { at: number; terms: string[] }>();
/** tavya's jargon, then the organization's repository and project names. */
async function keyterms(store: Store, organizationId: string, now = Date.now()): Promise<string[]> {
  const cached = keytermsByOrganization.get(organizationId);
  if (cached && now - cached.at < KEYTERMS_TTL_MS) return cached.terms;
  const names = [...(await store.listRepositories(organizationId).catch(() => [])).map((repository) => repository.name),
    ...(await store.listProjects().catch(() => [])).filter((project) => project.organizationId === organizationId).map((project) => project.name)];
  const seen = new Set<string>();
  const terms = [...TRANSCRIPTION_KEYTERMS, ...names].map((term) => term.trim()).filter((term) => {
    const key = term.toLowerCase();
    if (!term || term.length > 50 || term.split(/\s+/).length > 6 || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_KEYTERMS);
  if (keytermsByOrganization.size > 1_000) keytermsByOrganization.delete(keytermsByOrganization.keys().next().value!);
  keytermsByOrganization.set(organizationId, { at: now, terms });
  return terms;
}

const BRAND_WORD = new RegExp(`(?<![\\p{L}\\p{N}])${BRAND}(?![\\p{L}\\p{N}])`, 'giu');
/** Recognizers write the brand as a name ("Tavya", even after a key term);
 * it is always lower case. */
const withBrandCase = (text: string) => text.replace(BRAND_WORD, BRAND);

/** Transcribe one phrase on the organization's credit (or its own OpenRouter key). */
export async function transcribe(deps: GenerationDeps, organizationId: string, request: TranscriptionRequest): Promise<TranscriptionResult> {
  const { format, language } = checkAudio(request);
  const { key, funding } = await generationKey(deps, organizationId);
  const holdId = funding === 'credit' ? `transcription:${crypto.randomUUID()}` : undefined;
  if (holdId) {
    const perSecond = Math.max(await pricePerSecond(TRANSCRIPTION_MODEL) ?? 0, await pricePerSecond(TRANSCRIPTION_FALLBACK_MODEL) ?? 0);
    const quoteUsd = perSecond > 0 ? perSecond * TRANSCRIPTION_MAX_SECONDS : QUOTE_CEILING_USD;
    await holdGeneration(deps.store, { id: holdId, organizationId, costMicros: Math.ceil(quoteUsd * 1e6), until: Date.now() + HOLD_MS, what: 'this dictation' });
  }
  const audio = request.audio.toString('base64');
  const terms = await keyterms(deps.store, organizationId);
  const call = (model: string) => fetch(`${openRouterApiBase()}/audio/transcriptions`, { method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, input_audio: { data: audio, format }, ...(language ? { language } : {}), keyterms: terms,
      // Retained nowhere: only providers that keep no audio and train on none.
      provider: { zdr: true, data_collection: 'deny' } }),
    signal: AbortSignal.timeout(TIMEOUT_MS) });
  try {
    let model = TRANSCRIPTION_MODEL;
    let response = await call(model).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
    // Its provider is down, busy or slow: the next model, once.
    if (response instanceof Error || response.status === 429 || response.status >= 500) {
      if (response instanceof Response) await response.body?.cancel().catch(() => {});
      model = TRANSCRIPTION_FALLBACK_MODEL;
      response = await call(model);
    }
    if (!response.ok) throw await openRouterFailure(deps, organizationId, funding, response);
    const data = (await response.json()) as { text?: unknown; usage?: { cost?: unknown; seconds?: unknown } };
    const cost = Number(data.usage?.cost), seconds = Number(data.usage?.seconds);
    return { text: typeof data.text === 'string' ? withBrandCase(data.text.trim()) : '', model, funding,
      ...(Number.isFinite(cost) ? { costUsd: cost } : {}), ...(Number.isFinite(seconds) ? { seconds } : {}) };
  } finally {
    // Booked and released after the answer: the person waits for words, not
    // for the bookkeeping. Should this process stop first, the usage sweep
    // books the key's spend and the hold lapses.
    void settleGeneration(deps, organizationId, funding, undefined, holdId).catch(() => {});
  }
}

/** Requests a person may make: a phrase every 1.5 s for a minute, and 900 an
 * hour (an hour of dictating in 4 s phrases). Beyond, 429: the recorder is
 * stuck or someone scripts it. */
export class TranscriptionAdmission {
  private recent = new Map<string, number[]>();
  constructor(private readonly windows: ReadonlyArray<{ ms: number; max: number }> = [{ ms: 60_000, max: 40 }, { ms: 3_600_000, max: 900 }]) {}
  admit(by: string, now = Date.now()): boolean {
    const longest = Math.max(...this.windows.map((window) => window.ms));
    const kept = (this.recent.get(by) ?? []).filter((at) => now - at < longest);
    const full = this.windows.some((window) => kept.filter((at) => now - at < window.ms).length >= window.max);
    if (!full) kept.push(now);
    this.recent.delete(by);
    this.recent.set(by, kept);
    if (this.recent.size > 10_000) this.recent.delete(this.recent.keys().next().value!);
    return !full;
  }
}
