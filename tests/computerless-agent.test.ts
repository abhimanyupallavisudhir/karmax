import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ClaudeAdapter } from '../src/agent/claude.js';
import { CodexAdapter } from '../src/agent/codex.js';
import { AcpAdapter } from '../src/agent/acp.js';
import { MockAdapter } from '../src/agent/mock.js';
import { runTurn } from '../src/agent/runtime.js';
import { chatCompletionsEndpoint, ComputerlessModelUnsupported, computerlessModelGap } from '../src/agent/computerless.js';
import { COMPUTERLESS_TOOL_SCHEMAS, WORLD_TOOL_NAMES, computerlessToolHandlers } from '../src/agent/tools.js';
import { assemblePrompt, NO_COMPUTER_WORLD } from '../src/agent/prompt.js';
import { WorldRegistry } from '../src/world/registry.js';
import type { AgentAdapter, PlatformToolContext, TurnInput } from '../src/agent/types.js';
import type { World } from '../src/world/types.js';

/** A model API that answers each POST with the next scripted reply and keeps what it was sent. */
function stubModelApi() {
  const seen: Array<{ path: string; headers: http.IncomingHttpHeaders; body: any }> = [];
  let replies: Array<{ json?: unknown; sse?: unknown[]; event?: (e: any) => string | undefined }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      seen.push({ path: req.url ?? '', headers: req.headers, body: JSON.parse(raw || '{}') });
      const reply = replies.shift();
      if (!reply) { res.writeHead(500); res.end('no scripted reply'); return; }
      if (reply.json) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply.json)); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of reply.sse ?? []) {
        const name = reply.event?.(event);
        res.write(`${name ? `event: ${name}\n` : ''}data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`);
      }
      res.end();
    });
  });
  return {
    seen,
    script(next: typeof replies) { replies = next; seen.length = 0; },
    async listen() {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const PLATFORM_TOOLS = ['platform_request', 'create_task', 'create_sub_task', 'message_agent', 'get_conversation', 'find_task',
  'list_tasks', 'read_wiki', 'search_wiki', 'list_connections', 'execute_connection_tool', 'request_connection',
  'request_permission', 'my_authorization', 'notify', 'escalate_to_human', 'pause', 'signal_completion', 'save_skill'];
const NEVER = ['bash', 'read_file', 'write_file', 'start_job', 'stop_job', 'open_pr', 'create_branch', 'fill_payment_card',
  'save_session', 'use_session', 'publish_task_branch', 'import_task_branch'];

function context(calls: Array<{ method: string; path: string; body?: unknown }>, extra: Partial<PlatformToolContext> = {}): PlatformToolContext {
  return {
    openPr: () => { throw new Error('open_pr must never be reachable without a computer'); },
    signalCompletion: () => {}, createReviewInfo: () => {}, createSubTask: () => {},
    addCheckout: async () => { throw new Error('no checkouts without a computer'); }, respondToSubTask: () => {},
    raiseToParent: () => {}, waitForSubtasks: () => {}, saveSkill: () => {}, resolveDecision: () => {},
    confirmDecision: () => {}, requestSpend: async () => ({ status: 'denied' as const }),
    requestWait: () => {}, jobStarted: () => { throw new Error('no jobs without a computer'); },
    platformRequest: async (method, path, body) => { calls.push({ method, path, body }); return { ok: true, path }; },
    emit: () => {}, emitActivity: () => {},
    ...extra,
  };
}

let world: World;
const input = (overrides: Partial<TurnInput> = {}): TurnInput => ({
  profile: { id: 'p', name: 'p', provider: 'claude', model: 'claude-opus-5-5', role: 'do', capabilities: [] },
  world,
  messages: [{ id: 'm1', role: 'user', ts: 0, text: 'What is waiting on me?' }],
  role: 'do',
  systemPrompt: 'system',
  ...overrides,
});

beforeAll(async () => {
  world = await new WorldRegistry().create('none', { taskId: 'task_computerless_agent', base: 'main' });
});
afterAll(async () => { await world.destroy(); });

describe('tools of a task without a computer', () => {
  it('are tavya\'s platform tools only', () => {
    const names = COMPUTERLESS_TOOL_SCHEMAS.map((tool) => tool.name);
    for (const name of PLATFORM_TOOLS) expect(names).toContain(name);
    for (const name of NEVER) expect(names).not.toContain(name);
    for (const name of WORLD_TOOL_NAMES) expect(names).not.toContain(name);
    expect(Object.keys(computerlessToolHandlers(world, context([]))).sort()).toEqual([...names].sort());
  });

  it('pause takes no jobs; review info takes no commands or files', async () => {
    const waits: unknown[] = [];
    const handlers = computerlessToolHandlers(world, context([], { requestWait: (wait) => { waits.push(wait); } }));
    expect(await handlers.pause!({ minutes: 5, jobs: ['job_1'] })).toMatch(/this task has no computer/);
    expect(waits).toEqual([]);
    await handlers.pause!({ minutes: 5 });
    expect(waits).toEqual([{ minutes: 5 }]);
    expect(await handlers.create_review_info!({ actions: [{ kind: 'run', label: 'Test', command: 'npm test' }] })).toMatch(/rejected/);
    expect(await handlers.create_review_info!({ actions: [{ kind: 'open', label: 'Report', target: 'report.md' }] })).toMatch(/rejected/);
    expect(await handlers.create_review_info!({ caption: 'Check the invite', actions: [{ kind: 'open', label: 'Doc', target: 'https://example.com/doc' }] }))
      .toBe('review info recorded');
  });
});

describe('which models run without a computer', () => {
  it('API keys and the included model do; subscription logins and unknown vendors do not', () => {
    expect(computerlessModelGap({ provider: 'claude' }, { apiKey: true })).toBeUndefined();
    expect(computerlessModelGap({ provider: 'codex' }, { apiKey: true })).toBeUndefined();
    expect(computerlessModelGap({ provider: 'opencode', model: 'openrouter/deepseek/deepseek-v4.1-flash-1017' }, { apiKey: true })).toBeUndefined();
    expect(computerlessModelGap({ provider: 'opencode', model: 'anthropic/claude-haiku-5-5' }, { apiKey: true })).toBeUndefined();
    expect(computerlessModelGap({ provider: 'mock' }, { apiKey: false })).toBeUndefined();
    expect(computerlessModelGap({ provider: 'claude' }, { apiKey: false })).toMatch(/Claude Code login runs only on a computer/);
    expect(computerlessModelGap({ provider: 'codex' }, { apiKey: false })).toMatch(/Codex login runs only on a computer/);
    expect(computerlessModelGap({ provider: 'opencode', model: 'google/gemini-3-pro' }, { apiKey: true })).toMatch(/can't run without a computer/);
    expect(computerlessModelGap({ provider: 'kimi' as never }, { apiKey: true })).toMatch(/can't run without a computer/);
    expect(chatCompletionsEndpoint('openrouter/deepseek/deepseek-v4.1-flash-1017')).toMatchObject({ vendor: 'openrouter', model: 'deepseek/deepseek-v4.1-flash-1017' });
    expect(chatCompletionsEndpoint('google/gemini-3-pro')).toBeUndefined();
  });

  it('a subscription login refuses before any request', async () => {
    const claude = new ClaudeAdapter().runComputerlessTurn(input({ resolvedAuth: { configHome: '/tmp/home' } }), context([]));
    await expect(claude).rejects.toBeInstanceOf(ComputerlessModelUnsupported);
    const codex = new CodexAdapter().runComputerlessTurn(input({ profile: { id: 'p', name: 'p', provider: 'codex', role: 'do', capabilities: [] },
      resolvedAuth: { configHome: '/tmp/home' } }), context([]));
    await expect(codex).rejects.toThrow(/Codex login runs only on a computer/);
  });

  it('the runtime sends a computerless turn to the host-side rail, and refuses an agent without one', async () => {
    const called: string[] = [];
    const both: AgentAdapter = {
      provider: 'claude',
      async runTurn() { called.push('world'); return { termination: { kind: 'success', status: 'end_turn' }, output: 'world' }; },
      async runComputerlessTurn() { called.push('host'); return { termination: { kind: 'success', status: 'end_turn' }, output: 'host' }; },
    };
    expect((await runTurn(input(), { adapters: new Map([['claude', both]]) })).output).toBe('host');
    expect(called).toEqual(['host']);
    const worldOnly: AgentAdapter = { provider: 'claude', runTurn: both.runTurn };
    await expect(runTurn(input(), { adapters: new Map([['claude', worldOnly]]) })).rejects.toThrow(/can't run without a computer/);
  });

  it('the mock agent meets the world\'s refusal when it tries to run something', async () => {
    const turn = await new MockAdapter().runComputerlessTurn(input({ profile: { id: 'p', name: 'p', provider: 'mock', role: 'do', capabilities: [] },
      messages: [{ id: 'm1', role: 'user', ts: 0, text: '@run echo hi' }] }), context([])).catch((error: Error) => error);
    expect(turn instanceof Error ? turn.message : turn.output).toMatch(/this task has no computer/);
  });
});

describe('host-side loops of a task without a computer (stubbed model APIs)', () => {
  const api = stubModelApi();
  let base = '';
  beforeAll(async () => {
    base = await api.listen();
    process.env.KARMAX_ANTHROPIC_BASE_URL = base;
    process.env.KARMAX_OPENAI_BASE_URL = `${base}/v1`;
    process.env.KARMAX_OPENROUTER_API_URL = `${base}/openrouter/v1`;
  });
  afterAll(async () => {
    delete process.env.KARMAX_ANTHROPIC_BASE_URL;
    delete process.env.KARMAX_OPENAI_BASE_URL;
    delete process.env.KARMAX_OPENROUTER_API_URL;
    await api.close();
  });
  beforeEach(() => api.script([]));

  it('Claude Messages API: offers only platform tools and round-trips a platform tool call', async () => {
    api.script([
      { json: { id: 'msg_1', type: 'message', role: 'assistant', stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'toolu_1', name: 'platform_request', input: { method: 'GET', path: '/api/inbox' } },
          { type: 'tool_use', id: 'toolu_2', name: 'bash', input: { command: 'ls' } }] } },
      { json: { id: 'msg_2', type: 'message', role: 'assistant', stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 3 },
        content: [{ type: 'text', text: 'Two things wait on you.' }] } },
    ]);
    const calls: Array<{ method: string; path: string }> = [];
    const turn = await new ClaudeAdapter().runComputerlessTurn(input({ resolvedAuth: { apiKey: 'sk-ant-test' } }), context(calls));
    expect(turn.output).toBe('Two things wait on you.');
    expect(turn.usage).toMatchObject({ inputTokens: 30, outputTokens: 8 });
    expect(calls).toEqual([expect.objectContaining({ method: 'GET', path: '/api/inbox' })]);
    const offered = api.seen[0]!.body.tools.map((tool: { name: string }) => tool.name);
    expect(offered.sort()).toEqual(COMPUTERLESS_TOOL_SCHEMAS.map((tool) => tool.name).sort());
    const results = api.seen[1]!.body.messages.at(-1).content;
    expect(results[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });
    expect(JSON.parse(results[0].content)).toMatchObject({ path: '/api/inbox' });
    expect(results[1]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_2', is_error: true });
    expect(results[1].content).toMatch(/unknown tool bash/);
  });

  it('OpenAI Responses API: offers only platform tools', async () => {
    api.script([{ json: { id: 'resp_1', status: 'completed', usage: { input_tokens: 4, output_tokens: 2 },
      output: [{ type: 'message', id: 'msg_a', content: [{ type: 'output_text', text: 'Nothing waits on you.' }] }] } }]);
    const turn = await new CodexAdapter().runComputerlessTurn(input({ profile: { id: 'p', name: 'p', provider: 'codex', model: 'gpt-5.5', role: 'do', capabilities: [] },
      resolvedAuth: { apiKey: 'sk-test' } }), context([]));
    expect(turn.output).toBe('Nothing waits on you.');
    const offered = api.seen[0]!.body.tools.map((tool: { name: string }) => tool.name);
    expect(offered.sort()).toEqual(COMPUTERLESS_TOOL_SCHEMAS.map((tool) => tool.name).sort());
  });

  it('OpenAI-compatible Chat Completions (the included model on OpenRouter): streamed tool calls round-trip', async () => {
    const chunk = (delta: unknown, finish: string | null = null, extra: Record<string, unknown> = {}) =>
      ({ id: 'gen-1', model: 'deepseek/deepseek-v4.1-flash-1017', choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
    api.script([
      { sse: [
        chunk({ role: 'assistant', content: 'Let me ' }),
        chunk({ content: 'check.' }),
        chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'message_agent', arguments: '{"task_id":"task_9",' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"message":"Use Postgres"}' } }] }),
        chunk({}, 'tool_calls'),
        { id: 'gen-1', choices: [], usage: { prompt_tokens: 50, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 10 } } },
        '[DONE]',
      ] },
      { sse: [chunk({ content: 'Told #9 to use Postgres.' }), chunk({}, 'stop'),
        { id: 'gen-2', choices: [], usage: { prompt_tokens: 70, completion_tokens: 6 } }, '[DONE]'] },
    ]);
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const emitted: string[] = [];
    const turn = await new AcpAdapter('opencode').runComputerlessTurn(input({
      profile: { id: 'p', name: 'p', provider: 'opencode', model: 'openrouter/deepseek/deepseek-v4.1-flash-1017', effort: 'max', role: 'do', capabilities: [] },
      resolvedAuth: { apiKey: 'sk-or-org', modelOptions: { provider: { zdr: true } } },
    }), context(calls, { emit: (text, source) => { if (source === 'assistant') emitted.push(text); } }));
    expect(turn.output).toBe('Told #9 to use Postgres.');
    expect(turn.usage).toMatchObject({ inputTokens: 120, outputTokens: 13 });
    expect(emitted).toContain('Let me check.');
    expect(api.seen[0]!.path).toBe('/openrouter/v1/chat/completions');
    expect(api.seen[0]!.headers.authorization).toBe('Bearer sk-or-org');
    const first = api.seen[0]!.body;
    expect(first).toMatchObject({ model: 'deepseek/deepseek-v4.1-flash-1017', stream: true, provider: { zdr: true }, reasoning: { effort: 'high' } });
    expect(first.messages[0]).toEqual({ role: 'system', content: 'system' });
    expect(first.tools.map((tool: { function: { name: string } }) => tool.function.name).sort())
      .toEqual(COMPUTERLESS_TOOL_SCHEMAS.map((tool) => tool.name).sort());
    // message_agent went through the platform API, and its result came back to the model.
    expect(calls).toEqual([expect.objectContaining({ method: 'POST', path: '/api/tasks/task_9/messages' })]);
    const second = api.seen[1]!.body.messages;
    expect(second.at(-2)).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call_1', function: { name: 'message_agent' } }] });
    expect(second.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
  });

  it('Chat Completions also reads a plain JSON response', async () => {
    api.script([{ json: { id: 'gen-3', choices: [{ index: 0, message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 1 } } }]);
    const turn = await new AcpAdapter('opencode').runComputerlessTurn(input({
      profile: { id: 'p', name: 'p', provider: 'opencode', model: 'openai/gpt-5-mini', role: 'do', capabilities: [] },
      resolvedAuth: { apiKey: 'sk-openai' } }), context([]));
    expect(turn.output).toBe('Done.');
    expect(api.seen[0]!.path).toBe('/v1/chat/completions');
  });

  it('an OpenCode Anthropic model runs on the Messages API loop', async () => {
    api.script([{ json: { id: 'msg_3', type: 'message', role: 'assistant', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'text', text: 'Hi.' }] } }]);
    const turn = await new AcpAdapter('opencode').runComputerlessTurn(input({
      profile: { id: 'p', name: 'p', provider: 'opencode', model: 'anthropic/claude-haiku-5-5', role: 'do', capabilities: [] },
      resolvedAuth: { apiKey: 'sk-ant' } }), context([]));
    expect(turn.output).toBe('Hi.');
    expect(api.seen[0]!.path).toBe('/v1/messages');
    expect(api.seen[0]!.body.model).toBe('claude-haiku-5-5');
  });
});

describe('the prompt of a task without a computer', () => {
  it('says it has no computer and that work needing one goes to a task it creates', () => {
    const prompt = assemblePrompt({ profile: { id: 'p', name: 'p', provider: 'claude', role: 'do', capabilities: [] }, role: 'do',
      task: { taskId: 'task_1', projectId: 'proj_1', title: 'Ask', prompt: 'What is waiting on me?', project: { repos: [] } } as never,
      world: world.handle });
    expect(prompt).toContain(NO_COMPUTER_WORLD);
    expect(prompt).toContain('This task has no computer.');
    expect(prompt).toMatch(/create_task/);
    expect(prompt).not.toMatch(/^- start_job\(/m);
    expect(prompt).not.toMatch(/^- open_pr\(/m);
    expect(prompt).not.toMatch(/Working directory:/);
    expect(prompt).not.toMatch(/Do real work directly in the working directory/);
  });
});
