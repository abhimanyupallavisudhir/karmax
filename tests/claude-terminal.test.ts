import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdkState = vi.hoisted(() => ({ messages: [] as any[], options: undefined as any }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (config: any) => ({ type: 'sdk', name: config.name, instance: {} }),
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
  query: (args: any) => {
    sdkState.options = args.options;
    return (async function* () {
      for (const message of sdkState.messages) yield message;
    })();
  },
}));

import { ClaudeAdapter } from '../src/agent/claude.js';
import { ProviderFailure } from '../src/agent/limits.js';

const input: any = {
  profile: { id: 'p', name: 'claude', provider: 'claude', role: 'do', capabilities: [] },
  world: { handle: { id: 'w', root: '/tmp', branch: 'task', base: 'main' } },
  messages: [{ id: 'm', role: 'user', text: 'do the task', ts: 0 }],
  systemPrompt: 'Do the task.',
  role: 'do',
  resolvedAuth: { configHome: '/tmp/claude-terminal-test' },
};

const ctx: any = {
  signalCompletion() {},
  createReviewInfo() {},
  createSubTask() {},
  respondToSubTask() {},
  raiseToParent() {},
  waitForSubtasks() {},
  saveSkill() {},
  resolveDecision() {},
  confirmDecision() {},
  requestSpend: async () => ({ status: 'denied' }),
  emit() {},
};

describe('Claude Agent SDK terminal outcome contract', () => {
  beforeEach(() => { sdkState.messages = []; sdkState.options = undefined; });

  it('uses one stdio platform server plus a disjoint local-control server', async () => {
    sdkState.messages = [{ type: 'result', subtype: 'success', is_error: false, session_id: 's1', stop_reason: 'end_turn' }];
    await new ClaudeAdapter().runTurn({ ...input, extraEnv: { KARMAX_TOKEN: 'scoped' } }, ctx);
    expect(sdkState.options.strictMcpConfig).toBe(true);
    expect(sdkState.options.mcpServers.karmax).toMatchObject({
      command: process.execPath,
      env: expect.objectContaining({ KARMAX_TOKEN: 'scoped' }),
      alwaysLoad: true,
    });
    expect(sdkState.options.mcpServers.karmax_control).toMatchObject({ type: 'sdk', name: 'karmax_control' });
  });

  it('returns only after an explicit SDK success result', async () => {
    sdkState.messages = [
      { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'done' }] } },
      { type: 'result', subtype: 'success', is_error: false, session_id: 's1', stop_reason: 'end_turn' },
    ];
    const turn = await new ClaudeAdapter().runTurn(input, ctx);
    expect(turn.termination).toEqual({ kind: 'success', status: 'success', reason: 'end_turn' });
    expect(turn.output).toBe('done');
  });

  it('rejects an SDK error result even after partial assistant output', async () => {
    sdkState.messages = [
      { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'partial work' }] } },
      { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 's1', errors: ['stream disconnected'] },
    ];
    await expect(new ClaudeAdapter().runTurn(input, ctx)).rejects.toThrow(/error_during_execution.*stream disconnected/i);
  });

  it('types novel credit-exhaustion wording from an SDK error result', async () => {
    sdkState.messages = [
      {
        type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 's1',
        errors: ['Your prepaid balance has now been fully consumed.'],
      },
    ];
    const failure = await new ClaudeAdapter().runTurn(input, ctx).catch((e) => e);
    expect(failure).toBeInstanceOf(ProviderFailure);
    expect(failure.metadata).toMatchObject({
      kind: 'quota', permanence: 'hard', provider: 'claude', source: 'message',
    });
  });

  it('uses the structured assistant rate-limit signal even when the SDK result lies about success', async () => {
    sdkState.messages = [
      {
        type: 'assistant', session_id: 's1', error: 'rate_limit',
        message: { content: [{ type: 'text', text: "You've hit your session limit · resets 2:20am (America/Los_Angeles)" }] },
      },
      // This is the exact misleading terminal shape observed in task #183.
      { type: 'result', subtype: 'success', is_error: true, session_id: 's1', errors: ['completed'] },
    ];
    const failure = await new ClaudeAdapter().runTurn(input, ctx).catch((e) => e);
    expect(failure).toBeInstanceOf(ProviderFailure);
    expect(failure.metadata).toMatchObject({
      kind: 'quota', permanence: 'transient', provider: 'claude', source: 'structured', window: '5h',
    });
    expect(failure.metadata.resetHint).toBe('2:20am (America/Los_Angeles)');
  });

  it('uses a rejected SDK rate-limit event even without an assistant error frame', async () => {
    sdkState.messages = [
      {
        type: 'rate_limit_event', session_id: 's1',
        rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: Math.floor(Date.now() / 1000) + 120 },
      },
      { type: 'result', subtype: 'success', is_error: false, session_id: 's1' },
    ];
    const failure = await new ClaudeAdapter().runTurn(input, ctx).catch((e) => e);
    expect(failure).toBeInstanceOf(ProviderFailure);
    expect(failure.metadata).toMatchObject({
      kind: 'quota', permanence: 'transient', provider: 'claude', source: 'structured', window: 'model', note: 'opus',
    });
    expect(failure.metadata.resetHint).toMatch(/^in \d+s$/);
  });

  it('preserves a text-only API transport failure before a misleading success result', async () => {
    sdkState.messages = [
      {
        type: 'assistant', session_id: 's1',
        message: {
          stop_reason: 'stop_sequence',
          content: [{ type: 'text', text: 'API Error: Connection closed mid-response. The response above may be incomplete.' }],
        },
      },
      // Exact terminal envelope observed in task #240.
      { type: 'result', subtype: 'success', is_error: true, session_id: 's1', errors: ['completed'] },
    ];
    const failure = await new ClaudeAdapter().runTurn(input, ctx).catch((e) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ProviderFailure);
    expect(failure.message).toMatch(/transport interruption.*connection closed mid-response/i);
  });

  it.each([
    ['authentication_failed', 'credential'],
    ['billing_error', 'quota'],
  ])('types the structured %s assistant failure as hard %s unavailability', async (code, kind) => {
    sdkState.messages = [{
      type: 'assistant', session_id: 's1', error: code,
      message: { content: [{ type: 'text', text: 'account unavailable' }] },
    }];
    const failure = await new ClaudeAdapter().runTurn(input, ctx).catch((e) => e);
    expect(failure).toBeInstanceOf(ProviderFailure);
    expect(failure.metadata).toMatchObject({ kind, permanence: 'hard', provider: 'claude', source: 'structured' });
  });

  it.each(['overloaded', 'server_error', 'max_output_tokens'])(
    'surfaces the structured %s assistant failure as a retryable interruption',
    async (code) => {
      sdkState.messages = [{
        type: 'assistant', session_id: 's1', error: code,
        message: { content: [{ type: 'text', text: 'provider could not finish' }] },
      }];
      const failure = await new ClaudeAdapter().runTurn(input, ctx).catch((e) => e);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(ProviderFailure);
      expect(failure.message).toMatch(/overloaded|server_error|interrupted before completion/);
    },
  );

  it('rejects a stream that ends without any result event', async () => {
    sdkState.messages = [
      { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'partial work' }] } },
    ];
    await expect(new ClaudeAdapter().runTurn(input, ctx)).rejects.toThrow(/stream ended unexpectedly.*successful result/i);
  });
});
