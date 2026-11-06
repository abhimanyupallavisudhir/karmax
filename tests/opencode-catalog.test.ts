import { describe, expect, it } from 'vitest';
import { openCodeKeyModels } from '../src/agent/models.js';

const catalog = {
  openrouter: { models: {
    'anthropic/claude-sonnet-5': { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', tool_call: true, release_date: '2026-05-01', modalities: { output: ['text'] } },
    'old/model': { id: 'old/model', tool_call: true, status: 'deprecated', release_date: '2024-01-01' },
    'image/model': { id: 'image/model', tool_call: true, release_date: '2026-06-01', modalities: { output: ['image'] } },
    'chat/no-tools': { id: 'chat/no-tools', tool_call: false, release_date: '2026-07-01' },
    'google/gemini-3.1-pro-preview': { id: 'google/gemini-3.1-pro-preview', tool_call: true, release_date: '2026-06-02' },
  } },
  google: { models: { 'gemini-3.1-pro-preview': { id: 'gemini-3.1-pro-preview', tool_call: true } } },
};

describe('OpenCode models for an organization\'s API keys (task #515)', () => {
  it('lists only the key vendors\' tool-calling text models, newest first, from models.dev', async () => {
    let fetched = 0;
    const fetch = (async () => { fetched++; return new Response(JSON.stringify(catalog)); }) as typeof globalThis.fetch;
    const now = Date.UTC(2026, 9, 8);
    expect(await openCodeKeyModels(['openrouter'], { fetch, now })).toEqual([
      { id: 'openrouter/google/gemini-3.1-pro-preview' },
      { id: 'openrouter/anthropic/claude-sonnet-5', displayName: 'Claude Sonnet 5' },
    ]);
    // No Google key, no Google model; Kimi Code is karmax's own provider entry.
    expect((await openCodeKeyModels(['kimi', 'openrouter'], { fetch, now })).map((model) => model.id))
      .toEqual(['kimi/kimi-for-coding', 'kimi/k3', 'openrouter/google/gemini-3.1-pro-preview', 'openrouter/anthropic/claude-sonnet-5']);
    expect(fetched).toBe(1);
    expect(await openCodeKeyModels([], { fetch, now })).toEqual([]);
  });

  // OpenRouter serves ~300 models; its newest 25 were small labs' previews, and
  // Claude Opus or Gemini through OpenRouter were not offered at all.
  it('cuts a router\'s list per lab, so every lab\'s newest models are offered', async () => {
    const models: Record<string, unknown> = {};
    const add = (id: string, day: number) => { models[id] = { id, tool_call: true, release_date: `2026-10-${String(day).padStart(2, '0')}` }; };
    for (let i = 1; i <= 12; i++) add(`stealth/preview-${i}`, 10 + i);
    add('google/gemini-4-argon', 9);
    add('anthropic/claude-opus-5.5', 2);
    add('~anthropic/claude-opus-latest', 2);
    const fetch = (async () => new Response(JSON.stringify({ openrouter: { models } }))) as typeof globalThis.fetch;
    const ids = (await openCodeKeyModels(['openrouter'], { fetch, now: Date.UTC(2026, 10, 6), perRoutedCreator: 3 })).map((model) => model.id);
    expect(ids).toEqual(['openrouter/stealth/preview-12', 'openrouter/stealth/preview-11', 'openrouter/stealth/preview-10',
      'openrouter/google/gemini-4-argon', 'openrouter/anthropic/claude-opus-5.5']);
  });

  it('never answers one fetcher from a catalog another fetcher cached (CI #1650)', async () => {
    const now = Date.UTC(2026, 9, 9);
    const other = { openrouter: { models: { 'x/other': { id: 'x/other', tool_call: true } } } };
    await openCodeKeyModels(['openrouter'], { fetch: (async () => new Response(JSON.stringify(other))) as typeof globalThis.fetch, now });
    const fetch = (async () => new Response(JSON.stringify(catalog))) as typeof globalThis.fetch;
    expect((await openCodeKeyModels(['openrouter'], { fetch, now })).map((model) => model.id))
      .toEqual(['openrouter/google/gemini-3.1-pro-preview', 'openrouter/anthropic/claude-sonnet-5']);
  });

  it('lists nothing for a vendor when the catalog cannot be read', async () => {
    const fetch = (async () => { throw new Error('offline'); }) as typeof globalThis.fetch;
    // A fresh process-wide cache is not guaranteed here: a later "now" expires it.
    expect(await openCodeKeyModels(['xai'], { fetch, now: Date.UTC(2027, 0, 1) })).toEqual([]);
  });
});
