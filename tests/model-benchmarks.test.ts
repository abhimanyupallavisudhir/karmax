import { describe, expect, it } from 'vitest';
import { ArtificialAnalysis, baseSlug, benchmarkRef, toBenchmarks, variantEffort } from '../src/agent/model-benchmarks.js';

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
  claude: [{ id: 'opus[1m]' }], codex: [], kimi: [], grok: [],
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

  it('matches other vendors against the organization catalog', () => {
    expect(ref('google', 'gemini-3-1-pro-preview', 'Gemini 3.1 Pro Preview'))
      .toEqual({ provider: 'opencode', model: 'google/gemini-3.1-pro-preview' });
    expect(ref('kimi', 'kimi-k3-low', 'Kimi K3 (Low)')).toEqual({ provider: 'opencode', model: 'kimi/k3', effort: 'low' });
    expect(ref('kimi', 'kimi-k3', 'Kimi K3 (Max)')).toEqual({ provider: 'opencode', model: 'kimi/k3', effort: 'max' });
  });

  it('reports intelligence, price, end-to-end time and cost per answer, newest models only', () => {
    const models = toBenchmarks([
      row('anthropic', 'claude-opus-5-5-high', 'Claude Opus 5.5 (High, Default Fallback)'),
      row('openai', 'gpt-6-luna', 'GPT-6 Luna (Max)', { median_output_tokens_per_second: 0, pricing: { price_1m_blended_3_to_1: 0 } }),
      row('anthropic', 'claude-opus-4-1', 'Claude 4.1 Opus (Reasoning)', { release_date: '2025-08-05' }),
      row('anthropic', 'claude-opus-5-low', 'Claude Opus 5 (Low)', { evaluations: { artificial_analysis_intelligence_index: null } }),
    ], catalog, NOW);
    expect(models).toEqual([
      { id: 'id-claude-opus-5-5-high', name: 'Claude Opus 5.5 (High, Default Fallback)', creator: 'Anthropic', released: '2026-09-22',
        // 1k prompt tokens at $4/M + (5 s × 100 tok/s thinking + 500 answer) at $20/M.
        intelligence: 50, price: 8, seconds: 10, cost: 0.024, ref: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' } },
      // Unmeasured speed and price are absent, not zero.
      { id: 'id-gpt-6-luna', name: 'GPT-6 Luna (Max)', creator: 'openai', released: '2026-09-22',
        intelligence: 50, ref: { provider: 'codex', model: 'gpt-6-luna', effort: 'max' } },
    ]);
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

    const fresh = new ArtificialAnalysis({ apiKey: 'aa-key', now: () => now, fetch: async () => { calls++; return new Response('key aa-key rejected', { status: 401 }); } });
    await expect(fresh.models()).rejects.toThrow(/^Artificial Analysis returned 401$/);
    await expect(fresh.models()).rejects.toThrow(/401/);
    expect(calls).toBe(3);
    await expect(new ArtificialAnalysis({}).models()).rejects.toThrow(/not configured/);
  });
});
