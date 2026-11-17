import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformToolContext, TurnInput } from '../src/agent/types.js';

/**
 * pramana#137 (2026-11-09): the machine under a working agent was stopped (a
 * branch's pull request, waiting for review, parked the world they share).
 * The agent had answered and was idle, waiting on a background watch. Its turn
 * then showed Working for six hours, heard no message, and Stop did not end it.
 *
 * The Claude adapter in a remote world, with the SDK and the sandbox replaced:
 * what it makes of an agent process that is lost, and of an SDK stream that
 * does not end when its process has.
 */
const sdk = vi.hoisted(() => ({ query: undefined as undefined | ((args: any) => AsyncIterable<any>) }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (name: string, description: string, shape: Record<string, any>, run: any) => ({ name, description, shape, run }),
  createSdkMcpServer: (opts: { name: string; tools: any[] }) => ({ type: 'sdk', name: opts.name, tools: opts.tools }),
  query: (args: any) => sdk.query!(args),
}));
vi.mock('../src/agent/remote-process.js', async (original) => ({
  ...(await original<typeof import('../src/agent/remote-process.js')>()),
  isRemoteAgentWorld: () => true,
  seedRemoteAgentHome: async () => ({ absolute: '/home/user/.agent', relative: '.agent' }),
  syncRemoteAgentHomeBestEffort: async () => undefined,
  spawnRemoteAgentProcess: () => Object.assign(new EventEmitter(), { startupComplete() {}, kill() { return true; },
    startupDiagnostics: async () => ({}) }),
}));

const { ClaudeAdapter } = await import('../src/agent/claude.js');

type Agent = EventEmitter & { lost?: Error };
/** The sandbox drops: the process is reported lost, as `RemoteSpawnedProcess` does. */
function lose(agent: Agent): void {
  agent.lost = new Error('lost the connection to the agent in the sandbox; it may still be running there (the VM closed the SSH connection)');
  agent.emit('exit', null, 'SIGHUP');
}
const sdkExitError = () => new Error('Claude Code process terminated by signal SIGHUP');

/** A scripted harness in the sandbox: `script` gets the spawned process. */
function harness(script: (agent: Agent, stopped: Promise<void>) => AsyncGenerator<any>) {
  sdk.query = (args: any) => {
    const signal: AbortSignal = args.options.abortController.signal;
    const stopped = new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    const agent = args.options.spawnClaudeCodeProcess({ command: 'claude', args: [], env: {}, signal }) as Agent;
    let consumed: string[] = [];
    void (async () => { for await (const m of args.prompt) consumed.push(m.uuid); })();
    return (async function* () {
      for await (const m of script(agent, stopped)) {
        if (m.type === 'assistant' && consumed.length) { yield { ...m, user_message_uuids: consumed }; consumed = []; }
        else yield m;
      }
    })();
  };
}

function runTurn(extra: Partial<PlatformToolContext> = {}) {
  const ctx = { emit: () => {}, emitActivity: () => {}, ...extra } as unknown as PlatformToolContext;
  const input: TurnInput = {
    profile: { id: 'do', name: 'do', provider: 'claude', role: 'do', capabilities: [] },
    world: { handle: { id: 'task_lost', kind: 'fly', root: '/home/user/karmax' } } as any,
    messages: [{ id: 'm1', role: 'user', ts: 0, text: 'is the site back up?' }],
    role: 'do',
    systemPrompt: 'headless agent',
    resolvedAuth: { configHome: process.cwd() },
  };
  return new ClaudeAdapter().runTurn(input, ctx);
}

const answered = async function* (agent: Agent, watch = true) {
  yield { type: 'system', subtype: 'init', session_id: 'sess-lost' };
  if (watch) yield { type: 'system', subtype: 'task_started', task_id: 'watch', description: 'wait for the API to answer' };
  yield { type: 'assistant', message: { content: [{ type: 'text', text: 'The site is back up.' }] } };
  yield { type: 'result', subtype: 'success', session_id: 'sess-lost' };
  yield { type: 'system', subtype: 'session_state_changed', state: 'idle' };
};

afterEach(() => {
  delete process.env.KARMAX_AGENT_BG_SETTLE_MS;
  delete process.env.KARMAX_AGENT_EXIT_GRACE_MS;
});

describe('a Claude turn whose sandbox is lost', () => {
  it('is over with what the agent said, when it was lost after the agent had answered and gone idle', async () => {
    harness(async function* (agent) {
      yield* answered(agent);
      lose(agent);
      throw sdkExitError();
    });
    const turn = await runTurn();
    expect(turn.termination.kind).toBe('success');
    expect(turn.output).toBe('The site is back up.');
    // What it was still waiting on went with the machine, and the agent is told.
    expect(turn.stoppedBackgroundShells).toEqual(['wait for the API to answer']);
  }, 5000);

  it('is retried, when it was lost while the agent worked', async () => {
    harness(async function* (agent) {
      yield { type: 'system', subtype: 'init', session_id: 'sess-lost' };
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Checking the server.' }] } };
      lose(agent);
      throw sdkExitError();
    });
    await expect(runTurn()).rejects.toThrow(/lost the connection to the agent in the sandbox/);
  }, 5000);

  it('is retried, when it was lost while the agent worked on a message it took after an earlier answer', async () => {
    harness(async function* (agent) {
      yield* answered(agent, false);
      yield { type: 'system', subtype: 'session_state_changed', state: 'running' };
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'One more check.' }] } };
      lose(agent);
      throw sdkExitError();
    });
    process.env.KARMAX_AGENT_BG_SETTLE_MS = '60000';
    // The stream stays open for the follow-up: something is still outstanding.
    await expect(runTurn({ pullFollowUps: async (from: number) => from === 1 ? [{ id: 'm2', role: 'user', ts: 1, text: 'and the API?' }] : [] } as any))
      .rejects.toThrow(/lost the connection to the agent in the sandbox/);
  }, 5000);
});

describe('an SDK stream that does not end when its process has', () => {
  it('is given up once the lost process has been gone a while, and the turn is retried', async () => {
    process.env.KARMAX_AGENT_EXIT_GRACE_MS = '50';
    harness(async function* (agent) {
      yield { type: 'system', subtype: 'init', session_id: 'sess-lost' };
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Checking the server.' }] } };
      lose(agent);
      await new Promise(() => {}); // the SDK waits for an exit it already had
    });
    await expect(runTurn()).rejects.toThrow(/lost the connection to the agent in the sandbox/);
  }, 5000);

  it('is given up after the harness was stopped at the end of a turn', async () => {
    process.env.KARMAX_AGENT_BG_SETTLE_MS = '0';
    process.env.KARMAX_AGENT_EXIT_GRACE_MS = '50';
    harness(async function* (agent) {
      yield* answered(agent);
      await new Promise(() => {}); // stopped, and its stream still never ends
    });
    const turn = await runTurn();
    expect(turn.termination.kind).toBe('success');
    expect(turn.output).toBe('The site is back up.');
  }, 5000);

  it('does not keep a stopped turn from ending (Stop, Cancel)', async () => {
    process.env.KARMAX_AGENT_EXIT_GRACE_MS = '50';
    const stop = new AbortController();
    harness(async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-lost' };
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Checking the server.' }] } };
      setTimeout(() => stop.abort(), 20);
      await new Promise(() => {});
    });
    await expect(runTurn({ signal: stop.signal } as any)).rejects.toThrow(/cancelled/);
  }, 5000);
});

describe('endBoundedStream', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('cuts nothing off: the bound runs only while the reader waits, and a stream that ends is left alone', async () => {
    const { endBoundedStream } = await import('../src/agent/sdk-stream.js');
    const bounded = endBoundedStream((async function* () {
      for (let i = 0; i < 4; i++) { await sleep(30); yield i; }
    })(), 60);
    bounded.expectEnd(() => new Error('gone'));
    const read: number[] = [];
    for await (const value of bounded.stream) { read.push(value); await sleep(80); } // a slow reader is not the stream's silence
    expect(read).toEqual([0, 1, 2, 3]);
  });

  it('gives up for the first reason given, without waiting for the stream to return', async () => {
    const { endBoundedStream } = await import('../src/agent/sdk-stream.js');
    let returned = false;
    const source: AsyncIterable<number> = { [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<number>>(() => {}),
      return: () => { returned = true; return new Promise<IteratorResult<number>>(() => {}); },
    }) };
    const bounded = endBoundedStream(source, 40);
    const reader = bounded.stream[Symbol.asyncIterator]();
    const next = reader.next();
    await sleep(80); // nothing is expected yet: silence alone ends nothing
    bounded.expectEnd(() => new Error('the process is gone'));
    bounded.expectEnd(() => new Error('a later reason'));
    await expect(next).rejects.toThrow('the process is gone');
    // The source is told to stop, but its answer (waiting on that same next()) is not awaited.
    expect(await reader.return!()).toEqual({ done: true, value: undefined });
    expect(returned).toBe(true);
  });
});
