/** Real shipped Claude SDK + CLI against a local Messages fixture: no paid calls. */
import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

it('Claude 2.1.280 preserves SDK tools, explicit effort, resume and fork', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-sdk-compat-'));
  const requests: any[] = [];
  const calls: string[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (!req.url?.startsWith('/v1/messages')) { res.writeHead(200); res.end('{}'); return; }
    const body = JSON.parse(raw);
    if (req.url.includes('count_tokens')) { res.end(JSON.stringify({ input_tokens: 10 })); return; }
    requests.push(body);
    const callTool = requests.length === 1;
    const block = callTool
      ? { type: 'tool_use', id: 'tool_fixture', name: 'mcp__compat__echo', input: { text: 'compat-marker' } }
      : { type: 'text', text: 'compat-complete' };
    const message = { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: body.model,
      content: [block], stop_reason: callTool ? 'tool_use' : 'end_turn', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 } };
    if (!body.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(message)); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
      { type: 'content_block_start', index: 0, content_block: callTool ? { ...block, input: {} } : { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: callTool
        ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
        : { type: 'text_delta', text: block.text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const run = async (resume?: string, forkSession = false) => {
      const mcp = createSdkMcpServer({ name: 'compat', tools: [tool('echo', 'Echo a test marker', { text: z.string() }, async ({ text }) => {
        calls.push(text); return { content: [{ type: 'text' as const, text }] };
      })] });
      const messages: any[] = [];
      const session = query({ prompt: 'compat-marker', options: {
        cwd: home, model: 'claude-opus-5-5', effort: 'high', resume, forkSession,
        tools: [], mcpServers: { compat: mcp }, strictMcpConfig: true,
        canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }),
        abortController: controller, settingSources: [],
        env: { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: home,
          ANTHROPIC_API_KEY: 'local-fixture-only', ANTHROPIC_BASE_URL: base,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      } });
      try { for await (const message of session) messages.push(message); }
      finally { session.close(); }
      expect(messages.at(-1)).toMatchObject({ type: 'result', subtype: 'success', is_error: false });
      return messages.at(-1).session_id as string;
    };
    const original = await run();
    expect(calls).toEqual(['compat-marker']);
    expect(await run(original)).toBe(original);
    expect(await run(original, true)).not.toBe(original);
    expect(requests).toHaveLength(4);
    for (const body of requests) {
      expect(body.model).toBe('claude-opus-5-5');
      expect(body.output_config?.effort).toBe('high');
    }
    expect(JSON.stringify(requests.at(-1).messages)).toContain('tool_fixture');
    expect(JSON.stringify(requests.at(-1).messages)).toContain('compat-complete');
  } finally {
    clearTimeout(timer); controller.abort(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 60_000);
