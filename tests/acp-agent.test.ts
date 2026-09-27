import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcpAdapter } from '../src/agent/acp.js';
import { AttachmentStore } from '../src/store/attachments.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
);

const STUB = `#!/usr/bin/env node
const fs = require('fs');
const readline = require('readline');
const out = process.env.STUB_REQUESTS_OUT;
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
const record = (value) => out && fs.appendFileSync(out, JSON.stringify(value) + '\\n');
record({ env: {
  KIMI_API_KEY: process.env.KIMI_API_KEY,
  DATABASE_URL: process.env.DATABASE_URL,
  KIMI_MODEL_API_KEY: process.env.KIMI_MODEL_API_KEY,
  KIMI_MODEL_NAME: process.env.KIMI_MODEL_NAME,
  KIMI_MODEL_BASE_URL: process.env.KIMI_MODEL_BASE_URL,
  OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  XAI_API_KEY: process.env.XAI_API_KEY,
  GROK_HOME: process.env.GROK_HOME,
  KARMAX_CUSTODY_CHAIN: process.env.KARMAX_CUSTODY_CHAIN,
} });
let pendingPrompt;
let terminalId;
const finish = () => {
  send({ jsonrpc: '2.0', method: 'session/update', params: {
    sessionId: 'session-new',
    update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed' },
  } });
  send({ jsonrpc: '2.0', method: 'session/update', params: {
    sessionId: 'session-new',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'do' } },
  } });
  send({ jsonrpc: '2.0', method: 'session/update', params: {
    sessionId: 'session-new',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ne' } },
  } });
  send({ jsonrpc: '2.0', id: pendingPrompt, result: { stopReason: process.env.STUB_STOP_REASON || 'end_turn' } });
};
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const msg = JSON.parse(line);
  record(msg);
  if (msg.method === 'initialize' && process.env.OPENCODE_CONFIG_CONTENT) {
    const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
    for (const url of config.plugin || []) {
      const plugin = await (await import(url)).default();
      const output = { env: {} };
      await plugin['shell.env']({}, output);
      record({ nativeShellEnv: output.env });
    }
  }
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true },
      sessionCapabilities: { resume: {}, fork: {} },
    },
    authMethods: [{
      id: process.env.KIMI_MODEL_API_KEY ? 'login' : process.env.XAI_API_KEY ? 'xai.api_key' : 'cached_token',
      name: 'Non-interactive login',
    }],
    agentInfo: { name: 'fake-acp', version: '1' },
  } });
  else if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: {
    sessionId: 'session-new',
    configOptions: [
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'kimi/old', options: [{ value: 'kimi/k3', name: 'Kimi K3' }] },
      { id: 'thought', name: 'Thought level', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'high', name: 'High' }] },
    ],
  } });
  else if (msg.method === 'authenticate') send({ jsonrpc: '2.0', id: msg.id, result: {} });
  else if (msg.method === 'session/resume' || msg.method === 'session/load')
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  else if (msg.method === 'session/fork')
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'session-forked' } });
  else if (msg.method === 'session/set_config_option')
    send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: [] } });
  else if (msg.method === 'session/cancel') {
    // Steer-driven cancellation: resolve the in-flight prompt as cancelled.
    if (pendingPrompt) { send({ jsonrpc: '2.0', id: pendingPrompt, result: { stopReason: 'cancelled' } }); pendingPrompt = undefined; }
  }
  else if (msg.method === 'session/prompt') {
    pendingPrompt = msg.id;
    if (process.env.STUB_AWAIT_CANCEL) return; // run long; wait for a steer-driven session/cancel
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: msg.params.sessionId,
      update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Edit file', kind: 'edit', status: 'pending' },
    } });
    send({ jsonrpc: '2.0', id: 900, method: 'session/request_permission', params: {
      sessionId: msg.params.sessionId,
      toolCall: { toolCallId: 'tool-1', title: 'Edit file', kind: 'edit', status: 'pending' },
      options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
    } });
  } else if (msg.id === 900) {
    send({ jsonrpc: '2.0', id: 901, method: 'terminal/create', params: {
      sessionId: 'session-new',
      command: process.execPath,
      args: ['-e', 'process.stdout.write("terminal-ok:" + (process.env.KARMAX_CUSTODY_CHAIN || "") + ":work:" + (process.env.DATABASE_URL || "") + ":" + (process.env.XAI_API_KEY || ""))'],
      outputByteLimit: 1024,
    } });
  } else if (msg.id === 901) {
    terminalId = msg.result.terminalId;
    send({ jsonrpc: '2.0', id: 902, method: 'terminal/wait_for_exit', params: { sessionId: 'session-new', terminalId } });
  } else if (msg.id === 902) {
    send({ jsonrpc: '2.0', id: 903, method: 'terminal/output', params: { sessionId: 'session-new', terminalId } });
  } else if (msg.id === 903) {
    send({ jsonrpc: '2.0', id: 904, method: 'terminal/release', params: { sessionId: 'session-new', terminalId } });
  } else if (msg.id === 904) {
    finish();
  }
});
`;

describe('generic ACP agent adapter', () => {
  let dir: string | undefined;

  afterEach(() => {
    delete process.env.KARMAX_OPENCODE_CMD;
    delete process.env.KARMAX_KIMI_CMD;
    delete process.env.KARMAX_GROK_CMD;
    delete process.env.STUB_REQUESTS_OUT;
    delete process.env.STUB_STOP_REASON;
    delete process.env.STUB_AWAIT_CANCEL;
    delete process.env.KARMAX_HOME;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function run(opts: {
    hugeOutput?: boolean;
    subscription?: boolean;
    secretEnv?: Record<string, string>;
    session?: string;
    fork?: boolean;
    image?: boolean;
    provider?: 'opencode' | 'kimi' | 'grok';
    model?: string;
    modelProvider?: string;
    pullFollowUps?: (from: number) => Promise<any[]>;
  } = {}) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-acp-'));
    const stub = path.join(dir, 'agent.cjs');
    const requests = path.join(dir, 'requests.jsonl');
    fs.writeFileSync(stub, opts.hugeOutput ? STUB.replace('outputByteLimit: 1024', 'outputByteLimit: 1e12').replace('process.stdout.write("terminal-ok:"', 'process.stdout.write("x".repeat(2 * 1024 * 1024) + "terminal-ok:"') : STUB);
    fs.chmodSync(stub, 0o755);
    process.env.KARMAX_OPENCODE_CMD = stub;
    process.env.KARMAX_KIMI_CMD = stub;
    process.env.KARMAX_GROK_CMD = stub;
    process.env.STUB_REQUESTS_OUT = requests;
    process.env.KARMAX_HOME = path.join(dir, 'karmax-home');
    const output: string[] = [];
    const activities: any[] = [];
    const provider = opts.provider ?? 'opencode';
    const modelProvider = opts.modelProvider ?? (provider === 'grok' ? 'xai' : 'kimi');
    const model = opts.model ?? (provider === 'grok' ? 'grok-build' : 'kimi/k3');
    const image = opts.image ? new AttachmentStore().put(PNG, 'image/png') : undefined;
    const turn = await new AcpAdapter(provider).runTurn({
      profile: {
        id: 'p', name: 'Agent', provider, modelProvider,
        model, effort: 'high', maxTurns: 7, role: 'do',
      },
      world: { handle: { id: 'w', root: dir, branch: 'task', base: 'main' } },
      messages: [{ id: 'm', role: 'user', text: 'make it beautiful', ts: 0, ...(image ? { images: [image] } : {}) }],
      systemPrompt: 'Work carefully.',
      role: 'do',
      resolvedAuth: { ...(opts.subscription ? {} : { apiKey: 'secret-kimi-key' }), configHome: path.join(dir, 'home') },
      secretEnv: opts.secretEnv,
      extraEnv: { KARMAX_TOKEN: 'scoped-token' },
      agentMcp: [{ name: 'extra', command: process.execPath, args: ['server.js'] }],
      ...(opts.session ? { session: opts.session } : {}),
      ...(opts.fork ? { fork: true } : {}),
    } as any, {
      emit(text: string) { output.push(text); },
      emitActivity(activity: any) { activities.push(activity); },
      onSession() {},
      ...(opts.pullFollowUps ? { pullFollowUps: opts.pullFollowUps } : {}),
    } as any);
    const records = fs.readFileSync(requests, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    return { turn, output, activities, records };
  }

  it('caps provider-requested terminal output retention', async () => {
    const { records } = await run({ hugeOutput: true });
    const output = records.find(r => r.id === 903)?.result;
    expect(output.truncated).toBe(true);
    expect(Buffer.byteLength(output.output)).toBeLessThanOrEqual(1024 * 1024);
  });

  it('honors a leased subscription over ambient keys while giving terminals their project secrets', async () => {
    const prior = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = 'ambient-wrong-key';
    try {
      const { records } = await run({ subscription: true, model: 'xai/grok-4', modelProvider: 'xai',
        secretEnv: { XAI_API_KEY: 'project-xai', DATABASE_URL: 'project-db' } });
      const harness = records.find(r => r.env).env;
      expect(harness.XAI_API_KEY).toBeUndefined();
      expect(harness.DATABASE_URL).toBeUndefined();
      expect(records.find(r => r.nativeShellEnv).nativeShellEnv).toEqual({ XAI_API_KEY: 'project-xai', DATABASE_URL: 'project-db' });
      expect(fs.readdirSync(path.join(dir!, '.karmax-injection/work-env'))).toEqual([]);
      expect(harness.OPENCODE_CONFIG_CONTENT).not.toContain('project-xai');
      expect(JSON.parse(harness.OPENCODE_CONFIG_CONTENT).provider).toBeUndefined();
      expect(records.find(r => r.id === 903).result.output).toContain(':work:project-db:project-xai');
    } finally {
      if (prior === undefined) delete process.env.XAI_API_KEY; else process.env.XAI_API_KEY = prior;
    }
  });

  it('negotiates ACP, configures the advertised model/effort, passes MCP, and verifies end_turn', async () => {
    const { turn, output, activities, records } = await run({ image: true });
    expect(turn).toMatchObject({
      termination: { kind: 'success', status: 'end_turn' },
      session: 'session-new',
      output: 'done',
      delivered: 1,
    });
    // The console renders each emit as the whole live message (LT-5), so chunks
    // are published as the growing text, never as bare deltas.
    expect(output).toEqual(['do', 'done']);
    expect(activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'tool-1', kind: 'file', phase: 'started' }),
      expect.objectContaining({ id: 'tool-1', kind: 'file', phase: 'completed' }),
    ]));
    const created = records.find((r) => r.method === 'session/new');
    const prompted = records.find((r) => r.method === 'session/prompt');
    expect(records.some((r) => r.method === 'authenticate' && r.params.methodId === 'cached_token')).toBe(true);
    // `karmax` is the durable gateway MCP; `karmax_control` is the per-turn socket
    // bridge that carries the TURN-LOCAL controls (confirm/resolve/review-info) an
    // ACP harness could otherwise never reach — see src/agent/control-bridge.ts.
    expect(created.params.mcpServers.map((s: any) => s.name)).toEqual(['karmax', 'karmax_control', 'extra']);
    const control = created.params.mcpServers.find((s: any) => s.name === 'karmax_control');
    expect(control.command).toBe(process.execPath);
    expect(control.args[0]).toMatch(/control-mcp\.mjs$/);
    // The socket path is NOT the credential: same-uid peers can reach it, so the
    // per-turn token must be plumbed here too (control-bridge.ts security notes).
    expect(control.env).toEqual([
      { name: 'KARMAX_CONTROL_SOCKET', value: expect.stringMatching(/\.sock$/) },
      { name: 'KARMAX_CONTROL_TOKEN', value: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
    // The socket must not outlive the turn it mutates.
    expect(fs.existsSync(control.env[0].value)).toBe(false);
    expect(prompted.params.prompt.filter((block: any) => block.type === 'image')).toHaveLength(1);
    const configured = records.filter((r) => r.method === 'session/set_config_option').map((r) => r.params);
    expect(configured).toEqual(expect.arrayContaining([
      expect.objectContaining({ configId: 'model', value: 'kimi/k3' }),
      expect.objectContaining({ configId: 'thought', value: 'high' }),
    ]));
    const permission = records.find((r) => r.id === 900 && r.result);
    expect(permission.result.outcome).toMatchObject({ outcome: 'selected', optionId: 'yes' });
    const terminalResult = records.find((r) => r.id === 903)?.result;
    expect(terminalResult).toMatchObject({
      truncated: false,
      exitStatus: { exitCode: 0 },
    });
    const env = records[0].env;
    expect(terminalResult.output).toMatch(new RegExp(`^terminal-ok:${env.KARMAX_CUSTODY_CHAIN},[0-9a-f-]{36}:work::$`, 'i'));
    expect(env.KIMI_API_KEY).toBe('secret-kimi-key');
    expect(env.XDG_DATA_HOME).toContain('/home/data');
    expect(env.KARMAX_CUSTODY_CHAIN).toMatch(/[0-9a-f-]{36}$/i);
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toMatchObject({
      model: 'kimi/k3',
      permission: { '*': 'allow' },
      agent: { build: { prompt: 'Work carefully.', steps: 7 } },
      provider: { kimi: { options: { baseURL: 'https://api.kimi.com/coding/v1' } } },
    });
  });

  it('treats an ACP max_tokens stop as a resumable interruption, not a hard failure (provider parity)', async () => {
    // A model that produced valid work but hit an output boundary should resume
    // the session on retry, like the Claude SDK's max_output_tokens — not escalate
    // to a human. The interruption is signalled by a transport-classified message.
    process.env.STUB_STOP_REASON = 'max_tokens';
    await expect(run()).rejects.toThrow(/interrupted before completion/i);
  });

  it('cancels an in-flight turn to hand a mid-turn follow-up to the next turn (cancel-to-boundary steering)', async () => {
    // The stub runs long and never finishes on its own; a queued follow-up must
    // gracefully cancel the prompt and return cleanly, leaving `delivered`
    // unchanged so the workflow loops back to Do and delivers it next turn.
    process.env.STUB_AWAIT_CANCEL = '1';
    const followUp = { id: 'f1', role: 'user', text: 'actually, add tests too', ts: 5 };
    const { turn, records } = await run({ pullFollowUps: async (from: number) => (from >= 1 ? [followUp] : []) });
    expect(turn.termination).toMatchObject({ kind: 'success', status: 'end_turn' });
    expect(turn.delivered).toBe(1); // follow-up left for the next turn, not marked delivered
    expect(records.some((r) => r.method === 'session/cancel')).toBe(true);
  }, 15000);

  it('uses advertised native resume and fork instead of transcript emulation', async () => {
    const resumed = await run({ session: 'session-old' });
    expect(resumed.records.some((r) => r.method === 'session/resume' && r.params.sessionId === 'session-old')).toBe(true);

    const forked = await run({ session: 'session-old', fork: true });
    expect(forked.records.some((r) => r.method === 'session/fork' && r.params.sessionId === 'session-old')).toBe(true);
    expect(forked.turn.session).toBe('session-forked');
  });

  it('binds an unprefixed custom model to the provider selected by Credentials', async () => {
    const { records } = await run({ model: 'custom-design-model', modelProvider: 'google' });
    expect(JSON.parse(records[0].env.OPENCODE_CONFIG_CONTENT)).toMatchObject({
      model: 'google/custom-design-model',
      provider: { google: { options: { apiKey: '{env:GEMINI_API_KEY}' } } },
    });
  });

  it('uses Kimi Code’s documented ephemeral model channel for vault API keys', async () => {
    const { records } = await run({ provider: 'kimi' });
    expect(records[0].env).toMatchObject({
      KIMI_MODEL_API_KEY: 'secret-kimi-key',
      KIMI_MODEL_NAME: 'k3',
      KIMI_MODEL_BASE_URL: 'https://api.kimi.com/coding/v1',
    });
    expect(records.some((r) => r.method === 'authenticate')).toBe(false);
  });

  it('uses Grok Build ACP with its isolated home and advertised API-key auth', async () => {
    const { records } = await run({ provider: 'grok' });
    expect(records[0].env).toMatchObject({
      XAI_API_KEY: 'secret-kimi-key',
      GROK_HOME: expect.stringContaining('/home'),
    });
    expect(records.some((r) => r.method === 'authenticate' && r.params.methodId === 'xai.api_key')).toBe(true);
  });
});

describe('ACP adapters and remote worlds', () => {
  /**
   * ACP harnesses run only where krmax runs. `claude.ts`/`codex.ts` branch to
   * `spawnRemoteAgentProcess` for a cloud world; `acp.ts` has no such path, and
   * `remote-process.ts` is hardcoded to those two providers' config-home variables
   * and CLI packages. Before this guard the host `spawn` ran with a cwd that exists
   * only inside the sandbox: ENOENT was swallowed by the adapter's `error` handler
   * and the turn hung on the ACP `initialize` handshake with no stated cause.
   * Hosted deployments force remote worlds, so this is the path every hosted
   * OpenCode task took.
   */
  it('refuses a remote world with an actionable message instead of hanging', async () => {
    const remoteWorld = {
      handle: { id: 'w', root: '/home/user/karmax', branch: 'task', base: 'main',
        version: 2, sealedProviderRef: 'sealed:e2b:abc' },
    };
    await expect(new AcpAdapter('opencode').runTurn({
      profile: { id: 'p', name: 'Agent', provider: 'opencode', modelProvider: 'kimi',
        model: 'kimi/k3', effort: 'high', maxTurns: 7, role: 'do', capabilities: [] },
      world: remoteWorld,
      messages: [{ id: 'm', role: 'user', text: 'hi', ts: 0 }],
      systemPrompt: '',
      role: 'do',
    } as any, { emit() {}, emitActivity() {}, onSession() {} } as any))
      .rejects.toThrow(/cannot run in a remote \(cloud sandbox\) world/);
  });
});
