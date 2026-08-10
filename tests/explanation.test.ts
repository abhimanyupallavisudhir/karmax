import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_EXPLANATION_SETTINGS,
  explanationProvider,
  normalizeExplanationSettings,
  requestExplanation,
} from '../src/agent/explanation.js';

describe('explanation model calls', () => {
  it('defaults to Gemini Flash through OpenRouter', () => {
    expect(DEFAULT_EXPLANATION_SETTINGS.endpoint).toContain('openrouter.ai');
    expect(DEFAULT_EXPLANATION_SETTINGS.model).toBe('google/gemini-3.6-flash');
    expect(explanationProvider(DEFAULT_EXPLANATION_SETTINGS.endpoint)).toBe('openrouter');
  });

  it('sends prior user messages and the target through an OpenAI-compatible endpoint', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'A simpler answer.' } }],
    }), { status: 200 })) as unknown as typeof fetch;
    const text = await requestExplanation({
      settings: DEFAULT_EXPLANATION_SETTINGS,
      apiKey: 'secret',
      message: 'Dense agent answer',
      userContext: ['Original request', 'Follow-up'],
      fetchImpl,
    });
    expect(text).toBe('A simpler answer.');
    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(url).toBe(DEFAULT_EXPLANATION_SETTINGS.endpoint);
    expect(init.headers.authorization).toBe('Bearer secret');
    const body = JSON.parse(init.body);
    expect(body.messages[0].content).toBe(DEFAULT_EXPLANATION_SETTINGS.prompt);
    expect(body.messages[1].content).toContain('Original request');
    expect(body.messages[1].content).toContain('Dense agent answer');
  });

  it('uses native Anthropic and Google request shapes', async () => {
    const anthropicFetch = vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: 'text', text: 'Anthropic explanation' }],
    }), { status: 200 })) as unknown as typeof fetch;
    await expect(requestExplanation({
      settings: { endpoint: 'https://api.anthropic.com', model: 'claude-sonnet', prompt: 'Explain.' },
      apiKey: 'anthropic-key', message: 'answer', userContext: [], fetchImpl: anthropicFetch,
    })).resolves.toBe('Anthropic explanation');
    expect((anthropicFetch as any).mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages');
    expect((anthropicFetch as any).mock.calls[0][1].headers['x-api-key']).toBe('anthropic-key');

    const googleFetch = vi.fn(async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'Google explanation' }] } }],
    }), { status: 200 })) as unknown as typeof fetch;
    await expect(requestExplanation({
      settings: { endpoint: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-flash', prompt: 'Explain.' },
      apiKey: 'google-key', message: 'answer', userContext: [], fetchImpl: googleFetch,
    })).resolves.toBe('Google explanation');
    expect((googleFetch as any).mock.calls[0][0]).toContain('/models/gemini-flash:generateContent');
    expect((googleFetch as any).mock.calls[0][1].headers['x-goog-api-key']).toBe('google-key');
  });

  it('supports the native OpenAI Responses endpoint', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ output_text: 'OpenAI explanation' }), { status: 200 })) as unknown as typeof fetch;
    await expect(requestExplanation({
      settings: { endpoint: 'https://api.openai.com/v1/responses', model: 'openai/gpt-5-mini', prompt: 'Explain.' },
      apiKey: 'openai-key', message: 'answer', userContext: ['request'], fetchImpl,
    })).resolves.toBe('OpenAI explanation');
    const body = JSON.parse((fetchImpl as any).mock.calls[0][1].body);
    expect(body.model).toBe('gpt-5-mini');
    expect(body.instructions).toBe('Explain.');
    expect(body.input).toContain('request');
  });

  it('validates inherited overrides before a request is made', () => {
    expect(normalizeExplanationSettings({ model: 'other/model' }).model).toBe('other/model');
    expect(() => normalizeExplanationSettings({ endpoint: 'file:///tmp/key' })).toThrow('HTTP or HTTPS');
    expect(explanationProvider('https://api.together.xyz/v1/chat/completions')).toBe('together');
    expect(explanationProvider('https://openrouter.attacker.example/v1/chat/completions')).toBe('attacker');
  });
});
