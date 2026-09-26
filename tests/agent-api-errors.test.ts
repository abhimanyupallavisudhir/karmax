import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ close: vi.fn(async () => {}) }));
vi.mock('../src/mcp/connections/client.js', () => ({ apiMcpTools: async () => ({ tools: [], handlers: {}, close: state.close }) }));
import { ClaudeAdapter } from '../src/agent/claude.js';
import { CodexAdapter } from '../src/agent/codex.js';

afterEach(() => { vi.unstubAllGlobals(); state.close.mockReset(); });
for (const provider of ['claude', 'codex'] as const) describe(`${provider} API tool failures`, () => {
  const input: any = { profile: { provider }, world: { handle: { root: '/tmp' } }, role: 'do', messages: [], systemPrompt: 'test', resolvedAuth: { apiKey: 'fake' } };
  const adapter = () => provider === 'claude' ? new ClaudeAdapter() : new CodexAdapter();
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
