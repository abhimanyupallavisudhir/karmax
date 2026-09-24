/** Real shipped Claude SDK + CLI against a local Messages fixture: no paid calls. */
import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import crypto from 'node:crypto';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

it('Claude 2.1.281 preserves SDK tools, explicit effort, resume and fork', async () => {
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

// Task #348: a Temporal retry kills the harness while a `run_in_background` shell runs,
// then resumes the session. Claude Code settles that orphan first and emits an empty
// `result` before it handles the resumed prompt, so only `session_state_changed: idle`
// ends the turn (src/agent/claude.ts). SDK 0.3.280 also dropped SDK MCP servers on this
// path, leaving every `karmax_control` tool "no longer available".
it('Claude keeps SDK tools when resuming a session orphaned with a background shell', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-sdk-orphan-'));
  const calls: string[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (!req.url?.startsWith('/v1/messages')) { res.writeHead(200); res.end('{}'); return; }
    if (req.url.includes('count_tokens')) { res.end(JSON.stringify({ input_tokens: 10 })); return; }
    const body = JSON.parse(raw);
    const text = JSON.stringify(body.messages.filter((m: any) => m.role === 'user').at(-1));
    const bash = (command: string, background: boolean) => ({ type: 'tool_use', id: `tool_${command.replace(/\W/g, '')}`,
      name: 'Bash', input: { command, description: command, ...(background ? { run_in_background: true } : {}) } });
    const block = text.includes('orphan-start') ? bash('sleep 600', true)
      : text.includes('toolsleep600') ? bash('sleep 60', false)
        : text.includes('resume-marker') ? { type: 'tool_use', id: 'tool_echo', name: 'mcp__compat__echo', input: { text: 'resumed-call' } }
          : { type: 'text', text: 'done' };
    const stop = block.type === 'tool_use' ? 'tool_use' : 'end_turn';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { type: 'message_start', message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: body.model,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } } },
      { type: 'content_block_start', index: 0, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: block.type === 'tool_use'
        ? { type: 'input_json_delta', partial_json: JSON.stringify((block as any).input) }
        : { type: 'text_delta', text: (block as any).text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const options = (abortController: AbortController, resume?: string) => ({
    cwd: home, model: 'claude-opus-5-5', resume, tools: ['Bash'], strictMcpConfig: true, settingSources: [],
    mcpServers: { compat: createSdkMcpServer({ name: 'compat', tools: [tool('echo', 'Echo a test marker', { text: z.string() }, async ({ text }) => {
      calls.push(text); return { content: [{ type: 'text' as const, text }] };
    })] }) },
    canUseTool: async (_name: string, input: any) => ({ behavior: 'allow' as const, updatedInput: input }),
    abortController,
    env: { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: home,
      ANTHROPIC_API_KEY: 'local-fixture-only', ANTHROPIC_BASE_URL: base,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' },
  });
  try {
    // The first harness dies mid-command with its background shell still running.
    const killed = new AbortController();
    let session = '';
    const first = query({ prompt: 'orphan-start', options: options(killed) as any });
    await expect((async () => {
      for await (const m of first as AsyncIterable<any>) {
        session ||= m.session_id ?? '';
        if (m.type === 'assistant' && JSON.stringify(m).includes('sleep 60')) setTimeout(() => killed.abort(), 1000);
      }
    })()).rejects.toThrow();
    expect(session).toBeTruthy();

    // The resumed harness: keep input open, as the adapter does, until it reports idle
    // having answered our prompt (the orphan-settling pass may report idle before that).
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    async function* prompt() {
      yield { type: 'user', message: { role: 'user', content: 'resume-marker' }, parent_tool_use_id: null, uuid: promptId };
      await held;
    }
    const events: string[] = [];
    const promptId = crypto.randomUUID();
    let answered = false;
    let inventory: any[] = []; // the orphan-settling pass may report its own, earlier init
    const resumed = query({ prompt: prompt() as any, options: options(new AbortController(), session) as any });
    const timer = setTimeout(release, 45_000);
    try {
      for await (const m of resumed as AsyncIterable<any>) {
        if (m.type === 'system' && m.subtype === 'init') inventory = m.mcp_servers;
        if (m.type === 'assistant' && m.user_message_uuids?.includes(promptId)) answered = true;
        if (m.type === 'result') events.push(answered ? 'result' : 'early-result');
        if (m.type === 'system' && m.subtype === 'session_state_changed' && m.state === 'idle' && answered) release();
      }
    } finally { clearTimeout(timer); resumed.close(); }
    expect(inventory).toContainEqual(expect.objectContaining({ name: 'compat', status: 'connected' }));
    expect(calls).toEqual(['resumed-call']);
    expect(events).toEqual(['early-result', 'result']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 90_000);
