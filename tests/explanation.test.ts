import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_EXPLANATION_SETTINGS,
  explanationProvider,
  normalizeExplanationSettings,
  requestExplanation,
} from '../src/agent/explanation.js';
import { publicModelFetch } from '../src/mcp/connections/http.js';

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

  // Any member (and any agent, via platform_request) may override the endpoint
  // per request, and the organization's key follows the provider its host names.
  it('names a provider only for its own domain, so its key cannot be sent elsewhere', () => {
    expect(explanationProvider('https://api.openai.com/v1')).toBe('openai');
    expect(explanationProvider('https://openai.com/v1')).toBe('openai');
    expect(explanationProvider('https://evilopenai.com/v1')).toBe('evilopenai');
    expect(explanationProvider('https://notanthropic.com/v1')).toBe('notanthropic');
    expect(explanationProvider('https://fakex.ai/v1')).toBe('fakex');
    expect(explanationProvider('https://api.x.ai/v1')).toBe('xai');
  });

  it('sends keys only over HTTPS, except to a model server on this machine', () => {
    expect(() => normalizeExplanationSettings({ endpoint: 'http://api.example.com/v1' })).toThrow('HTTPS');
    expect(() => normalizeExplanationSettings({ endpoint: 'http://169.254.169.254/latest' })).toThrow('HTTPS');
    expect(normalizeExplanationSettings({ endpoint: 'http://localhost:11434/v1' }).endpoint).toBe('http://localhost:11434/v1');
    expect(normalizeExplanationSettings({ endpoint: 'http://127.0.0.1:8080/v1' }).endpoint).toBe('http://127.0.0.1:8080/v1');
    expect(normalizeExplanationSettings({ endpoint: 'http://[::1]:8080/v1' }).endpoint).toBe('http://[::1]:8080/v1');
  });

  it('never follows a redirect with the key attached', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })) as unknown as typeof fetch;
    await requestExplanation({ settings: DEFAULT_EXPLANATION_SETTINGS, apiKey: 'k', message: 'm', userContext: [], fetchImpl });
    expect((fetchImpl as any).mock.calls[0][1].redirect).toBe('error');
  });

  it('keeps a hosted cell off private networks', async () => {
    const settings = { ...DEFAULT_EXPLANATION_SETTINGS, endpoint: 'https://169.254.169.254/v1' };
    await expect(requestExplanation({ settings, apiKey: 'k', message: 'm', userContext: [], fetchImpl: publicModelFetch }))
      .rejects.toThrow(/Private and local/);
    const loopback = { ...DEFAULT_EXPLANATION_SETTINGS, endpoint: 'https://127.0.0.1/v1' };
    await expect(requestExplanation({ settings: loopback, apiKey: 'k', message: 'm', userContext: [], fetchImpl: publicModelFetch }))
      .rejects.toThrow(/Private and local/);
  });
});
