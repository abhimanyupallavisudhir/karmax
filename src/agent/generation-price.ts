/**
 * What a generation will cost at most, before it runs (wiki features/generate):
 * worked out from OpenRouter's own price lists and the request's parameters,
 * not guessed. The quote is held against the credit until the generation's
 * actual cost is booked, so it must not be lower than what OpenRouter will
 * charge; where a price list is ambiguous (several SKUs could apply) it takes
 * the highest, and parameters left out count at the model's largest (the
 * longest duration, the highest resolution). Where nothing in a model's price
 * list can be read it falls back to a fixed ceiling per kind.
 *
 * Prices are USD at OpenRouter's prices; the credit is charged that × the
 * organization's compute multiplier.
 */
import { openRouterApiBase } from './included-model.js';

export type QuoteKind = 'text' | 'image' | 'video' | 'speech';

export interface Quote {
  usd: number;
  /** price-list: from the model's published prices; ceiling: none could be read. */
  basis: 'price-list' | 'ceiling';
}

export interface QuoteRequest {
  prompt: string;
  system?: string;
  count?: number;
  duration?: number;
  resolution?: string;
  size?: string;
  audio?: boolean;
  maxTokens?: number;
  /** Input images (or, for video, frames and references). */
  references?: number;
}

/** When a model's price list cannot be read: the most one generation may hold. */
export const QUOTE_CEILING_USD: Readonly<Record<QuoteKind, number>> = { text: 1, image: 1, speech: 1, video: 10 };
/** Text: the reply is bounded by this many tokens unless the request says otherwise. */
export const TEXT_MAX_TOKENS_DEFAULT = 8192;
/** About how many tokens a character of prompt is, at most (most tokenizers: ~4 characters a token). */
const TOKENS_PER_CHAR = 1 / 3;
/** An input image, in prompt tokens, at most (OpenAI's high detail on a large image, ~1,500). */
const TOKENS_PER_IMAGE = 1_600;
/** Output image tokens per image, at most, by resolution: Gemini's are ~1,100 at 1K, ~1,700 at 2K, ~2,500 at 4K;
 * gpt-image's high quality reaches ~6,200 on its largest size. */
const IMAGE_OUTPUT_TOKENS: Record<string, number> = { '512': 1_200, '1k': 1_800, '2k': 2_600 };
const IMAGE_OUTPUT_TOKENS_MAX = 6_500;
/** Speech: characters a second of speech at most (fast speech is ~15 a second); audio tokens a second (~25–32). */
const SPEECH_CHARS_PER_SECOND = 10;
const SPEECH_TOKENS_PER_SECOND = 32;
/** A completion price at least this high (USD) is per second of audio, not per token (OpenRouter: per-second models put their rate there). */
const PER_SECOND_PRICE_MIN = 0.0005;
/** Video frames a second, for models priced per video token (tokens ≈ width × height × fps × seconds / 1024). */
const VIDEO_FPS = 24;

const RESOLUTIONS: Record<string, [number, number]> = {
  '360p': [640, 360], '480p': [854, 480], '540p': [960, 540], '720p': [1280, 720], '768p': [1366, 768],
  '1080p': [1920, 1080], '1k': [1920, 1080], '2k': [2560, 1440], '4k': [3840, 2160],
};
const RESOLUTION_SUFFIX = /_(360p|480p|540p|720p|768p|1080p|2k|4k)(?=_|$)/;

const num = (value: unknown) => { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : undefined; };
const normalResolution = (value?: string) => value?.trim().toLowerCase();

/** Width × height of the request: its size, else its resolution, else the largest of `supported`. */
function frame(request: QuoteRequest, supported?: string[]): [number, number] {
  const size = request.size?.match(/^(\d+)x(\d+)$/i);
  if (size) return [Number(size[1]), Number(size[2])];
  const asked = normalResolution(request.resolution);
  if (asked && RESOLUTIONS[asked]) return RESOLUTIONS[asked];
  const known = (supported ?? []).map((value) => RESOLUTIONS[normalResolution(value)!]).filter(Boolean) as Array<[number, number]>;
  return known.sort((a, b) => b[0] * b[1] - a[0] * a[1])[0] ?? RESOLUTIONS['4k']!;
}

/** A text model (OpenRouter's /models entry): its prompt at the prompt price
 * and up to `maxTokens` of reply (reasoning included) at the completion price,
 * at the dearest hour of its time-of-day prices. */
export function quoteText(model: { pricing?: Record<string, unknown>; top_provider?: { max_completion_tokens?: number } } | undefined,
  request: QuoteRequest): Quote {
  const pricing = model?.pricing;
  if (!pricing) return { usd: QUOTE_CEILING_USD.text, basis: 'ceiling' };
  const priced = [pricing, ...(Array.isArray(pricing.overrides) ? pricing.overrides as Record<string, unknown>[] : [])];
  const highest = (field: string) => Math.max(0, ...priced.map((entry) => num(entry[field]) ?? 0));
  const prompt = highest('prompt'), completion = Math.max(highest('completion'), highest('internal_reasoning'));
  if (num(pricing.prompt) === undefined || num(pricing.completion) === undefined) return { usd: QUOTE_CEILING_USD.text, basis: 'ceiling' };
  const promptTokens = Math.ceil((request.prompt.length + (request.system?.length ?? 0)) * TOKENS_PER_CHAR) + (request.references ?? 0) * TOKENS_PER_IMAGE;
  const cap = num(model?.top_provider?.max_completion_tokens);
  const replyTokens = Math.min(request.maxTokens ?? TEXT_MAX_TOKENS_DEFAULT, cap || Infinity);
  return { usd: promptTokens * prompt + replyTokens * completion + (num(pricing.request) ?? 0)
    + (request.references ?? 0) * (num(pricing.image) ?? 0), basis: 'price-list' };
}

/** An image model (OpenRouter's /images/models/:id/endpoints): the dearest of
 * its providers, per image or per token, × the number of images. */
export function quoteImage(endpoints: Array<{ pricing?: Array<{ billable?: string; unit?: string; cost_usd?: number; variant?: string }> }> | undefined,
  request: QuoteRequest): Quote {
  const count = request.count ?? 1;
  const asked = normalResolution(request.resolution);
  const outputTokens = (asked && IMAGE_OUTPUT_TOKENS[asked]) || IMAGE_OUTPUT_TOKENS_MAX;
  const promptTokens = Math.ceil(request.prompt.length * TOKENS_PER_CHAR);
  let best: number | undefined;
  for (const endpoint of endpoints ?? []) {
    const entries = (endpoint.pricing ?? []).filter((entry) => num(entry.cost_usd) !== undefined);
    if (!entries.length) continue;
    let usd = 0, read = false;
    const perImage = entries.filter((entry) => entry.unit === 'image' && (entry.billable ?? 'output_image') === 'output_image');
    if (perImage.length) {
      const matching = asked ? perImage.filter((entry) => normalResolution(entry.variant) === asked) : [];
      usd += Math.max(...(matching.length ? matching : perImage).map((entry) => entry.cost_usd!)) * count;
      read = true;
    }
    for (const entry of entries) {
      if (entry.unit !== 'token') continue;
      if (entry.billable === 'output_image') { usd += entry.cost_usd! * outputTokens * count; read = true; }
      else if (entry.billable === 'input_text') usd += entry.cost_usd! * promptTokens;
      else if (entry.billable === 'input_image') usd += entry.cost_usd! * (request.references ?? 0) * TOKENS_PER_IMAGE;
    }
    if (read) best = Math.max(best ?? 0, usd);
  }
  return best === undefined ? { usd: QUOTE_CEILING_USD.image * count, basis: 'ceiling' } : { usd: best, basis: 'price-list' };
}

/** A speech model (OpenRouter's /models entry): per character of text, and
 * per second (or audio token) of speech where it also charges for output. */
export function quoteSpeech(model: { pricing?: Record<string, unknown> } | undefined, request: QuoteRequest): Quote {
  const prompt = num(model?.pricing?.prompt), completion = num(model?.pricing?.completion);
  if (prompt === undefined && completion === undefined) return { usd: QUOTE_CEILING_USD.speech, basis: 'ceiling' };
  const chars = request.prompt.length, seconds = chars / SPEECH_CHARS_PER_SECOND;
  const output = !completion ? 0 : completion >= PER_SECOND_PRICE_MIN ? completion * seconds : completion * seconds * SPEECH_TOKENS_PER_SECOND;
  return { usd: (prompt ?? 0) * chars + output, basis: 'price-list' };
}

export interface VideoModel {
  supported_durations?: number[] | null;
  supported_resolutions?: string[] | null;
  pricing_skus?: Record<string, string> | null;
}

/** A video model (OpenRouter's /videos/models entry): the dearest of its
 * SKUs that can apply to this resolution, × the duration (the model's longest
 * when none is asked for), plus its per-image and minimum charges. */
export function quoteVideo(model: VideoModel | undefined, request: QuoteRequest): Quote {
  const skus = Object.entries(model?.pricing_skus ?? {}).map(([key, value]) => [key.toLowerCase(), num(value)] as const)
    .filter((entry): entry is readonly [string, number] => entry[1] !== undefined);
  if (!model || !skus.length) return { usd: QUOTE_CEILING_USD.video, basis: 'ceiling' };
  const durations = (model.supported_durations ?? []).filter((value) => Number.isFinite(value));
  const seconds = request.duration ?? (durations.length ? Math.max(...durations) : 20);
  // The SKUs for a resolution are those that name it; where none does, those
  // that name none (the model's base price). With no resolution asked for,
  // the dearest of the model's resolutions.
  const named = (key: string) => key.match(RESOLUTION_SUFFIX)?.[1];
  const perSecondAt = (resolution: string | undefined): number | undefined => {
    const [width, height] = frame({ ...request, ...(resolution ? { resolution } : {}) }, model.supported_resolutions ?? undefined);
    const specific = resolution ? skus.filter(([key]) => named(key) === resolution) : [];
    const rates: number[] = [];
    for (const [key, price] of specific.length ? specific : skus.filter(([key]) => !named(key))) {
      if (/duration_seconds/.test(key)) rates.push(price);
      else if (/^cents_per_(second_output|video_output_second|second_video_continuation)/.test(key)) rates.push(price / 100);
      else if (key.startsWith('cents_per_megapixel_second')) rates.push(price / 100 * width * height / 1e6);
      else if (key.startsWith('video_tokens')) rates.push(price * width * height * VIDEO_FPS / 1024);
    }
    return rates.length ? Math.max(...rates) : undefined;
  };
  const asked = request.size ? undefined : normalResolution(request.resolution);
  const resolutions = asked ? [asked] : (model.supported_resolutions ?? []).map((value) => normalResolution(value)!);
  const perSecond = (resolutions.length ? resolutions : [undefined]).map(perSecondAt).filter((rate): rate is number => rate !== undefined);
  if (!perSecond.length) return { usd: QUOTE_CEILING_USD.video, basis: 'ceiling' };
  const sku = (key: string) => skus.find(([name]) => name === key)?.[1];
  const images = request.references ?? 0;
  const perImage = Math.max((sku('cents_per_image_input') ?? 0) / 100, sku('reference_images') ?? 0, sku('reference_input_images') ?? 0);
  const usd = Math.max(Math.max(...perSecond) * seconds + perImage * images, (sku('minimum_cents_per_generation') ?? 0) / 100);
  return { usd, basis: 'price-list' };
}

// ── OpenRouter's price lists, cached ──
const TTL_MS = 6 * 60 * 60_000;
const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(path: string, read: (body: any) => T): Promise<T | undefined> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
  const response = await fetch(`${openRouterApiBase()}${path}`, { signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
  if (!response?.ok) return undefined;
  const value = read(await response.json().catch(() => ({})));
  cache.set(path, { at: Date.now(), value });
  return value;
}
const byId = (body: { data?: any[] }) => new Map((body?.data ?? []).filter((entry) => typeof entry?.id === 'string').map((entry) => [entry.id as string, entry]));

/** Tests: forget cached price lists. */
export function resetQuoteCache(): void { cache.clear(); }

/** The most `model` may cost for this request, from OpenRouter's price lists. */
export async function quote(kind: QuoteKind, model: string, request: QuoteRequest): Promise<Quote> {
  if (kind === 'text') return quoteText((await cached('/models', byId))?.get(model), request);
  if (kind === 'speech') return quoteSpeech((await cached('/models?output_modalities=speech', byId))?.get(model), request);
  if (kind === 'video') return quoteVideo((await cached('/videos/models', byId))?.get(model), request);
  const endpoints = await cached(`/images/models/${model.split('/').map(encodeURIComponent).join('/')}/endpoints`,
    (body) => (body?.data?.endpoints ?? body?.endpoints ?? []) as Parameters<typeof quoteImage>[0]);
  return quoteImage(endpoints, request);
}
