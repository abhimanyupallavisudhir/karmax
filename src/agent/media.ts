/**
 * Media generation on the compute credit (wiki features/media-generation):
 * images, video and speech from any model OpenRouter serves (Seedance, Veo,
 * Kling, gpt-image, Nano Banana, ElevenLabs, …), so an agent needs no account
 * with each lab. The `generate_media` tool (in a task, and on tavya's own MCP
 * server) calls these through `/api/organizations/:id/media`.
 *
 * Which key pays: the organization's own OpenRouter API key when it connected
 * one (its own OpenRouter account), else the organization's key on tavya's
 * OpenRouter account — the included model's key (src/agent/included-model.ts),
 * whose limit follows the credit. What that key spends is read back and booked
 * as `agent.cost` on the credit, so a generation costs what OpenRouter charged
 * × the organization's compute multiplier, like the included model.
 *
 * Every request asks OpenRouter for providers that do not train on prompts
 * (`data_collection: deny`). Zero data retention is not asked for: OpenRouter
 * offers no ZDR route for video, and few for images.
 */
import type { CredentialBroker } from '../autonomy/broker.js';
import type { ConfigHomeManager } from '../autonomy/config-homes.js';
import type { Store } from '../store/db.js';
import { includedModel, includedModelKey, openRouterApiBase, syncIncludedModelUsage } from './included-model.js';
import { outOfCompute } from '../world/managed-compute.js';

export const MEDIA_KINDS = ['image', 'video', 'speech'] as const;
export type MediaKind = typeof MEDIA_KINDS[number];

/** Defaults when no model is named (2026-11-16, from OpenRouter's catalogue):
 * well-regarded and cheap for their kind. An agent picks another with `model`;
 * `GET /api/media/models?kind=` lists them with prices. */
export const MEDIA_DEFAULT_MODELS: Readonly<Record<MediaKind, string>> = {
  image: 'google/gemini-3.1-flash-image',
  video: 'bytedance/seedance-2.0-fast',
  speech: 'elevenlabs/eleven-flash-v2.5',
};

/** OpenRouter routing every media request carries: no provider that trains on it. */
export const MEDIA_PROVIDER_OPTIONS = { data_collection: 'deny' } as const;

export interface MediaReference {
  /** An https URL or a data: URL. */
  url: string;
  /** Video only: the clip's first or last frame; otherwise a reference. */
  role?: 'first_frame' | 'last_frame' | 'reference';
}

export interface MediaRequest {
  kind: MediaKind;
  prompt: string;
  model?: string;
  aspectRatio?: string;
  resolution?: string;
  size?: string;
  /** Images: how many (1–10). */
  count?: number;
  /** Video: seconds. */
  duration?: number;
  /** Video: with sound (the model's default when omitted). */
  audio?: boolean;
  seed?: number;
  /** Speech: the voice (the model's first voice when omitted). */
  voice?: string;
  /** Speech: delivery guidance (tone, pace), where the model supports it. */
  instructions?: string;
  speed?: number;
  /** Speech: mp3 (default) or pcm. */
  format?: 'mp3' | 'pcm';
  references?: MediaReference[];
}

export interface MediaFile { mediaType: string; base64: string }

export interface MediaResult {
  kind: MediaKind;
  model: string;
  status: 'completed' | 'pending' | 'in_progress' | 'failed' | 'cancelled' | 'expired';
  /** Video: poll it with mediaJob. */
  jobId?: string;
  /** What OpenRouter charged, USD, when it says. */
  costUsd?: number;
  /** credit: tavya's key, on the organization's credit; own: the organization's own OpenRouter key. */
  funding: 'credit' | 'own';
  files?: MediaFile[];
  /** Video, completed: how many files GET …/content?index= serves. */
  outputs?: number;
  error?: string;
}

/** Nothing can pay: no OpenRouter key of the organization's own and no included model here. */
export class MediaUnavailable extends Error {
  constructor(message: string) { super(message); this.name = 'MediaUnavailable'; }
}

/** OpenRouter refused the request as given (an unknown model, an unsupported duration, …). */
export class MediaRequestError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = 'MediaRequestError'; }
}

export interface MediaDeps {
  store: Store;
  broker?: CredentialBroker;
  configHomes?: ConfigHomeManager;
}

interface JobRecord { organizationId: string; model: string; funding: MediaResult['funding']; taskId?: string; projectId?: string; at: number }
const jobKey = (jobId: string) => `media-job:${jobId}`;
const MODEL_ID = /^[a-z0-9][\w.-]*\/[\w.:~-]+$/i;
const MAX_PROMPT = 40_000;

/** Check and normalize a request (the gateway's 400s). */
export function parseMediaRequest(body: Record<string, unknown>): MediaRequest {
  const kind = String(body.kind ?? '') as MediaKind;
  if (!(MEDIA_KINDS as readonly string[]).includes(kind)) throw new MediaRequestError(`kind must be one of ${MEDIA_KINDS.join(', ')}`);
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) throw new MediaRequestError('prompt is required');
  if (prompt.length > MAX_PROMPT) throw new MediaRequestError(`prompt is longer than ${MAX_PROMPT} characters`);
  const model = body.model === undefined || body.model === '' ? undefined : String(body.model).trim();
  if (model && !MODEL_ID.test(model)) throw new MediaRequestError(`model must be an OpenRouter model id such as ${MEDIA_DEFAULT_MODELS[kind]}`);
  const text = (name: string) => body[name] === undefined || body[name] === '' ? undefined : String(body[name]);
  const number = (name: string, min: number, max: number, integer = false) => {
    if (body[name] === undefined || body[name] === null || body[name] === '') return undefined;
    const value = Number(body[name]);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
      throw new MediaRequestError(`${name} must be ${integer ? 'an integer ' : 'a number '}from ${min} to ${max}`);
    return value;
  };
  const format = text('format');
  if (format && format !== 'mp3' && format !== 'pcm') throw new MediaRequestError('format must be mp3 or pcm');
  const references = body.references === undefined ? undefined : Array.isArray(body.references) ? body.references : null;
  if (references === null) throw new MediaRequestError('references must be a list of {url, role?}');
  const parsedReferences = references?.map((entry): MediaReference => {
    const ref = (typeof entry === 'string' ? { url: entry } : entry ?? {}) as Record<string, unknown>;
    const url = String(ref.url ?? '');
    if (!/^(https:\/\/|data:[\w.+-]+\/[\w.+-]+;base64,)/i.test(url)) throw new MediaRequestError('each reference url must be an https: or base64 data: URL');
    const role = ref.role === undefined ? undefined : String(ref.role);
    if (role && !['first_frame', 'last_frame', 'reference'].includes(role)) throw new MediaRequestError('reference role must be first_frame, last_frame or reference');
    return { url, ...(role ? { role: role as MediaReference['role'] } : {}) };
  });
  const request: MediaRequest = { kind, prompt, ...(model ? { model } : {}) };
  const set = <K extends keyof MediaRequest>(key: K, value: MediaRequest[K] | undefined) => { if (value !== undefined) request[key] = value; };
  set('aspectRatio', text('aspectRatio')); set('resolution', text('resolution')); set('size', text('size'));
  set('count', number('count', 1, 10, true)); set('duration', number('duration', 1, 120));
  set('audio', body.audio === undefined ? undefined : body.audio === true || body.audio === 'true');
  set('seed', number('seed', 0, 2 ** 32, true)); set('voice', text('voice')); set('instructions', text('instructions'));
  set('speed', number('speed', 0.25, 4)); set('format', format as MediaRequest['format']);
  if (parsedReferences?.length) request.references = parsedReferences;
  return request;
}

/** The key a generation is paid with: the organization's own OpenRouter key
 * first, else its key on tavya's account (refused, Out of compute, below the
 * included model's minimum credit). */
async function keyFor(deps: MediaDeps, organizationId: string): Promise<{ key: string; funding: MediaResult['funding'] }> {
  const { gatherCredentialSources } = await import('../platform/credential-sources.js');
  const { enumerateCredentials } = await import('../platform/credentials.js');
  const own = enumerateCredentials(await gatherCredentialSources({ configHomes: deps.configHomes, broker: deps.broker, organizationId }))
    .filter((credential) => credential.kind === 'key' && credential.provider === 'openrouter');
  for (const credential of own) {
    const key = credential.apiKeyHandle
      ? await deps.broker?.resolve(credential.apiKeyHandle, { caps: [`use-credential:${credential.apiKeyHandle}`] }).catch(() => undefined)
      : process.env.OPENROUTER_API_KEY;
    if (key) return { key, funding: 'own' };
  }
  if (deps.broker && await includedModel(deps.store, deps.broker))
    return { key: await includedModelKey(deps.store, deps.broker, organizationId), funding: 'credit' };
  throw new MediaUnavailable('Media generation needs an OpenRouter key: connect an OpenRouter API key in Settings → Agent logins'
    + (deps.store.hosted ? '' : ', or set OPENROUTER_API_KEY'));
}

async function call(key: string, method: string, path: string, body?: unknown, timeoutMs = 180_000): Promise<Response> {
  return fetch(`${openRouterApiBase()}${path}`, { method,
    headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) });
}

/** An OpenRouter failure as the caller should see it: 402 (the key's limit,
 * which follows the credit) as Out of compute; any other 4xx as the request's
 * own error; 5xx as a failure to retry. */
async function failure(deps: MediaDeps, organizationId: string, funding: MediaResult['funding'], response: Response): Promise<Error> {
  const text = await response.text().catch(() => '');
  let message = text.slice(0, 500);
  try { message = String((JSON.parse(text) as any)?.error?.message ?? message); } catch { /* plain text */ }
  if (response.status === 402 && funding === 'credit') return outOfCompute(deps.store, organizationId, 'openrouter');
  if (response.status >= 400 && response.status < 500) return new MediaRequestError(`OpenRouter: ${message || response.statusText}`, response.status === 404 ? 404 : 400);
  return new Error(`OpenRouter failed (${response.status}): ${message}`);
}

const SPEECH_TTL_MS = 6 * 60 * 60_000;
let speechModels: { at: number; voices: Map<string, string[]> } | undefined;
/** A speech model's first voice: OpenRouter requires one for most models. */
async function defaultVoice(model: string): Promise<string | undefined> {
  if (!speechModels || Date.now() - speechModels.at > SPEECH_TTL_MS) {
    const response = await fetch(`${openRouterApiBase()}/models?output_modalities=speech`, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    const data = response?.ok ? ((await response.json()) as { data?: any[] }).data ?? [] : [];
    if (!data.length) return undefined;
    speechModels = { at: Date.now(), voices: new Map(data.map((entry) => [String(entry.id), Array.isArray(entry.supported_voices) ? entry.supported_voices.map(String) : []])) };
  }
  return speechModels.voices.get(model)?.[0];
}

/** Tests: forget cached model metadata. */
export function resetMediaCaches(): void { speechModels = undefined; }

const imageRef = (url: string) => ({ type: 'image_url', image_url: { url } });

async function book(deps: MediaDeps, organizationId: string, funding: MediaResult['funding'], task?: { taskId: string; projectId?: string }) {
  if (funding !== 'credit' || !deps.broker) return;
  await syncIncludedModelUsage(deps.store, deps.broker, organizationId, task).catch((error) =>
    console.warn(`[karmax] media usage of ${organizationId}: ${error instanceof Error ? error.message : String(error)}`));
}

/** Generate an image or speech now, or start a video (poll it with mediaJob). */
export async function generateMedia(deps: MediaDeps, organizationId: string, request: MediaRequest,
  task?: { taskId: string; projectId?: string }): Promise<MediaResult> {
  const model = request.model ?? MEDIA_DEFAULT_MODELS[request.kind];
  const { key, funding } = await keyFor(deps, organizationId);
  const provider = MEDIA_PROVIDER_OPTIONS;
  if (request.kind === 'image') {
    const response = await call(key, 'POST', '/images', { model, prompt: request.prompt, provider,
      ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}), ...(request.resolution ? { resolution: request.resolution } : {}),
      ...(request.size ? { size: request.size } : {}), ...(request.count ? { n: request.count } : {}),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      ...(request.references?.length ? { input_references: request.references.map((ref) => imageRef(ref.url)) } : {}) });
    if (!response.ok) throw await failure(deps, organizationId, funding, response);
    const body = (await response.json()) as { data?: Array<{ b64_json?: string; media_type?: string }>; usage?: { cost?: number } };
    await book(deps, organizationId, funding, task);
    const files = (body.data ?? []).filter((item) => item.b64_json).map((item) => ({ mediaType: item.media_type ?? 'image/png', base64: item.b64_json! }));
    if (!files.length) throw new Error('OpenRouter returned no image');
    return { kind: 'image', model, status: 'completed', funding, files,
      ...(typeof body.usage?.cost === 'number' ? { costUsd: body.usage.cost } : {}) };
  }
  if (request.kind === 'speech') {
    const voice = request.voice ?? await defaultVoice(model);
    const response = await call(key, 'POST', '/audio/speech', { model, input: request.prompt, provider,
      response_format: request.format ?? 'mp3', ...(voice ? { voice } : {}),
      ...(request.instructions ? { instructions: request.instructions } : {}), ...(request.speed !== undefined ? { speed: request.speed } : {}),
      ...(request.references?.length ? { input_references: request.references.map((ref) => imageRef(ref.url)) } : {}) });
    if (!response.ok) throw await failure(deps, organizationId, funding, response);
    const bytes = Buffer.from(await response.arrayBuffer());
    await book(deps, organizationId, funding, task);
    const mediaType = response.headers.get('content-type')?.split(';')[0] || (request.format === 'pcm' ? 'audio/pcm' : 'audio/mpeg');
    return { kind: 'speech', model, status: 'completed', funding, files: [{ mediaType, base64: bytes.toString('base64') }] };
  }
  const frames = request.references?.filter((ref) => ref.role === 'first_frame' || ref.role === 'last_frame') ?? [];
  const references = request.references?.filter((ref) => !ref.role || ref.role === 'reference') ?? [];
  const response = await call(key, 'POST', '/videos', { model, prompt: request.prompt, provider,
    ...(request.duration !== undefined ? { duration: request.duration } : {}), ...(request.resolution ? { resolution: request.resolution } : {}),
    ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}), ...(request.size ? { size: request.size } : {}),
    ...(request.audio !== undefined ? { generate_audio: request.audio } : {}), ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(frames.length ? { frame_images: frames.map((ref) => ({ ...imageRef(ref.url), frame_type: ref.role })) } : {}),
    ...(references.length ? { input_references: references.map((ref) => imageRef(ref.url)) } : {}) }, 60_000);
  if (!response.ok) throw await failure(deps, organizationId, funding, response);
  const job = (await response.json()) as { id?: string; status?: string };
  if (!job.id) throw new Error('OpenRouter did not return a video job');
  await deps.store.kvSet(jobKey(job.id), JSON.stringify({ organizationId, model, funding, at: Date.now(),
    ...(task?.taskId ? { taskId: task.taskId } : {}), ...(task?.projectId ? { projectId: task.projectId } : {}) } satisfies JobRecord));
  return { kind: 'video', model, status: (job.status as MediaResult['status']) ?? 'pending', jobId: job.id, funding };
}

async function jobRecord(store: Store, organizationId: string, jobId: string): Promise<JobRecord> {
  let record: JobRecord | undefined;
  try { record = JSON.parse((await store.kvGet(jobKey(jobId))) ?? 'null') ?? undefined; } catch { /* missing */ }
  // Another organization's job is as unknown as one that never existed.
  if (!record || record.organizationId !== organizationId) throw new MediaRequestError(`no media job ${jobId}`, 404);
  return record;
}

/** A video job's status; once completed, with its files when `content` is asked
 * for (base64: a task's tool saves them into its world). */
export async function mediaJob(deps: MediaDeps, organizationId: string, jobId: string, options: { content?: boolean } = {}): Promise<MediaResult> {
  const record = await jobRecord(deps.store, organizationId, jobId);
  const { key, funding } = await keyFor(deps, organizationId);
  const response = await call(key, 'GET', `/videos/${encodeURIComponent(jobId)}`, undefined, 30_000);
  if (!response.ok) throw await failure(deps, organizationId, funding, response);
  const job = (await response.json()) as { status?: string; unsigned_urls?: string[]; urls?: string[]; usage?: { cost?: number }; error?: unknown };
  const status = (job.status ?? 'pending') as MediaResult['status'];
  const result: MediaResult = { kind: 'video', model: record.model, status, jobId, funding: record.funding,
    ...(typeof job.usage?.cost === 'number' ? { costUsd: job.usage.cost } : {}),
    ...(job.error ? { error: typeof job.error === 'string' ? job.error : String((job.error as any)?.message ?? JSON.stringify(job.error)) } : {}) };
  if (status !== 'completed' && status !== 'failed') return result;
  const task = record.taskId ? { taskId: record.taskId, ...(record.projectId ? { projectId: record.projectId } : {}) } : undefined;
  await book(deps, organizationId, record.funding, task);
  if (status !== 'completed') return result;
  result.outputs = Math.max(1, job.unsigned_urls?.length ?? job.urls?.length ?? 1);
  if (options.content) {
    result.files = [];
    for (let index = 0; index < result.outputs; index++) {
      const content = await mediaJobContent(deps, organizationId, jobId, index);
      result.files.push({ mediaType: content.headers.get('content-type')?.split(';')[0] || 'video/mp4',
        base64: Buffer.from(await content.arrayBuffer()).toString('base64') });
    }
  }
  return result;
}

/** A completed video's bytes, as OpenRouter serves them (to stream on). */
export async function mediaJobContent(deps: MediaDeps, organizationId: string, jobId: string, index = 0): Promise<Response> {
  await jobRecord(deps.store, organizationId, jobId);
  const { key, funding } = await keyFor(deps, organizationId);
  const response = await call(key, 'GET', `/videos/${encodeURIComponent(jobId)}/content?index=${index}`, undefined, 300_000);
  if (!response.ok) throw await failure(deps, organizationId, funding, response);
  return response;
}

export interface MediaModel { id: string; name?: string; pricing?: Record<string, unknown>; [detail: string]: unknown }

/** The models OpenRouter serves for `kind`, with what each supports and costs (public, no key). */
export async function mediaModels(kind: MediaKind): Promise<MediaModel[]> {
  const path = kind === 'image' ? '/images/models' : kind === 'video' ? '/videos/models' : '/models?output_modalities=speech';
  const response = await fetch(`${openRouterApiBase()}${path}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`OpenRouter ${kind} models: ${response.status}`);
  const data = ((await response.json()) as { data?: any[] }).data ?? [];
  return data.filter((entry) => typeof entry?.id === 'string').map((entry) => ({ id: entry.id, name: entry.name,
    ...(entry.pricing ? { pricing: entry.pricing } : entry.pricing_skus ? { pricing: entry.pricing_skus } : {}),
    ...(entry.supported_parameters && !Array.isArray(entry.supported_parameters) ? { parameters: entry.supported_parameters } : {}),
    ...(entry.supported_durations ? { durations: entry.supported_durations } : {}),
    ...(entry.supported_resolutions ? { resolutions: entry.supported_resolutions } : {}),
    ...(entry.supported_aspect_ratios ? { aspectRatios: entry.supported_aspect_ratios } : {}),
    ...(entry.supported_voices ? { voices: entry.supported_voices.slice(0, 40) } : {}),
    ...(entry.id === MEDIA_DEFAULT_MODELS[kind] ? { default: true } : {}) }));
}
