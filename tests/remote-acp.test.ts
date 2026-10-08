import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpAdapter } from '../src/agent/acp.js';
import { remoteControlBridge, type ControlFrame } from '../src/agent/control-bridge.js';
import { hostAcpSessionFile, multiplexAcpChannel, validAcpExport } from '../src/agent/remote-acp.js';
import { OPENCODE_PACKAGE, OPENCODE_VERSION } from '../src/agent/acp-packages.js';
import { OPENCODE_REMOTE_REFRESH_SENTINEL, isControlPlaneAuth, prewarmRemoteAgentHome, remoteAgentCommand, remoteAgentEnv,
  remoteAuthProjection } from '../src/agent/remote-process.js';
import { PINNED_REMOTE_NODE_VERSION } from '../src/agent/remote-node.js';
import { ProviderStreamError, SandboxProviderFailure } from '../src/agent/limits.js';
import type { World, WorldPty } from '../src/world/types.js';

/**
 * Remote OpenCode end to end, without a cloud: a world shaped like an E2B
 * sandbox whose "sandbox" is a local directory. Everything karmax runs there
 * runs for real — the uploaded launcher, `acp-relay.mjs`, the dependency-free
 * `control-mcp.mjs` the agent spawns, and a stub OpenCode that speaks ACP and
 * `export`/`import`. Only the runtime bootstrap is answered (it would install
 * Node and link it into /usr/local/bin: the 2026-10-02 incident).
 */

const STUB_AGENT = String.raw`#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const store = path.join(process.env.XDG_DATA_HOME || '/nonexistent', 'opencode', 'stub-sessions');
const records = path.join(process.cwd(), '.stub-records.jsonl');
const record = (value) => fs.appendFileSync(records, JSON.stringify(value) + '\n');
const sessionFile = (id) => path.join(store, id + '.json');
const load = (id) => { try { return JSON.parse(fs.readFileSync(sessionFile(id), 'utf8')); } catch { return undefined; } };
const save = (session) => { fs.mkdirSync(store, { recursive: true }); fs.writeFileSync(sessionFile(session.info.id), JSON.stringify(session)); };
const [command, argument] = process.argv.slice(2);
if (command === '--version') { console.log('0.0.0-stub'); process.exit(0); }
if (command === 'export') {
  const session = load(argument);
  if (!session) { console.error('Session not found: ' + argument); process.exit(1); }
  process.stdout.write(JSON.stringify(session, null, 2));
  process.exit(0);
}
if (command === 'import') {
  const session = JSON.parse(fs.readFileSync(argument, 'utf8'));
  save(session);
  record({ imported: session.info.id, messages: session.messages.length });
  console.log('Imported session: ' + session.info.id);
  process.exit(0);
}
if (command !== 'acp') process.exit(2);
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const sessions = new Map();
/** A minimal MCP client for one stdio server, as OpenCode spawns them. */
function mcp(server) {
  const env = { ...process.env, ...Object.fromEntries((server.env || []).map((e) => [e.name, e.value])) };
  const child = spawn(server.command, server.args, { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let next = 1;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  });
  const request = (method, params) => new Promise((resolve) => {
    const id = next++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { request, notify: (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'), close: () => child.kill() };
}
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    record({ initialize: msg.params.clientCapabilities, env: { XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, KARMAX_TOKEN: process.env.KARMAX_TOKEN,
      MODEL_KEY: process.env.ANTHROPIC_API_KEY, DATABASE_URL: process.env.DATABASE_URL } });
    for (const url of config.plugin || []) {
      const plugin = await (await import(url)).default();
      const output = { env: {} };
      await plugin['shell.env']({}, output);
      record({ shellEnv: output.env });
    }
    const prompt = config.agent && config.agent.build && config.agent.build.prompt;
    const file = /^\{file:(.+)\}$/.exec(prompt || '');
    record({ systemPrompt: file ? fs.readFileSync(file[1], 'utf8').length : -1, inline: !file });
    send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true,
      promptCapabilities: { image: true }, sessionCapabilities: { resume: {}, fork: {} } }, authMethods: [] } });
  } else if (msg.method === 'session/new') {
    const id = 'ses_' + Math.random().toString(36).slice(2, 12);
    save({ info: { id, directory: msg.params.cwd }, messages: [] });
    sessions.set(id, msg.params.mcpServers);
    record({ new: id, cwd: msg.params.cwd, servers: msg.params.mcpServers.map((s) => ({ name: s.name, command: s.command, args: s.args })) });
    send({ id: msg.id, result: { sessionId: id } });
  } else if (msg.method === 'session/resume' || msg.method === 'session/fork') {
    const source = load(msg.params.sessionId);
    if (!source) { send({ id: msg.id, error: { code: -32602, message: 'Session not found: ' + msg.params.sessionId } }); return; }
    let id = msg.params.sessionId;
    if (msg.method === 'session/fork') {
      id = 'ses_' + Math.random().toString(36).slice(2, 12);
      save({ info: { id, directory: msg.params.cwd, parent: source.info.id }, messages: [...source.messages] });
    }
    sessions.set(id, msg.params.mcpServers);
    record({ [msg.method === 'session/fork' ? 'forked' : 'resumed']: id, from: msg.params.sessionId, messages: source.messages.length });
    send({ id: msg.id, result: msg.method === 'session/fork' ? { sessionId: id } : {} });
  } else if (msg.method === 'session/prompt') {
    const id = msg.params.sessionId;
    const text = msg.params.prompt.filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (text.includes('STUB_QUOTA')) { send({ id: msg.id, error: { code: -32603, message: 'Internal error: You have reached your specified workspace API usage limits.' } }); return; }
    const session = load(id);
    session.messages.push({ role: 'user', text: text.slice(0, 200) }, { role: 'assistant', text: 'done' });
    save(session);
    record({ prompt: Buffer.byteLength(text), head: text.slice(0, 80) });
    const control = (sessions.get(id) || []).find((s) => s.name === 'karmax_control');
    if (control && process.env.STUB_CALL_TOOLS !== '0') {
      const client = mcp(control);
      const init = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stub', version: '1' } });
      client.notify('notifications/initialized');
      const listed = await client.request('tools/list', {});
      const called = await client.request('tools/call', { name: 'create_review_info', arguments: { summary: 'Remote review summary', caption: 'from the sandbox' } });
      const forged = mcp({ ...control, env: control.env.map((e) => e.name === 'KARMAX_CONTROL_TOKEN' ? { ...e, value: 'forged' } : e) });
      await forged.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'forged', version: '1' } });
      const refused = await forged.request('tools/call', { name: 'create_review_info', arguments: { summary: 'forged' } });
      forged.close();
      record({ mcp: init.result.serverInfo.name, tools: listed.result.tools.map((t) => t.name), called: called.result, refused: refused.result });
      client.close();
    }
    send({ method: 'session/update', params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'remote ' } } } });
    send({ method: 'session/update', params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } } });
    send({ id: msg.id, result: { stopReason: 'end_turn' } });
  } else if (msg.id !== undefined) send({ id: msg.id, result: {} });
});
`;

/** A world shaped like an E2B sandbox whose sandbox is `root` on this host. */
function sandboxWorld(root: string): World & { ptys: number; bootstraps: string[] } {
  const runtimeBin = path.join(root, `.karmax-injection/agent/tools/node-${PINNED_REMOTE_NODE_VERSION}/bin`);
  fs.mkdirSync(runtimeBin, { recursive: true });
  const nodeBin = path.dirname(process.execPath);
  for (const name of ['node', 'npm', 'npx']) {
    const target = name === 'node' ? process.execPath : path.join(nodeBin, name);
    if (!fs.existsSync(path.join(runtimeBin, name))) fs.symlinkSync(fs.existsSync(target) ? target : name, path.join(runtimeBin, name));
  }
  const live = new Set<ChildProcess>();
  const world: World & { ptys: number; bootstraps: string[] } = {
    ptys: 0,
    bootstraps: [],
    handle: { version: 2, kind: 'e2b', provider: 'e2b', sealedProviderRef: 'sealed', id: 'task', root, branch: 'task', base: 'main' } as any,
    async exec(command, args, opts = {}) {
      // The runtime bootstrap: answered, never run on this machine.
      if (command === 'bash' && args[0] === '-lc' && args[1]?.includes('KARMAX_WORK_DIRECTORY_READY')) {
        world.bootstraps.push(args[1]);
        const home = /mkdir -p '([^']+)' && find/.exec(args[1])?.[1];
        if (home) fs.mkdirSync(home, { recursive: true, mode: 0o700 });
        fs.mkdirSync(path.join(root, '.karmax-injection/work-env'), { recursive: true, mode: 0o700 });
        const digest = /if \[ -r '([^']+\.sha256)' \]/.exec(args[1])?.[1];
        const marker = digest && fs.existsSync(digest) ? `\nKARMAX_ACP_SESSION ${fs.readFileSync(digest, 'utf8').slice(0, 64)}\n` : '';
        return { code: 0, stdout: `\nKARMAX_WORK_DIRECTORY_READY\n${marker}`, stderr: '' };
      }
      const result = spawnSync(command, args, { cwd: opts.cwd ?? root, env: { ...process.env, ...opts.env },
        input: opts.input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    },
    async readFile(name) { return fs.readFileSync(path.join(root, name), 'utf8'); },
    async readFileBuffer(name) { return fs.readFileSync(path.join(root, name)); },
    async writeFile(name, content) { await world.writeFileBuffer!(name, Buffer.from(content)); },
    async writeFileBuffer(name, content) {
      if (name.endsWith('memory-guard.sh')) return; // never start a guard on the test machine
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), content);
    },
    async listFiles() { return []; },
    async startProcess() { throw new Error('unused'); },
    async openPty(spec = {}) {
      world.ptys++;
      const child = spawn('bash', ['-c', spec.command ?? 'bash'], { cwd: spec.cwd ?? root,
        env: { ...process.env, ...spec.env }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      live.add(child);
      child.stdin!.on('error', () => {});
      const exits = new Set<(code: number | null) => void>();
      child.on('exit', (code) => { live.delete(child); for (const listener of exits) listener(code); });
      const pty: WorldPty = {
        onData(listener) { const on = (chunk: Buffer) => listener(chunk.toString()); child.stdout!.on('data', on); return () => child.stdout!.off('data', on); },
        onExit(listener) { exits.add(listener); return () => exits.delete(listener); },
        async write(data) { child.stdin!.write(data); },
        async resize() {},
        async close() { try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* gone */ } },
      };
      return pty;
    },
    async destroy() { for (const child of live) { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } } },
  };
  return world;
}

function records(root: string): any[] {
  const file = path.join(root, '.stub-records.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
}

describe('remote OpenCode (ACP in a cloud sandbox)', () => {
  let dir: string;
  const worlds: World[] = [];
  const saved = { ...process.env };

  afterEach(async () => {
    for (const world of worlds.splice(0)) await world.destroy();
    process.env = { ...saved };
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-remote-acp-'));
    const pkg = path.join(dir, `opencode-stub-${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'opencode-stub', version: '0.0.0', bin: { opencode: 'bin/opencode.js' } }));
    fs.writeFileSync(path.join(pkg, 'bin', 'opencode.js'), STUB_AGENT, { mode: 0o755 });
    process.env.KARMAX_REMOTE_OPENCODE_PACKAGE = pkg;
    process.env.KARMAX_HOME = path.join(dir, 'karmax-home');
  }

  function sandbox(name: string) {
    const root = path.join(dir, name);
    fs.mkdirSync(root, { recursive: true });
    const world = sandboxWorld(root);
    worlds.push(world);
    return world;
  }

  async function turn(world: World, opts: { session?: string; fork?: boolean; text?: string; systemPrompt?: string;
    secretEnv?: Record<string, string>; reviews?: any[]; activities?: any[]; provider?: 'opencode' | 'kimi' } = {}) {
    const output: string[] = [];
    let session: string | undefined;
    const result = await new AcpAdapter(opts.provider ?? 'opencode').runTurn({
      profile: { id: 'p', name: 'Agent', provider: opts.provider ?? 'opencode', model: 'anthropic/claude-haiku-4-5', role: 'do' },
      world,
      messages: [{ id: 'm1', role: 'user', text: opts.text ?? 'make it work', ts: 0 }],
      systemPrompt: opts.systemPrompt ?? 'Work carefully.',
      role: 'do',
      resolvedAuth: { apiKey: 'sk-ant-test-key' },
      extraEnv: { KARMAX_TOKEN: 'scoped-token' },
      ...(opts.secretEnv ? { secretEnv: opts.secretEnv } : {}),
      agentMcp: [{ name: 'chrome-devtools', command: '/sandbox/node', args: ['/sandbox/chrome-cdp-launcher.mjs'], env: { KARMAX_CDP_PORT: '9222' } }],
      ...(opts.session ? { session: opts.session } : {}),
      ...(opts.fork ? { fork: true } : {}),
    } as any, {
      emit(text: string) { output.push(text); },
      emitActivity(activity: any) { opts.activities?.push(activity); },
      onSession(id: string) { session = id; },
      createReviewInfo(info: any) { opts.reviews?.push(info); },
    } as any);
    return { result, output, session: session! };
  }

  it('runs a turn in the sandbox: relay, a control tool round trip, a 128 KiB+ prompt, and the session kept on the host', async () => {
    setup();
    const world = sandbox('first');
    const reviews: any[] = [];
    const systemPrompt = 'Role instructions for a remote OpenCode agent.\n'.repeat(4000);
    const text = 'Task context that is longer than any one PTY frame.\n'.repeat(3000);
    expect(Buffer.byteLength(systemPrompt)).toBeGreaterThan(128 * 1024);
    expect(Buffer.byteLength(text)).toBeGreaterThan(128 * 1024);
    const { result, session } = await turn(world, { systemPrompt, text, reviews, secretEnv: { DATABASE_URL: 'postgres://work-only' } });

    expect(result.termination).toEqual({ kind: 'success', status: 'end_turn' });
    expect(result.output).toBe('remote done');
    const seen = records(world.handle.root);
    const init = seen.find((r) => r.initialize);
    // The agent's own tools run in the sandbox; nothing is executed on the host.
    expect(init.initialize).toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
    expect(init.env.XDG_DATA_HOME).toBe(`${world.handle.root}/.karmax-injection/agent/opencode/api/data`);
    expect(init.env.KARMAX_TOKEN).toBe('scoped-token');
    expect(init.env.MODEL_KEY).toBe('sk-ant-test-key');
    // Work secrets reach commands through the plugin only, never the harness.
    expect(init.env.DATABASE_URL).toBeUndefined();
    expect(seen.find((r) => r.shellEnv)?.shellEnv).toEqual({ DATABASE_URL: 'postgres://work-only' });
    // A >128 KiB system prompt travels as a file, a >128 KiB prompt in one line.
    expect(seen.find((r) => 'systemPrompt' in r)).toEqual({ systemPrompt: systemPrompt.length, inline: false });
    expect(seen.find((r) => r.prompt)?.prompt).toBeGreaterThan(128 * 1024);
    // MCP servers: the turn's controls and the declared browser, no host paths.
    const servers = seen.find((r) => r.new).servers;
    expect(servers.map((s: any) => s.name)).toEqual(['karmax_control', 'chrome-devtools']);
    expect(servers[0].command).toBe(`${world.handle.root}/.karmax-injection/agent/tools/node-${PINNED_REMOTE_NODE_VERSION}/bin/node`);
    expect(servers[0].args).toEqual([`${world.handle.root}/.karmax-injection/agent/acp/control-mcp.mjs`]);
    // The control tool ran in THIS activity, with the platform tools beside it.
    const mcp = seen.find((r) => r.mcp);
    expect(mcp.mcp).toBe('karmax_control');
    expect(mcp.tools).toEqual(expect.arrayContaining(['create_review_info', 'signal_completion', 'resolve_decision', 'platform_request', 'list_tasks']));
    expect(mcp.called.isError).toBeFalsy();
    expect(reviews).toEqual([expect.objectContaining({ summary: 'Remote review summary' })]);
    expect(mcp.refused).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('unauthorized') }] });
    // The session is kept on the host and the sandbox knows it holds that copy.
    const stored = fs.readFileSync(hostAcpSessionFile('opencode', session));
    expect(validAcpExport(stored, session)).toBe(true);
    expect(JSON.parse(stored.toString()).messages).toHaveLength(2);
    const digest = path.join(world.handle.root, '.karmax-injection/agent/opencode/api/karmax-sessions', `${session}.sha256`);
    expect(fs.readFileSync(digest, 'utf8')).toBe(crypto.createHash('sha256').update(stored).digest('hex'));
    // Nothing of the turn is left behind but the session and the agent home.
    expect(fs.readdirSync(path.join(world.handle.root, '.karmax-injection/agent/opencode/api/karmax-turn'))).toEqual([]);
    expect(fs.readdirSync(path.join(world.handle.root, '.karmax-injection/work-env'))).toEqual([]);
  }, 60_000);

  it('resumes the same session in a sandbox that lost it, and forks it into another world', async () => {
    setup();
    const first = sandbox('first');
    const { session } = await turn(first);
    // Same sandbox: it holds the session, so nothing is imported.
    await turn(first, { session, text: 'and again' });
    expect(records(first.handle.root).filter((r) => r.imported)).toEqual([]);
    expect(records(first.handle.root).find((r) => r.resumed)).toMatchObject({ resumed: session, messages: 2 });

    // A restored world has none of `.karmax-injection`: the host's copy is imported.
    const restored = sandbox('restored');
    const resumed = await turn(restored, { session, text: 'after a restore' });
    expect(resumed.session).toBe(session);
    expect(records(restored.handle.root)).toEqual(expect.arrayContaining([
      expect.objectContaining({ imported: session, messages: 4 }),
      expect.objectContaining({ resumed: session, messages: 4 }),
    ]));
    expect(JSON.parse(fs.readFileSync(hostAcpSessionFile('opencode', session), 'utf8')).messages).toHaveLength(6);

    const other = sandbox('fork');
    const forked = await turn(other, { session, fork: true, text: 'a forked agent' });
    expect(forked.session).not.toBe(session);
    expect(records(other.handle.root).find((r) => r.forked)).toMatchObject({ from: session, messages: 6 });
    expect(fs.existsSync(hostAcpSessionFile('opencode', forked.session))).toBe(true);
  }, 90_000);

  it('continues in a new session with the whole conversation when no copy of the session exists', async () => {
    setup();
    const world = sandbox('lost');
    const activities: any[] = [];
    const { session, result } = await turn(world, { session: 'ses_neverstored', text: 'the original request', activities });
    expect(result.termination.kind).toBe('success');
    expect(session).not.toBe('ses_neverstored');
    expect(activities).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'acp-session-recovery' })]));
    expect(records(world.handle.root).find((r) => r.prompt).head).toContain('the original request');
  }, 60_000);

  it('prepares the sandbox once, beside prompt preparation, and fetches the pinned CLI there', async () => {
    setup();
    const world = sandbox('prewarm');
    prewarmRemoteAgentHome(world, 'opencode', undefined, undefined);
    await turn(world);
    expect(world.bootstraps).toHaveLength(1);
    expect(world.bootstraps[0]).toContain(`npx --yes --package='${process.env.KARMAX_REMOTE_OPENCODE_PACKAGE}' -c true`);
    expect(world.bootstraps[0]).toContain(`'${world.handle.root}/.karmax-injection/agent/opencode/api'`);
  }, 60_000);

  it('leaves a provider limit reported from the sandbox for the host to confirm', async () => {
    setup();
    const failure = await turn(sandbox('quota'), { text: 'STUB_QUOTA' }).catch((error) => error);
    expect(failure).toBeInstanceOf(SandboxProviderFailure);
    expect(failure.failure).toBeInstanceOf(ProviderStreamError);
    expect(failure.message).toContain('workspace API usage limits');
  }, 60_000);

  it('refuses ACP harnesses without a remote implementation instead of running them on the host', async () => {
    setup();
    await expect(turn(sandbox('kimi'), { provider: 'kimi' })).rejects.toThrow(/cannot run in a remote \(cloud sandbox\) world/);
  });
});

describe('remote OpenCode pieces', () => {
  it('pins the OpenCode package and keeps the sandbox environment to the allowlist', () => {
    expect(OPENCODE_PACKAGE).toBe(`opencode-ai@${OPENCODE_VERSION}`);
    expect(remoteAgentCommand('opencode', 'opencode', ['acp'])).toEqual({ command: 'npx', args: ['--yes', OPENCODE_PACKAGE, 'acp'] });
    expect(() => remoteAgentCommand('kimi', 'kimi', ['acp'])).toThrow(/no remote/);
    const env = remoteAgentEnv('opencode', '/w/.karmax-injection/agent/opencode/api', {
      KARMAX_TOKEN: 't', OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_DISABLE_AUTOUPDATE: '1', ANTHROPIC_API_KEY: 'k',
      KARMAX_VAULT_KEY: 'never', XDG_DATA_HOME: '/host/data', DATABASE_URL: 'work-only',
    }, ['ANTHROPIC_API_KEY']);
    expect(env).toEqual({
      XDG_DATA_HOME: '/w/.karmax-injection/agent/opencode/api/data',
      XDG_CONFIG_HOME: '/w/.karmax-injection/agent/opencode/api/config',
      OPENCODE_CONFIG_DIR: '/w/.karmax-injection/agent/opencode/api/config/opencode',
      KARMAX_TOKEN: 't', OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_DISABLE_AUTOUPDATE: '1', ANTHROPIC_API_KEY: 'k',
    });
  });

  it('projects an OpenCode login without its rotating refresh tokens', () => {
    expect(isControlPlaneAuth('opencode', 'data/opencode/auth.json')).toBe(true);
    const projected = JSON.parse(remoteAuthProjection('opencode', 'data/opencode/auth.json', Buffer.from(JSON.stringify({
      anthropic: { type: 'oauth', refresh: 'host-only-refresh', access: 'access-token', expires: 1 },
      openrouter: { type: 'api', key: 'sk-or' },
    }))).toString());
    expect(projected).toEqual({
      anthropic: { type: 'oauth', refresh: OPENCODE_REMOTE_REFRESH_SENTINEL, access: 'access-token', expires: 1 },
      openrouter: { type: 'api', key: 'sk-or' },
    });
  });

  it('demultiplexes control frames from ACP lines however the PTY splits them, and writes frames between lines', async () => {
    const ptyOut = new PassThrough();
    const ptyIn = new PassThrough();
    const frames: ControlFrame[] = [];
    const channel = multiplexAcpChannel({ stdin: ptyIn, stdout: ptyOut }, (frame) => frames.push(frame));
    const acp: string[] = [];
    channel.stdout.on('data', (chunk) => acp.push(chunk.toString()));
    const stream = `{"jsonrpc":"2.0","id":1}\n\x1eKXC {"c":3,"m":"{\\"op\\":\\"list\\"}"}\n{"jsonrpc":"2.0","method":"x","params":{"t":"\\u001e"}}\n`;
    for (let i = 0; i < stream.length; i += 7) ptyOut.write(stream.slice(i, i + 7));
    await new Promise((resolve) => setImmediate(resolve));
    expect(frames).toEqual([{ c: 3, m: '{"op":"list"}' }]);
    expect(acp.join('')).toBe('{"jsonrpc":"2.0","id":1}\n{"jsonrpc":"2.0","method":"x","params":{"t":"\\u001e"}}\n');

    const written: string[] = [];
    ptyIn.on('data', (chunk) => written.push(chunk.toString()));
    channel.stdin.write('{"jsonrpc":"2.0",');
    channel.sendControl({ c: 3, m: '{"ok":true}' });
    channel.stdin.write('"id":2}\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(written.join('')).toBe('\x1eKXC {"c":3,"m":"{\\"ok\\":true}"}\n{"jsonrpc":"2.0","id":2}\n');
  });

  it('answers sandbox frames only with the turn token, and nothing after the turn', async () => {
    const calls: any[] = [];
    const bridge = remoteControlBridge({ signal_completion: async (args: any) => { calls.push(args); return 'ok'; } } as any)!;
    const sent: ControlFrame[] = [];
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
    bridge.serve({ c: 1, m: JSON.stringify({ id: 1, token: 'wrong', op: 'list' }) }, (frame) => sent.push(frame));
    await settle();
    expect(sent).toEqual([{ c: 1, m: expect.stringContaining('unauthorized') }, { c: 1, close: true }]);
    bridge.serve({ c: 1, m: JSON.stringify({ id: 2, token: bridge.token, op: 'list' }) }, (frame) => sent.push(frame));
    bridge.serve({ c: 2, m: JSON.stringify({ id: 3, token: bridge.token, op: 'call', name: 'signal_completion', args: { summary: 's' } }) }, (frame) => sent.push(frame));
    await settle();
    expect(sent.slice(2)).toEqual([{ c: 2, m: JSON.stringify({ id: 3, ok: true, text: 'ok' }) }]);
    expect(calls).toEqual([{ summary: 's' }]);
    bridge.close();
    bridge.serve({ c: 2, m: JSON.stringify({ id: 4, token: bridge.token, op: 'call', name: 'signal_completion', args: {} }) }, (frame) => sent.push(frame));
    await settle();
    expect(calls).toHaveLength(1);
  });
});
