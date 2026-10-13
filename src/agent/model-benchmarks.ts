/**
 * Intelligence, price and speed of the models an agent can run, from
 * Artificial Analysis (artificialanalysis.ai), for the model picker's
 * "compare models" chart.
 *
 * Artificial Analysis benchmarks each reasoning effort as its own row —
 * "Claude Opus 5.5 (High)" is `claude-opus-5-5-high` — so a row maps onto one
 * `harness:model:effort` choice. A row is offered only when some harness can
 * run exactly that: Claude takes any exact Anthropic id, and every other model
 * — OpenAI's included — must be in the organization's catalog (OpenAI refuses a
 * model the pinned Codex or the login does not offer). Rows a harness
 * cannot reproduce (non-reasoning modes, ChatGPT-only and Pro models, efforts
 * the model does not accept) are dropped rather than mislabelled.
 *
 * Cost and time are per task: the output tokens (thinking included) a model
 * and effort spend on a task, at its token price and output speed. LiveBench
 * measures those tokens for the models it runs; the rest are estimated from
 * them (see taskTokens).
 *
 * The list ships with tavya as a snapshot (model-benchmarks.json and
 * model-task-tokens.json, refreshed by scripts/refresh-model-benchmarks.ts), so the chart works on any installation
 * without a key. With ARTIFICIAL_ANALYSIS_API_KEY the server also fetches the
 * live list once a day — their free API asks to be called server-side only,
 * cached and credited, and allows 1,000 requests a day — falling back to the
 * snapshot when that fails.
 */
import type { Provider } from '../domain/types.js';
import { claudeMessagesEffort, codexReasoningEffort, type Effort } from './effort.js';
import type { ModelCatalog } from './models.js';
import bundled from './model-benchmarks.json' with { type: 'json' };
import bundledTokens from './model-task-tokens.json' with { type: 'json' };

export const ARTIFICIAL_ANALYSIS_URL = 'https://artificialanalysis.ai/api/v2/data/llms/models';
export const ARTIFICIAL_ANALYSIS_KEY_ENV = 'ARTIFICIAL_ANALYSIS_API_KEY';
const DAY_MS = 24 * 60 * 60_000;
/** Older models (than the list) are rarely what anyone wants and crowd the chart. */
const MAX_AGE_MS = 365 * DAY_MS;
/** Artificial Analysis times a 1,000-token prompt (`prompt_length: medium`)
 * and reports end-to-end response time for a 500-token answer. A LiveBench
 * question's prompt is about as long (~1,250 tokens), so a task's prompt is priced as this. */
const PROMPT_TOKENS = 1_000;
const ANSWER_TOKENS = 500;
/** What Artificial Analysis assumes a model thinks when it cannot see the
 * thinking: its first answer token is timed at exactly this many tokens' worth
 * of output after its first token. */
const ASSUMED_THINKING_TOKENS = 2_000;
/** Within-model elasticity of task tokens to speed-test tokens when too few
 * models have two measured efforts to fit it (fitted: 0.49 on 2026-10-12). */
const DEFAULT_ELASTICITY = 0.5;
export const LIVEBENCH_URL = 'https://livebench.ai/';

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
  /** Output tokens, thinking included, spent on a task (see taskTokens). */
  tokens?: number;
  /** The tokens were measured by LiveBench for this model and effort, not estimated. */
  measured?: true;
  /** Seconds to generate those tokens at the measured output speed. */
  seconds?: number;
  /**
   * USD per task: the prompt and those tokens at the model's prices. A price per
   * token alone would show every effort level of a model at the same cost, and
   * models differ several-fold in how many tokens they spend on the same task.
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
    if (catalog.codex?.some((m) => m.id === model)) {
      return !effort || codexReasoningEffort(model, effort) === effort ? withEffort('codex', model) : undefined;
    }
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

// ── Tokens per task ──────────────────────────────────────────────────────────

/** Output tokens a LiveBench model spent per question, on average. */
export interface TokenMeasurement { model: string; outputTokens: number }

/** A LiveBench model id as an Artificial Analysis base slug and effort:
 * `claude-opus-5-5-max-effort` → claude-opus-5-5, max; `gpt-6.1-sol-xhigh` → gpt-6-1-sol, xhigh. */
export function measurementKey(model: string): { base: string; effort?: Effort } {
  const id = model.toLowerCase().replace(/-20\d\d-?\d\d-?\d\d(?=-|$)/, '').replace(/[._]/g, '-');
  const effort = /-(low|medium|high|xhigh|max)(?:-effort)?$/.exec(id)?.[1] as Effort | undefined;
  const base = baseSlug(id.replace(/-effort$/, ''));
  return effort ? { base, effort } : { base };
}

const measures = (key: { base: string; effort?: Effort }, row: RawModel): boolean =>
  typeof row.slug === 'string' && typeof row.name === 'string' && baseSlug(row.slug) === key.base
  // Without an effort, LiveBench ran the model as shipped: the row without a suffix.
  && (key.effort ? variantEffort(row.name) === key.effort : row.slug.toLowerCase() === key.base);

/**
 * Thinking plus answer tokens on Artificial Analysis' speed test: the time to
 * the first answer token at the output speed, plus the 500-token answer.
 * Undefined when not measured — no speed, or thinking the model does not
 * stream, which Artificial Analysis fills in as a flat 2,000 tokens.
 */
export function probeTokens(row: RawModel): number | undefined {
  const speed = positive(row.median_output_tokens_per_second);
  const firstAnswer = positive(row.median_time_to_first_answer_token) ?? positive(row.median_time_to_first_token_seconds);
  if (!speed || !firstAnswer) return undefined;
  const firstToken = positive(row.median_time_to_first_token_seconds);
  if (firstToken && Math.abs((firstAnswer - firstToken) * speed - ASSUMED_THINKING_TOKENS) < ASSUMED_THINKING_TOKENS / 100) return undefined;
  return firstAnswer * speed + ANSWER_TOKENS;
}

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const groupBy = <T, K>(items: T[], key: (item: T) => K) => {
  const groups = new Map<K, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
};
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.ceil((sorted.length - 1) / 2)]!) / 2;
};

/**
 * Output tokens per task for each row of an Artificial Analysis list.
 *
 * LiveBench measures them for the model and effort it ran. The speed test's
 * tokens alone are a poor guide (5× off on a typical model, 50× on the worst,
 * and worse than assuming the same count for every model): one short prompt
 * says little about how long a model thinks on real tasks. Across the efforts
 * of one model, though, they track task tokens closely as a power law,
 * T ∝ P^k with k ≈ 0.5 — so
 *  - a row LiveBench measured is that measurement;
 *  - another effort of a measured model is scaled from the measured efforts by
 *    (P / P_measured)^k, within ~10%;
 *  - a model never measured gets the typical model's e^α·P^k, ~2× either way.
 * k is fitted within models, α across them, from the rows of this list; a row
 * whose speed test did not measure thinking takes the median speed-test tokens
 * of its effort level. With nothing measured, the speed test's tokens it is.
 */
export function taskTokens(rows: RawModel[], measurements: TokenMeasurement[]): (row: RawModel) => { tokens: number; measured: boolean } | undefined {
  const measured = new Map<RawModel, number>();
  for (const measurement of measurements) {
    const key = measurementKey(measurement.model);
    for (const row of rows) if (measurement.outputTokens > 0 && measures(key, row)) measured.set(row, measurement.outputTokens);
  }
  const group = (row: RawModel) => baseSlug(String(row.slug));
  const probes = new Map(rows.flatMap((row) => { const probe = probeTokens(row); return probe ? [[row, Math.log(probe)] as const] : []; }));
  const fitted = [...measured].flatMap(([row, tokens]) => probes.has(row) ? [{ group: group(row), x: probes.get(row)!, y: Math.log(tokens) }] : []);
  if (!fitted.length) return (row) => { const probe = probeTokens(row); return probe ? { tokens: Math.round(probe), measured: false } : undefined; };

  // Pooled within-model slope: how task tokens grow with speed-test tokens across one model's efforts.
  let covariance = 0, variance = 0;
  for (const points of groupBy(fitted, (point) => point.group).values()) {
    const x = mean(points.map((point) => point.x)), y = mean(points.map((point) => point.y));
    for (const point of points) { covariance += (point.x - x) * (point.y - y); variance += (point.x - x) ** 2; }
  }
  const k = variance > 0 ? covariance / variance : DEFAULT_ELASTICITY;
  const alpha = mean(fitted.map((point) => point.y - k * point.x));
  const byEffort = groupBy([...probes.keys()], (row) => variantEffort(String(row.name)));
  const typical = (effort: ReturnType<typeof variantEffort>) => median((byEffort.get(effort) ?? [...probes.keys()]).map((row) => probes.get(row)!));
  const x = (row: RawModel) => probes.get(row) ?? typical(variantEffort(String(row.name)));

  return (row) => {
    const own = measured.get(row);
    if (own) return { tokens: own, measured: true };
    const anchors = [...measured].filter(([other]) => group(other) === group(row));
    const log = anchors.length
      ? mean(anchors.map(([other, tokens]) => Math.log(tokens) + k * (x(row) - x(other))))
      : alpha + k * x(row);
    return { tokens: Math.round(Math.exp(log)), measured: false };
  };
}

/** A response reduced to the fields read here, for the bundled snapshot. */
export function trimModels(data: unknown, now = Date.now()): RawModel[] {
  if (!Array.isArray(data)) return [];
  return (data as RawModel[]).flatMap((raw) => {
    const released = typeof raw?.release_date === 'string' ? raw.release_date : undefined;
    if (!raw?.evaluations?.artificial_analysis_intelligence_index || (released && now - Date.parse(released) > MAX_AGE_MS)) return [];
    return [{
      id: raw.id, name: raw.name, slug: raw.slug, release_date: raw.release_date,
      model_creator: { slug: raw.model_creator?.slug, name: raw.model_creator?.name },
      evaluations: { artificial_analysis_intelligence_index: raw.evaluations.artificial_analysis_intelligence_index },
      pricing: {
        price_1m_blended_3_to_1: raw.pricing?.price_1m_blended_3_to_1,
        price_1m_input_tokens: raw.pricing?.price_1m_input_tokens,
        price_1m_output_tokens: raw.pricing?.price_1m_output_tokens,
      },
      median_output_tokens_per_second: raw.median_output_tokens_per_second,
      median_time_to_first_token_seconds: raw.median_time_to_first_token_seconds,
      median_time_to_first_answer_token: raw.median_time_to_first_answer_token,
    }];
  });
}

/**
 * The rows of an Artificial Analysis list that some harness can run. `now` is
 * when the list was fetched, so an old snapshot still shows its newest models.
 */
export function toBenchmarks(data: unknown, catalog: Partial<ModelCatalog>, now = Date.now(),
  measurements: TokenMeasurement[] = BUNDLED_TASK_TOKENS.data): ModelBenchmark[] {
  if (!Array.isArray(data)) return [];
  const tokensFor = taskTokens((data as RawModel[]).filter((raw) => raw && typeof raw === 'object'), measurements);
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
    const task = tokensFor(raw);
    const speed = positive(raw.median_output_tokens_per_second);
    const price = positive(raw.pricing?.price_1m_blended_3_to_1);
    const input = positive(raw.pricing?.price_1m_input_tokens);
    const output = positive(raw.pricing?.price_1m_output_tokens);
    const cost = task && input && output ? (PROMPT_TOKENS * input + task.tokens * output) / 1e6 : undefined;
    out.push({
      id: raw.id,
      name: raw.name,
      creator: typeof raw.model_creator?.name === 'string' ? raw.model_creator.name : creator,
      ...(released ? { released } : {}),
      intelligence,
      ...(price ? { price } : {}),
      ...(task ? { tokens: task.tokens, ...(task.measured ? { measured: true as const } : {}) } : {}),
      ...(task && speed ? { seconds: Math.round((task.tokens / speed) * 10) / 10 } : {}),
      ...(cost ? { cost: Number(cost.toPrecision(3)) } : {}),
      ref,
    });
  }
  return out;
}

export const BUNDLED_MODELS = { at: Date.parse(bundled.fetchedAt), data: bundled.data as unknown[] };
/** LiveBench's measured output tokens per question (livebench.ai cost table). */
export const BUNDLED_TASK_TOKENS = { at: Date.parse(bundledTokens.fetchedAt), data: bundledTokens.data as TokenMeasurement[] };

/** The Artificial Analysis model list: the bundled snapshot, or with a key the
 * live list fetched at most once a day. A failed fetch is remembered for a few
 * minutes so a broken key or an outage cannot spend the daily allowance, and
 * the newest list in hand keeps serving meanwhile. */
export class ArtificialAnalysis {
  private cached?: { at: number; data: unknown[] };
  private failed?: { at: number; error: Error };
  private pending?: Promise<{ at: number; data: unknown[] }>;

  constructor(private readonly options: {
    apiKey?: string;
    fetch?: typeof fetch;
    now?: () => number;
    url?: string;
    /** The list served without a key or before a fetch succeeds; null for none. */
    snapshot?: { at: number; data: unknown[] } | null;
  } = {}) {}

  private get snapshot() { return this.options.snapshot === undefined ? BUNDLED_MODELS : this.options.snapshot; }

  /** Whether there is any list to chart. */
  get available(): boolean { return !!this.options.apiKey || !!this.snapshot?.data.length; }

  async models(): Promise<{ at: number; data: unknown[] }> {
    const fallback = this.cached ?? this.snapshot;
    if (!this.options.apiKey) {
      if (fallback) return fallback;
      throw new Error('Artificial Analysis is not configured');
    }
    const now = (this.options.now ?? Date.now)();
    if (this.cached && now - this.cached.at < DAY_MS) return this.cached;
    if (this.failed && now - this.failed.at < 5 * 60_000) {
      if (fallback) return fallback;
      throw this.failed.error;
    }
    this.pending ??= this.load(now).finally(() => { this.pending = undefined; });
    try {
      return await this.pending;
    } catch (error) {
      if (fallback) return fallback; // a stale chart beats none
      throw error;
    }
  }

  private async load(now: number): Promise<{ at: number; data: unknown[] }> {
    try {
      const response = await (this.options.fetch ?? fetch)(this.options.url ?? ARTIFICIAL_ANALYSIS_URL, {
        headers: { 'x-api-key': this.options.apiKey! },
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
