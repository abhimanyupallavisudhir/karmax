import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { CodexAdapter } from '../src/agent/codex.js';

// The pinned Codex app-server and the real adapter; only the model's Responses
// endpoint is a fixture. Subscription (app-server) turns once reported no usage,
// so every GPT turn showed 0 tokens in Insights. Resuming a thread also replays
// the previous turn's reading, which must not be counted again.
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('reports each subscription turn\'s own provider-reported tokens, across a resumed thread', async () => {
  let request = 0;
  const model = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    request++;
    const message = { id: `msg_${request}`, type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: `reply ${request}`, annotations: [] }] };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const event of [
      { type: 'response.created', response: { id: `resp_${request}`, status: 'in_progress', output: [] } },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response: { id: `resp_${request}`, status: 'completed', output: [message],
        usage: { input_tokens: 1000 * request, input_tokens_details: { cached_tokens: 600 * request },
          output_tokens: 40 * request, output_tokens_details: { reasoning_tokens: 10 }, total_tokens: 1040 * request } } },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => { model.closeAllConnections(); model.close(() => resolve()); }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-codex-usage-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const root = path.join(dir, 'world');
  fs.mkdirSync(home); fs.mkdirSync(root);
  fs.writeFileSync(path.join(home, 'config.toml'), `model_provider = "fixture"
model = "gpt-5.5"
[model_providers.fixture]
name = "Local test response"
base_url = "http://127.0.0.1:${(model.address() as { port: number }).port}/v1"
wire_api = "responses"
requires_openai_auth = false
`);
  const turn = (session: string | undefined, text: string) => new CodexAdapter().runTurn({
    world: { handle: { id: 'w', root, branch: 'task', base: 'main' } }, ...(session ? { session } : {}),
    profile: { id: 'p', name: 'codex', provider: 'codex', role: 'do', capabilities: [], model: 'gpt-5.5' },
    resolvedAuth: { configHome: home },
    messages: [{ id: text, role: 'user', text, ts: 0 }], systemPrompt: 'Reply briefly.', role: 'do',
  } as any, { emit() {}, emitActivity() {} } as any);

  const first = await turn(undefined, 'Begin.');
  expect(first.output).toContain('reply 1');
  expect(first.usage).toEqual({ inputTokens: 1000, cacheReadTokens: 600, outputTokens: 40,
    inputTokensIncludeCacheRead: true, totalTokens: 1040 });

  const resumed = await turn(first.session, 'Continue.');
  expect(resumed.session).toBe(first.session);
  expect(resumed.output).toContain('reply 2');
  expect(resumed.usage).toEqual({ inputTokens: 2000, cacheReadTokens: 1200, outputTokens: 80,
    inputTokensIncludeCacheRead: true, totalTokens: 2080 });
}, 90_000);
