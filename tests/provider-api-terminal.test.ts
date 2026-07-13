import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAdapter } from '../src/agent/claude.js';
import { CodexAdapter } from '../src/agent/codex.js';

const world: any = { handle: { id: 'w', root: '/tmp', branch: 'task', base: 'main' } };
const messages: any[] = [{ id: 'm', role: 'user', text: 'do the task', ts: 0 }];
const ctx: any = {
  signalCompletion() {}, createReviewInfo() {}, createSubTask() {}, respondToSubTask() {},
  raiseToParent() {}, waitForSubtasks() {}, saveSkill() {}, resolveDecision() {},
  confirmDecision() {}, requestSpend: async () => ({ status: 'denied' }), emit() {},
};

afterEach(() => vi.unstubAllGlobals());

describe('metered provider API terminal outcomes', () => {
  it('accepts an Anthropic end_turn without requiring signal_completion', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }),
    }));
    const turn = await new ClaudeAdapter().runTurn({
      profile: { id: 'p', name: 'c', provider: 'claude', role: 'do', capabilities: [] },
      world, messages, systemPrompt: 'Do it.', role: 'do', resolvedAuth: { apiKey: 'test' },
    } as any, ctx);
    expect(turn.termination).toEqual({ kind: 'success', status: 'end_turn', reason: 'end_turn' });
  });

  it('rejects an Anthropic truncation that exhausts the turn backstop', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'partial' }], stop_reason: 'max_tokens' }),
    }));
    await expect(new ClaudeAdapter().runTurn({
      profile: { id: 'p', name: 'c', provider: 'claude', role: 'do', capabilities: [] },
      world, messages, systemPrompt: 'Do it.', role: 'do', maxTurns: 1, resolvedAuth: { apiKey: 'test' },
    } as any, ctx)).rejects.toThrow(/backstop without a successful terminal response/i);
  });

  it('accepts an OpenAI completed response without requiring signal_completion', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'r1', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }] }),
    }));
    const turn = await new CodexAdapter().runTurn({
      profile: { id: 'p', name: 'o', provider: 'codex', role: 'do', capabilities: [] },
      world, messages, systemPrompt: 'Do it.', role: 'do', resolvedAuth: { apiKey: 'test' },
    } as any, ctx);
    expect(turn.termination).toEqual({ kind: 'success', status: 'completed' });
  });

  it('rejects an OpenAI incomplete response even when it contains partial text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'r1', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial' }] }],
      }),
    }));
    await expect(new CodexAdapter().runTurn({
      profile: { id: 'p', name: 'o', provider: 'codex', role: 'do', capabilities: [] },
      world, messages, systemPrompt: 'Do it.', role: 'do', resolvedAuth: { apiKey: 'test' },
    } as any, ctx)).rejects.toThrow(/status=incomplete.*max_output_tokens/i);
  });
});
