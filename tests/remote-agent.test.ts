import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../src/agent/codex.js';
import { installedClaudeCodeVersion, materializeRemoteSession, remoteAgentCommand, remoteAgentEnv,
  remoteAgentHomeRelative, seedRemoteAgentHome, syncRemoteAgentHome } from '../src/agent/remote-process.js';
import type { World, WorldPty, WorldPtySpec } from '../src/world/types.js';

const codexIdToken = (expiresAt: number) =>
  `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(expiresAt / 1000) })).toString('base64url')}.signature`;
const freshCodexAuth = () => JSON.stringify({
  auth_mode: 'chatgpt',
  tokens: { id_token: codexIdToken(Date.now() + 60 * 60_000), access_token: 'access', refresh_token: 'host-authority' },
});

describe('remote subscription agents', () => {
  let localHome: string | undefined;
  afterEach(() => {
    delete process.env.KARMAX_REMOTE_GATEWAY_URL;
    delete process.env.KARMAX_CODEX_USAGE_CMD;
    if (localHome) fs.rmSync(localHome, { recursive: true, force: true });
    localHome = undefined;
  });

  it('seeds leased credentials/config while removing the obsolete remote platform MCP', async () => {
    localHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-remote-home-'));
    fs.writeFileSync(path.join(localHome, 'auth.json'), JSON.stringify({
      tokens: { access_token: 'subscription', refresh_token: 'host-only-refresh' },
    }));
    fs.mkdirSync(path.join(localHome, 'skills', 'review'), { recursive: true });
    fs.writeFileSync(path.join(localHome, 'skills', 'review', 'SKILL.md'), 'review skill');
    fs.mkdirSync(path.join(localHome, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(localHome, 'sessions', 'host-task.jsonl'), 'host-only conversation');
    fs.mkdirSync(path.join(localHome, 'plugins', 'cache', 'large'), { recursive: true });
    fs.writeFileSync(path.join(localHome, 'logs_2.sqlite'), Buffer.alloc(1024));
    fs.writeFileSync(path.join(localHome, 'plugins', 'cache', 'large', 'asset.bin'), Buffer.alloc(1024));
    fs.mkdirSync(path.join(localHome, '.tmp', 'plugins', 'marketplace'), { recursive: true });
    fs.writeFileSync(path.join(localHome, '.tmp', 'plugins', 'marketplace', 'catalog.bin'), Buffer.alloc(1024));
    fs.writeFileSync(path.join(localHome, 'config.toml'), '[mcp_servers.karmax]\ncommand = "/host/node"\n\n[notice]\nkeep = true\n');
    const world = fakeWorld();

    const seeded = await seedRemoteAgentHome(world, 'codex', localHome);
    const remoteHome = remoteAgentHomeRelative('codex', localHome);

    expect(seeded.absolute).toBe(`/workspace/${remoteHome}`);
    expect(world.files.get(`${remoteHome}/auth.json`)?.toString()).toContain('subscription');
    expect(world.files.get(`${remoteHome}/auth.json`)?.toString()).not.toContain('host-only-refresh');
    expect(world.files.get(`${remoteHome}/skills/review/SKILL.md`)?.toString()).toBe('review skill');
    expect(world.files.has(`${remoteHome}/sessions/host-task.jsonl`)).toBe(false);
    expect(world.files.has(`${remoteHome}/logs_2.sqlite`)).toBe(false);
    expect(world.files.has(`${remoteHome}/plugins/cache/large/asset.bin`)).toBe(false);
    expect(world.files.has(`${remoteHome}/.tmp/plugins/marketplace/catalog.bin`)).toBe(false);
    const config = world.files.get(`${remoteHome}/config.toml`)?.toString() ?? '';
    expect(config).toContain('[notice]');
    expect(config).not.toContain('/host/node');
    expect(config).not.toContain('mcp_servers.karmax');
    expect(world.files.has('.karmax-injection/agent/tools/platform-mcp/karmax-mcp.cjs')).toBe(false);
    world.files.set(`${remoteHome}/auth.json`, Buffer.from('{"tokens":{"access_token":"refreshed-remotely"}}'));
    await seedRemoteAgentHome(world, 'codex', localHome);
    expect(world.files.get(`${remoteHome}/auth.json`)?.toString()).toContain('subscription');
    expect(world.commands.some((command) => command.includes('find') && command.includes('chmod 600'))).toBe(true);
    await seedRemoteAgentHome(world, 'codex', localHome, 'host-task');
    expect(world.files.get(`${remoteHome}/sessions/host-task.jsonl`)?.toString()).toBe('host-only conversation');
  });

  it('passes only the remote home and explicit turn-scoped environment', () => {
    expect(remoteAgentEnv('claude', '/workspace/.karmax-injection/agent/claude', {
      PATH: '/host/bin', HOME: '/host/home', OPENAI_API_KEY: 'wrong-account',
      CLAUDE_CODE_OAUTH_TOKEN: 'subscription', KARMAX_TOKEN: 'turn-token',
      CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_VERSION: '0.3.220',
    })).toEqual({
      CLAUDE_CONFIG_DIR: '/workspace/.karmax-injection/agent/claude',
      CLAUDE_CODE_OAUTH_TOKEN: 'subscription', KARMAX_TOKEN: 'turn-token',
      CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_VERSION: '0.3.220',
    });
    expect(remoteAgentEnv('claude', '/workspace/.karmax-injection/agent/claude', {
      KARMAX_TOKEN: 'turn-token', DATABASE_URL: 'postgres://task-db',
      HOST_ONLY: 'must-not-cross', CLAUDE_CONFIG_DIR: '/host/escape',
    }, ['DATABASE_URL', 'CLAUDE_CONFIG_DIR'])).toEqual({
      CLAUDE_CONFIG_DIR: '/workspace/.karmax-injection/agent/claude',
      KARMAX_TOKEN: 'turn-token',
      DATABASE_URL: 'postgres://task-db',
    });
    // The remote CLI pin is *derived* from the installed Agent SDK's declared
    // `claudeCodeVersion` (see remote-process.ts) precisely so that no second,
    // hand-written version exists to drift. Assert that invariant rather than a
    // literal: a literal here would reintroduce the very pin the source avoids,
    // and would fail on every legitimate SDK bump.
    const pinned = installedClaudeCodeVersion();
    expect(pinned).toMatch(/^\d+\.\d+\.\d+/);
    expect(remoteAgentCommand('claude', '/usr/bin/node', ['/host/sdk/cli.js', '--resume', 's']).args)
      .toEqual(expect.arrayContaining([`@anthropic-ai/claude-code@${pinned}`, '--print', '--resume', 's']));
    expect(remoteAgentCommand('codex', 'codex', ['app-server']).args)
      .toEqual(expect.arrayContaining(['@openai/codex@0.144.5', 'app-server']));
  });

  it('isolates accounts and exports native sessions without importing task-local OAuth state', async () => {
    const first = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-account-a-'));
    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-account-b-'));
    localHome = first;
    fs.writeFileSync(path.join(first, 'auth.json'), '{"account":"a-old"}');
    fs.writeFileSync(path.join(second, 'auth.json'), '{"account":"b"}');
    const world = fakeWorld();
    const a = await seedRemoteAgentHome(world, 'codex', first);
    const b = await seedRemoteAgentHome(world, 'codex', second);
    expect(a.relative).not.toBe(b.relative);
    expect(world.files.get(`${a.relative}/auth.json`)?.toString()).toContain('a-old');
    expect(world.files.get(`${b.relative}/auth.json`)?.toString()).toContain('"b"');
    world.files.set(`${a.relative}/auth.json`, Buffer.from('{"account":"a-refreshed"}'));
    world.files.set(`${a.relative}/sessions/2026/session-a.jsonl`, Buffer.from('durable native session'));
    await syncRemoteAgentHome(world, 'codex', a, first);
    expect(fs.readFileSync(path.join(first, 'auth.json'), 'utf8')).toContain('a-old');
    expect(fs.readFileSync(path.join(first, 'sessions/2026/session-a.jsonl'), 'utf8')).toBe('durable native session');
    fs.rmSync(second, { recursive: true, force: true });
  });

  it('keeps the control plane authoritative even when remote OAuth metadata looks newer', async () => {
    localHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-remote-reauth-'));
    const localAuth = {
      auth_mode: 'chatgpt', last_refresh: '2026-08-19T22:00:00.000Z',
      tokens: { access_token: 'fresh-control-plane', refresh_token: 'fresh-refresh' },
    };
    fs.writeFileSync(path.join(localHome, 'auth.json'), JSON.stringify(localAuth));
    const world = fakeWorld();
    const home = await seedRemoteAgentHome(world, 'codex', localHome);
    world.files.set(`${home.relative}/auth.json`, Buffer.from(JSON.stringify({
      auth_mode: 'chatgpt', last_refresh: '2026-08-20T22:00:00.000Z',
      tokens: { access_token: 'expired-remote', refresh_token: 'expired-refresh' },
    })));

    await seedRemoteAgentHome(world, 'codex', localHome);
    expect(world.files.get(`${home.relative}/auth.json`)?.toString()).toContain('fresh-control-plane');

    // A late cleanup from any world must not become refresh authority.
    world.files.set(`${home.relative}/auth.json`, Buffer.from(JSON.stringify({
      auth_mode: 'chatgpt', last_refresh: '2026-08-21T22:00:00.000Z',
      tokens: { access_token: 'expired-remote', refresh_token: 'expired-refresh' },
    })));
    await syncRemoteAgentHome(world, 'codex', home, localHome);
    expect(fs.readFileSync(path.join(localHome, 'auth.json'), 'utf8')).toContain('fresh-control-plane');
  });

  it('rewrites a selected browser MCP to the probed sandbox-local headless runtime', async () => {
    localHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-remote-browser-'));
    fs.writeFileSync(path.join(localHome, '.claude.json'), JSON.stringify({ mcpServers: {
      'chrome-devtools': { command: 'npx', args: ['-y', 'chrome-devtools-mcp'] },
    } }));
    const world = fakeWorld(false, true);
    const seeded = await seedRemoteAgentHome(world, 'claude', localHome);
    // chrome-devtools runs through karmax's launcher so the sandbox browser
    // exposes a loopback CDP port the gateway's remote fill types into (§5B); the
    // launcher sets vm.overcommit_memory=1 first so Chrome's V8 renderer can run
    // in the memory-constrained sandbox (findings/e2b-headless-chrome-overcommit).
    expect(seeded.browserMcp?.['chrome-devtools']).toMatchObject({
      command: 'node',
      args: ['/workspace/.karmax-injection/agent/chrome-cdp-launcher.mjs'],
      env: {
        PLAYWRIGHT_BROWSERS_PATH: '/opt/karmax/browsers',
        KARMAX_CDP_MCP_BIN: '/opt/karmax/bin/chrome-devtools-mcp',
        KARMAX_CDP_CHROME: '/opt/karmax/browsers/chromium',
        KARMAX_CDP_NO_SANDBOX: '1',
        KARMAX_CDP_SET_OVERCOMMIT: '1',
      },
    });
    expect(world.files.get('.karmax-injection/agent/chrome-cdp-launcher.mjs')?.toString()).toContain('--remote-debugging-port');
  });

  it('copies only the requested native session between remote worlds', async () => {
    localHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-remote-destination-'));
    const source = fakeWorld();
    const destination = fakeWorld();
    destination.handle.root = '/destination';
    source.files.set('.karmax-injection/agent/claude/source-account/projects/-workspace/session-1.jsonl', Buffer.from('native history'));
    source.files.set('.karmax-injection/agent/claude/source-account/projects/-workspace/other.jsonl', Buffer.from('do not copy'));
    expect(await materializeRemoteSession(source, destination, 'claude', 'session-1', localHome)).toBe(true);
    const destinationHome = remoteAgentHomeRelative('claude', localHome);
    expect(destination.files.get(`${destinationHome}/projects/-destination/session-1.jsonl`)?.toString()).toBe('native history');
    expect([...destination.files.keys()].some((file) => file.endsWith('/other.jsonl'))).toBe(false);
  });

  it('runs Codex app-server inside the remote PTY with the seeded subscription', async () => {
    localHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-remote-codex-'));
    fs.writeFileSync(path.join(localHome, 'auth.json'), freshCodexAuth());
    const world = fakeWorld(true);
    const sessions: string[] = [];
    const platformCalls: string[] = [];

    const result = await new CodexAdapter().runTurn({
      profile: { id: 'p', name: 'codex', provider: 'codex', role: 'do', capabilities: [] },
      world,
      messages: [{ id: 'm', role: 'user', text: 'edit the repository', ts: 0 }],
      systemPrompt: 'Do the task.', role: 'do', resolvedAuth: { configHome: localHome },
    } as any, { emit() {}, emitActivity() {}, onSession: (id: string) => sessions.push(id),
      platformRequest: async (method: string, requestPath: string) => { platformCalls.push(`${method} ${requestPath}`); return [{ type: 'ok' }]; } } as any);

    expect(result).toMatchObject({ termination: { kind: 'success', status: 'completed' }, session: 'remote-thread', output: 'done remotely' });
    expect(world.openedPty?.command).toContain('@openai/codex@0.144.5');
    expect(world.openedPty?.command).toContain('/opt/karmax/bin/codex');
    expect(world.openedPty?.command).toContain('app-server');
    expect(world.openedPty?.command).toContain('stty raw -echo');
    expect(world.openedPty?.command).toContain('exec sh -c');
    expect(world.openedPty?.command).toContain('karmax-agent.pid');
    expect(world.openedPty?.command).not.toContain('\u001eKARMAX_AGENT_READY\u001e');
    expect(spawnSync('bash', ['-n', '-c', world.openedPty?.command ?? '']).status).toBe(0);
    const remoteHome = remoteAgentHomeRelative('codex', localHome);
    expect(world.openedPty?.env).toMatchObject({ CODEX_HOME: `/workspace/${remoteHome}` });
    expect(world.files.get(`${remoteHome}/auth.json`)?.toString()).toContain('chatgpt');
    expect(sessions).toContain('remote-thread');
    expect(platformCalls).toEqual(['GET /api/tasks/task/events?since=0']);
    expect(world.dynamicTools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'list_events' })]));
  });

  it('preserves a successful Codex turn when best-effort remote state export times out', async () => {
    localHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-remote-codex-sync-timeout-'));
    fs.writeFileSync(path.join(localHome, 'auth.json'), freshCodexAuth());
    const world = fakeWorld(true);
    const exec = world.exec.bind(world);
    let stateListings = 0;
    world.exec = async (command, args, options) => {
      if (command === 'bash' && args[1]?.includes('-type f -print') && ++stateListings > 1)
        throw new Error('[canceled] Request handshake timed out after 60000ms');
      return exec(command, args, options);
    };
    const activities: any[] = [];

    const result = await new CodexAdapter().runTurn({
      profile: { id: 'p', name: 'codex', provider: 'codex', role: 'do', capabilities: [] },
      world,
      messages: [{ id: 'm', role: 'user', text: 'edit the repository', ts: 0 }],
      systemPrompt: 'Do the task.', role: 'do', resolvedAuth: { configHome: localHome },
    } as any, { emit() {}, emitActivity: (activity: any) => activities.push(activity),
      platformRequest: async () => [{ type: 'ok' }] } as any);

    expect(result).toMatchObject({
      termination: { kind: 'success', status: 'completed' },
      session: 'remote-thread', output: 'done remotely',
    });
    expect(activities).toContainEqual(expect.objectContaining({
      kind: 'error', phase: 'failed', title: expect.stringMatching(/remote Codex state/i),
      detail: expect.stringContaining('Request handshake timed out'),
    }));
  });

  it('centrally refreshes and resumes once when a remote access-only token expires', async () => {
    localHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-remote-codex-refresh-'));
    fs.writeFileSync(path.join(localHome, 'auth.json'), freshCodexAuth());
    const usageStub = path.join(localHome, 'refresh-stub.cjs');
    fs.writeFileSync(usageStub, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') send({ id: request.id, result: {} });
  else if (request.method === 'account/read') {
    const authPath = path.join(process.env.CODEX_HOME, 'auth.json');
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    auth.tokens.id_token = 'e30.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.signature';
    fs.writeFileSync(authPath, JSON.stringify(auth));
    send({ id: request.id, result: { account: { type: 'chatgpt' } } });
  }
  else if (request.method === 'account/rateLimits/read') send({ id: request.id, result: { rateLimits: {} } });
});`);
    fs.chmodSync(usageStub, 0o755);
    process.env.KARMAX_CODEX_USAGE_CMD = usageStub;
    const world = fakeWorld(true, false, true);
    const activities: any[] = [];

    const result = await new CodexAdapter().runTurn({
      profile: { id: 'p', name: 'codex', provider: 'codex', role: 'do', capabilities: [] },
      world,
      messages: [{ id: 'm', role: 'user', text: 'continue safely', ts: 0 }],
      systemPrompt: 'Do the task.', role: 'do', resolvedAuth: { configHome: localHome },
    } as any, { emit() {}, emitActivity: (activity: any) => activities.push(activity),
      platformRequest: async () => [{ type: 'ok' }] } as any);

    expect(result).toMatchObject({ termination: { kind: 'success' }, session: 'remote-thread' });
    expect(world.requests.filter((request) => request.method === 'turn/start')).toHaveLength(2);
    expect(activities).toContainEqual(expect.objectContaining({
      id: 'codex-credential-recovery', phase: 'completed',
      title: expect.stringMatching(/resuming turn/i),
    }));
  });

  it('refreshes an expired canonical ID token before seeding a remote Codex process', async () => {
    localHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-remote-codex-preflight-'));
    const expiredIdToken = codexIdToken(Date.now() - 60_000);
    fs.writeFileSync(path.join(localHome, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { id_token: expiredIdToken, access_token: 'still-valid', refresh_token: 'host-authority' },
    }));
    const usageStub = path.join(localHome, 'preflight-stub.cjs');
    fs.writeFileSync(usageStub, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') send({ id: request.id, result: {} });
  else if (request.method === 'account/read') {
    const authPath = path.join(process.env.CODEX_HOME, 'auth.json');
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    auth.tokens.id_token = 'e30.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.signature';
    fs.writeFileSync(authPath, JSON.stringify(auth));
    send({ id: request.id, result: { account: { type: 'chatgpt' } } });
  } else if (request.method === 'account/rateLimits/read') send({ id: request.id, result: { rateLimits: {} } });
});`);
    fs.chmodSync(usageStub, 0o755);
    process.env.KARMAX_CODEX_USAGE_CMD = usageStub;
    const world = fakeWorld(true);
    const activities: any[] = [];

    await new CodexAdapter().runTurn({
      profile: { id: 'p', name: 'codex', provider: 'codex', role: 'do', capabilities: [] },
      world,
      messages: [{ id: 'm', role: 'user', text: 'continue safely', ts: 0 }],
      systemPrompt: 'Do the task.', role: 'do', resolvedAuth: { configHome: localHome },
    } as any, { emit() {}, emitActivity: (activity: any) => activities.push(activity),
      platformRequest: async () => [{ type: 'ok' }] } as any);

    const remoteHome = remoteAgentHomeRelative('codex', localHome);
    const projected = JSON.parse(world.files.get(`${remoteHome}/auth.json`)!.toString());
    expect(projected.tokens.id_token).not.toBe(expiredIdToken);
    expect(projected.tokens.refresh_token).toBeUndefined();
    expect(world.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
    expect(activities).toContainEqual(expect.objectContaining({
      id: 'codex-credential-preflight', phase: 'completed',
    }));
  });

  it.each([
    { fork: false, method: 'thread/resume' },
    { fork: true, method: 'thread/fork' },
  ])('adds Karmax tools before native Codex $method of an external session', async ({ fork, method }) => {
    localHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-remote-external-codex-'));
    fs.writeFileSync(path.join(localHome, 'auth.json'), freshCodexAuth());
    const session = '019f-external-thread';
    const directory = path.join(localHome, 'sessions', '2026', '07', '19');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `rollout-${session}.jsonl`),
      `${JSON.stringify({ timestamp: 'now', type: 'session_meta', payload: { session_id: session, cwd: '/host' } })}\n` +
      `${JSON.stringify({ timestamp: 'now', type: 'event_msg', payload: { type: 'task_started' } })}\n`);
    const world = fakeWorld(true);

    await new CodexAdapter().runTurn({
      profile: { id: 'p', name: 'codex', provider: 'codex', role: 'do', capabilities: [] },
      world, session, fork,
      messages: [{ id: 'm', role: 'user', text: 'continue', ts: 0 }],
      systemPrompt: 'Do the task.', role: 'do', resolvedAuth: { configHome: localHome },
    } as any, { emit() {}, emitActivity() {},
      platformRequest: async () => [{ type: 'ok' }] } as any);

    expect(world.requests.some((request) => request.method === method)).toBe(true);
    const remoteHome = remoteAgentHomeRelative('codex', localHome);
    const rollout = world.files.get(`${remoteHome}/sessions/2026/07/19/rollout-${session}.jsonl`)!.toString();
    const metadata = JSON.parse(rollout.split('\n')[0]!);
    expect(metadata.payload.dynamic_tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function', name: 'list_events' }),
      expect.objectContaining({ type: 'function', name: 'publish_task_branch' }),
      expect.objectContaining({ type: 'function', name: 'propose_project_resource' }),
      expect.objectContaining({ type: 'function', name: 'message_agent' }),
    ]));
  });
});

function fakeWorld(appServer = false, browserReady = false, expireFirstTurn = false): World & {
  files: Map<string, Buffer>; commands: string[]; requests: any[]; openedPty?: WorldPtySpec; dynamicTools?: any[];
} {
  const files = new Map<string, Buffer>();
  const commands: string[] = [];
  const requests: any[] = [];
  let turnStarts = 0;
  const world: World & { files: Map<string, Buffer>; commands: string[]; requests: any[]; openedPty?: WorldPtySpec; dynamicTools?: any[] } = {
    files, commands, requests,
    handle: { version: 2, kind: 'e2b', provider: 'e2b', sealedProviderRef: 'sealed', id: 'task', root: '/workspace', branch: 'task', base: 'main' },
    async exec(command, args) {
      commands.push([command, ...args].join(' '));
      if (command === 'bash' && args[1]?.includes('-type f -print')) {
        return { stdout: [...files.keys()].map((file) => `/workspace/${file}`).join('\n'), stderr: '', code: 0 };
      }
      if (command === 'node' && args[0] === '-e' && args[1]?.includes('process.versions.node'))
        return { stdout: '', stderr: '', code: 0 };
      if (browserReady && command === 'node' && args[0] === '-e' && args[1]?.includes('executablePath'))
        return { stdout: '/opt/karmax/browsers/chromium', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    },
    async readFile(name) { return files.get(name)?.toString() ?? ''; },
    async readFileBuffer(name) { return files.get(name) ?? Buffer.alloc(0); },
    async writeFile(name, value) { files.set(name, Buffer.from(value)); },
    async writeFileBuffer(name, value) { files.set(name, Buffer.from(value)); },
    async listFiles() { return [...files.keys()]; },
    async startProcess() { throw new Error('unused'); },
    async openPty(spec = {}) {
      world.openedPty = spec;
      const data = new Set<(chunk: string) => void>();
      const exits = new Set<(code: number | null) => void>();
      let input = '';
      let ready = false;
      const send = (value: unknown) => { const line = JSON.stringify(value) + '\n'; for (const listener of data) listener(line); };
      const pty: WorldPty = {
        onData(listener) {
          data.add(listener);
          if (appServer && !ready) {
            ready = true;
            queueMicrotask(() => { if (data.has(listener)) listener('\u001eKARMAX_AGENT_READY\u001e'); });
          }
          return () => data.delete(listener);
        },
        onExit(listener) { exits.add(listener); return () => exits.delete(listener); },
        async write(chunk) {
          if (!appServer || chunk === '\x04') return;
          input += chunk;
          let newline: number;
          while ((newline = input.indexOf('\n')) >= 0) {
            const line = input.slice(0, newline); input = input.slice(newline + 1);
            if (!line.trim()) continue;
            const request = JSON.parse(line);
            requests.push(request);
            if (request.method === 'initialize') send({ id: request.id, result: {} });
            else if (request.method === 'account/rateLimits/read') send({ id: request.id, result: {
              rateLimits: { primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1999999999 } },
            } });
            else if (request.method === 'mcpServerStatus/list') send({ id: request.id, result: { data: [], nextCursor: null } });
            else if (request.method === 'thread/start') {
              world.dynamicTools = request.params.dynamicTools;
              send({ id: request.id, result: { thread: { id: 'remote-thread' } } });
            }
            else if (request.method === 'thread/resume')
              send({ id: request.id, result: { thread: { id: request.params.threadId } } });
            else if (request.method === 'thread/fork')
              send({ id: request.id, result: { thread: { id: 'forked-remote-thread' } } });
            else if (request.method === 'turn/start') {
              turnStarts++;
              send({ id: request.id, result: { turn: { id: 'remote-turn' } } });
              send({ method: 'turn/started', params: { turn: { id: 'remote-turn' } } });
              if (expireFirstTurn && turnStarts === 1) {
                // Current Codex can preserve this only on the failed terminal
                // turn, not as a separate structured `error` notification.
                send({ method: 'turn/completed', params: { turn: {
                  id: 'remote-turn', status: 'failed', error: {
                    message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, request id: req_remote_expired',
                    codexErrorInfo: 'other',
                  },
                } } });
                continue;
              }
              send({ id: 99, method: 'item/tool/call', params: { threadId: 'remote-thread', turnId: 'remote-turn',
                callId: 'call-1', namespace: null, tool: 'list_events', arguments: { task_id: 'task', since: 0 } } });
            } else if (request.id === 99 && request.result?.success) {
              send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'done remotely' } } });
              send({ method: 'turn/completed', params: { turn: { id: 'remote-turn', status: 'completed' } } });
            }
          }
        },
        async resize() {},
        async close() { for (const listener of exits) listener(0); },
      };
      return pty;
    },
    async destroy() {},
  };
  return world;
}
