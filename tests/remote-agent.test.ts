import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../src/agent/codex.js';
import { materializeRemoteSession, remoteAgentCommand, remoteAgentEnv, remoteAgentHomeRelative, seedRemoteAgentHome, syncRemoteAgentHome } from '../src/agent/remote-process.js';
import type { World, WorldPty, WorldPtySpec } from '../src/world/types.js';

describe('remote subscription agents', () => {
  let localHome: string | undefined;
  afterEach(() => {
    delete process.env.KARMAX_REMOTE_GATEWAY_URL;
    if (localHome) fs.rmSync(localHome, { recursive: true, force: true });
    localHome = undefined;
  });

  it('seeds leased credentials/config and the platform MCP under the task world', async () => {
    localHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-remote-home-'));
    fs.writeFileSync(path.join(localHome, 'auth.json'), '{"tokens":{"access_token":"subscription"}}');
    fs.mkdirSync(path.join(localHome, 'skills', 'review'), { recursive: true });
    fs.writeFileSync(path.join(localHome, 'skills', 'review', 'SKILL.md'), 'review skill');
    fs.mkdirSync(path.join(localHome, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(localHome, 'sessions', 'host-task.jsonl'), 'host-only conversation');
    fs.mkdirSync(path.join(localHome, 'plugins', 'cache', 'large'), { recursive: true });
    fs.writeFileSync(path.join(localHome, 'logs_2.sqlite'), Buffer.alloc(1024));
    fs.writeFileSync(path.join(localHome, 'plugins', 'cache', 'large', 'asset.bin'), Buffer.alloc(1024));
    fs.writeFileSync(path.join(localHome, 'config.toml'), '[mcp_servers.karmax]\ncommand = "/host/node"\n\n[notice]\nkeep = true\n');
    process.env.KARMAX_REMOTE_GATEWAY_URL = 'https://karmax.example.test/';
    const world = fakeWorld();

    const seeded = await seedRemoteAgentHome(world, 'codex', localHome);
    const remoteHome = remoteAgentHomeRelative('codex', localHome);

    expect(seeded.absolute).toBe(`/workspace/${remoteHome}`);
    expect(world.files.get(`${remoteHome}/auth.json`)?.toString()).toContain('subscription');
    expect(world.files.get(`${remoteHome}/skills/review/SKILL.md`)?.toString()).toBe('review skill');
    expect(world.files.has(`${remoteHome}/sessions/host-task.jsonl`)).toBe(false);
    expect(world.files.has(`${remoteHome}/logs_2.sqlite`)).toBe(false);
    expect(world.files.has(`${remoteHome}/plugins/cache/large/asset.bin`)).toBe(false);
    const config = world.files.get(`${remoteHome}/config.toml`)?.toString() ?? '';
    expect(config).toContain('[notice]');
    expect(config).not.toContain('/host/node');
    expect(config).toContain('https://karmax.example.test');
    const platformBundle = world.files.get('.karmax-injection/agent/tools/platform-mcp/karmax-mcp.cjs');
    expect(platformBundle?.length).toBeGreaterThan(10_000);
    // Execute the exact seeded artifact. Bundling Zod v4 into this bridge once
    // produced a syntactically valid file that crashed before MCP initialize,
    // leaving Codex with a named `karmax` server and zero tools.
    const probeDir = path.join(localHome, 'bundle-probe');
    fs.mkdirSync(probeDir);
    fs.writeFileSync(path.join(probeDir, 'karmax-mcp.cjs'), platformBundle!);
    fs.symlinkSync(path.resolve('node_modules'), path.join(probeDir, 'node_modules'), 'dir');
    const handshake = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ].map((message) => JSON.stringify(message)).join('\n') + '\n';
    const probe = spawnSync(process.execPath, [path.join(probeDir, 'karmax-mcp.cjs')],
      { input: handshake, encoding: 'utf8', timeout: 10_000 });
    expect(probe.status, probe.stderr).toBe(0);
    expect(probe.stdout).toContain('"name":"list_events"');
    world.files.set(`${remoteHome}/auth.json`, Buffer.from('{"tokens":{"access_token":"refreshed-remotely"}}'));
    await seedRemoteAgentHome(world, 'codex', localHome);
    expect(world.files.get(`${remoteHome}/auth.json`)?.toString()).toContain('refreshed-remotely');
    expect(world.commands.some((command) => command.includes('find') && command.includes('chmod 600'))).toBe(true);
    await seedRemoteAgentHome(world, 'codex', localHome, 'host-task');
    expect(world.files.get(`${remoteHome}/sessions/host-task.jsonl`)?.toString()).toBe('host-only conversation');
  });

  it('passes only the remote home and explicit turn-scoped environment', () => {
    expect(remoteAgentEnv('claude', '/workspace/.karmax-injection/agent/claude', {
      PATH: '/host/bin', HOME: '/host/home', OPENAI_API_KEY: 'wrong-account',
      CLAUDE_CODE_OAUTH_TOKEN: 'subscription', KARMAX_TOKEN: 'turn-token',
    })).toEqual({
      CLAUDE_CONFIG_DIR: '/workspace/.karmax-injection/agent/claude',
      CLAUDE_CODE_OAUTH_TOKEN: 'subscription', KARMAX_TOKEN: 'turn-token',
    });
    expect(remoteAgentCommand('claude', '/usr/bin/node', ['/host/sdk/cli.js', '--resume', 's']).args)
      .toEqual(expect.arrayContaining(['@anthropic-ai/claude-code@2.1.212', '--resume', 's']));
    expect(remoteAgentCommand('codex', 'codex', ['app-server']).args)
      .toEqual(expect.arrayContaining(['@openai/codex@0.144.5', 'app-server']));
  });

  it('isolates rotated accounts and exports refreshed auth plus native sessions', async () => {
    const first = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-account-a-'));
    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-account-b-'));
    localHome = first;
    fs.writeFileSync(path.join(first, 'auth.json'), '{"account":"a-old"}');
    fs.writeFileSync(path.join(second, 'auth.json'), '{"account":"b"}');
    process.env.KARMAX_REMOTE_GATEWAY_URL = 'https://karmax.example.test';
    const world = fakeWorld();
    const a = await seedRemoteAgentHome(world, 'codex', first);
    const b = await seedRemoteAgentHome(world, 'codex', second);
    expect(a.relative).not.toBe(b.relative);
    expect(world.files.get(`${a.relative}/auth.json`)?.toString()).toContain('a-old');
    expect(world.files.get(`${b.relative}/auth.json`)?.toString()).toContain('"b"');
    world.files.set(`${a.relative}/auth.json`, Buffer.from('{"account":"a-refreshed"}'));
    world.files.set(`${a.relative}/sessions/2026/session-a.jsonl`, Buffer.from('durable native session'));
    await syncRemoteAgentHome(world, 'codex', a, first);
    expect(fs.readFileSync(path.join(first, 'auth.json'), 'utf8')).toContain('a-refreshed');
    expect(fs.readFileSync(path.join(first, 'sessions/2026/session-a.jsonl'), 'utf8')).toBe('durable native session');
    fs.rmSync(second, { recursive: true, force: true });
  });

  it('rewrites a selected browser MCP to the probed sandbox-local headless runtime', async () => {
    localHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-remote-browser-'));
    fs.writeFileSync(path.join(localHome, '.claude.json'), JSON.stringify({ mcpServers: {
      'chrome-devtools': { command: 'npx', args: ['-y', 'chrome-devtools-mcp'] },
    } }));
    const seeded = await seedRemoteAgentHome(fakeWorld(false, true), 'claude', localHome);
    expect(seeded.browserMcp?.['chrome-devtools']).toMatchObject({
      command: '/opt/karmax/bin/chrome-devtools-mcp',
      args: expect.arrayContaining(['--headless', '--isolated', '--chromeArg=--no-sandbox']),
      env: { PLAYWRIGHT_BROWSERS_PATH: '/opt/karmax/browsers' },
    });
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
    fs.writeFileSync(path.join(localHome, 'auth.json'), '{"auth_mode":"chatgpt"}');
    process.env.KARMAX_REMOTE_GATEWAY_URL = 'https://karmax.example.test';
    const world = fakeWorld(true);
    const sessions: string[] = [];

    const result = await new CodexAdapter().runTurn({
      profile: { id: 'p', name: 'codex', provider: 'codex', role: 'do', capabilities: [] },
      world,
      messages: [{ id: 'm', role: 'user', text: 'edit the repository', ts: 0 }],
      systemPrompt: 'Do the task.', role: 'do', resolvedAuth: { configHome: localHome },
    } as any, { emit() {}, emitActivity() {}, onSession: (id: string) => sessions.push(id) } as any);

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
  });
});

function fakeWorld(appServer = false, browserReady = false): World & {
  files: Map<string, Buffer>; commands: string[]; openedPty?: WorldPtySpec;
} {
  const files = new Map<string, Buffer>();
  const commands: string[] = [];
  const world: World & { files: Map<string, Buffer>; commands: string[]; openedPty?: WorldPtySpec } = {
    files, commands,
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
            if (request.method === 'initialize') send({ id: request.id, result: {} });
            else if (request.method === 'mcpServerStatus/list') send({ id: request.id, result: { data: [
              { name: 'karmax', authStatus: 'unsupported', resourceTemplates: [], resources: [],
                tools: { list_events: { name: 'list_events', inputSchema: { type: 'object' } } } },
            ], nextCursor: null } });
            else if (request.method === 'thread/start') send({ id: request.id, result: { thread: { id: 'remote-thread' } } });
            else if (request.method === 'turn/start') {
              send({ id: request.id, result: { turn: { id: 'remote-turn' } } });
              send({ method: 'turn/started', params: { turn: { id: 'remote-turn' } } });
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
