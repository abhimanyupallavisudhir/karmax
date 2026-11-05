import { describe, it, expect, vi } from 'vitest';
import type { PlatformToolContext, TurnInput } from '../src/agent/types.js';
import { isDiskFullMessage } from '../src/world/disk.js';

/**
 * Claude Code on a full disk (2.1.301+, SDK 0.3.301+ and 0.3.317+). It no longer
 * fails with a raw ENOSPC: a login refresh that cannot write says so in words, as
 * `invalid_request` (it was `authentication_failed`), and a turn whose transcript
 * could not be saved still succeeds, followed by a `session_writes_lost` message as
 * the CLI exits. Both must reach the turn's caller as a full disk (which blocks the
 * task as "Out of disk"), never as a dead login or a silently truncated session.
 */

const sdk = vi.hoisted(() => ({ query: undefined as undefined | ((args: any) => AsyncIterable<any>) }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (name: string, description: string, shape: Record<string, any>, run: any) => ({ name, description, shape, run }),
  createSdkMcpServer: (opts: { name: string; tools: any[] }) => ({ type: 'sdk', name: opts.name, tools: opts.tools }),
  query: (args: any) => sdk.query!(args),
}));

const { ClaudeAdapter } = await import('../src/agent/claude.js');
const { ProviderFailure } = await import('../src/agent/limits.js');

/** A harness that reads its input to the end and then plays `frames`, echoing the prompt's uuid. */
function harness(frames: (uuid: string) => any[]) {
  sdk.query = (args: any) => (async function* () {
    let uuid = '';
    for await (const m of args.prompt) { uuid = m.uuid; break; }
    for (const frame of frames(uuid)) yield frame;
  })();
}

async function runTurn() {
  const noop = () => {};
  const ctx = {
    openPr: noop, signalCompletion: noop, createReviewInfo: noop, createSubTask: noop,
    addCheckout: async () => ({ name: '', root: '', branch: '' }), respondToSubTask: noop, raiseToParent: noop,
    waitForSubtasks: noop, requestWait: noop, jobStarted: noop, saveSkill: noop, resolveDecision: noop,
    confirmDecision: noop, requestSpend: async () => ({ status: 'denied' as const }), emit: noop, emitActivity: noop,
  } as PlatformToolContext;
  const input: TurnInput = {
    profile: { id: 'do', name: 'do', provider: 'claude', role: 'do', capabilities: [] },
    world: { handle: { id: 'task_disk', root: process.cwd() } } as any,
    messages: [{ id: 'm1', role: 'user', ts: 0, text: 'build it' }],
    role: 'do',
    systemPrompt: 'headless agent',
    resolvedAuth: { configHome: process.cwd() },
  };
  return new ClaudeAdapter().runTurn(input, ctx).then(() => undefined, (error: unknown) => error as Error);
}

describe('Claude Code on a full disk', () => {
  it('fails a turn whose transcript could not be saved, as a full disk', async () => {
    harness((uuid) => [
      { type: 'system', subtype: 'init', session_id: 'sess-disk' },
      { type: 'assistant', user_message_uuids: [uuid], message: { content: [{ type: 'text', text: 'built' }] } },
      { type: 'result', subtype: 'success', session_id: 'sess-disk', num_turns: 1 },
      { type: 'system', subtype: 'session_writes_lost', error_code: 'ENOSPC', lost: ['transcript', 'global_config'],
        transcript_session_ids: ['sess-disk'], uuid: 'u-lost', session_id: 'sess-disk' },
    ]);
    const error = await runTurn();
    expect(error).toBeInstanceOf(Error);
    expect(isDiskFullMessage(error!.message)).toBe(true);
    expect(error!.message).toContain('session transcript');
  });

  it('reads a login refresh that could not write as a full disk, not a rejected login', async () => {
    const text = 'OAuth access token could not be refreshed: the disk that holds the Claude Code config directory, '
      + 'or the disk quota on it, is full; delete files you no longer need on that disk and try again';
    harness((uuid) => [
      { type: 'system', subtype: 'init', session_id: 'sess-oauth' },
      { type: 'assistant', error: 'invalid_request', user_message_uuids: [uuid], message: { content: [{ type: 'text', text }] } },
      { type: 'result', subtype: 'success', is_error: true, session_id: 'sess-oauth', num_turns: 1 },
    ]);
    const error = await runTurn();
    expect(error).not.toBeInstanceOf(ProviderFailure);
    expect(isDiskFullMessage(error!.message)).toBe(true);
  });
});
