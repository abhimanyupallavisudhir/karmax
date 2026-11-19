import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ClaudeAdapter } from '../src/agent/claude.js';
import { CodexAdapter } from '../src/agent/codex.js';
import { AcpAdapter } from '../src/agent/acp.js';
import { ASK_TOOL_NAMES, AskToolset } from '../src/agent/computerless.js';
import { COMPUTERLESS_TOOL_SCHEMAS, WORLD_TOOL_NAMES } from '../src/agent/tools.js';
import { assemblePrompt, NO_COMPUTER_WORLD } from '../src/agent/prompt.js';
import { WorldRegistry } from '../src/world/registry.js';
import { Store } from '../src/store/db.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import type { PlatformToolContext, TurnInput } from '../src/agent/types.js';
import type { World } from '../src/world/types.js';

/**
 * What an Ask costs (wiki features/computerless-tasks § What an Ask costs):
 * a host-side turn of a task without a computer is offered Ask's own tool
 * set, not all 65 platform tools (more_tools turns on the rest); on
 * OpenRouter it goes to the cheapest provider and stays there for the turn,
 * so its cached prefix keeps being read; the Claude Messages API caches the
 * prefix; the agent is told to do only what was asked; and an Ask thinks at
 * low effort unless someone chose another.
 */

function stubModelApi() {
  const seen: Array<{ path: string; body: any }> = [];
  let replies: Array<{ json?: unknown; sse?: unknown[] }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      seen.push({ path: req.url ?? '', body: JSON.parse(raw || '{}') });
      const reply = replies.shift();
      if (!reply) { res.writeHead(500); res.end('no scripted reply'); return; }
      if (reply.json) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply.json)); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of reply.sse ?? []) res.write(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`);
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

function context(calls: Array<{ method: string; path: string }> = []): PlatformToolContext {
  return {
    openPr: () => { throw new Error('no PR'); }, signalCompletion: () => {}, createReviewInfo: () => {}, createSubTask: () => {},
    addCheckout: async () => { throw new Error('no checkouts'); }, respondToSubTask: () => {}, raiseToParent: () => {},
    waitForSubtasks: () => {}, saveSkill: () => {}, resolveDecision: () => {}, confirmDecision: () => {},
    requestSpend: async () => ({ status: 'denied' as const }), requestWait: () => {}, jobStarted: () => { throw new Error('no jobs'); },
    platformRequest: async (method, path) => { calls.push({ method, path }); return { ok: true }; },
    emit: () => {}, emitActivity: () => {},
  };
}

let world: World;
const opencode = (model: string, extra: Partial<TurnInput> = {}): TurnInput => ({
  profile: { id: 'p', name: 'p', provider: 'opencode', model, effort: 'low', role: 'do', capabilities: [] },
  world, role: 'do', systemPrompt: 'system',
  messages: [{ id: 'm1', role: 'user', ts: 0, text: 'Create a task to benchmark the importer, and tell me when it is done.' }],
  resolvedAuth: { apiKey: 'sk-or-org', modelOptions: { provider: { zdr: true, quantizations: ['fp8'] } } },
  ...extra,
});
const chunk = (delta: unknown, finish: string | null = null, provider = 'DeepInfra') =>
  ({ id: 'gen', provider, model: 'xiaomi/mimo-v2.6-pro', choices: [{ index: 0, delta, finish_reason: finish }] });
const call = (id: string, name: string, args: unknown, provider?: string) => ({ sse: [
  chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null, provider),
  chunk({}, 'tool_calls', provider), { id: 'gen', choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }, '[DONE]'] });
const answer = (text: string, provider?: string) => ({ sse: [chunk({ content: text }, null, provider), chunk({}, 'stop', provider),
  { id: 'gen', choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }, '[DONE]'] });
const offeredChat = (body: any) => body.tools.map((tool: { function: { name: string } }) => tool.function.name).sort();

beforeAll(async () => {
  world = await new WorldRegistry().create('none', { taskId: 'task_ask_cost', base: 'main' });
});
afterAll(async () => { await world.destroy(); });

describe('Ask\'s own tool set', () => {
  it('is a small part of the platform tools, plus more_tools for the rest', () => {
    const all = COMPUTERLESS_TOOL_SCHEMAS.map((tool) => tool.name);
    for (const name of ASK_TOOL_NAMES) expect(all).toContain(name);
    expect(ASK_TOOL_NAMES.length).toBeLessThanOrEqual(26);
    const toolset = new AskToolset({});
    const offered = toolset.schemas().map((tool) => tool.name);
    expect(offered).toEqual([...ASK_TOOL_NAMES, 'more_tools']);
    const size = (names: string[]) => JSON.stringify(COMPUTERLESS_TOOL_SCHEMAS.filter((tool) => names.includes(tool.name))).length;
    expect(size(offered)).toBeLessThan(size(all) / 2);
  });

  it('more_tools lists the rest, turns on what is named, and never a world tool', async () => {
    const ran: string[] = [];
    const toolset = new AskToolset({ create_sub_task: async () => { ran.push('create_sub_task'); return 'ok'; } });
    const listing = await toolset.call('more_tools', {});
    expect(listing).toMatch(/create_sub_task/);
    expect(listing).toMatch(/request_credential/);
    expect(listing).not.toMatch(/\bplatform_request\b/);
    expect(await toolset.call('more_tools', { names: ['create_sub_task', 'start_job', 'bash'] })).toMatch(/Turned on: create_sub_task\..*start_job, bash/s);
    expect(toolset.schemas().map((tool) => tool.name)).toContain('create_sub_task');
    for (const name of WORLD_TOOL_NAMES) expect(toolset.schemas().map((tool) => tool.name)).not.toContain(name);
    expect(await toolset.call('create_sub_task', {})).toBe('ok');
    await expect(toolset.call('start_job', {})).rejects.toThrow(/unknown tool start_job/);
  });
});

describe('host-side rails of an Ask (stubbed model APIs)', () => {
  const api = stubModelApi();
  beforeAll(async () => {
    const base = await api.listen();
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

  it('OpenRouter: the cheapest provider first, then the one that answered for the rest of the turn', async () => {
    api.script([
      call('c1', 'search_tasks', { project_id: 'proj_1', query: 'importer' }, 'DeepInfra'),
      call('c2', 'more_tools', { names: ['create_sub_task'] }, 'DeepInfra'),
      answer('Done.', 'DeepInfra'),
    ]);
    const turn = await new AcpAdapter('opencode').runComputerlessTurn(opencode('openrouter/xiaomi/mimo-v2.6-pro'), context());
    expect(turn.output).toBe('Done.');
    const [first, second, third] = api.seen.map((seen) => seen.body);
    // The organization's routing (zero data retention, no 4-bit builds) is kept; price decides among those providers.
    expect(first.provider).toEqual({ zdr: true, quantizations: ['fp8'], sort: 'price' });
    expect(second.provider).toEqual({ zdr: true, quantizations: ['fp8'], sort: 'price', order: ['DeepInfra'], allow_fallbacks: true });
    expect(third.provider).toEqual(second.provider);
    expect(offeredChat(first)).toEqual([...ASK_TOOL_NAMES, 'more_tools'].sort());
    expect(offeredChat(third)).toContain('create_sub_task');
  });

  it('other Chat Completions vendors get no OpenRouter routing', async () => {
    api.script([answer('Hi.')]);
    await new AcpAdapter('opencode').runComputerlessTurn(opencode('openai/gpt-5-mini', { resolvedAuth: { apiKey: 'sk-openai' } }), context());
    expect(api.seen[0]!.path).toBe('/v1/chat/completions');
    expect(api.seen[0]!.body).not.toHaveProperty('provider');
  });

  it('Claude Messages API: Ask\'s tool set, and the prefix cached', async () => {
    api.script([{ json: { id: 'msg', type: 'message', role: 'assistant', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'text', text: 'Hi.' }] } }]);
    await new ClaudeAdapter().runComputerlessTurn(opencode('x', { profile: { id: 'p', name: 'p', provider: 'claude', model: 'claude-haiku-5-5', role: 'do', capabilities: [] },
      resolvedAuth: { apiKey: 'sk-ant' } }), context());
    const body = api.seen[0]!.body;
    expect(body.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([...ASK_TOOL_NAMES, 'more_tools'].sort());
  });

  it('OpenAI Responses API: Ask\'s tool set', async () => {
    api.script([{ json: { id: 'resp', status: 'completed', usage: { input_tokens: 1, output_tokens: 1 },
      output: [{ type: 'message', id: 'msg', content: [{ type: 'output_text', text: 'Hi.' }] }] } }]);
    await new CodexAdapter().runComputerlessTurn(opencode('x', { profile: { id: 'p', name: 'p', provider: 'codex', model: 'gpt-5.5', role: 'do', capabilities: [] },
      resolvedAuth: { apiKey: 'sk-test' } }), context());
    expect(api.seen[0]!.body.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([...ASK_TOOL_NAMES, 'more_tools'].sort());
  });
});

describe('the Ask prompt', () => {
  it('tells the agent to do only what was asked', () => {
    expect(NO_COMPUTER_WORLD).toMatch(/Do only what was asked/);
    const prompt = assemblePrompt({ profile: { id: 'p', name: 'p', provider: 'claude', role: 'do', capabilities: [] }, role: 'do',
      task: { taskId: 'task_1', projectId: 'proj_1', title: 'Ask', prompt: 'x', project: { repos: [] } } as never, world: world.handle });
    expect(prompt).toMatch(/Do only what was asked/);
  });
});

describe('an Ask thinks at low effort', () => {
  async function fixture() {
    const store = await Store.create(':memory:');
    const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const project = await store.createProject('Assistant', {}, organization.id);
    const authorization = await AuthorizationService.create(store);
    await authorization.bootstrapOrganizationOwner('system:test', 'owner', organization.id);
    const tokens = new TokenAuthority(store);
    const client = { workflow: { getHandle: () => ({ describe: async () => ({ status: { name: 'COMPLETED' } }), signal: async () => undefined }),
      start: async () => ({}) } } as any;
    const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, authorization });
    const owner = (await tokens.mintPrincipal('user:owner', await authorization.capabilities('user:owner', project.id, organization.id),
      project.id, undefined, organization.id)).token;
    // What the task's Do agent runs with, as pinned when it was queued.
    const effort = async (task: { id: string }) => (JSON.parse((await store.kvGet(`task-agents:${task.id}`)) ?? '{}').do as { effort?: string } | undefined)?.effort;
    return { api, project, owner, effort };
  }

  it('unless the task chose one; a task with a computer keeps its default', async () => {
    const f = await fixture();
    const ask = await f.api.createTask(f.owner, { projectId: f.project.id, workflow: 'software-dev', prompt: 'what waits on me?',
      params: { computer: { provider: 'none' } } });
    expect(await f.effort(ask)).toBe('low');
    const chosen = await f.api.createTask(f.owner, { projectId: f.project.id, workflow: 'software-dev', prompt: 'think hard',
      params: { computer: { provider: 'none' }, 'agent:do': { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' } } });
    expect(await f.effort(chosen)).toBe('high');
    const coding = await f.api.createTask(f.owner, { projectId: f.project.id, workflow: 'software-dev', prompt: 'code', params: {} });
    expect(await f.effort(coding)).not.toBe('low');
  });
});
