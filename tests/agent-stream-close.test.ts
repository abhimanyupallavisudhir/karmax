import { describe, it, expect, vi, afterEach } from 'vitest';
import type { PlatformToolContext, TurnInput } from '../src/agent/types.js';
import type { ReviewInfo } from '../src/domain/types.js';

/**
 * Regression: `karmax_control` MCP tools failing with **"Stream closed"** (SPEC §3.4, §5.6).
 *
 * The in-process control tools (`create_review_info`, `signal_completion`, `create_sub_task`,
 * …) and the `canUseTool` approver reach the adapter over the Claude Code harness's
 * *control channel*, which rides on the harness's stdin. The harness rejects every
 * control request the instant that stdin ends:
 *
 *     async sendRequest(...) { ...; if (this.inputClosed) throw Error("Stream closed"); ... }
 *
 * and the Agent SDK ends stdin as soon as the `prompt` async iterable completes. The
 * adapter closed that iterable on the turn's first `result` — but a `result` is NOT
 * reliably the end of the harness process: while an in-harness sub-agent or a
 * backgrounded shell is still running, Claude Code keeps the session alive, folds the
 * settlement back in, and drives the agent through more exchanges. Two production
 * transcripts show exactly that shape — the agent went idle waiting on a backgrounded
 * `npm test` / two async sub-agents, worked another 18–25 minutes once they settled, and
 * every `mcp__karmax_control__create_review_info` call in that window came back
 * "Stream closed".
 *
 * Cheap test (no Temporal, no login): a fake harness that consumes the input stream and
 * enforces the real `inputClosed` guard.
 */

const sdk = vi.hoisted(() => ({ query: undefined as undefined | ((args: any) => AsyncIterable<any>) }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (name: string, description: string, shape: Record<string, any>, run: any) => ({ name, description, shape, run }),
  createSdkMcpServer: (opts: { name: string; tools: any[] }) => ({ type: 'sdk', name: opts.name, tools: opts.tools }),
  query: (args: any) => sdk.query!(args),
}));

const { ClaudeAdapter } = await import('../src/agent/claude.js');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The half of the Claude Code harness this bug lives in. */
interface Harness {
  /** True once the SDK input stream (the harness's stdin) has ended. */
  readonly inputClosed: boolean;
  /** Invoke an in-process `karmax_control` tool the way the harness does — over the
   *  control channel, which is dead once stdin has ended. */
  control(name: string, input: Record<string, unknown>): Promise<string>;
}

/** Install a scripted fake harness as the SDK's `query`, and return a handle on it. */
function fakeHarness(script: (h: Harness) => AsyncGenerator<any>): { current?: Harness } {
  const handle: { current?: Harness } = {};
  sdk.query = (args: any) => {
    const tools = new Map<string, any>((args.options.mcpServers.karmax_control.tools ?? []).map((t: any) => [t.name, t]));
    let inputClosed = false;
    const h: Harness = {
      get inputClosed() { return inputClosed; },
      async control(name, input) {
        if (inputClosed) throw new Error('Stream closed');
        return (await tools.get(name)!.run(input)).content[0].text;
      },
    };
    // The harness reads stdin until the SDK ends it (`transport.endInput()`).
    void (async () => {
      for await (const _ of args.prompt) { /* the turn's user messages */ }
      inputClosed = true;
    })();
    handle.current = h;
    return script(h);
  };
  return handle;
}

async function runTurn(reviewInfos: ReviewInfo[]) {
  const ctx: PlatformToolContext = {
    openPr: () => {},
    signalCompletion: () => {},
    createReviewInfo: (info) => { reviewInfos.push(info); },
    createSubTask: () => {},
    addCheckout: async () => ({ name: '', root: '', branch: '' }),
    respondToSubTask: () => {},
    raiseToParent: () => {},
    waitForSubtasks: () => {},
    saveSkill: () => {},
    resolveDecision: () => {},
    confirmDecision: () => {},
    requestSpend: async () => ({ status: 'denied' as const }),
    emit: () => {},
    emitActivity: () => {},
  };
  const input: TurnInput = {
    profile: { id: 'do', name: 'do', provider: 'claude', role: 'do', capabilities: [] },
    world: { handle: { id: 'task_stream', root: process.cwd() } } as any,
    messages: [{ id: 'm1', role: 'user', ts: 0, text: 'review the change' }],
    role: 'do',
    systemPrompt: 'headless agent',
    // Force the Agent SDK path (a config home, not an API key) without a real login.
    resolvedAuth: { configHome: process.cwd() },
  };
  return new ClaudeAdapter().runTurn(input, ctx);
}

afterEach(() => {
  delete process.env.KARMAX_AGENT_BG_SETTLE_MS;
});

describe('Claude Agent-SDK input stream vs. the harness control channel', () => {
  it('keeps the control channel alive while a backgrounded shell settles after the first result', async () => {
    const seen: string[] = [];
    fakeHarness(async function* (h) {
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
      // The agent backgrounds a test run and goes idle waiting for it.
      yield { type: 'system', subtype: 'task_started', task_id: 'sh-1' };
      yield { type: 'result', subtype: 'success', session_id: 'sess-1' };
      await sleep(30); // let the adapter act on the result
      // The harness is still alive: the shell settles and it drives the agent again.
      yield { type: 'system', subtype: 'task_notification', task_id: 'sh-1', status: 'completed' };
      try {
        seen.push(await h.control('create_review_info', { caption: 'run the suite' }));
      } catch (e) {
        seen.push(`error: ${(e as Error).message}`);
      }
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'all green' }] } };
      yield { type: 'result', subtype: 'success', session_id: 'sess-1' };
      await sleep(30);
    });

    const reviewInfos: ReviewInfo[] = [];
    const turn = await runTurn(reviewInfos);

    expect(seen).toEqual(['review info recorded']);
    expect(reviewInfos.map((r) => r.caption)).toEqual(['run the suite']);
    expect(turn.output).toBe('all green');
    expect(turn.termination).toMatchObject({ kind: 'success' });
  });

  it('keeps it alive while an in-harness sub-agent is still running', async () => {
    const seen: string[] = [];
    fakeHarness(async function* (h) {
      yield { type: 'system', subtype: 'init', session_id: 'sess-2' };
      yield { type: 'system', subtype: 'task_started', task_id: 'a-1', subagent_type: 'general-purpose' };
      yield { type: 'result', subtype: 'success', session_id: 'sess-2' };
      await sleep(30);
      yield { type: 'system', subtype: 'task_notification', task_id: 'a-1', status: 'completed' };
      try {
        seen.push(await h.control('signal_completion', { summary: 'done' }));
      } catch (e) {
        seen.push(`error: ${(e as Error).message}`);
      }
      yield { type: 'result', subtype: 'success', session_id: 'sess-2' };
      await sleep(30);
    });

    await runTurn([]);
    expect(seen).toEqual(['completion recorded']);
  });

  it('closes the input stream at once when the harness has nothing outstanding', async () => {
    // The common case must not linger: with no in-harness work the turn still ends on
    // the first result, which is what lets the harness process exit.
    const h = fakeHarness(async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-3' };
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'nothing to do' }] } };
      yield { type: 'result', subtype: 'success', session_id: 'sess-3' };
      await sleep(30);
    });

    await runTurn([]);
    expect(h.current!.inputClosed).toBe(true);
  });

  it('bounds the wait — a deliberately long-lived background shell cannot wedge the turn', async () => {
    // A dev server the task left running never settles. After the grace we close anyway
    // (degrading to the old behaviour) rather than holding the turn open forever.
    process.env.KARMAX_AGENT_BG_SETTLE_MS = '0';
    const h = fakeHarness(async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-4' };
      yield { type: 'system', subtype: 'task_started', task_id: 'sh-server' };
      yield { type: 'result', subtype: 'success', session_id: 'sess-4' };
      await sleep(30);
    });

    const turn = await runTurn([]);
    expect(h.current!.inputClosed).toBe(true);
    expect(turn.pendingBackgroundShells).toBe(1);
  });
});
