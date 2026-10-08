/**
 * Intelligence, price and speed of the models an agent can run, from
 * Artificial Analysis (artificialanalysis.ai), for the model picker's
 * "compare models" chart.
 *
 * Artificial Analysis benchmarks each reasoning effort as its own row —
 * "Claude Opus 5.5 (High)" is `claude-opus-5-5-high` — so a row maps onto one
 * `harness:model:effort` choice. A row is offered only when some harness can
 * run exactly that: Claude and Codex take any exact Anthropic/OpenAI id, and
 * every other model must be in the organization's catalog. Rows a harness
 * cannot reproduce (non-reasoning modes, ChatGPT-only and Pro models, efforts
 * the model does not accept) are dropped rather than mislabelled.
 *
 * Their free API asks to be called server-side only, cached, and credited; it
 * allows 1,000 requests a day. One fetch serves every organization for a day.
 */
import type { Provider } from '../domain/types.js';
import { claudeMessagesEffort, codexReasoningEffort, type Effort } from './effort.js';
import type { ModelCatalog } from './models.js';

export const ARTIFICIAL_ANALYSIS_URL = 'https://artificialanalysis.ai/api/v2/data/llms/models';
export const ARTIFICIAL_ANALYSIS_KEY_ENV = 'ARTIFICIAL_ANALYSIS_API_KEY';
const DAY_MS = 24 * 60 * 60_000;
/** Older models are rarely what anyone wants and crowd the chart. */
const MAX_AGE_MS = 365 * DAY_MS;
/** Artificial Analysis times a 1,000-token prompt (`prompt_length: medium`)
 * and reports end-to-end response time for a 500-token answer. */
const PROMPT_TOKENS = 1_000;
const ANSWER_TOKENS = 500;

export interface ModelRef { provider: Exclude<Provider, 'mock'>; model: string; effort?: Effort }

export interface ModelBenchmark {
  /** Artificial Analysis' stable id. */
  id: string;
  name: string;
  creator: string;
  released?: string;
  /** Artificial Analysis Intelligence Index. */
  intelligence: number;
  /** USD per million tokens, blended 3:1 input:output. */
  price?: number;
  /** Seconds to a 500-token answer: time to first answer token + generation. */
  seconds?: number;
  /**
   * Estimated USD for that answer, thinking included. A price per token alone
   * would show every effort level of a model at the same cost; what effort
   * changes is how many tokens are spent. Thinking tokens are the time to the
   * first answer token at the measured output speed.
   */
  cost?: number;
  ref: ModelRef;
}

export interface ModelBenchmarks {
  source: { name: string; url: string };
  fetchedAt: number;
  models: ModelBenchmark[];
}

interface RawModel {
  id?: unknown;
  name?: unknown;
  slug?: unknown;
  release_date?: unknown;
  model_creator?: { slug?: unknown; name?: unknown };
  evaluations?: { artificial_analysis_intelligence_index?: unknown };
  pricing?: { price_1m_blended_3_to_1?: unknown; price_1m_input_tokens?: unknown; price_1m_output_tokens?: unknown };
  median_output_tokens_per_second?: unknown;
  median_time_to_first_token_seconds?: unknown;
  median_time_to_first_answer_token?: unknown;
}

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const positive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

/**
 * The effort a row was benchmarked at, from its name's last parenthetical
 * ("(High)", "(Max, Default Fallback)"): `''` for the model's own default,
 * `null` for a mode no harness selects (non-reasoning, minimal).
 */
export function variantEffort(name: string): Effort | '' | null {
  const label = /\(([^()]*)\)\s*$/.exec(name)?.[1]?.split(',')[0]?.trim().toLowerCase() ?? '';
  if ((EFFORTS as readonly string[]).includes(label)) return label as Effort;
  if (label === 'non-reasoning' || label === 'minimal') return null;
  return '';
}

/** The model a row's slug names, without its effort or thinking-mode suffix. */
export function baseSlug(slug: string): string {
  let base = slug.toLowerCase();
  for (let previous = ''; previous !== base;) {
    previous = base;
    base = base.replace(/-(?:xhigh|high|medium|low|minimal|max|non-reasoning(?:-low-effort)?|reasoning|thinking|adaptive)$/, '');
  }
  return base;
}

/** Catalog ids compare by their last path segment with `.` spelled `-`, the
 * way Artificial Analysis writes them (`google/gemini-3.1-pro` ↔ `gemini-3-1-pro`). */
function catalogKeys(id: string): string[] {
  const parts = id.toLowerCase().split('/');
  const last = parts[parts.length - 1]!.replace(/[._]/g, '-');
  return parts.length > 1 ? [last, `${parts[parts.length - 2]}-${last}`] : [last];
}

/** The harness choice that reproduces one Artificial Analysis row, if any. */
export function benchmarkRef(row: { creator: string; slug: string; name: string }, catalog: Partial<ModelCatalog>): ModelRef | undefined {
  const effort = variantEffort(row.name);
  if (effort === null) return undefined;
  const base = baseSlug(row.slug);
  const withEffort = (provider: ModelRef['provider'], model: string): ModelRef =>
    effort ? { provider, model, effort } : { provider, model };

  if (row.creator === 'anthropic') {
    // Claude 4.5 and earlier put the version first: claude-4-5-sonnet.
    const model = base.replace(/^claude-(\d+)-(\d+)-(opus|sonnet|haiku)$/, 'claude-$3-$1-$2');
    if (/^claude-(?:opus|sonnet|haiku|fable|mythos)-\d+(?:-\d+)?$/.test(model)) {
      return !effort || claudeMessagesEffort(model, effort) === effort ? withEffort('claude', model) : undefined;
    }
  }
  if (row.creator === 'openai' && /^gpt-\d/.test(base) && !/(?:oss|pro|instant|chatgpt|daybreak|search|audio|realtime|image)/.test(base)) {
    const model = base.replace(/^gpt-(\d+)-(\d+)(?=-|$)/, 'gpt-$1.$2');
    return !effort || codexReasoningEffort(model, effort) === effort ? withEffort('codex', model) : undefined;
  }

  for (const provider of ['opencode', 'claude', 'codex', 'kimi', 'grok'] as const) {
    for (const model of catalog[provider] ?? []) {
      if (!catalogKeys(model.id).includes(base)) continue;
      if (model.effort?.length) {
        if (!effort || model.effort.includes(effort)) return withEffort(provider, model.id);
      } else if (row.slug.toLowerCase() === base) {
        // No effort control: the harness runs the model as its vendor ships
        // it, which is the row Artificial Analysis lists without a suffix.
        return { provider, model: model.id };
      }
    }
  }
  return undefined;
}

/** The rows of an Artificial Analysis response that some harness can run. */
export function toBenchmarks(data: unknown, catalog: Partial<ModelCatalog>, now = Date.now()): ModelBenchmark[] {
  if (!Array.isArray(data)) return [];
  const out: ModelBenchmark[] = [];
  const seen = new Set<string>();
  for (const raw of data as RawModel[]) {
    const intelligence = positive(raw?.evaluations?.artificial_analysis_intelligence_index);
    const creator = typeof raw?.model_creator?.slug === 'string' ? raw.model_creator.slug : '';
    if (!intelligence || typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.slug !== 'string') continue;
    const released = typeof raw.release_date === 'string' ? raw.release_date : undefined;
    if (released && now - Date.parse(released) > MAX_AGE_MS) continue;
    const ref = benchmarkRef({ creator, slug: raw.slug, name: raw.name }, catalog);
    const key = ref && `${ref.provider}:${ref.model}:${ref.effort ?? ''}`;
    if (!ref || seen.has(key!)) continue;
    seen.add(key!);
    const speed = positive(raw.median_output_tokens_per_second);
    const firstToken = positive(raw.median_time_to_first_answer_token) ?? positive(raw.median_time_to_first_token_seconds);
    const price = positive(raw.pricing?.price_1m_blended_3_to_1);
    const input = positive(raw.pricing?.price_1m_input_tokens);
    const output = positive(raw.pricing?.price_1m_output_tokens);
    const cost = speed && firstToken && input && output
      ? (PROMPT_TOKENS * input + (firstToken * speed + ANSWER_TOKENS) * output) / 1e6 : undefined;
    out.push({
      id: raw.id,
      name: raw.name,
      creator: typeof raw.model_creator?.name === 'string' ? raw.model_creator.name : creator,
      ...(released ? { released } : {}),
      intelligence,
      ...(price ? { price } : {}),
      ...(speed && firstToken ? { seconds: Math.round((firstToken + ANSWER_TOKENS / speed) * 10) / 10 } : {}),
      ...(cost ? { cost: Number(cost.toPrecision(3)) } : {}),
      ref,
    });
  }
  return out;
}

/** The Artificial Analysis model list, fetched at most once a day. A failed
 * fetch is remembered for a few minutes so a broken key or an outage cannot
 * spend the daily request allowance. */
export class ArtificialAnalysis {
  private cached?: { at: number; data: unknown[] };
  private failed?: { at: number; error: Error };
  private pending?: Promise<{ at: number; data: unknown[] }>;

  constructor(private readonly options: {
    apiKey?: string;
    fetch?: typeof fetch;
    now?: () => number;
    url?: string;
  } = {}) {}

  get configured(): boolean { return !!this.options.apiKey; }

  async models(): Promise<{ at: number; data: unknown[] }> {
    const now = (this.options.now ?? Date.now)();
    if (this.cached && now - this.cached.at < DAY_MS) return this.cached;
    if (this.failed && now - this.failed.at < 5 * 60_000) {
      if (this.cached) return this.cached;
      throw this.failed.error;
    }
    this.pending ??= this.load(now).finally(() => { this.pending = undefined; });
    try {
      return await this.pending;
    } catch (error) {
      if (this.cached) return this.cached; // a stale chart beats none
      throw error;
    }
  }

  private async load(now: number): Promise<{ at: number; data: unknown[] }> {
    if (!this.options.apiKey) throw new Error('Artificial Analysis is not configured');
    try {
      const response = await (this.options.fetch ?? fetch)(this.options.url ?? ARTIFICIAL_ANALYSIS_URL, {
        headers: { 'x-api-key': this.options.apiKey },
        signal: AbortSignal.timeout(15_000),
      });
      // Never echo the response body: it may repeat the request's key.
      if (!response.ok) throw new Error(`Artificial Analysis returned ${response.status}`);
      const body = await response.json() as { data?: unknown };
      if (!Array.isArray(body.data)) throw new Error('Artificial Analysis returned no model list');
      this.cached = { at: now, data: body.data };
      this.failed = undefined;
      return this.cached;
    } catch (error) {
      this.failed = { at: now, error: error instanceof Error ? error : new Error(String(error)) };
      throw this.failed.error;
    }
  }
}
