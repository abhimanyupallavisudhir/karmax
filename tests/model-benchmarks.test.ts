import { describe, expect, it } from 'vitest';
import { codexModelCatalog } from '../src/agent/models.js';
import { ArtificialAnalysis, BUNDLED_MODELS, BUNDLED_TASK_TOKENS, baseSlug, benchmarkRef, measurementKey, probeTokens, taskTokens,
  toBenchmarks, trimModels, variantEffort } from '../src/agent/model-benchmarks.js';

const NOW = Date.parse('2026-10-08T00:00:00Z');
const row = (creator: string, slug: string, name: string, extra: Record<string, unknown> = {}) => ({
  id: `id-${slug}`, name, slug, release_date: '2026-09-22',
  model_creator: { slug: creator, name: creator === 'anthropic' ? 'Anthropic' : creator },
  evaluations: { artificial_analysis_intelligence_index: 50 },
  pricing: { price_1m_blended_3_to_1: 8, price_1m_input_tokens: 4, price_1m_output_tokens: 20 },
  median_output_tokens_per_second: 100,
  median_time_to_first_answer_token: 5,
  ...extra,
});
const catalog = {
  claude: [{ id: 'opus[1m]' }], kimi: [], grok: [],
  codex: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4-mini'].map((id) => ({ id })),
  opencode: [{ id: 'google/gemini-3.1-pro-preview' }, { id: 'kimi/k3', effort: ['low', 'high', 'max'] }],
};
const ref = (creator: string, slug: string, name: string) => benchmarkRef({ creator, slug, name }, catalog);

describe('Artificial Analysis rows as harness choices', () => {
  it('reads the benchmarked effort from the row name', () => {
    expect(variantEffort('Claude Opus 5.5 (Max, Default Fallback)')).toBe('max');
    expect(variantEffort('GPT-6 Astra (Xhigh)')).toBe('xhigh');
    expect(variantEffort('Claude Sonnet 4.6 (Non-reasoning, High)')).toBeNull();
    expect(variantEffort('GPT-5 (Minimal)')).toBeNull();
    expect(variantEffort('Gemini 2.5 Flash Preview (Sep \'25) (Reasoning)')).toBe('');
    expect(variantEffort('Gemini 3.1 Pro Preview')).toBe('');
    expect(baseSlug('claude-sonnet-4-6-non-reasoning-low-effort')).toBe('claude-sonnet-4-6');
    expect(baseSlug('claude-opus-4-6-adaptive')).toBe('claude-opus-4-6');
  });

  it('maps Anthropic and OpenAI rows onto Claude and Codex ids', () => {
    expect(ref('anthropic', 'claude-opus-5-5-high', 'Claude Opus 5.5 (High, Default Fallback)'))
      .toEqual({ provider: 'claude', model: 'claude-opus-5-5', effort: 'high' });
    expect(ref('anthropic', 'claude-opus-5-5', 'Claude Opus 5.5 (Max, Default Fallback)'))
      .toEqual({ provider: 'claude', model: 'claude-opus-5-5', effort: 'max' });
    expect(ref('anthropic', 'claude-4-5-haiku-reasoning', 'Claude 4.5 Haiku (Reasoning)'))
      .toEqual({ provider: 'claude', model: 'claude-haiku-4-5' });
    expect(ref('openai', 'gpt-6-1-sol-low', 'GPT-6.1 Sol (Low)')).toEqual({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'low' });
    expect(ref('openai', 'gpt-6-astra', 'GPT-6 Astra (Max)')).toEqual({ provider: 'codex', model: 'gpt-6-astra', effort: 'max' });
    expect(ref('openai', 'gpt-5-4-mini-medium', 'GPT-5.4 mini (Medium)')).toEqual({ provider: 'codex', model: 'gpt-5.4-mini', effort: 'medium' });
  });

  it('drops rows no harness can reproduce', () => {
    expect(ref('anthropic', 'claude-sonnet-4-6', 'Claude Sonnet 4.6 (Non-reasoning, High)')).toBeUndefined();
    // Codex clamps max to xhigh on GPT-5.x, so a Max row would be mislabelled.
    expect(ref('openai', 'gpt-5-6-sol', 'GPT-5.6 Sol (Max)')).toBeUndefined();
    expect(ref('openai', 'gpt-5-5-pro', 'GPT-5.5 Pro (Xhigh)')).toBeUndefined();
    expect(ref('openai', 'gpt-oss-120b', 'gpt-oss-120b (High)')).toBeUndefined();
    expect(ref('deepseek', 'deepseek-v4-pro', 'DeepSeek V4 Pro 0813 (Max)')).toBeUndefined();
  });

  it('offers an OpenAI model only when the Codex catalog lists it', () => {
    // OpenAI refuses a model the pinned Codex or the login does not offer:
    // "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."
    expect(benchmarkRef({ creator: 'openai', slug: 'gpt-6-1-sol-low', name: 'GPT-6.1 Sol (Low)' },
      { ...catalog, codex: [{ id: 'gpt-6-sol' }] })).toBeUndefined();
    expect(benchmarkRef({ creator: 'openai', slug: 'gpt-6-1-sol-low', name: 'GPT-6.1 Sol (Low)' },
      { ...catalog, codex: undefined })).toBeUndefined();
  });

  it('matches other vendors against the organization catalog', () => {
    expect(ref('google', 'gemini-3-1-pro-preview', 'Gemini 3.1 Pro Preview'))
      .toEqual({ provider: 'opencode', model: 'google/gemini-3.1-pro-preview' });
    expect(ref('kimi', 'kimi-k3-low', 'Kimi K3 (Low)')).toEqual({ provider: 'opencode', model: 'kimi/k3', effort: 'low' });
    expect(ref('kimi', 'kimi-k3', 'Kimi K3 (Max)')).toEqual({ provider: 'opencode', model: 'kimi/k3', effort: 'max' });
  });

  it('reports intelligence, price, time and cost per task, newest models only', () => {
    const models = toBenchmarks([
      row('anthropic', 'claude-opus-5-5-high', 'Claude Opus 5.5 (High, Default Fallback)'),
      row('openai', 'gpt-6-luna', 'GPT-6 Luna (Max)', { median_output_tokens_per_second: 0, pricing: { price_1m_blended_3_to_1: 0 } }),
      row('anthropic', 'claude-opus-4-1', 'Claude 4.1 Opus (Reasoning)', { release_date: '2025-08-05' }),
      row('anthropic', 'claude-opus-5-low', 'Claude Opus 5 (Low)', { evaluations: { artificial_analysis_intelligence_index: null } }),
    ], catalog, NOW, []);
    expect(models).toEqual([
      { id: 'id-claude-opus-5-5-high', name: 'Claude Opus 5.5 (High, Default Fallback)', creator: 'Anthropic', released: '2026-09-22',
        // Nothing measured, so the speed test's tokens: 5 s × 100 tok/s thinking + the 500-token answer.
        // 1k prompt tokens at $4/M + 1k output tokens at $20/M, generated at 100 tok/s.
        intelligence: 50, price: 8, tokens: 1_000, seconds: 10, cost: 0.024, ref: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' } },
      // Unmeasured speed and price are absent, not zero.
      { id: 'id-gpt-6-luna', name: 'GPT-6 Luna (Max)', creator: 'openai', released: '2026-09-22',
        intelligence: 50, ref: { provider: 'codex', model: 'gpt-6-luna', effort: 'max' } },
    ]);
  });
});

describe('tokens per task', () => {
  // A row whose speed test spent `probe` tokens (thinking + the 500-token answer) at 100 tokens/s.
  const timed = (creator: string, slug: string, name: string, probe: number) =>
    row(creator, slug, name, { median_time_to_first_token_seconds: 0.5, median_time_to_first_answer_token: (probe - 500) / 100 });

  it('names a LiveBench model as an Artificial Analysis base slug and effort', () => {
    expect(measurementKey('claude-opus-5-5-max-effort')).toEqual({ base: 'claude-opus-5-5', effort: 'max' });
    expect(measurementKey('gpt-6.1-sol-xhigh')).toEqual({ base: 'gpt-6-1-sol', effort: 'xhigh' });
    expect(measurementKey('kimi-k3')).toEqual({ base: 'kimi-k3' });
    expect(measurementKey('kimi-k2.6-thinking')).toEqual({ base: 'kimi-k2-6' });
    expect(measurementKey('gpt-5.2-2025-12-11-high')).toEqual({ base: 'gpt-5-2', effort: 'high' });
  });

  it('reads thinking from the speed test only where Artificial Analysis measured it', () => {
    expect(probeTokens(timed('anthropic', 'claude-opus-5-5', 'Claude Opus 5.5 (Max)', 40_000))).toBe(40_000);
    // A model that does not stream its thinking is charged a flat 2,000 thinking tokens:
    // the first answer token comes exactly 2,000 tokens' time after the first token.
    expect(probeTokens(row('kimi', 'kimi-k3', 'Kimi K3 (Max)', {
      median_output_tokens_per_second: 41.4, median_time_to_first_token_seconds: 2.44, median_time_to_first_answer_token: 2.44 + 2000 / 41.4,
    }))).toBeUndefined();
    expect(probeTokens(row('openai', 'gpt-6-sol', 'GPT-6 Sol (Max)', { median_output_tokens_per_second: 0 }))).toBeUndefined();
  });

  it('uses measured tokens, scales a measured effort to the others, and calibrates the rest', () => {
    // Measured tokens follow T = c·P^0.5 with c = 100 for A and 50 for B, so the fit is exact:
    // elasticity 0.5 within a model, and a typical c of √(100·50) for a model never measured.
    const rows = [
      timed('anthropic', 'model-a', 'Model A (Max)', 40_000), timed('anthropic', 'model-a-xhigh', 'Model A (Xhigh)', 10_000),
      timed('anthropic', 'model-a-high', 'Model A (High)', 2_500),
      timed('openai', 'model-b', 'Model B (Max)', 10_000), timed('openai', 'model-b-xhigh', 'Model B (Xhigh)', 2_500),
      timed('google', 'model-c-high', 'Model C (High)', 3_600),
      row('kimi', 'model-d-high', 'Model D (High)', { median_output_tokens_per_second: 0 }),
      row('openai', 'model-b-low', 'Model B (Low)', { median_output_tokens_per_second: 0 }),
    ];
    const tokens = taskTokens(rows, [
      { model: 'model-a-max-effort', outputTokens: 20_000 }, { model: 'model-a-xhigh-effort', outputTokens: 10_000 },
      { model: 'model-b-max', outputTokens: 5_000 }, { model: 'model-b-xhigh', outputTokens: 2_500 },
    ]);
    const typical = Math.sqrt(100 * 50);
    expect(tokens(rows[0]!)).toEqual({ tokens: 20_000, measured: true });
    expect(tokens(rows[2]!)).toEqual({ tokens: 5_000, measured: false });
    expect(tokens(rows[5]!)).toEqual({ tokens: Math.round(typical * 60), measured: false });
    // No speed test: the typical speed-test tokens at that effort (Model A and C at High).
    expect(tokens(rows[6]!)).toEqual({ tokens: Math.round(typical * Math.sqrt(Math.sqrt(2_500 * 3_600))), measured: false });
    // Low has no speed test anywhere, so it is typed like every row: Model B scaled to the median.
    expect(tokens(rows[7]!)?.measured).toBe(false);
  });

  it('falls back to the speed test when nothing in the list was measured', () => {
    const rows = [timed('anthropic', 'model-a', 'Model A (Max)', 4_000), row('kimi', 'model-d', 'Model D', { median_output_tokens_per_second: 0 })];
    const tokens = taskTokens(rows, []);
    expect(tokens(rows[0]!)).toEqual({ tokens: 4_000, measured: false });
    expect(tokens(rows[1]!)).toBeUndefined();
  });

  it('charts cost and time per task from those tokens, and says which were measured', () => {
    const rows = [
      timed('anthropic', 'claude-opus-5-5', 'Claude Opus 5.5 (Max)', 40_000),
      timed('anthropic', 'claude-opus-5-5-xhigh', 'Claude Opus 5.5 (Xhigh)', 10_000),
      timed('anthropic', 'claude-opus-5-5-high', 'Claude Opus 5.5 (High)', 2_500),
    ];
    const models = toBenchmarks(rows, catalog, NOW, [
      { model: 'claude-opus-5-5-max-effort', outputTokens: 20_000 }, { model: 'claude-opus-5-5-xhigh-effort', outputTokens: 10_000 },
    ]);
    expect(models.map(({ ref, tokens, measured, cost, seconds }) => ({ effort: ref.effort, tokens, measured, cost, seconds }))).toEqual([
      // 1k prompt tokens at $4/M + the task's output tokens at $20/M, generated at 100 tokens/s.
      { effort: 'max', tokens: 20_000, measured: true, cost: 0.404, seconds: 200 },
      { effort: 'xhigh', tokens: 10_000, measured: true, cost: 0.204, seconds: 100 },
      { effort: 'high', tokens: 5_000, measured: undefined, cost: 0.104, seconds: 50 },
    ]);
  });

  it('ships LiveBench measurements that match the bundled list', () => {
    expect(BUNDLED_TASK_TOKENS.data.length).toBeGreaterThan(30);
    const models = toBenchmarks(BUNDLED_MODELS.data, { codex: codexModelCatalog([]) }, BUNDLED_MODELS.at);
    expect(models.find((model) => model.ref.model === 'claude-opus-5-5' && model.ref.effort === 'max')?.measured).toBe(true);
    const low = models.find((model) => model.ref.model === 'claude-opus-5-5' && model.ref.effort === 'low');
    expect(low).toMatchObject({ tokens: expect.any(Number), cost: expect.any(Number) });
    expect(low).not.toHaveProperty('measured');
  });
});

describe('Artificial Analysis client', () => {
  it('fetches once a day with the key and serves the cache in between', async () => {
    let now = NOW;
    const calls: Array<{ url: string; key: string | null }> = [];
    const source = new ArtificialAnalysis({
      apiKey: 'aa-key', now: () => now,
      fetch: async (url, init) => {
        calls.push({ url: String(url), key: new Headers(init?.headers).get('x-api-key') });
        return Response.json({ status: 200, data: [{ id: String(calls.length) }] });
      },
    });
    expect((await source.models()).data).toEqual([{ id: '1' }]);
    now += 23 * 60 * 60_000;
    expect((await source.models()).data).toEqual([{ id: '1' }]);
    now += 2 * 60 * 60_000;
    expect((await source.models()).data).toEqual([{ id: '2' }]);
    expect(calls).toEqual([
      { url: 'https://artificialanalysis.ai/api/v2/data/llms/models', key: 'aa-key' },
      { url: 'https://artificialanalysis.ai/api/v2/data/llms/models', key: 'aa-key' },
    ]);
  });

  it('backs off after a failure and keeps serving the last good list', async () => {
    let now = NOW;
    let status = 200;
    let calls = 0;
    const source = new ArtificialAnalysis({
      apiKey: 'aa-key', now: () => now,
      fetch: async () => { calls++; return status === 200 ? Response.json({ data: [{ id: 'ok' }] }) : new Response('key aa-key rejected', { status }); },
    });
    await source.models();
    now += 25 * 60 * 60_000;
    status = 429;
    expect((await source.models()).data).toEqual([{ id: 'ok' }]);
    expect((await source.models()).data).toEqual([{ id: 'ok' }]);
    expect(calls).toBe(2);

    const fresh = new ArtificialAnalysis({ apiKey: 'aa-key', snapshot: null, now: () => now, fetch: async () => { calls++; return new Response('key aa-key rejected', { status: 401 }); } });
    await expect(fresh.models()).rejects.toThrow(/^Artificial Analysis returned 401$/);
    await expect(fresh.models()).rejects.toThrow(/401/);
    expect(calls).toBe(3);
    await expect(new ArtificialAnalysis({ snapshot: null }).models()).rejects.toThrow(/not configured/);
  });
});

describe('bundled snapshot', () => {
  it('serves without a key and never touches the network', async () => {
    const source = new ArtificialAnalysis({ fetch: async () => { throw new Error('no network'); } });
    expect(source.available).toBe(true);
    const { at, data } = await source.models();
    expect(at).toBe(BUNDLED_MODELS.at);
    // Charted as of the snapshot's own date, so an old snapshot keeps its newest models.
    const models = toBenchmarks(data, { codex: codexModelCatalog([]) }, at);
    expect(models.length).toBeGreaterThan(20);
    expect(new Set(models.map((model) => model.ref.provider))).toEqual(new Set(['claude', 'codex']));
    expect(models.some((model) => model.cost && model.seconds)).toBe(true);
    // The Codex offline catalog covers the newest benchmarked OpenAI model.
    expect(models.some((model) => model.ref.model === 'gpt-6.1-sol')).toBe(true);
  });

  it('falls back to the snapshot when the live list cannot be fetched', async () => {
    const source = new ArtificialAnalysis({ apiKey: 'aa-key', now: () => NOW, fetch: async () => new Response('', { status: 500 }) });
    expect((await source.models()).at).toBe(BUNDLED_MODELS.at);
  });

  it('keeps only the fields the chart reads, for the year before the fetch', () => {
    const [kept, ...rest] = trimModels([
      row('anthropic', 'claude-opus-5-5-high', 'Claude Opus 5.5 (High)', { secret_field: 'x', evaluations: { artificial_analysis_intelligence_index: 50, gpqa: 0.9 } }),
      row('anthropic', 'claude-opus-4-1', 'Claude 4.1 Opus', { release_date: '2025-08-05' }),
      row('anthropic', 'claude-x', 'Claude X', { evaluations: { artificial_analysis_intelligence_index: null } }),
    ], NOW);
    expect(rest).toEqual([]);
    expect(kept).not.toHaveProperty('secret_field');
    expect(kept!.evaluations).toEqual({ artificial_analysis_intelligence_index: 50 });
    expect(toBenchmarks([kept], {}, NOW)).toHaveLength(1);
  });
});
