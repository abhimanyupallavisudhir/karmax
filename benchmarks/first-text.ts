import http from 'node:http';
import os from 'node:os';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { runTurn } from '../src/agent/runtime.js';
import { ClaudeAdapter } from '../src/agent/claude.js';
import { CodexAdapter } from '../src/agent/codex.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxApi } from '../src/platform/api.js';
import type { AgentAdapter, TurnInput } from '../src/agent/types.js';

/**
 * Offline first-visible-text benchmark (LT-5, LT-16). A loopback provider
 * generates a reply at a fixed token rate: streamed when the request asks for
 * it, else returned whole once generation ends, as the real APIs do. Measures,
 * through the provider-neutral runtime, when the first and last agent.output
 * would be published and how many are published per turn; and how long task
 * creation takes to reach workflow.start while the advisory GitHub preflight
 * is slow. No network, no credentials, no spend. Run on two commits to compare.
 *
 *   npx tsx benchmarks/first-text.ts [repeats]
 */

const WORDS = 120, WORDS_PER_SECOND = 40, PERMISSION_MS = 250;
const reply = Array.from({ length: WORDS }, (_, i) => `word${i}`).join(' ');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1]!;

async function provider() {
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    const openai = req.url?.includes('/responses');
    const words = reply.split(' ');
    if (!body.stream) {
      await sleep((words.length / WORDS_PER_SECOND) * 1000);
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(openai
        ? { id: 'resp', status: 'completed', usage: { input_tokens: 10, output_tokens: WORDS }, output: [{ type: 'message', id: 'm', content: [{ type: 'output_text', text: reply }] }] }
        : { id: 'msg', type: 'message', role: 'assistant', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: WORDS }, content: [{ type: 'text', text: reply }] }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (event: any) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    if (openai) send({ type: 'response.created', response: { id: 'resp', status: 'in_progress', output: [] } });
    else {
      send({ type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 1 } } });
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    }
    for (const [i, word] of words.entries()) {
      await sleep(1000 / WORDS_PER_SECOND);
      const delta = (i ? ' ' : '') + word;
      if (openai) send({ type: 'response.output_text.delta', item_id: 'm', output_index: 0, content_index: 0, delta });
      else send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } });
    }
    if (openai) send({ type: 'response.completed', response: { id: 'resp', status: 'completed', usage: { input_tokens: 10, output_tokens: WORDS }, output: [{ type: 'message', id: 'm', content: [{ type: 'output_text', text: reply }] }] } });
    else {
      send({ type: 'content_block_stop', index: 0 });
      send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: WORDS } });
      send({ type: 'message_stop' });
    }
    res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, base: `http://127.0.0.1:${(server.address() as any).port}` };
}

async function turn(adapter: AgentAdapter, provider: 'claude' | 'codex') {
  const input: TurnInput = { profile: { id: 'p', name: 'p', provider, role: 'do', capabilities: [] } as any,
    world: { handle: { id: 'bench', root: os.tmpdir(), kind: 'memory' } } as any,
    messages: [{ id: 'm', role: 'user', text: 'go', ts: 0 }], role: 'do', systemPrompt: 'bench',
    resolvedAuth: { apiKey: 'offline' } };
  const started = performance.now();
  const outputs: number[] = [];
  await runTurn(input, { adapters: new Map([[provider, adapter]]), onEmit: () => { outputs.push(performance.now() - started); } });
  return { firstTextMs: Math.round(outputs[0]!), lastTextMs: Math.round(outputs.at(-1)!), turnMs: Math.round(performance.now() - started), outputEvents: outputs.length };
}

async function createToStart() {
  const store = await Store.create(':memory:');
  await store.claimPersonalOrganization('creator');
  const project = await store.createProject('Bench', { remote: 'pr', defaultBase: 'main', defaultTarget: 'main' } as any);
  const connection = await store.upsertGitConnection({ organizationId: project.organizationId!, provider: 'github', installationId: 'i', accountLogin: 'acme', accountType: 'Organization' });
  const repository = await store.upsertRepository({ organizationId: project.organizationId!, provider: 'github', providerId: 'r', owner: 'acme', name: 'widgets',
    sshUrl: 'git@github.com:acme/widgets.git', defaultBranch: 'main', private: true, gitConnectionId: connection.id });
  await store.attachProjectRepository({ projectId: project.id, repositoryId: repository.id });
  const tokens = new TokenAuthority();
  const token = (await tokens.mintPrincipal('user:creator', ['*'], project.id)).token;
  let startedAt = 0;
  const api = new KarmaxApi({ store, tokens, taskQueue: 'bench', client: { workflow: { start: async () => { startedAt = performance.now(); } } } as any,
    githubApp: { activeUserAccountId: async () => 'acct', repositoryPermission: async () => { await sleep(PERMISSION_MS); return { canMerge: false }; } } as any });
  const began = performance.now();
  await api.createTask(token, { projectId: project.id, workflow: 'software-dev', prompt: 'ship it' });
  const result = { toWorkflowStartMs: Math.round(startedAt - began), responseMs: Math.round(performance.now() - began) };
  await store.close();
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repeats = Number(process.argv[2] ?? 3);
  const { server, base } = await provider();
  process.env.KARMAX_ANTHROPIC_BASE_URL = base;
  process.env.KARMAX_OPENAI_BASE_URL = `${base}/v1`;
  const results: Record<string, any> = {};
  try {
    for (const [name, make, id] of [['anthropic-messages', () => new ClaudeAdapter(), 'claude'], ['openai-responses', () => new CodexAdapter(), 'codex']] as const) {
      const samples = [];
      for (let i = 0; i < repeats; i++) samples.push(await turn(make(), id));
      results[name] = Object.fromEntries(Object.keys(samples[0]!).map((key) => [key, median(samples.map((s: any) => s[key]))]));
    }
    const creates = [];
    for (let i = 0; i < repeats; i++) creates.push(await createToStart());
    results['create-with-slow-github-preflight'] = Object.fromEntries(Object.keys(creates[0]!).map((key) => [key, median(creates.map((s: any) => s[key]))]));
  } finally { server.close(); }
  console.log(JSON.stringify({ reply: `${WORDS} words at ${WORDS_PER_SECOND}/s`, githubPermissionMs: PERMISSION_MS, repeats, medians: results }, null, 2));
}
