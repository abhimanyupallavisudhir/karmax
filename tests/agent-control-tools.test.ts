import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MESSAGES_API_TOOLS, controlMcpServer } from '../src/agent/claude.js';
import { controlClient } from './helpers/control-server.js';
import { CodexAdapter, RESPONSES_API_TOOLS, codexDynamicTools, ensureLocalCodexSessionTools } from '../src/agent/codex.js';
import {
  CONTROL_SERVER_NAME,
  CONTROL_TOKEN_ENV,
  controlMcpServerSpec,
  startControlBridge,
  type ControlBridge,
} from '../src/agent/control-bridge.js';
import {
  PLATFORM_TOOL_SCHEMAS,
  SDK_CONTROL_TOOL_NAMES,
  TOOL_SCHEMAS,
  platformToolHandlers,
} from '../src/agent/tools.js';

/**
 * Cross-rail coverage for the TURN-LOCAL control tools (SDK_CONTROL_TOOL_NAMES).
 *
 * These eleven tools mutate the result of the activity that is running right now, so
 * they cannot be served by the durable gateway-backed `karmax` MCP — every rail has
 * to host them itself. Three rails silently did not: the Codex app-server outside a
 * remote world, `codex exec`, and every ACP harness (OpenCode/Kimi/Grok). On a Codex
 * **subscription** login or OpenCode that made the Resolve and Confirm gates
 * structurally unable to produce a verdict, while `prompt.ts` advertised the tools to
 * every agent regardless of provider.
 *
 * The table below reads each rail's OWN exported tool list (the same value the rail
 * hands the provider), so it fails the moment a new rail forgets — which is the point.
 */

const CONTROL_NAMES = [...SDK_CONTROL_TOOL_NAMES].sort();

/** A tool-name provider per rail. Async so socket-backed rails can be exercised
 *  end-to-end (spawn the real stdio MCP child and ask it for tools/list). */
type Rail = { rail: string; names: () => Promise<string[]> };

const allHandlers = Object.fromEntries(TOOL_SCHEMAS.map((t) => [t.name, async () => 'ok'])) as any;

/** Connect a real MCP client to the bridge's real child process. */
async function bridgeToolNames(bridge: ControlBridge): Promise<string[]> {
  const spec = controlMcpServerSpec(bridge);
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: spec.command, args: spec.args, env: { ...spec.env } });
  await client.connect(transport);
  try {
    return (await client.listTools()).tools.map((t) => t.name);
  } finally {
    await client.close();
  }
}

describe('turn-local control tools reach every rail', () => {
  const bridges: ControlBridge[] = [];
  afterEach(async () => {
    for (const bridge of bridges.splice(0)) (await bridge.close());
  });

  const rails: Rail[] = [
    // ── in-process / protocol-native rails ────────────────────────────────────
    { rail: 'claude messages API', names: async () => MESSAGES_API_TOOLS.map((t) => t.name) },
    { rail: 'claude agent SDK (local)', names: async () => (await controlClient(controlMcpServer(z, allHandlers))).names() },
    {
      rail: 'claude agent SDK (remote world)',
      names: async () => (await controlClient(controlMcpServer(z, allHandlers, PLATFORM_TOOL_SCHEMAS))).names(),
    },
    { rail: 'codex responses API', names: async () => RESPONSES_API_TOOLS.map((t) => t.name) },
    { rail: 'codex app-server (local)', names: async () => codexDynamicTools(false).map((t) => t.name) },
    { rail: 'codex app-server (remote world)', names: async () => codexDynamicTools(true).map((t) => t.name) },
    // ── stdio-MCP rails, served by the per-turn control bridge ────────────────
    {
      rail: 'codex exec / ACP (control bridge)',
      names: async () => {
        const bridge = await startControlBridge(platformToolHandlers({} as any, {} as any));
        expect(bridge, 'the control bridge must be available on this platform').toBeTruthy();
        bridges.push(bridge!);
        return bridgeToolNames(bridge!);
      },
    },
  ];

  it.each(rails)('$rail registers every turn-local control tool', async ({ names }) => {
    expect([...new Set(await names())].sort()).toEqual(expect.arrayContaining(CONTROL_NAMES));
  });
});

describe('control bridge (codex exec / ACP transport)', () => {
  const bridges: ControlBridge[] = [];
  afterEach(async () => {
    for (const bridge of bridges.splice(0)) (await bridge.close());
  });

  async function bridgeFor(ctx: any): Promise<ControlBridge> {
    const bridge = await startControlBridge(platformToolHandlers({} as any, ctx));
    bridges.push(bridge!);
    return bridge!;
  }

  it('routes a control tool call through the child MCP into THIS turn’s result', async () => {
    const recorded: any = {};
    const bridge = await bridgeFor({
      openPr: () => { recorded.openPr = true; },
      confirmDecision: (d: any) => { recorded.confirm = d; },
      createReviewInfo: (info: any) => { recorded.review = info; },
      emit() {}, emitActivity() {},
    });

    const spec = controlMcpServerSpec(bridge);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: spec.command, args: spec.args, env: { ...spec.env } }));
    try {
      const confirmed: any = await client.callTool({ name: 'confirm_decision', arguments: { action: 'revise', text: 'add tests' } });
      expect(confirmed.content[0].text).toBe('confirm decision recorded: revise');
      // The whole point: the handler ran INSIDE this activity and mutated its result.
      expect(recorded.confirm).toEqual({ action: 'revise', text: 'add tests' });

      const review: any = await client.callTool({ name: 'create_review_info', arguments: { caption: 'run the suite' } });
      expect(review.content[0].text).toBe('review info recorded');
      expect(recorded.review).toMatchObject({ caption: 'run the suite' });

      const opened: any = await client.callTool({ name: 'open_pr', arguments: {} });
      expect(opened.content[0].text).toMatch(/pull request requested/i);
      expect(recorded.openPr).toBe(true);

      // The nested `actions` schema survives the hop verbatim (no zod round trip).
      const listed = await client.listTools();
      const actions: any = listed.tools.find((t) => t.name === 'create_review_info')!.inputSchema.properties!.actions;
      expect(actions.items.properties.kind.enum).toEqual(['run', 'open']);

      // A durable, gateway-backed tool must NOT gain a second token-less door here.
      const denied: any = await client.callTool({ name: 'platform_request', arguments: { method: 'GET', path: '/api/tasks' } });
      expect(denied.isError).toBe(true);
      expect(denied.content[0].text).toMatch(/unknown control tool/i);
    } finally {
      await client.close();
    }
  });

  it('serves only the controls whose handler this turn actually has', async () => {
    // Defensive parity with controlMcpServer: a handler map missing an entry must not
    // advertise that tool, so the model can never call a door that isn't wired.
    const handlers: any = platformToolHandlers({} as any, { emit() {}, emitActivity() {} } as any);
    delete handlers.confirm_decision;
    const bridge = (await startControlBridge(handlers))!;
    bridges.push(bridge);
    expect(bridge.tools.map((t) => t.name)).toContain('signal_completion');
    expect(bridge.tools.map((t) => t.name)).not.toContain('confirm_decision');
    expect(await bridgeToolNames(bridge)).not.toContain('confirm_decision');
  });

  it('does not outlive the turn: close() drops the socket and its directory', async () => {
    const bridge = await bridgeFor({ signalCompletion() {}, emit() {}, emitActivity() {} });
    expect(fs.existsSync(bridge.socketPath)).toBe(true);
    (await bridge.close());
    expect(fs.existsSync(bridge.socketPath)).toBe(false);
    expect(fs.existsSync(path.dirname(bridge.socketPath))).toBe(false);
  });
});

/**
 * The bridge socket is NOT isolation between agents.
 *
 * Every karmax agent's harness (`codex exec`, ACP) is spawned host-side by the same
 * uid, so the 0700 temp dir and 0600 socket exclude other unix *users* and nobody
 * else. Agent A's ordinary `bash` tool can list `os.tmpdir()`, find agent B's live
 * `kx-ctl-*` socket and speak the NDJSON protocol at it. Three of the eleven control
 * tools reach past this turn — `request_spend` allocates budget, `fill_payment_card`
 * types a real PAN/CVC over CDP, `create_sub_task` creates a durable task — so an
 * unauthenticated socket is a cross-agent hijack of B's turn, not a cosmetic gap.
 * The per-turn token is what makes it a private channel.
 */
describe('control bridge rejects a second agent on the same host', () => {
  const bridges: ControlBridge[] = [];
  afterEach(async () => {
    for (const bridge of bridges.splice(0)) (await bridge.close());
  });

  /** A hostile client: raw NDJSON straight at the socket, no child MCP involved. */
  function attacker(socketPath: string) {
    const socket = net.createConnection(socketPath);
    socket.setEncoding('utf8');
    const lines: string[] = [];
    const waiters: ((line: string) => void)[] = [];
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const waiter = waiters.shift();
        if (waiter) waiter(line);
        else lines.push(line);
      }
    });
    const ready = new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });
    return {
      ready,
      close: () => socket.destroy(),
      async send(frame: Record<string, unknown>): Promise<any> {
        await ready;
        const reply = new Promise<string>((resolve, reject) => {
          const buffered = lines.shift();
          if (buffered) { resolve(buffered); return; }
          waiters.push(resolve);
          // The bridge may also answer an unauthorized frame by hanging up; a
          // dropped connection is a refusal too, not a test hang.
          socket.once('close', () => reject(new Error('closed')));
          setTimeout(() => reject(new Error('timeout')), 5_000).unref();
        });
        socket.write(`${JSON.stringify(frame)}\n`);
        return JSON.parse(await reply.catch(() => '{"ok":false,"error":"connection dropped"}'));
      },
    };
  }

  async function victimTurn(): Promise<{ bridge: ControlBridge; recorded: any }> {
    const recorded: any = {};
    const bridge = (await startControlBridge(platformToolHandlers({} as any, {
      confirmDecision: (d: any) => { recorded.confirm = d; },
      emit() {}, emitActivity() {},
    } as any)))!;
    bridges.push(bridge);
    return { bridge, recorded };
  }

  it('the premise: another same-uid process can find and open the socket', async () => {
    const { bridge } = await victimTurn();
    // This is the enumeration agent A's bash tool would do.
    const found = fs.readdirSync(os.tmpdir())
      .filter((entry) => entry.startsWith('kx-ctl-'))
      .flatMap((entry) => {
        const dir = path.join(os.tmpdir(), entry);
        try { return fs.readdirSync(dir).map((f) => path.join(dir, f)); } catch { return []; }
      });
    expect(found).toContain(bridge.socketPath);
    const client = attacker(bridge.socketPath);
    await expect(client.ready).resolves.toBeUndefined();
    client.close();
  });

  it('refuses a call with no token, and the victim turn is not mutated', async () => {
    const { bridge, recorded } = await victimTurn();
    const client = attacker(bridge.socketPath);
    try {
      const reply = await client.send({ id: 1, op: 'call', name: 'confirm_decision', args: { action: 'confirm' } });
      expect(reply.ok).not.toBe(true);
      expect(String(reply.error)).toMatch(/unauthorized/i);
      expect(recorded.confirm).toBeUndefined();
    } finally {
      client.close();
    }
  });

  it('refuses `list` with no token — the tool surface is not even enumerable', async () => {
    const { bridge } = await victimTurn();
    const client = attacker(bridge.socketPath);
    try {
      const reply = await client.send({ id: 1, op: 'list' });
      expect(reply.ok).not.toBe(true);
      expect(reply.tools).toBeUndefined();
    } finally {
      client.close();
    }
  });

  it('refuses a wrong token without leaking the expected one', async () => {
    const { bridge, recorded } = await victimTurn();
    const client = attacker(bridge.socketPath);
    try {
      const guess = 'a'.repeat(bridge.token.length); // same length: no length oracle
      const reply = await client.send({ id: 1, token: guess, op: 'call', name: 'confirm_decision', args: { action: 'confirm' } });
      expect(reply.ok).not.toBe(true);
      expect(JSON.stringify(reply)).not.toContain(bridge.token);
      expect(recorded.confirm).toBeUndefined();
    } finally {
      client.close();
    }
  });

  it('refuses the real child MCP when it is pointed at a socket it has no token for', async () => {
    const { bridge, recorded } = await victimTurn();
    const spec = controlMcpServerSpec(bridge);
    // Exactly what agent A can do: run karmax's own child script against B's socket.
    // A knows the path (it enumerated /tmp) but not B's per-turn token.
    const stolen = { ...spec.env };
    delete stolen[CONTROL_TOKEN_ENV];
    const client = new Client({ name: 'attacker', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: spec.command, args: spec.args, env: stolen }));
    try {
      expect((await client.listTools()).tools).toEqual([]);
      const hijack: any = await client.callTool({ name: 'confirm_decision', arguments: { action: 'confirm' } });
      expect(hijack.isError).toBe(true);
      expect(recorded.confirm).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it('the legitimate child — same socket, with the token — still works end to end', async () => {
    const { bridge, recorded } = await victimTurn();
    const spec = controlMcpServerSpec(bridge);
    expect(spec.env[CONTROL_TOKEN_ENV]).toBe(bridge.token);
    expect(bridge.token).toMatch(/^[0-9a-f]{64}$/); // 32 unguessable bytes
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: spec.command, args: spec.args, env: { ...spec.env } }));
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(CONTROL_NAMES));
      const ok: any = await client.callTool({ name: 'confirm_decision', arguments: { action: 'confirm' } });
      expect(ok.content[0].text).toBe('confirm decision recorded: confirm');
      expect(recorded.confirm).toEqual({ action: 'confirm' });
    } finally {
      await client.close();
    }
  });

  it('gives every turn a distinct token', async () => {
    const a = await victimTurn();
    const b = await victimTurn();
    expect(a.bridge.token).not.toBe(b.bridge.token);
  });
});

/**
 * `codex exec` is a one-shot subprocess with no dynamic-tool control channel, so the
 * bridge is registered as an stdio MCP server through `-c` config overrides. The stub
 * records the argv it was launched with and probes the socket while it runs.
 */
const EXEC_STUB = `#!/usr/bin/env node
const fs = require('fs');
const argv = process.argv.slice(2);
const oi = argv.indexOf('-o');
const outFile = oi >= 0 ? argv[oi + 1] : null;
const socket = (argv.find((a) => a.startsWith('mcp_servers.karmax_control.env.KARMAX_CONTROL_SOCKET=')) || '').split('=').slice(1).join('=');
fs.writeFileSync(process.env.STUB_ARGV_OUT, JSON.stringify({
  argv,
  socket: socket ? JSON.parse(socket) : null,
  socketLive: socket ? fs.existsSync(JSON.parse(socket)) : false,
}));
if (outFile) fs.writeFileSync(outFile, 'done');
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'th_stub' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');
process.exit(0);
`;

describe('codex exec registers the control bridge as an MCP server', () => {
  let dir: string | undefined;
  afterEach(() => {
    delete process.env.KARMAX_CODEX_EXEC_CMD;
    delete process.env.KARMAX_CODEX_USE_EXEC;
    delete process.env.STUB_ARGV_OUT;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('passes command/args/socket via -c overrides and tears the socket down after the turn', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-codex-control-'));
    const stub = path.join(dir, 'codex-stub.cjs');
    fs.writeFileSync(stub, EXEC_STUB);
    fs.chmodSync(stub, 0o755);
    process.env.KARMAX_CODEX_EXEC_CMD = stub;
    process.env.KARMAX_CODEX_USE_EXEC = '1';
    process.env.STUB_ARGV_OUT = path.join(dir, 'argv.json');

    await new CodexAdapter().runTurn({
      profile: { id: 'p', name: 'c', provider: 'codex', model: 'gpt-5.5', role: 'do', capabilities: [] },
      world: { handle: { id: 'w', root: dir, branch: 'b', base: 'main' } },
      messages: [{ id: 'm', role: 'user', text: 'go', ts: 0 }],
      systemPrompt: 'Work.',
      role: 'do',
      resolvedAuth: { configHome: dir },
    } as any, { emit() {}, emitActivity() {} } as any);

    const record = JSON.parse(fs.readFileSync(process.env.STUB_ARGV_OUT!, 'utf8'));
    const overrides = record.argv.filter((a: string) => a.startsWith(`mcp_servers.${CONTROL_SERVER_NAME}.`));
    expect(overrides).toEqual(expect.arrayContaining([
      `mcp_servers.${CONTROL_SERVER_NAME}.command=${JSON.stringify(process.execPath)}`,
      expect.stringMatching(/^mcp_servers\.karmax_control\.args=\[".*control-mcp\.mjs"\]$/),
      expect.stringMatching(/^mcp_servers\.karmax_control\.env\.KARMAX_CONTROL_SOCKET="/),
      // The socket path is reachable by every same-uid agent on this host, so the
      // per-turn token has to ride the same `-c` env channel or `codex exec`'s
      // child cannot authenticate (control-bridge.ts security notes).
      expect.stringMatching(/^mcp_servers\.karmax_control\.env\.KARMAX_CONTROL_TOKEN="[0-9a-f]{64}"$/),
    ]));
    // Live while codex ran…
    expect(record.socketLive).toBe(true);
    // …and gone once the turn ended (it carries no token, but it must not linger).
    expect(fs.existsSync(record.socket)).toBe(false);
  });
});

describe('codex app-server dynamic-tool persistence across resume', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('migrates tools into a new identity without changing source history', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-codex-home-'));
    const sessions = path.join(dir, 'sessions', '2026', '07');
    fs.mkdirSync(sessions, { recursive: true });
    const file = path.join(sessions, 'rollout-2026-07-27T10-00-00-thread-abc.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'thread-abc', cwd: '/w' } }),
      JSON.stringify({ type: 'response_item', payload: { role: 'user' } }),
    ].join('\n') + '\n');

    const original = fs.readFileSync(file);
    const session = await ensureLocalCodexSessionTools(dir, 'thread-abc', codexDynamicTools(false));
    expect(session).toBeTruthy();
    expect(fs.readFileSync(file)).toEqual(original);
    expect(await ensureLocalCodexSessionTools(dir, session!, codexDynamicTools(false))).toBe(session);
    const lines = fs.readFileSync(path.join(dir, 'sessions', 'forked', fs.readdirSync(path.join(dir, 'sessions', 'forked')).find((name) => name.endsWith(`${session}.jsonl`))!), 'utf8').split('\n');
    const meta = JSON.parse(lines[0]!);
    expect(meta.payload.id).toBe(session);
    expect(meta.payload.cwd).toBe('/w');
    expect(meta.payload.dynamic_tools.map((t: any) => t.name).sort()).toEqual(CONTROL_NAMES);
    expect(JSON.parse(lines[1]!)).toMatchObject({ type: 'response_item' }); // history untouched
  });

  it('rejects unknown sessions and malformed histories before a turn', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-codex-home-'));
    await expect(ensureLocalCodexSessionTools(dir, 'missing-session', [])).rejects.toThrow('missing source');
    const sessions = path.join(dir, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, 'rollout-thread-bad.jsonl'), 'not json\n');
    await expect(ensureLocalCodexSessionTools(dir, 'thread-bad', [])).rejects.toThrow('invalid JSONL');
  });
});
