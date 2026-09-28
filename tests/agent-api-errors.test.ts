import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ close: vi.fn(async () => {}) }));
vi.mock('../src/mcp/connections/client.js', () => ({ apiMcpTools: async () => ({ tools: [], handlers: {}, close: state.close }) }));
import { ClaudeAdapter } from '../src/agent/claude.js';
import { CodexAdapter } from '../src/agent/codex.js';

afterEach(() => { vi.unstubAllGlobals(); state.close.mockReset(); });
for (const provider of ['claude', 'codex'] as const) describe(`${provider} API tool failures`, () => {
  const input: any = { profile: { provider }, world: { handle: { root: '/tmp' } }, role: 'do', messages: [], systemPrompt: 'test', resolvedAuth: { apiKey: 'fake' } };
  const adapter = () => provider === 'claude' ? new ClaudeAdapter() : new CodexAdapter();
  // AD-3: an API key's per-minute throttle must not park its login for the
  // five-hour subscription window. The provider's own Retry-After wins; an
  // unqualified 429 waits a minute. Hard quota exhaustion stays hard.
  it.each<{ headers: Record<string, string>; detail: string; resetHint: string | RegExp }>([
    { headers: { 'retry-after': '12' }, detail: 'rate limit exceeded', resetHint: 'in 12s' },
    { headers: { 'retry-after-ms': '2500', 'retry-after': '9' }, detail: 'rate limit exceeded', resetHint: 'in 3s' },
    { headers: { 'retry-after': new Date(Date.now() + 90_000).toUTCString() }, detail: 'too many requests', resetHint: /^in (8[89]|9[01])s$/ },
    { headers: {}, detail: 'too many requests', resetHint: 'in 60s' },
    { headers: { 'retry-after': 'soon' }, detail: 'rate limit exceeded', resetHint: 'in 60s' },
    // A zero `retry-after-ms` does not hide a usable Retry-After.
    { headers: { 'retry-after-ms': '0', 'retry-after': '7' }, detail: 'rate limit exceeded', resetHint: 'in 7s' },
    // OpenAI's wording is a relative duration, never a clock time: read at
    // 14:00, "in 1.5s" must not become 1 o'clock (#367 review item 10).
    { headers: {}, detail: 'Rate limit reached for gpt-5 in organization org-x on tokens per min. Please try again in 1.5s.', resetHint: 'in 2s' },
    { headers: {}, detail: 'Rate limit reached on requests per min. Please try again in 120ms.', resetHint: 'in 1s' },
    { headers: {}, detail: 'Rate limit reached on requests per day. Please try again in 6m0s.', resetHint: 'in 360s' },
    { headers: {}, detail: 'rate limit exceeded, try again at 5:55 PM', resetHint: 'in 60s' },
    { headers: { 'x-ratelimit-reset-requests': '6m0s', 'x-ratelimit-reset-tokens': '1s' }, detail: 'rate limit exceeded', resetHint: 'in 360s' },
  ])('waits out an API throttle as the provider asks ($resetHint)', async ({ headers, detail, resetHint }) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(detail, { status: 429, headers })));
    const failure: any = await adapter().runTurn(input, { emit() {} } as any).catch((error) => error);
    expect(failure).toMatchObject({ name: 'ProviderFailure', metadata: { kind: 'quota', permanence: 'transient' } });
    expect(failure.metadata.resetHint).toMatch(resetHint);
  });
  it('keeps exhausted API credit hard, without a throttle wait', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}',
      { status: 429, headers: { 'retry-after': '5' } })));
    const failure: any = await adapter().runTurn(input, { emit() {} } as any).catch((error) => error);
    expect(failure.metadata).toMatchObject({ kind: 'quota', permanence: 'hard' });
    expect(failure.metadata.resetHint).toBeUndefined();
  });
  it('waits a minute when the throttle arrives inside the stream', async () => {
    const event = provider === 'claude'
      ? 'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}\n\n'
      : 'data: {"type":"error","code":"rate_limit_exceeded","message":"Rate limit reached for requests"}\n\n';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(event, { status: 200, headers: { 'content-type': 'text/event-stream' } })));
    const failure: any = await adapter().runTurn(input, { emit() {} } as any).catch((error) => error);
    expect(failure.metadata).toMatchObject({ kind: 'quota', permanence: 'transient', resetHint: 'in 60s' });
  });
  it('returns failed tools to the model and does not treat failed completion as success', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify(provider === 'claude'
        ? { stop_reason: bodies.length === 1 ? 'tool_use' : 'end_turn', content: bodies.length === 1 ? [{ type: 'tool_use', name: 'signal_completion', id: 'c', input: {} }] : [{ type: 'text', text: 'recovered' }] }
        : { id: 'r', status: 'completed', output: bodies.length === 1 ? [{ type: 'function_call', name: 'signal_completion', call_id: 'c', arguments: '{}' }] : [{ type: 'message', content: [{ type: 'output_text', text: 'recovered' }] }] }));
    }));
    const result = await adapter().runTurn(input, { emit() {}, signalCompletion() { throw new Error('unauthorized gateway tool'); } } as any);
    expect(result.output).toBe('recovered');
    expect(result.termination.reason).not.toBe('signal_completion');
    const output = provider === 'claude' ? bodies[1].messages.at(-1).content[0] : JSON.parse(bodies[1].input[0].output);
    expect(output.is_error).toBe(true);
  });
  it('preserves verified success when MCP shutdown fails', async () => {
    state.close.mockRejectedValueOnce(new Error('cleanup failed'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(provider === 'claude'
      ? { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] }
      : { id: 'r', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }] }))));
    expect((await adapter().runTurn(input, { emit() {} } as any)).output).toBe('done');
  });
});
