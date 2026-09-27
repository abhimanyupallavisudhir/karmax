import { afterEach, describe, expect, it, vi } from 'vitest';
// The PTY transport is exercised in bounded-exec.test.ts; these fake worlds
// answer commands directly, with the environment the tool delivers.
vi.mock('../src/world/bounded-exec.js', () => ({
  boundedExec: async (world: any, command: string, options: { env?: Record<string, string> }) =>
    world.exec('bash', ['-lc', command], { env: options.env }),
}));
import { TimingTrace, withTiming } from '../src/timing/index.js';
import { ClaudeAdapter } from '../src/agent/claude.js';
import { CodexAdapter } from '../src/agent/codex.js';
import { ProviderFailure, isTransportError } from '../src/agent/limits.js';

const world: any = { handle: { id: 'w', root: '/tmp', branch: 'task', base: 'main' } };
const messages: any[] = [{ id: 'm', role: 'user', text: 'do the task', ts: 0 }];
const ctx: any = {
  signalCompletion() {}, createReviewInfo() {}, createSubTask() {}, respondToSubTask() {},
  raiseToParent() {}, waitForSubtasks() {}, saveSkill() {}, resolveDecision() {},
  confirmDecision() {}, requestSpend: async () => ({ status: 'denied' }), emit() {},
};

afterEach(() => vi.unstubAllGlobals());

describe('metered provider API terminal outcomes', () => {
  it.each(['claude', 'codex'] as const)('%s keeps the selected API credential while delivering application secrets to Bash', async (provider) => {
    const secretEnv = { ANTHROPIC_API_KEY: 'project-anthropic', OPENAI_API_KEY: 'project-openai', DATABASE_URL: 'project-db' };
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: 'work complete', stderr: '' });
    const responses = provider === 'claude' ? [
      { content: [{ type: 'tool_use', id: 't', name: 'bash', input: { command: 'app-test' } }], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
    ] : [
      { id: 'r1', status: 'completed', output: [{ type: 'function_call', call_id: 't', name: 'bash', arguments: JSON.stringify({ command: 'app-test' }) }] },
      { id: 'r2', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }] },
    ];
    const request = vi.fn().mockImplementation(async () => Response.json(responses.shift()));
    vi.stubGlobal('fetch', request);
    const adapter = provider === 'claude' ? new ClaudeAdapter() : new CodexAdapter();
    const result = await adapter.runTurn({
      profile: { id: 'p', name: 'api', provider, role: 'do', capabilities: [] },
      world: { ...world, exec }, messages, systemPrompt: 'Do it.', role: 'do',
      resolvedAuth: { apiKey: 'selected-model-key' }, secretEnv,
    } as any, ctx);
    expect(result.output).toBe('done');
    expect(exec).toHaveBeenCalledWith('bash', ['-lc', 'app-test'], expect.objectContaining({ env: secretEnv }));
    expect(request).toHaveBeenCalledTimes(2);
    for (const [, options] of request.mock.calls) {
      expect(options.headers[provider === 'claude' ? 'x-api-key' : 'authorization'])
        .toBe(provider === 'claude' ? 'selected-model-key' : 'Bearer selected-model-key');
    }
  });

  it.each([false, true])('accepts an Anthropic end_turn without requiring signal_completion (timing: %s)', async (tracing) => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 } })));
    const rows: any[] = [];
    const invoke = () => new ClaudeAdapter().runTurn({
      profile: { id: 'p', name: 'c', provider: 'claude', role: 'do', capabilities: [] },
      world, messages, systemPrompt: 'Do it.', role: 'do', resolvedAuth: { apiKey: 'test' },
    } as any, ctx);
    const turn = await (tracing ? (await withTiming(new TimingTrace({ taskId: 'fixture' }, row => rows.push(row)), invoke)) : invoke());
    expect(rows.filter(row => row.name === 'provider.usage')).toHaveLength(tracing ? 1 : 0);
    expect(turn.termination).toEqual({ kind: 'success', status: 'end_turn', reason: 'end_turn' });
    expect(turn.usage).toEqual({ inputTokens: 12, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 2,
      inputTokensIncludeCacheRead: false, totalTokens: 21 });
  });

  it('rejects an Anthropic truncation that exhausts the turn backstop', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({ content: [{ type: 'text', text: 'partial' }], stop_reason: 'max_tokens' })));
    await expect(new ClaudeAdapter().runTurn({
      profile: { id: 'p', name: 'c', provider: 'claude', role: 'do', capabilities: [] },
      world, messages, systemPrompt: 'Do it.', role: 'do', maxTurns: 1, resolvedAuth: { apiKey: 'test' },
    } as any, ctx)).rejects.toThrow(/backstop without a successful terminal response/i);
  });

  it('types an Anthropic HTTP quota response as structured provider metadata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('{"error":{"message":"Your prepaid balance has been depleted"}}', { status: 402 })));
    const failure = await new ClaudeAdapter().runTurn({
      profile: { id: 'p', name: 'c', provider: 'claude', role: 'do', capabilities: [] },
      world, messages, systemPrompt: 'Do it.', role: 'do', resolvedAuth: { apiKey: 'test' },
    } as any, ctx).catch((e) => e);
    expect(failure).toBeInstanceOf(ProviderFailure);
    expect(failure.metadata).toMatchObject({
      kind: 'quota', permanence: 'hard', provider: 'claude', source: 'structured',
    });
  });

  it.each([false, true])('accepts an OpenAI completed response without requiring signal_completion (timing: %s)', async (tracing) => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({ id: 'r1', status: 'completed', usage: { input_tokens: 10, output_tokens: 5,
        input_tokens_details: { cached_tokens: 6 } }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }] })));
    const rows: any[] = [];
    const invoke = () => new CodexAdapter().runTurn({
      profile: { id: 'p', name: 'o', provider: 'codex', role: 'do', capabilities: [] },
      world, messages, systemPrompt: 'Do it.', role: 'do', resolvedAuth: { apiKey: 'test' },
    } as any, ctx);
    const turn = await (tracing ? (await withTiming(new TimingTrace({ taskId: 'fixture' }, row => rows.push(row)), invoke)) : invoke());
    expect(rows.filter(row => row.name === 'provider.usage')).toHaveLength(tracing ? 1 : 0);
    expect(turn.termination).toEqual({ kind: 'success', status: 'completed' });
    expect(turn.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 6,
      inputTokensIncludeCacheRead: true, totalTokens: 15 });
  });

  it('rejects an OpenAI incomplete response even when it contains partial text, retryably', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({
      id: 'r1', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial' }] }],
    })));
    await expect(new CodexAdapter().runTurn({
      profile: { id: 'p', name: 'o', provider: 'codex', role: 'do', capabilities: [] },
      world, messages, systemPrompt: 'Do it.', role: 'do', resolvedAuth: { apiKey: 'test' },
    } as any, ctx)).rejects.toThrow(/max_output_tokens/i);

    // The load-bearing guarantee is unchanged: a partial response is NEVER
    // returned as a successful turn. What changed is the classification — an
    // output-boundary stop is now phrased as a resumable interruption so it
    // retries and resumes the response chain, instead of escalating to a human
    // the way it used to. ACP and both Claude paths already behaved this way.
    const err: Error = await new CodexAdapter().runTurn({
      profile: { id: 'p', name: 'o', provider: 'codex', role: 'do', capabilities: [] },
      world, messages, systemPrompt: 'Do it.', role: 'do', resolvedAuth: { apiKey: 'test' },
    } as any, ctx).catch((e) => e);
    expect(err.message).not.toContain('partial');
    expect(isTransportError(err.message)).toBe(true);
  });
});
