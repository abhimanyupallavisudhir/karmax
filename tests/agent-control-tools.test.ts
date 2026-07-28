import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MESSAGES_API_TOOLS, buildSdkTools } from '../src/agent/claude.js';
import { CodexAdapter, RESPONSES_API_TOOLS, codexDynamicTools, ensureLocalCodexSessionTools } from '../src/agent/codex.js';
import {
  CONTROL_SERVER_NAME,
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
 * These ten tools mutate the result of the activity that is running right now, so
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

const fakeTool = (name: string, description: string, shape: Record<string, any>, run: any) =>
  ({ name, description, shape, run });
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
  afterEach(() => {
    for (const bridge of bridges.splice(0)) bridge.close();
  });

  const rails: Rail[] = [
    // ── in-process / protocol-native rails ────────────────────────────────────
    { rail: 'claude messages API', names: async () => MESSAGES_API_TOOLS.map((t) => t.name) },
    { rail: 'claude agent SDK (local)', names: async () => buildSdkTools(fakeTool as any, z, allHandlers).map((d: any) => d.name) },
    {
      rail: 'claude agent SDK (remote world)',
      names: async () => buildSdkTools(fakeTool as any, z, allHandlers, PLATFORM_TOOL_SCHEMAS).map((d: any) => d.name),
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
  afterEach(() => {
    for (const bridge of bridges.splice(0)) bridge.close();
  });

  async function bridgeFor(ctx: any): Promise<ControlBridge> {
    const bridge = await startControlBridge(platformToolHandlers({} as any, ctx));
    bridges.push(bridge!);
    return bridge!;
  }

  it('routes a control tool call through the child MCP into THIS turn’s result', async () => {
    const recorded: any = {};
    const bridge = await bridgeFor({
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
    // Defensive parity with buildSdkTools: a handler map missing an entry must not
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
    bridge.close();
    expect(fs.existsSync(bridge.socketPath)).toBe(false);
    expect(fs.existsSync(path.dirname(bridge.socketPath))).toBe(false);
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

  it('rewrites a rollout’s session_meta so a resumed thread still advertises the controls', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-codex-home-'));
    const sessions = path.join(dir, 'sessions', '2026', '07');
    fs.mkdirSync(sessions, { recursive: true });
    const file = path.join(sessions, 'rollout-2026-07-27T10-00-00-thread-abc.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'thread-abc', cwd: '/w' } }),
      JSON.stringify({ type: 'response_item', payload: { role: 'user' } }),
    ].join('\n'));

    expect(ensureLocalCodexSessionTools(dir, 'thread-abc', codexDynamicTools(false))).toBe(true);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const meta = JSON.parse(lines[0]!);
    expect(meta.payload.id).toBe('thread-abc'); // pre-existing metadata preserved
    expect(meta.payload.dynamic_tools.map((t: any) => t.name).sort()).toEqual(CONTROL_NAMES);
    expect(JSON.parse(lines[1]!)).toMatchObject({ type: 'response_item' }); // history untouched
  });

  it('is best-effort: an unknown session or malformed rollout never fails the turn', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-codex-home-'));
    expect(ensureLocalCodexSessionTools(dir, 'missing', [])).toBe(false);
    const sessions = path.join(dir, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, 'rollout-thread-bad.jsonl'), 'not json\n');
    expect(ensureLocalCodexSessionTools(dir, 'thread-bad', [])).toBe(false);
  });
});
