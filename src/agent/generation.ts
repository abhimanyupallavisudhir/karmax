/**
 * Generation on the compute credit (wiki features/generate): text, images,
 * video and speech from any model OpenRouter serves (GPT, Gemini, DeepSeek,
 * Seedance, Veo, Kling, gpt-image, Nano Banana, ElevenLabs, …), so an agent
 * needs no account with each lab. The `generate` tool (in a task, and on
 * tavya's own MCP server) calls these through `/api/organizations/:id/generations`.
 *
 * Which key pays: the organization's own OpenRouter API key when it connected
 * one (its own OpenRouter account), else the organization's key on tavya's
 * OpenRouter account — the included model's key (src/agent/included-model.ts),
 * whose limit follows the credit. What that key spends is read back and booked
 * as `agent.cost` on the credit, so a generation costs what OpenRouter charged
 * × the organization's compute multiplier, like the included model.
 *
 * Quote, hold, settle: before anything runs, what it can cost at most is
 * worked out from OpenRouter's price lists (generation-price.ts). A request
 * whose quote is above its `maxCostUsd` is refused; on the credit the quote is
 * held against it (refused, Out of compute, when it does not fit), so
 * generations running at once cannot together spend past the credit; when the
 * generation ends what it actually cost is booked and the hold released.
 *
 * Every request asks OpenRouter for providers that do not train on prompts
 * (`data_collection: deny`); text also asks for zero data retention and no
 * 4-bit builds, as the included model does. Video has no ZDR route, and few
 * image models do.
 */
import crypto from 'node:crypto';
import type { CredentialBroker } from '../autonomy/broker.js';
import type { ConfigHomeManager } from '../autonomy/config-homes.js';
import type { Store } from '../store/db.js';
import { INCLUDED_MODEL_DEFAULT, INCLUDED_MODEL_MIN_MICROS, INCLUDED_MODEL_OPTIONS, includedModel, includedModelKey, openRouterApiBase, syncIncludedModelUsage } from './included-model.js';
import { computeCredit, holdGeneration, outOfCompute } from '../world/managed-compute.js';
import { BRAND } from '../domain/brand.js';
import { quote, type Quote } from './generation-price.js';
import { TASK_PROVIDERS, TASK_PROVIDER_IMPLS, TASK_PROVIDER_INFO, TaskProviderError, TaskProviderUnavailable, downloadOutputs, outputFiles,
  taskProviderKey, type Submitted, type TaskProviderId } from './generation-providers.js';

export const GENERATION_KINDS = ['text', 'image', 'video', 'speech'] as const;
export type GenerationKind = typeof GENERATION_KINDS[number];

/** Defaults when no model is named (2026-11-16, from OpenRouter's catalogue):
 * cheap and well regarded for their kind; text: the included model. An agent
 * picks another with `model`; `GET /api/generation-models?kind=` lists them
 * with prices. */
export const GENERATION_DEFAULT_MODELS: Readonly<Record<GenerationKind, string>> = {
  text: INCLUDED_MODEL_DEFAULT,
  image: 'google/gemini-3.1-flash-image',
  video: 'bytedance/seedance-2.0-fast',
  speech: 'elevenlabs/eleven-flash-v2.5',
};

/** OpenRouter routing every media request carries: no provider that trains on it. */
export const MEDIA_PROVIDER_OPTIONS = { data_collection: 'deny' } as const;

/** How long a hold lasts if its generation is never collected: a video's
 * cost is then booked by the usage sweep and the hold lapses. */
const HOLD_MS: Readonly<Record<GenerationKind, number>> = { text: 15 * 60_000, image: 15 * 60_000, speech: 15 * 60_000, video: 2 * 60 * 60_000 };

export interface GenerationReference {
  /** An https URL or a data: URL. */
  url: string;
  /** Video only: the clip's first or last frame; otherwise a reference. */
  role?: 'first_frame' | 'last_frame' | 'reference';
}

export interface GenerationRequest {
  /** OpenRouter's kinds; with another provider, what the agent says it is (optional). */
  kind: GenerationKind;
  /** openrouter (default), or a provider the operator turned on (generation-providers.ts). */
  provider?: 'openrouter' | TaskProviderId;
  /** Another provider: the model's own input, as its docs give it. */
  input?: Record<string, unknown>;
  prompt: string;
  model?: string;
  /** Text: instructions for the model. */
  system?: string;
  /** Text: at most this many tokens of reply, reasoning included (default 8,192). */
  maxTokens?: number;
  /** Text: reasoning effort, where the model reasons. */
  effort?: 'minimal' | 'low' | 'medium' | 'high';
  /** Refuse unless the quote is at most this much, USD at OpenRouter's prices. */
  maxCostUsd?: number;
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
  references?: GenerationReference[];
}

export interface GenerationFile { mediaType: string; base64: string }

export interface GenerationResult {
  kind: GenerationKind;
  provider?: 'openrouter' | TaskProviderId;
  /** Another provider's output as it gave it (URLs of its files included). */
  output?: unknown;
  model: string;
  status: 'completed' | 'pending' | 'in_progress' | 'failed' | 'cancelled' | 'expired';
  /** Video: poll it with generationJob. */
  jobId?: string;
  /** The most it could cost, USD at OpenRouter's prices, and how that was known. */
  quoteUsd?: number;
  quoteBasis?: Quote['basis'];
  /** What OpenRouter charged, USD, when it says. */
  costUsd?: number;
  /** credit: tavya's key, on the organization's credit; own: the organization's own OpenRouter key. */
  funding: 'credit' | 'own';
  /** Text: the reply. */
  text?: string;
  files?: GenerationFile[];
  /** Video, completed: how many files GET …/content?index= serves. */
  outputs?: number;
  error?: string;
}

/** Nothing can pay: no OpenRouter key of the organization's own and no included model here. */
export class GenerationUnavailable extends Error {
  constructor(message: string) { super(message); this.name = 'GenerationUnavailable'; }
}

/** The request as given cannot run (an unknown model, an unsupported duration, a quote above maxCostUsd, …). */
export class GenerationRequestError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = 'GenerationRequestError'; }
}

export interface GenerationDeps {
  store: Store;
  broker?: CredentialBroker;
  configHomes?: ConfigHomeManager;
}

interface JobRecord { organizationId: string; model: string; funding: GenerationResult['funding']; taskId?: string; projectId?: string;
  holdId?: string; quoteUsd?: number; at: number; kind?: GenerationKind;
  /** Another provider's job: which, its own id, where to poll it. */
  provider?: TaskProviderId; job?: Submitted }
const jobKey = (jobId: string) => `generation-job:${jobId}`;
const MODEL_ID = /^[a-z0-9][\w.-]*\/[\w.:~-]+$/i;
const MAX_PROMPT = 200_000;

/** Check and normalize a request (the gateway's 400s). */
export function parseGenerationRequest(body: Record<string, unknown>): GenerationRequest {
  const provider = body.provider === undefined || body.provider === '' ? 'openrouter' : String(body.provider);
  if (provider !== 'openrouter' && !(TASK_PROVIDERS as readonly string[]).includes(provider))
    throw new GenerationRequestError(`provider must be one of openrouter, ${TASK_PROVIDERS.join(', ')}`);
  if (provider !== 'openrouter') return parseTaskRequest(provider as TaskProviderId, body);
  const kind = String(body.kind ?? '') as GenerationKind;
  if (!(GENERATION_KINDS as readonly string[]).includes(kind)) throw new GenerationRequestError(`kind must be one of ${GENERATION_KINDS.join(', ')}`);
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) throw new GenerationRequestError('prompt is required');
  if (prompt.length > MAX_PROMPT) throw new GenerationRequestError(`prompt is longer than ${MAX_PROMPT} characters`);
  const model = body.model === undefined || body.model === '' ? undefined : String(body.model).trim();
  if (model && !MODEL_ID.test(model)) throw new GenerationRequestError(`model must be an OpenRouter model id such as ${GENERATION_DEFAULT_MODELS[kind]}`);
  const text = (name: string) => body[name] === undefined || body[name] === null || body[name] === '' ? undefined : String(body[name]);
  const number = (name: string, min: number, max: number, integer = false) => {
    if (body[name] === undefined || body[name] === null || body[name] === '') return undefined;
    const value = Number(body[name]);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
      throw new GenerationRequestError(`${name} must be ${integer ? 'an integer ' : 'a number '}from ${min} to ${max}`);
    return value;
  };
  const format = text('format');
  if (format && format !== 'mp3' && format !== 'pcm') throw new GenerationRequestError('format must be mp3 or pcm');
  const effort = text('effort');
  if (effort && !['minimal', 'low', 'medium', 'high'].includes(effort)) throw new GenerationRequestError('effort must be minimal, low, medium or high');
  const references = body.references === undefined ? undefined : Array.isArray(body.references) ? body.references : null;
  if (references === null) throw new GenerationRequestError('references must be a list of {url, role?}');
  const parsedReferences = references?.map((entry): GenerationReference => {
    const ref = (typeof entry === 'string' ? { url: entry } : entry ?? {}) as Record<string, unknown>;
    const url = String(ref.url ?? '');
    if (!/^(https:\/\/|data:[\w.+-]+\/[\w.+-]+;base64,)/i.test(url)) throw new GenerationRequestError('each reference url must be an https: or base64 data: URL');
    const role = ref.role === undefined ? undefined : String(ref.role);
    if (role && !['first_frame', 'last_frame', 'reference'].includes(role)) throw new GenerationRequestError('reference role must be first_frame, last_frame or reference');
    return { url, ...(role ? { role: role as GenerationReference['role'] } : {}) };
  });
  const request: GenerationRequest = { kind, prompt, ...(model ? { model } : {}) };
  const set = <K extends keyof GenerationRequest>(key: K, value: GenerationRequest[K] | undefined) => { if (value !== undefined) request[key] = value; };
  set('system', text('system')); set('maxTokens', number('maxTokens', 1, 1_000_000, true));
  set('effort', effort as GenerationRequest['effort']); set('maxCostUsd', number('maxCostUsd', 0, 10_000));
  set('aspectRatio', text('aspectRatio')); set('resolution', text('resolution')); set('size', text('size'));
  set('count', number('count', 1, 10, true)); set('duration', number('duration', 1, 120));
  set('audio', body.audio === undefined ? undefined : body.audio === true || body.audio === 'true');
  set('seed', number('seed', 0, 2 ** 32, true)); set('voice', text('voice')); set('instructions', text('instructions'));
  set('speed', number('speed', 0.25, 4)); set('format', format as GenerationRequest['format']);
  if (parsedReferences?.length) request.references = parsedReferences;
  return request;
}

/** A request to another provider: its model id and the model's own input
 * (a bare prompt becomes `{prompt}`). */
function parseTaskRequest(provider: TaskProviderId, body: Record<string, unknown>): GenerationRequest {
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (!/^[\w.-]+(\/[\w.:~-]+)+$/.test(model)) throw new GenerationRequestError(`model is required: a ${TASK_PROVIDER_INFO[provider].name} model id, see ${TASK_PROVIDER_INFO[provider].models}`);
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const input = body.input === undefined ? (prompt ? { prompt } : undefined) : body.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new GenerationRequestError('input must be the model’s input object');
  if (JSON.stringify(input).length > 5_000_000) throw new GenerationRequestError('input is larger than 5 MB');
  const kind = (GENERATION_KINDS as readonly string[]).includes(String(body.kind)) ? String(body.kind) as GenerationKind : 'image';
  const maxCost = body.maxCostUsd === undefined || body.maxCostUsd === null || body.maxCostUsd === '' ? undefined : Number(body.maxCostUsd);
  if (maxCost !== undefined && (!Number.isFinite(maxCost) || maxCost < 0)) throw new GenerationRequestError('maxCostUsd must be a positive number');
  return { kind, provider, model, prompt, input: input as Record<string, unknown>, ...(maxCost !== undefined ? { maxCostUsd: maxCost } : {}) };
}

/** The key a generation is paid with: the organization's own OpenRouter key
 * first, else its key on tavya's account (refused, Out of compute, below the
 * included model's minimum credit). */
async function keyFor(deps: GenerationDeps, organizationId: string): Promise<{ key: string; funding: GenerationResult['funding'] }> {
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
  throw new GenerationUnavailable('Generation needs an OpenRouter key: connect an OpenRouter API key in Settings → Agent logins'
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
async function failure(deps: GenerationDeps, organizationId: string, funding: GenerationResult['funding'], response: Response): Promise<Error> {
  const text = await response.text().catch(() => '');
  let message = text.slice(0, 500);
  try { message = String((JSON.parse(text) as { error?: { message?: string } })?.error?.message ?? message); } catch { /* plain text */ }
  if (response.status === 402 && funding === 'credit') {
    // Refused for money although the organization's credit is there: what ran
    // out is tavya's own OpenRouter balance (Service limits warns the operator
    // at 80% and 95% of it), not the customer's.
    const credit = await computeCredit(deps.store, organizationId).catch(() => undefined);
    if (credit?.availableMicros != null && credit.availableMicros < INCLUDED_MODEL_MIN_MICROS) return outOfCompute(deps.store, organizationId, 'openrouter');
    return new GenerationUnavailable(`${BRAND}'s OpenRouter balance has run out, not your credit: nothing was charged. `
      + 'Try again once the operator has topped it up, or connect your own OpenRouter API key in Settings → Agent logins.');
  }
  if (response.status >= 400 && response.status < 500) return new GenerationRequestError(`OpenRouter: ${message || response.statusText}`, response.status === 404 ? 404 : 400);
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
export function resetGenerationCaches(): void { speechModels = undefined; }

const imageRef = (url: string) => ({ type: 'image_url', image_url: { url } });

/** What the generation cost is booked (on the credit: the key's new spend,
 * to the task), then its hold released. */
async function settle(deps: GenerationDeps, organizationId: string, funding: GenerationResult['funding'],
  task: { taskId: string; projectId?: string } | undefined, holdId: string | undefined) {
  if (funding === 'credit' && deps.broker)
    await syncIncludedModelUsage(deps.store, deps.broker, organizationId, task).catch((error) =>
      console.warn(`[karmax] generation usage of ${organizationId}: ${error instanceof Error ? error.message : String(error)}`));
  if (holdId) await deps.store.closeComputeHold(holdId).catch(() => undefined);
}

const describe = (request: GenerationRequest, model: string) =>
  `this ${request.kind === 'text' ? 'reply' : request.kind}${request.kind === 'video' && request.duration ? ` (${request.duration} s)` : ''} on ${model}`;

/** Generate text, an image or speech now, or start a video (poll it with
 * generationJob), after quoting it and holding the quote on the credit. */
export async function generate(deps: GenerationDeps, organizationId: string, request: GenerationRequest,
  task?: { taskId: string; projectId?: string }): Promise<GenerationResult> {
  if (request.provider && request.provider !== 'openrouter') return generateWithProvider(deps, organizationId, request.provider, request, task);
  const kind = request.kind;
  const model = request.model ?? (kind === 'text' ? (await includedModel(deps.store, deps.broker))?.model : undefined) ?? GENERATION_DEFAULT_MODELS[kind];
  const references = request.references?.length ?? 0;
  const estimate = await quote(kind, model, { prompt: request.prompt, ...(request.system ? { system: request.system } : {}),
    ...(request.count ? { count: request.count } : {}), ...(request.duration !== undefined ? { duration: request.duration } : {}),
    ...(request.resolution ? { resolution: request.resolution } : {}), ...(request.size ? { size: request.size } : {}),
    ...(request.audio !== undefined ? { audio: request.audio } : {}), ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}), references });
  // A cap the agent set: a price list's quote above it is refused; with none
  // to read, the cap itself is what may be spent.
  if (request.maxCostUsd !== undefined && estimate.basis === 'price-list' && estimate.usd > request.maxCostUsd)
    throw new GenerationRequestError(`${describe(request, model)} may cost up to $${estimate.usd.toFixed(3)}, above maxCostUsd $${request.maxCostUsd}: `
      + 'choose a cheaper model, fewer or smaller outputs, or a higher maxCostUsd');
  const quoted: Quote = request.maxCostUsd !== undefined && estimate.basis === 'ceiling' ? { usd: request.maxCostUsd, basis: 'ceiling' } : estimate;
  const { key, funding } = await keyFor(deps, organizationId);
  const holdId = funding === 'credit' ? `generation:${crypto.randomUUID()}` : undefined;
  const held = holdId ? await holdGeneration(deps.store, { id: holdId, organizationId, ...(task?.taskId ? { taskId: task.taskId } : {}),
    costMicros: Math.ceil(quoted.usd * 1e6), until: Date.now() + HOLD_MS[kind], what: describe(request, model) }) : false;
  const hold = held ? holdId : undefined;
  const base = { kind, model, funding, quoteUsd: Math.round(quoted.usd * 1e6) / 1e6, quoteBasis: quoted.basis };
  try {
    if (kind === 'text') return { ...base, ...(await generateText(deps, organizationId, funding, key, model, request)) };
    if (kind === 'image') return { ...base, ...(await generateImage(deps, organizationId, funding, key, model, request)) };
    if (kind === 'speech') return { ...base, ...(await generateSpeech(deps, organizationId, funding, key, model, request)) };
    const job = await startVideo(deps, organizationId, funding, key, model, request);
    await deps.store.kvSet(jobKey(job.id), JSON.stringify({ organizationId, model, funding, at: Date.now(), quoteUsd: base.quoteUsd,
      ...(hold ? { holdId: hold } : {}), ...(task?.taskId ? { taskId: task.taskId } : {}), ...(task?.projectId ? { projectId: task.projectId } : {}) } satisfies JobRecord));
    return { ...base, status: job.status, jobId: job.id };
  } catch (error) {
    // A video that did not start has nothing to wait for.
    if (kind === 'video') await settle(deps, organizationId, funding, task, hold);
    throw error;
  } finally {
    // Text, an image or speech is done (or failed): book what it cost and release the hold.
    if (kind !== 'video') await settle(deps, organizationId, funding, task, hold);
  }
}

type Partial_ = Pick<GenerationResult, 'status' | 'costUsd' | 'text' | 'files'>;

async function generateText(deps: GenerationDeps, organizationId: string, funding: GenerationResult['funding'], key: string, model: string,
  request: GenerationRequest): Promise<Partial_> {
  const content = request.references?.length
    ? [{ type: 'text', text: request.prompt }, ...request.references.map((ref) => imageRef(ref.url))] : request.prompt;
  const response = await call(key, 'POST', '/chat/completions', { model, ...INCLUDED_MODEL_OPTIONS,
    messages: [...(request.system ? [{ role: 'system', content: request.system }] : []), { role: 'user', content }],
    max_tokens: request.maxTokens ?? 8192, ...(request.effort ? { reasoning: { effort: request.effort } } : {}) }, 600_000);
  if (!response.ok) throw await failure(deps, organizationId, funding, response);
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>; usage?: { cost?: number } };
  const choice = body.choices?.[0];
  return { status: 'completed', text: choice?.message?.content ?? '',
    ...(choice?.finish_reason === 'length' ? { error: 'the reply reached maxTokens and was cut off' } : {}),
    ...(typeof body.usage?.cost === 'number' ? { costUsd: body.usage.cost } : {}) };
}

async function generateImage(deps: GenerationDeps, organizationId: string, funding: GenerationResult['funding'], key: string, model: string,
  request: GenerationRequest): Promise<Partial_> {
  const response = await call(key, 'POST', '/images', { model, prompt: request.prompt, provider: MEDIA_PROVIDER_OPTIONS,
    ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}), ...(request.resolution ? { resolution: request.resolution } : {}),
    ...(request.size ? { size: request.size } : {}), ...(request.count ? { n: request.count } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(request.references?.length ? { input_references: request.references.map((ref) => imageRef(ref.url)) } : {}) });
  if (!response.ok) throw await failure(deps, organizationId, funding, response);
  const body = (await response.json()) as { data?: Array<{ b64_json?: string; media_type?: string }>; usage?: { cost?: number } };
  const files = (body.data ?? []).filter((item) => item.b64_json).map((item) => ({ mediaType: item.media_type ?? 'image/png', base64: item.b64_json! }));
  if (!files.length) throw new Error('OpenRouter returned no image');
  return { status: 'completed', files, ...(typeof body.usage?.cost === 'number' ? { costUsd: body.usage.cost } : {}) };
}

async function generateSpeech(deps: GenerationDeps, organizationId: string, funding: GenerationResult['funding'], key: string, model: string,
  request: GenerationRequest): Promise<Partial_> {
  const voice = request.voice ?? await defaultVoice(model);
  const response = await call(key, 'POST', '/audio/speech', { model, input: request.prompt, provider: MEDIA_PROVIDER_OPTIONS,
    response_format: request.format ?? 'mp3', ...(voice ? { voice } : {}),
    ...(request.instructions ? { instructions: request.instructions } : {}), ...(request.speed !== undefined ? { speed: request.speed } : {}),
    ...(request.references?.length ? { input_references: request.references.map((ref) => imageRef(ref.url)) } : {}) });
  if (!response.ok) throw await failure(deps, organizationId, funding, response);
  const bytes = Buffer.from(await response.arrayBuffer());
  const mediaType = response.headers.get('content-type')?.split(';')[0] || (request.format === 'pcm' ? 'audio/pcm' : 'audio/mpeg');
  return { status: 'completed', files: [{ mediaType, base64: bytes.toString('base64') }] };
}

async function startVideo(deps: GenerationDeps, organizationId: string, funding: GenerationResult['funding'], key: string, model: string,
  request: GenerationRequest): Promise<{ id: string; status: GenerationResult['status'] }> {
  const frames = request.references?.filter((ref) => ref.role === 'first_frame' || ref.role === 'last_frame') ?? [];
  const references = request.references?.filter((ref) => !ref.role || ref.role === 'reference') ?? [];
  const response = await call(key, 'POST', '/videos', { model, prompt: request.prompt, provider: MEDIA_PROVIDER_OPTIONS,
    ...(request.duration !== undefined ? { duration: request.duration } : {}), ...(request.resolution ? { resolution: request.resolution } : {}),
    ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}), ...(request.size ? { size: request.size } : {}),
    ...(request.audio !== undefined ? { generate_audio: request.audio } : {}), ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(frames.length ? { frame_images: frames.map((ref) => ({ ...imageRef(ref.url), frame_type: ref.role })) } : {}),
    ...(references.length ? { input_references: references.map((ref) => imageRef(ref.url)) } : {}) }, 60_000);
  if (!response.ok) throw await failure(deps, organizationId, funding, response);
  const job = (await response.json()) as { id?: string; status?: string };
  if (!job.id) throw new Error('OpenRouter did not return a video job');
  return { id: job.id, status: (job.status as GenerationResult['status']) ?? 'pending' };
}

async function jobRecord(store: Store, organizationId: string, jobId: string): Promise<JobRecord> {
  let record: JobRecord | undefined;
  try { record = JSON.parse((await store.kvGet(jobKey(jobId))) ?? 'null') ?? undefined; } catch { /* missing */ }
  // Another organization's job is as unknown as one that never existed.
  if (!record || record.organizationId !== organizationId) throw new GenerationRequestError(`no generation job ${jobId}`, 404);
  return record;
}

/** A video job's status; once it ends, what it cost is booked and its hold
 * released; once completed, with its files when `content` is asked for
 * (base64: a task's tool saves them into its world). */
export async function generationJob(deps: GenerationDeps, organizationId: string, jobId: string, options: { content?: boolean } = {}): Promise<GenerationResult> {
  const record = await jobRecord(deps.store, organizationId, jobId);
  if (record.provider) return providerJob(deps, organizationId, jobId, record, options);
  const { key, funding } = await keyFor(deps, organizationId);
  const response = await call(key, 'GET', `/videos/${encodeURIComponent(jobId)}`, undefined, 30_000);
  if (!response.ok) throw await failure(deps, organizationId, funding, response);
  const job = (await response.json()) as { status?: string; unsigned_urls?: string[]; urls?: string[]; usage?: { cost?: number }; error?: unknown };
  const status = (job.status ?? 'pending') as GenerationResult['status'];
  const result: GenerationResult = { kind: 'video', model: record.model, status, jobId, funding: record.funding,
    ...(record.quoteUsd !== undefined ? { quoteUsd: record.quoteUsd } : {}),
    ...(typeof job.usage?.cost === 'number' ? { costUsd: job.usage.cost } : {}),
    ...(job.error ? { error: typeof job.error === 'string' ? job.error : String((job.error as { message?: string }).message ?? JSON.stringify(job.error)) } : {}) };
  if (status === 'pending' || status === 'in_progress') return result;
  const task = record.taskId ? { taskId: record.taskId, ...(record.projectId ? { projectId: record.projectId } : {}) } : undefined;
  await settle(deps, organizationId, record.funding, task, record.holdId);
  if (status !== 'completed') return result;
  result.outputs = Math.max(1, job.unsigned_urls?.length ?? job.urls?.length ?? 1);
  if (options.content) {
    result.files = [];
    for (let index = 0; index < result.outputs; index++) {
      const content = await generationJobContent(deps, organizationId, jobId, index);
      result.files.push({ mediaType: content.headers.get('content-type')?.split(';')[0] || 'video/mp4',
        base64: Buffer.from(await content.arrayBuffer()).toString('base64') });
    }
  }
  return result;
}

/** A completed video's bytes, as OpenRouter serves them (to stream on). */
export async function generationJobContent(deps: GenerationDeps, organizationId: string, jobId: string, index = 0): Promise<Response> {
  const record = await jobRecord(deps.store, organizationId, jobId);
  if (record.provider) {
    const key = await taskProviderKey(deps.store, deps.broker, record.provider).catch((error) => { throw unavailable(error); });
    const polled = await TASK_PROVIDER_IMPLS[record.provider].poll(key, record.model, record.job!);
    const url = polled.status === 'completed' ? outputFiles(polled.output)[index] : undefined;
    if (!url) throw new GenerationRequestError(`job ${jobId} has no file ${index}`, 404);
    const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`could not download the file (${response.status})`);
    return response;
  }
  const { key, funding } = await keyFor(deps, organizationId);
  const response = await call(key, 'GET', `/videos/${encodeURIComponent(jobId)}/content?index=${index}`, undefined, 300_000);
  if (!response.ok) throw await failure(deps, organizationId, funding, response);
  return response;
}

export interface GenerationModel { id: string; name?: string; pricing?: Record<string, unknown>; [detail: string]: unknown }

/** The models OpenRouter serves for `kind`, with what each supports and costs (public, no key). */
export async function generationModels(kind: GenerationKind): Promise<GenerationModel[]> {
  const path = kind === 'image' ? '/images/models' : kind === 'video' ? '/videos/models'
    : kind === 'speech' ? '/models?output_modalities=speech' : '/models?output_modalities=text';
  const response = await fetch(`${openRouterApiBase()}${path}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`OpenRouter ${kind} models: ${response.status}`);
  const data = ((await response.json()) as { data?: any[] }).data ?? [];
  return data.filter((entry) => typeof entry?.id === 'string').map((entry) => ({ id: entry.id, name: entry.name,
    ...(entry.pricing ? { pricing: kind === 'text' ? { prompt: entry.pricing.prompt, completion: entry.pricing.completion } : entry.pricing }
      : entry.pricing_skus ? { pricing: entry.pricing_skus } : {}),
    ...(kind === 'text' && entry.context_length ? { context: entry.context_length } : {}),
    ...(entry.supported_parameters && !Array.isArray(entry.supported_parameters) ? { parameters: entry.supported_parameters } : {}),
    ...(entry.supported_durations ? { durations: entry.supported_durations } : {}),
    ...(entry.supported_resolutions ? { resolutions: entry.supported_resolutions } : {}),
    ...(entry.supported_aspect_ratios ? { aspectRatios: entry.supported_aspect_ratios } : {}),
    ...(entry.supported_voices ? { voices: entry.supported_voices.slice(0, 40) } : {}),
    ...(entry.id === GENERATION_DEFAULT_MODELS[kind] ? { default: true } : {}) }));
}

// ── Other providers (generation-providers.ts): quote, hold, submit; poll, settle ──

const unavailable = (error: unknown) => error instanceof TaskProviderUnavailable ? new GenerationUnavailable(error.message) : error;
const providerFailure = (provider: TaskProviderId, error: unknown) => error instanceof TaskProviderError
  ? error.status === 402
    ? new GenerationUnavailable(`${BRAND}'s ${TASK_PROVIDER_INFO[provider].name} balance has run out, not your credit: nothing was charged. Try again once the operator has topped it up.`)
    : new GenerationRequestError(error.message, error.status)
  : error;

async function generateWithProvider(deps: GenerationDeps, organizationId: string, provider: TaskProviderId, request: GenerationRequest,
  task?: { taskId: string; projectId?: string }): Promise<GenerationResult> {
  const impl = TASK_PROVIDER_IMPLS[provider], model = request.model!, input = request.input ?? {};
  const key = await taskProviderKey(deps.store, deps.broker, provider).catch((error) => { throw unavailable(error); });
  const estimate = await impl.quote(key, model, input).catch((error) => { throw providerFailure(provider, error); });
  if (request.maxCostUsd !== undefined && estimate.basis === 'price-list' && estimate.usd > request.maxCostUsd)
    throw new GenerationRequestError(`this request on ${model} may cost up to $${estimate.usd.toFixed(3)}, above maxCostUsd $${request.maxCostUsd}`);
  const quoted: Quote = request.maxCostUsd !== undefined && estimate.basis === 'ceiling' ? { usd: request.maxCostUsd, basis: 'ceiling' } : estimate;
  const holdId = `generation:${crypto.randomUUID()}`;
  const held = await holdGeneration(deps.store, { id: holdId, organizationId, provider, ...(task?.taskId ? { taskId: task.taskId } : {}),
    costMicros: Math.ceil(quoted.usd * 1e6), until: Date.now() + HOLD_MS.video, what: `this request on ${model}` });
  const base = { kind: request.kind, provider, model, funding: 'credit' as const, quoteUsd: Math.round(quoted.usd * 1e6) / 1e6, quoteBasis: quoted.basis };
  let job: Submitted;
  try { job = await impl.submit(key, model, input); }
  catch (error) {
    if (held) await deps.store.closeComputeHold(holdId).catch(() => undefined);
    throw providerFailure(provider, error);
  }
  const jobId = `${provider}.${job.ref}`;
  await deps.store.kvSet(jobKey(jobId), JSON.stringify({ organizationId, model, funding: 'credit', at: Date.now(), quoteUsd: base.quoteUsd,
    kind: request.kind, provider, job, ...(held ? { holdId } : {}),
    ...(task?.taskId ? { taskId: task.taskId } : {}), ...(task?.projectId ? { projectId: task.projectId } : {}) } satisfies JobRecord));
  return { ...base, status: job.status === 'completed' ? 'in_progress' : job.status, jobId };
}

async function providerJob(deps: GenerationDeps, organizationId: string, jobId: string, record: JobRecord,
  options: { content?: boolean }): Promise<GenerationResult> {
  const provider = record.provider!, impl = TASK_PROVIDER_IMPLS[provider];
  const key = await taskProviderKey(deps.store, deps.broker, provider).catch((error) => { throw unavailable(error); });
  const polled = await impl.poll(key, record.model, record.job!).catch((error) => { throw providerFailure(provider, error); });
  const result: GenerationResult = { kind: record.kind ?? 'image', provider, model: record.model, status: polled.status, jobId, funding: 'credit',
    ...(record.quoteUsd !== undefined ? { quoteUsd: record.quoteUsd } : {}), ...(polled.error ? { error: polled.error } : {}) };
  if (polled.status === 'pending' || polled.status === 'in_progress') return result;
  // Ended: book what it cost (what the provider says; else, for a
  // completed job, the quote) once, and release the hold.
  const reported = await impl.cost(key, record.model, record.job!).catch(() => undefined);
  const costUsd = reported ?? (polled.status === 'completed' ? record.quoteUsd ?? 0 : 0);
  if (costUsd > 0) await deps.store.recordUsage({ id: `usage:generation:${jobId}`, organizationId, ...(record.projectId ? { projectId: record.projectId } : {}),
    ...(record.taskId ? { taskId: record.taskId } : {}), provider, kind: 'agent.cost', quantity: 0, unit: 'request',
    costMicros: Math.round(costUsd * 1e6), startedAt: record.at, endedAt: Date.now(), fundingSource: 'managed',
    costClassification: reported !== undefined ? 'incurred' : 'estimated', metadata: { costBasis: reported !== undefined ? 'provider-reported' : 'quote', model: record.model } });
  if (record.holdId) await deps.store.closeComputeHold(record.holdId).catch(() => undefined);
  result.costUsd = costUsd;
  if (polled.status !== 'completed') return result;
  const urls = outputFiles(polled.output);
  result.output = polled.output;
  result.outputs = urls.length;
  if (options.content) result.files = (await downloadOutputs(urls)).map(({ mediaType, base64 }) => ({ mediaType, base64 }));
  return result;
}

/** Another provider's models (fal: its public catalogue, searchable; Unifically: with the operator's key). */
export async function providerModels(deps: GenerationDeps, provider: TaskProviderId, search?: string): Promise<GenerationModel[]> {
  if (provider === 'fal') {
    const url = `${(process.env.KARMAX_FAL_API_URL ?? 'https://api.fal.ai/v1').replace(/\/$/, '')}/models?limit=50${search ? `&q=${encodeURIComponent(search)}` : ''}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`fal.ai models: ${response.status}`);
    const body = (await response.json()) as { models?: any[]; data?: any[] };
    return (body.models ?? body.data ?? []).filter((entry) => typeof (entry?.endpoint_id ?? entry?.id) === 'string').map((entry) => ({
      id: entry.endpoint_id ?? entry.id, name: entry.metadata?.display_name ?? entry.display_name ?? entry.name,
      ...(entry.metadata?.category ?? entry.category ? { category: entry.metadata?.category ?? entry.category } : {}),
      docs: `https://fal.ai/models/${entry.endpoint_id ?? entry.id}/api` }));
  }
  const key = await taskProviderKey(deps.store, deps.broker, provider).catch((error) => { throw unavailable(error); });
  const response = await fetch(`${(process.env.KARMAX_UNIFICALLY_API_URL ?? 'https://api.unifically.com').replace(/\/$/, '')}/v1/models`,
    { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Unifically models: ${response.status}`);
  const words = (search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return (((await response.json()) as { data?: any[] }).data ?? [])
    .filter((entry) => typeof entry?.id === 'string' && entry.category !== 'llm')
    .filter((entry) => words.every((word) => `${entry.id} ${entry.display_name ?? ''}`.toLowerCase().includes(word)))
    .map((entry) => ({ id: entry.id, name: entry.display_name, category: entry.category, docs: 'https://docs.unifically.com/llms.txt' }));
}
