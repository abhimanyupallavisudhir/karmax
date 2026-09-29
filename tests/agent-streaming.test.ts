import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { isTransportError } from '../src/agent/limits.js';
import { runTurn, OUTPUT_PUBLISH_INTERVAL_MS } from '../src/agent/runtime.js';
import { serverSentEvents } from '../src/agent/api-streams.js';
import type { AgentAdapter, PlatformToolContext, TurnInput } from '../src/agent/types.js';

/**
 * LT-5: agent text streams as it is produced. Adapters re-emit the growing text
 * of the block being generated; the runtime publishes the first chunk at once and
 * then at most one coalesced update per window, so a fast stream cannot flood the
 * event log or every open console. Cheap test: fake adapters, no provider.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const input = (): TurnInput => ({
  profile: { id: 'p', name: 'p', provider: 'claude', role: 'do', capabilities: [] },
  world: { handle: { id: 'task_stream', root: process.cwd(), kind: 'memory' } } as any,
  messages: [{ id: 'm1', role: 'user', ts: 0, text: 'go' }],
  role: 'do',
  systemPrompt: 'test',
});

function recorder() {
  const log: { at: number; kind: 'output' | 'activity'; text: string }[] = [];
  const started = Date.now();
  return {
    log,
    deps: {
      onEmit: (text: string) => { log.push({ at: Date.now() - started, kind: 'output', text }); },
      onActivity: (activity: { kind: string; phase: string; title?: string }) => {
        if (activity.kind !== 'turn') log.push({ at: Date.now() - started, kind: 'activity', text: `${activity.kind}:${activity.phase}:${activity.title}` });
      },
    },
  };
}

const adapter = (run: (ctx: PlatformToolContext) => Promise<string>): AgentAdapter => ({
  provider: 'claude',
  async runTurn(_input, ctx) {
    const output = await run(ctx);
    return { termination: { kind: 'success', status: 'end_turn' }, output };
  },
});

describe('runtime output publication (LT-5)', () => {
  // #396 review item 7: a late SDK or notification callback must not publish
  // into a turn that has already ended.
  it('ignores output emitted after the turn has ended', async () => {
    const { log, deps } = recorder();
    await runTurn(input(), { adapters: new Map([['claude', adapter(async (ctx) => {
      ctx.emit('Done', 'assistant');
      setTimeout(() => { ctx.emit('Done, and late', 'assistant'); ctx.emit('$ late tool'); }, 20);
      return 'Done';
    })]]), ...deps });
    await sleep(OUTPUT_PUBLISH_INTERVAL_MS * 2);
    expect(log.map((e) => e.text)).toEqual(['Done']);
  });

  it('publishes the first chunk at once and coalesces the rest of a burst', async () => {
    const { log, deps } = recorder();
    let publishedBeforeYield = 0;
    await runTurn(input(), { adapters: new Map([['claude', adapter(async (ctx) => {
      let text = '';
      for (const word of ['Hel', 'lo', ', ', 'wor', 'ld']) { text += word; ctx.emit(text, 'assistant'); }
      publishedBeforeYield = log.length;
      await sleep(OUTPUT_PUBLISH_INTERVAL_MS * 2);
      return text;
    })]]), ...deps });
    expect(publishedBeforeYield).toBe(1);
    expect(log.map((e) => e.text)).toEqual(['Hel', 'Hello, world']);
  });

  it('keeps publishing at a bounded rate while text streams steadily', async () => {
    const { log, deps } = recorder();
    await runTurn(input(), { adapters: new Map([['claude', adapter(async (ctx) => {
      let text = '';
      for (let i = 0; i < 40; i++) { text += `${i} `; ctx.emit(text, 'assistant'); await sleep(10); }
      return text;
    })]]), ...deps });
    const outputs = log.filter((e) => e.kind === 'output');
    // ~400 ms of streaming: the first chunk, a few window updates, the final text.
    expect(outputs.length).toBeGreaterThanOrEqual(3);
    expect(outputs.length).toBeLessThanOrEqual(6);
    // The turn's end flushes the final text at once; every update before it is paced.
    for (let i = 1; i < outputs.length - 1; i++)
      expect(outputs[i]!.at - outputs[i - 1]!.at).toBeGreaterThanOrEqual(OUTPUT_PUBLISH_INTERVAL_MS - 20);
    expect(outputs.at(-1)!.text).toBe(Array.from({ length: 40 }, (_, i) => `${i} `).join(''));
  });

  it('lands the latest text before the activity that completes it, exactly once', async () => {
    const { log, deps } = recorder();
    await runTurn(input(), { adapters: new Map([['claude', adapter(async (ctx) => {
      ctx.emit('Plan', 'assistant');
      ctx.emit('Plan: edit', 'assistant');
      ctx.emit('Plan: edit the file', 'assistant');
      ctx.emitActivity({ id: 'msg-1', kind: 'message', phase: 'completed', title: 'Plan: edit the file' });
      await sleep(OUTPUT_PUBLISH_INTERVAL_MS * 2);
      return 'Plan: edit the file';
    })]]), ...deps });
    expect(log.map((e) => e.text)).toEqual(['Plan', 'Plan: edit the file', 'message:completed:Plan: edit the file']);
  });

  it('flushes the pending text when the turn completes', async () => {
    const { log, deps } = recorder();
    await runTurn(input(), { adapters: new Map([['claude', adapter(async (ctx) => {
      ctx.emit('a', 'assistant');
      ctx.emit('ab', 'assistant');
      return 'ab';
    })]]), ...deps });
    expect(log.map((e) => e.text)).toEqual(['a', 'ab']);
  });

  it('publishes tool lines immediately, after any pending assistant text', async () => {
    const { log, deps } = recorder();
    await runTurn(input(), { adapters: new Map([['claude', adapter(async (ctx) => {
      ctx.emit('Running', 'assistant');
      ctx.emit('Running the tests', 'assistant');
      ctx.emit('$ npm test');
      return 'Running the tests';
    })]]), ...deps });
    expect(log.map((e) => e.text)).toEqual(['Running', 'Running the tests', '$ npm test']);
  });

  it('never publishes a partial message after a failed or cancelled turn', async () => {
    const { log, deps } = recorder();
    const controller = new AbortController();
    await expect(runTurn(input(), { signal: controller.signal, adapters: new Map([['claude', {
      provider: 'claude',
      async runTurn(_input, ctx) {
        ctx.emit('Half', 'assistant');
        ctx.emit('Half a mess', 'assistant');
        controller.abort(new Error('cancelled'));
        throw new Error('cancelled');
      },
    } as AgentAdapter]]), ...deps })).rejects.toThrow('cancelled');
    await sleep(OUTPUT_PUBLISH_INTERVAL_MS * 2);
    expect(log.map((e) => e.text)).toEqual(['Half']);
  });
});

// ─── Adapters ────────────────────────────────────────────────────────────────

const sdk = vi.hoisted(() => ({ query: undefined as undefined | ((args: any) => AsyncIterable<any>), options: undefined as any }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (name: string, description: string, shape: Record<string, any>, run: any) => ({ name, description, shape, run }),
  createSdkMcpServer: (opts: { name: string; tools: any[] }) => ({ type: 'sdk', name: opts.name, tools: opts.tools }),
  query: (args: any) => { sdk.options = args.options; return sdk.query!(args); },
}));
const { ClaudeAdapter } = await import('../src/agent/claude.js');
const { CodexAdapter } = await import('../src/agent/codex.js');

function toolContext(emitted: string[], activities: any[] = []): PlatformToolContext {
  return {
    openPr: () => {}, signalCompletion: () => {}, createReviewInfo: () => {}, createSubTask: () => {},
    addCheckout: async () => ({ name: '', root: '', branch: '' }), respondToSubTask: () => {},
    raiseToParent: () => {}, waitForSubtasks: () => {}, saveSkill: () => {}, resolveDecision: () => {},
    confirmDecision: () => {}, requestSpend: async () => ({ status: 'denied' as const }),
    requestWait: () => {}, jobStarted: () => {},
    emit: (text, source) => { if (source === 'assistant') emitted.push(text); },
    emitActivity: (activity) => { activities.push(activity); },
  };
}

describe('Claude Agent SDK text deltas (LT-5)', () => {
  const textDelta = (text: string, parent: string | null = null) => ({ type: 'stream_event', parent_tool_use_id: parent, uuid: `u-${text}`,
    session_id: 'sess-1', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  const blockStart = (type: string, parent: string | null = null) => ({ type: 'stream_event', parent_tool_use_id: parent, uuid: `s-${type}`,
    session_id: 'sess-1', event: { type: 'content_block_start', index: 0, content_block: type === 'text' ? { type, text: '' } : { type, id: 't1', name: 'Bash', input: {} } } });

  it('asks for partial messages and emits each text block as it grows, recording the message once', async () => {
    sdk.query = (args: any) => (async function* () {
      const consumed: string[] = [];
      void (async () => { for await (const m of args.prompt) consumed.push(m.uuid); })();
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
      yield { type: 'stream_event', session_id: 'sess-1', parent_tool_use_id: null, event: { type: 'message_start', message: { content: [] } } };
      yield blockStart('text');
      yield textDelta('Look');
      yield textDelta('ing at');
      // A sub-agent's stream belongs to its own transcript, never the main bubble.
      yield blockStart('text', 'task-1');
      yield textDelta('sub-agent chatter', 'task-1');
      yield textDelta(' the diff');
      await sleep(5);
      yield { type: 'assistant', uuid: 'a1', user_message_uuids: consumed, message: { content: [{ type: 'text', text: 'Looking at the diff' }] } };
      yield blockStart('tool_use');
      yield { type: 'assistant', uuid: 'a2', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } };
      yield blockStart('text');
      yield textDelta('Done');
      yield { type: 'assistant', uuid: 'a3', message: { content: [{ type: 'text', text: 'Done' }] } };
      yield { type: 'result', subtype: 'success', session_id: 'sess-1', num_turns: 2 };
    })();
    const emitted: string[] = [];
    const activities: any[] = [];
    const turn = await new ClaudeAdapter().runTurn({
      ...input(), world: { handle: { id: 'task_stream', root: process.cwd() } } as any, resolvedAuth: { configHome: process.cwd() },
    }, toolContext(emitted, activities));
    expect(sdk.options.includePartialMessages).toBe(true);
    expect(emitted).toEqual(['Look', 'Looking at', 'Looking at the diff', 'Done']);
    expect(activities.filter((a) => a.kind === 'message').map((a) => a.title)).toEqual(['Looking at the diff', 'Done']);
    expect(turn.output).toBe('Done');
  });
});

/** A stub provider endpoint: each request takes the next scripted reply. */
function stubProvider() {
  const seen: any[] = [];
  let replies: Array<{ sse?: any[]; json?: any; status?: number; truncate?: boolean; contentType?: string; done?: boolean }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      seen.push(JSON.parse(body || '{}'));
      const reply = replies.shift()!;
      if (!reply.sse) {
        res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.json));
        return;
      }
      res.writeHead(200, { 'content-type': reply.contentType ?? 'text/event-stream' });
      for (const event of reply.sse) {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        await sleep(2);
      }
      if (reply.done) res.write('data: [DONE]\n\n');
      if (reply.truncate) res.destroy(); else res.end();
    });
  });
  return {
    seen,
    script(next: typeof replies) { replies = next; seen.length = 0; },
    async listen() {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** The Messages API event sequence for one complete message. */
function anthropicEvents(message: any, chunk = 4): any[] {
  const { content, usage, stop_reason, ...rest } = message;
  const events: any[] = [{ type: 'message_start', message: { ...rest, content: [], stop_reason: null,
    usage: { input_tokens: usage.input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens, output_tokens: 1 } } }];
  content.forEach((block: any, index: number) => {
    if (block.type === 'text') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      for (let i = 0; i < block.text.length; i += chunk)
        events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text.slice(i, i + chunk) } });
    } else {
      events.push({ type: 'content_block_start', index, content_block: { ...block, input: {} } });
      const json = JSON.stringify(block.input);
      for (let i = 0; i < json.length; i += chunk)
        events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(i, i + chunk) } });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({ type: 'ping' });
  events.push({ type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  events.push({ type: 'message_stop' });
  return events;
}

describe('metered API rails stream their responses (LT-5)', () => {
  const provider = stubProvider();
  beforeAll(async () => {
    const base = await provider.listen();
    process.env.KARMAX_ANTHROPIC_BASE_URL = base;
    process.env.KARMAX_OPENAI_BASE_URL = `${base}/v1`;
  });
  afterAll(async () => {
    delete process.env.KARMAX_ANTHROPIC_BASE_URL;
    delete process.env.KARMAX_OPENAI_BASE_URL;
    await provider.close();
  });

  const claudeInput = (): TurnInput => ({ ...input(), world: { handle: { id: 'w', root: os.tmpdir() } } as any, resolvedAuth: { apiKey: 'sk-ant-test' } });
  const toolTurn = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude', stop_reason: 'tool_use',
    usage: { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 12 },
    content: [{ type: 'text', text: 'Checking the tree.' }, { type: 'tool_use', id: 'toolu_1', name: 'not_a_real_tool', input: { path: 'src', depth: 2 } }] };
  const finalTurn = { id: 'msg_2', type: 'message', role: 'assistant', model: 'claude', stop_reason: 'end_turn',
    usage: { input_tokens: 150, cache_read_input_tokens: 60, output_tokens: 9 },
    content: [{ type: 'text', text: 'All done, nothing to change.' }] };

  it('Messages API: emits text as it streams and keeps usage, tool calls and stop reasons as before', async () => {
    provider.script([{ json: toolTurn }, { json: finalTurn }]);
    const emittedJson: string[] = [];
    const viaJson = await new ClaudeAdapter().runTurn(claudeInput(), toolContext(emittedJson));
    const requestsJson = structuredClone(provider.seen);

    provider.script([{ sse: anthropicEvents(toolTurn) }, { sse: anthropicEvents(finalTurn) }]);
    const emitted: string[] = [];
    const activities: any[] = [];
    const viaStream = await new ClaudeAdapter().runTurn(claudeInput(), toolContext(emitted, activities));

    expect(provider.seen.every((body) => body.stream === true)).toBe(true);
    expect(emitted.length).toBeGreaterThan(4);
    expect(emitted.slice(0, 2)).toEqual(['Chec', 'Checking']);
    expect(emitted).toContain('Checking the tree.');
    expect(emitted.at(-1)).toBe('All done, nothing to change.');
    expect(activities.filter((a) => a.kind === 'message').map((a) => a.title)).toEqual(['Checking the tree.', 'All done, nothing to change.']);
    expect(viaStream).toEqual(viaJson);
    // The reassembled assistant turn (text + tool_use input) is what the next request replays.
    expect(provider.seen[1].messages).toEqual(requestsJson[1].messages);
  });

  it('Messages API: classifies a mid-stream error exactly like the same error returned over HTTP', async () => {
    const overloaded = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } };
    provider.script([{ status: 529, json: overloaded }]);
    const viaHttp = await new ClaudeAdapter().runTurn(claudeInput(), toolContext([])).catch((e) => e);
    provider.script([{ sse: [anthropicEvents(finalTurn)[0], overloaded] }]);
    const viaStream = await new ClaudeAdapter().runTurn(claudeInput(), toolContext([])).catch((e) => e);
    expect(viaStream).toBeInstanceOf(viaHttp.constructor);
    expect(viaStream.message).toBe(viaHttp.message);
    expect(isTransportError(viaStream)).toBe(true);
  });

  it('Messages API: a stream cut before message_stop is a retryable interruption, never a finished turn', async () => {
    provider.script([{ sse: anthropicEvents(finalTurn).slice(0, 4), truncate: true }]);
    const error = await new ClaudeAdapter().runTurn(claudeInput(), toolContext([])).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(isTransportError(error)).toBe(true);
  });

  const codexInput = (): TurnInput => ({ ...input(), profile: { id: 'p', name: 'c', provider: 'codex', model: 'gpt-5.5', role: 'do', capabilities: [] },
    world: { handle: { id: 'w', root: os.tmpdir() } } as any, resolvedAuth: { apiKey: 'sk-test' } });
  const responseEvents = (response: any, chunk = 5): any[] => {
    const events: any[] = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }];
    response.output.forEach((item: any, output_index: number) => {
      events.push({ type: 'response.output_item.added', output_index, item: { ...item, content: [] } });
      if (item.type === 'message') for (const [content_index, part] of item.content.entries())
        for (let i = 0; i < part.text.length; i += chunk)
          events.push({ type: 'response.output_text.delta', item_id: item.id, output_index, content_index, delta: part.text.slice(i, i + chunk) });
      events.push({ type: 'response.output_item.done', output_index, item });
    });
    events.push({ type: `response.${response.status === 'completed' ? 'completed' : response.status}`, response });
    return events;
  };
  const callResponse = { id: 'resp_1', status: 'completed', usage: { input_tokens: 90, output_tokens: 7, input_tokens_details: { cached_tokens: 30 } },
    output: [{ type: 'message', id: 'msg_a', content: [{ type: 'output_text', text: 'Reading the file.' }] },
      { type: 'function_call', call_id: 'c1', name: 'not_a_real_tool', arguments: '{"path":"README.md"}' }] };
  const doneResponse = { id: 'resp_2', status: 'completed', usage: { input_tokens: 120, output_tokens: 11, input_tokens_details: { cached_tokens: 50 } },
    output: [{ type: 'message', id: 'msg_b', content: [{ type: 'output_text', text: 'Finished the change.' }] }] };

  it('Responses API: emits text as it streams and keeps the terminal response as the source of truth', async () => {
    provider.script([{ json: callResponse }, { json: doneResponse }]);
    const viaJson = await new CodexAdapter().runTurn(codexInput(), toolContext([]));
    const requestsJson = structuredClone(provider.seen);

    provider.script([{ sse: responseEvents(callResponse) }, { sse: responseEvents(doneResponse) }]);
    const emitted: string[] = [];
    const viaStream = await new CodexAdapter().runTurn(codexInput(), toolContext(emitted));
    expect(provider.seen.every((body) => body.stream === true)).toBe(true);
    expect(emitted.slice(0, 2)).toEqual(['Readi', 'Reading th']);
    expect(emitted).toContain('Reading the file.');
    expect(emitted.at(-1)).toBe('Finished the change.');
    expect(viaStream).toEqual(viaJson);
    expect(provider.seen[1].input).toEqual(requestsJson[1].input);
  });

  it('Responses API: an incomplete terminal response still fails exactly as before', async () => {
    const incomplete = { id: 'resp_3', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 1, output_tokens: 1 },
      output: [{ type: 'message', id: 'msg_c', content: [{ type: 'output_text', text: 'Half' }] }] };
    provider.script([{ json: incomplete }]);
    const viaJson = await new CodexAdapter().runTurn(codexInput(), toolContext([])).catch((e) => e);
    provider.script([{ sse: responseEvents(incomplete) }]);
    const viaStream = await new CodexAdapter().runTurn(codexInput(), toolContext([])).catch((e) => e);
    expect(viaStream.message).toBe(viaJson.message);
    expect(viaStream).toBeInstanceOf(viaJson.constructor);
  });

  it('Responses API: a stream error event is classified like the provider error body', async () => {
    const limited = { error: { message: 'Rate limit reached for gpt-5.5', type: 'requests', code: 'rate_limit_exceeded', param: null } };
    provider.script([{ status: 429, json: limited }]);
    const viaHttp = await new CodexAdapter().runTurn(codexInput(), toolContext([])).catch((e) => e);
    provider.script([{ sse: [{ type: 'response.created', response: { id: 'r', status: 'in_progress', output: [] } },
      { type: 'error', code: 'rate_limit_exceeded', message: 'Rate limit reached for gpt-5.5', param: null }] }]);
    const viaStream = await new CodexAdapter().runTurn(codexInput(), toolContext([])).catch((e) => e);
    expect(viaStream).toBeInstanceOf(viaHttp.constructor);
    const { diagnostic: _streamed, ...streamed } = viaStream.metadata;
    const { diagnostic: _returned, ...returned } = viaHttp.metadata;
    expect(streamed).toEqual(returned);
  });

  // #396 review item 4: without streaming, a response that fails mid-generation
  // came back as the HTTP status of its error code, so a transient outage retried.
  it.each([
    ['server_error', 500, 'The server had an error while processing your request.'],
    ['rate_limit_exceeded', 429, 'Rate limit reached for gpt-5.5'],
    ['insufficient_quota', 429, 'You exceeded your current quota, please check your plan and billing details.'],
    ['invalid_prompt', 400, 'Invalid prompt: the prompt was flagged.'],
  ])('Responses API: a response.failed with %s is classified like HTTP %i', async (code, status, message) => {
    const classify = (error: any) => ({ constructor: error.constructor, message: error.message,
      transport: isTransportError(error), metadata: error.metadata && (({ diagnostic: _d, ...rest }) => rest)(error.metadata) });
    provider.script([{ status, json: { error: { message, type: code === 'server_error' ? 'server_error' : 'requests', code, param: null } } }]);
    const viaHttp = classify(await new CodexAdapter().runTurn(codexInput(), toolContext([])).catch((e) => e));
    provider.script([{ sse: [{ type: 'response.created', response: { id: 'r', status: 'in_progress', output: [] } },
      { type: 'response.failed', response: { id: 'r', status: 'failed', output: [], error: { code, message } } }] }]);
    const viaStream = classify(await new CodexAdapter().runTurn(codexInput(), toolContext([])).catch((e) => e));
    expect(viaStream.constructor).toBe(viaHttp.constructor);
    expect(viaStream.transport).toBe(viaHttp.transport);
    expect(viaStream.metadata).toEqual(viaHttp.metadata);
    expect(viaStream.message).toMatch(new RegExp(`^OpenAI Responses API ${status}: `));
    if (code === 'server_error') expect(viaStream.transport).toBe(true);
  });
});

// #396 review item 11: the fallbacks around a stream that is not what it says.
describe('stream framing and fallbacks', () => {
  const chunked = (chunks: Array<string | Uint8Array>) => new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
      controller.close();
    },
  });
  const read = async (chunks: Array<string | Uint8Array>) => {
    const out: Array<{ event?: string; data: string }> = [];
    for await (const event of serverSentEvents(chunked(chunks))) out.push(event);
    return out;
  };

  it('reassembles events split across chunks, lines, CRLF and multi-byte characters', async () => {
    const bytes = new TextEncoder().encode('data: {"text":"héllo ✓"}\n\n');
    const cut = bytes.indexOf(0xc3) + 1; // inside "é"
    expect(await read([bytes.slice(0, cut), bytes.slice(cut, -3), bytes.slice(-3)])).toEqual([{ data: '{"text":"héllo ✓"}' }]);
    expect(await read(['event: ping\r', '\ndata: 1\r\n', '\r\nda', 'ta: 2\n\n'])).toEqual([{ event: 'ping', data: '1' }, { data: '2' }]);
    expect(await read(['data: first\ndata: second\n', '\n'])).toEqual([{ data: 'first\nsecond' }]);
    expect(await read([': keep-alive\n\n', 'data: x\n\n', 'data: dangling'])).toEqual([{ data: 'x' }]);
  });

  describe('against a provider endpoint', () => {
    const provider = stubProvider();
    beforeAll(async () => {
      const base = await provider.listen();
      process.env.KARMAX_ANTHROPIC_BASE_URL = base;
      process.env.KARMAX_OPENAI_BASE_URL = `${base}/v1`;
    });
    afterAll(async () => {
      delete process.env.KARMAX_ANTHROPIC_BASE_URL;
      delete process.env.KARMAX_OPENAI_BASE_URL;
      await provider.close();
    });
    const claudeInput = (): TurnInput => ({ ...input(), world: { handle: { id: 'w', root: os.tmpdir() } } as any, resolvedAuth: { apiKey: 'sk-ant-test' } });
    const codexInput = (): TurnInput => ({ ...input(), profile: { id: 'p', name: 'c', provider: 'codex', model: 'gpt-5.5', role: 'do', capabilities: [] },
      world: { handle: { id: 'w', root: os.tmpdir() } } as any, resolvedAuth: { apiKey: 'sk-test' } });
    const message = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude', stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 3 }, content: [{ type: 'text', text: 'Proxied reply.' }] };
    const response = { id: 'resp_1', status: 'completed', usage: { input_tokens: 10, output_tokens: 3 },
      output: [{ type: 'message', id: 'msg_a', content: [{ type: 'output_text', text: 'Proxied reply.' }] }] };
    const responseEvents = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_text.delta', item_id: 'msg_a', output_index: 0, content_index: 0, delta: 'Proxied reply.' },
      { type: 'response.completed', response }];

    it('reads an event stream served under another content type', async () => {
      provider.script([{ sse: anthropicEvents(message), contentType: 'application/json' }]);
      expect((await new ClaudeAdapter().runTurn(claudeInput(), toolContext([]))).output).toBe('Proxied reply.');
      provider.script([{ sse: responseEvents, contentType: 'text/plain' }]);
      expect((await new CodexAdapter().runTurn(codexInput(), toolContext([]))).output).toBe('Proxied reply.');
    });

    it('asks once more when a stream ends cleanly without its terminal event', async () => {
      provider.script([{ sse: anthropicEvents(message).slice(0, -1) }, { sse: anthropicEvents(message) }]);
      expect((await new ClaudeAdapter().runTurn(claudeInput(), toolContext([]))).output).toBe('Proxied reply.');
      expect(provider.seen).toHaveLength(2);
    });

    it('fails as a protocol error, not a retryable interruption, when it happens again', async () => {
      provider.script([{ sse: anthropicEvents(message).slice(0, -1) }, { sse: anthropicEvents(message).slice(0, -1) }]);
      const claude = await new ClaudeAdapter().runTurn(claudeInput(), toolContext([])).catch((e) => e);
      expect(provider.seen).toHaveLength(2);
      expect(claude.message).toMatch(/protocol/i);
      expect(isTransportError(claude)).toBe(false);
      provider.script([{ sse: responseEvents.slice(0, -1), done: true }, { sse: responseEvents.slice(0, -1), done: true }]);
      const codex = await new CodexAdapter().runTurn(codexInput(), toolContext([])).catch((e) => e);
      expect(provider.seen).toHaveLength(2);
      expect(codex.message).toMatch(/protocol/i);
      expect(isTransportError(codex)).toBe(false);
    });
  });
});
