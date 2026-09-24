import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ClaudeAdapter } from '../src/agent/claude.js';
import { CodexAdapter } from '../src/agent/codex.js';

// Real pinned harnesses, local model fixtures, fake credentials. Prove that a
// work command sees the project key but both surrounding model calls do not.
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

function directories() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-work-env-e2e-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'); const cwd = path.join(root, 'world');
  fs.mkdirSync(home); fs.mkdirSync(cwd);
  return { home, cwd };
}

const ctx: any = { emit() {}, emitActivity() {} };

describe('project environment versus model authentication', () => {
  it('Claude shell receives project secrets without changing subscription auth, including resume', async () => {
    const { home, cwd } = directories();
    const keys: string[] = [];
    const command = 'printf "%s" "$ANTHROPIC_API_KEY|$DATABASE_URL" > work-result.txt';
    const url = await fixture(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      if (!req.url?.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
        res.setHeader('content-type', 'application/json'); res.end('{}'); return;
      }
      const body = JSON.parse(raw);
      keys.push(String(req.headers.authorization ?? req.headers['x-api-key']));
      const done = keys.length % 2 === 0;
      const block = done ? { type: 'text', text: '' } : { type: 'tool_use', id: `call_${keys.length}`, name: 'Bash', input: {} };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [
        { type: 'message_start', message: { id: `msg_${keys.length}`, type: 'message', role: 'assistant', model: body.model,
          content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: block },
        { type: 'content_block_delta', index: 0, delta: done ? { type: 'text_delta', text: 'done' }
          : { type: 'input_json_delta', partial_json: JSON.stringify({ command }) } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: done ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 10 } },
        { type: 'message_stop' },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    const adapter = new ClaudeAdapter();
    let session: string | undefined;
    for (const value of ['project-first', 'project-rotated', '']) {
      const result = await adapter.runTurn({
        profile: { id: 'p', name: 'test', provider: 'claude', role: 'do', model: 'claude-opus-5-5', mcpConnections: [] },
        world: { handle: { id: 'work-env', root: cwd, base: 'main', branch: 'task' } },
        resolvedAuth: { configHome: home, oauthToken: 'sk-ant-oat01-fixture-subscription' },
        secretEnv: value ? { ANTHROPIC_API_KEY: value, DATABASE_URL: "db with ' quotes\nand $variables" } : {},
        extraEnv: { ANTHROPIC_BASE_URL: url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        systemPrompt: 'Run the requested command.', role: 'do', session,
        messages: [{ id: value, role: 'user', text: 'Run the work command now.', ts: 0 }],
      } as any, { ...ctx, signal: AbortSignal.timeout(45_000) });
      session = result.session;
      expect(result.output).toContain('done');
      expect(fs.readFileSync(path.join(cwd, 'work-result.txt'), 'utf8')).toBe(value ? `${value}|db with ' quotes\nand $variables` : '|');
      expect(fs.readdirSync(path.join(cwd, '.karmax-injection/work-env'))).toEqual([]);
    }
    expect(keys.length).toBeGreaterThanOrEqual(4);
    expect(new Set(keys)).toEqual(new Set(['Bearer sk-ant-oat01-fixture-subscription']));
  }, 90_000);

  it.each(['app-server', 'exec'])('Codex %s gives shell tools project keys without changing the model key', async (mode) => {
    const { home, cwd } = directories();
    const headers: string[] = [];
    let calls = 0;
    const url = await fixture(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      headers.push(String(req.headers.authorization));
      calls++;
      const body = JSON.parse(raw);
      const done = calls % 2 === 0;
      const item = done
        ? { id: `msg_${calls}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] }
        : { id: `fc_${calls}`, type: 'function_call', call_id: `call_${calls}`, name: 'exec_command',
          arguments: JSON.stringify({ cmd: 'printf "%s" "$OPENAI_API_KEY|$CODEX_API_KEY|$DATABASE_URL" > work-result.txt' }) };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [
        { type: 'response.created', response: { id: `resp_${calls}`, status: 'in_progress', output: [] } },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: `resp_${calls}`, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    fs.writeFileSync(path.join(home, 'config.toml'), `model_provider = "fixture"
model = "gpt-5.5"
[model_providers.fixture]
name = "Test fixture"
base_url = "${url}/v1"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "selected-model-credential"
`);
    const prior = process.env.KARMAX_CODEX_USE_EXEC;
    process.env.KARMAX_CODEX_USE_EXEC = mode === 'exec' ? '1' : '0';
    cleanups.push(() => { if (prior === undefined) delete process.env.KARMAX_CODEX_USE_EXEC; else process.env.KARMAX_CODEX_USE_EXEC = prior; });
    let session: string | undefined;
    for (const value of ['project-openai', 'project-rotated', '']) {
      const result = await new CodexAdapter().runTurn({
        profile: { id: 'p', name: 'test', provider: 'codex', role: 'do', model: 'gpt-5.5', mcpConnections: [] },
        world: { handle: { id: 'work-env', root: cwd, base: 'main', branch: 'task' } },
        resolvedAuth: { configHome: home },
        secretEnv: value ? { OPENAI_API_KEY: value, CODEX_API_KEY: 'project-codex', DATABASE_URL: 'project-db' } : {},
        systemPrompt: 'Run the requested command.', role: 'do', session,
        messages: [{ id: value, role: 'user', text: 'Run the work command.', ts: 0 }],
      } as any, { ...ctx, signal: AbortSignal.timeout(45_000) });
      session = result.session;
      expect(result.output).toContain('done');
      expect(fs.readFileSync(path.join(cwd, 'work-result.txt'), 'utf8')).toBe(value ? `${value}|project-codex|project-db` : '||');
      expect(fs.readdirSync(home).filter(name => name.startsWith('karmax-work-'))).toEqual([]);
    }
    expect(headers.length).toBeGreaterThanOrEqual(6);
    expect(new Set(headers)).toEqual(new Set(['Bearer selected-model-credential']));
    expect(fs.readdirSync(home).filter(name => name.startsWith('karmax-work-'))).toEqual([]);
  }, 90_000);
});
