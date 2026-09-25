import { ProjectResourceService } from '../src/world/resources.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter, codexDynamicTools } from '../src/agent/codex.js';
import { ensureRemoteBrowser, installedClaudeCodeVersion, materializeRemoteSession, remoteAgentCommand, remoteAgentEnv,
  remoteAgentHomeRelative, seedRemoteAgentHome, syncRemoteAgentHome,
  reconcileRemoteCodexSessionCopies, RemoteSpawnedProcess, CODEX_REMOTE_REFRESH_SENTINEL, installMemoryGuard,
  spawnRemoteAgentProcess } from '../src/agent/remote-process.js';
import { ensureClaudeAccessTokenFresh } from '../src/agent/usage.js';
import { isTransportError } from '../src/agent/limits.js';
import type { World, WorldPty, WorldPtySpec, WorldPtyTermination } from '../src/world/types.js';

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
    expect(JSON.parse(world.files.get(`${remoteHome}/auth.json`)!.toString()).tokens.refresh_token)
      .toBe(CODEX_REMOTE_REFRESH_SENTINEL);
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
    expect(world.files.get(`${remoteHome}/sessions/forked/host-task.jsonl`)?.toString()).toBe('host-only conversation');
  });

  it('keeps a managed runtime even when task-installed system Node reports a modern version', async () => {
    localHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-runtime-'));
    const world = fakeWorld();
    // All commands, including an ambient version probe, report success.
    const first = await seedRemoteAgentHome(world, 'codex', localHome);
    const second = await seedRemoteAgentHome(world, 'codex', localHome);
    expect(first.runtimeBin).toBe('/workspace/.karmax-injection/agent/tools/node-22.16.0/bin');
    expect(second.runtimeBin).toBe(first.runtimeBin);
    expect(world.commands.filter((command) => command.includes('ln -sfnT') && command.includes('/usr/local/bin/node'))).toHaveLength(2);
  });

  it('bounds parallel config uploads and settles them before protecting the home', async () => {
    localHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-parallel-home-'));
    fs.mkdirSync(path.join(localHome, 'skills'));
    for (let i = 0; i < 21; i++) fs.writeFileSync(path.join(localHome, 'skills', `${i}.md`), `skill-${i}`);
    const world = fakeWorld();
    const write = world.writeFileBuffer!.bind(world);
    let active = 0, peak = 0;
    world.writeFileBuffer = async (file, content) => {
      peak = Math.max(peak, ++active);
      try { await new Promise(resolve => setTimeout(resolve, 1)); await write(file, content); }
      finally { active--; }
    };
    const exec = world.exec.bind(world);
    world.exec = async (command, args, options) => {
      if (args?.some(arg => arg.includes('chmod 600'))) expect(active).toBe(0);
      return exec(command, args, options);
    };
    const home = await seedRemoteAgentHome(world, 'claude', localHome);
    expect(peak).toBe(8);
    expect(active).toBe(0);
    for (let i = 0; i < 21; i++) expect(world.files.get(`${home.relative}/skills/${i}.md`)?.toString()).toBe(`skill-${i}`);
  });

  it('reports when a sandbox cannot expose the managed toolchain', async () => {
    localHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-runtime-'));
    const world = fakeWorld();
    const exec = world.exec.bind(world);
    world.exec = async (command, args = [], options) => args.some((arg) => arg.includes('ln -sfnT') && arg.includes('/usr/local/bin/node'))
      ? { code: 1, stdout: '', stderr: 'sudo: a password is required' }
      : exec(command, args, options);
    await expect(seedRemoteAgentHome(world, 'claude', localHome)).rejects.toThrow(
      'could not make managed Node/npm the sandbox default');
  });

  it('probes baked browser packages without an out-of-world working directory', async () => {
    const world = fakeWorld();
    world.exec = async (_command, args = [], options) => {
      if (options?.cwd && !options.cwd.startsWith('/workspace')) throw new Error('path must be relative to the world');
      if (args.includes('-e')) {
        expect(options?.env?.NODE_PATH).toBe('/opt/karmax/browser/node_modules');
        return { code: 0, stdout: '/opt/karmax/browsers/chromium', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    const result = await ensureRemoteBrowser(world, 'playwright');
    expect(result.playwright?.command).toBe('/opt/karmax/bin/playwright-mcp');
    expect(result.playwright?.env?.PLAYWRIGHT_BROWSERS_PATH).toBe('/opt/karmax/browsers');
  });

  it('delivers remote stderr before close, including when diagnostics cannot be read', async () => {
    for (const readable of [true, false]) {
      let exit!: (code: number | null) => void;
      const world = fakeWorld();
      world.openPty = async () => ({
        onData: () => () => {}, onExit: (listener) => { exit = listener; return () => {}; },
        write: async () => {}, resize: async () => {}, close: async () => {},
      });
      world.exec = async () => {
        if (!readable) throw new Error('sandbox unavailable');
        return { code: 0, stdout: 'npm ENOENT: missing node/lib', stderr: '' };
      };
      const child = new RemoteSpawnedProcess(world, 'command', '/workspace', {}, undefined, '/home/agent-stderr.log');
      let diagnostic = '';
      child.stderr.on('data', (chunk) => { diagnostic += chunk; });
      const closed = new Promise<void>((resolve) => child.once('close', (code) => {
        expect(code).toBe(254);
        expect(diagnostic).toBe(readable ? 'npm ENOENT: missing node/lib' : '');
        resolve();
      }));
      await Promise.resolve();
      exit(254);
      await closed;
    }
  });

  // Tasks 348/349: a 2 GB sandbox spent ~150 MB on an `npm exec` process that
  // only waited for Claude, and nothing stopped a runaway command from freezing it.
  it('runs the paired CLI without a resident npm and starts the memory guard', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-remote-spawn-'));
    const stubs = path.join(root, 'stubs');
    const injection = path.join(root, '.karmax-injection', 'agent');
    const home = path.join(injection, 'claude', 'home');
    fs.mkdirSync(stubs); fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(stubs, 'npx'), `#!/bin/sh\ncase "$*" in *'-c command -v claude') echo ${stubs}/claude ;; *) echo "npx ran the agent" >&2; exit 9 ;; esac\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(stubs, 'claude'), '#!/bin/sh\necho "parent=$(cat /proc/$PPID/comm) args=$*"\n', { mode: 0o755 });
    let spec: WorldPtySpec | undefined;
    const world = { handle: { root, id: 'spawn' }, async exec(command: string, args: string[], options: { timeoutMs?: number }) {
      const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: options.timeoutMs });
      return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    }, async writeFile(file: string, content: string) {
      fs.writeFileSync(path.join(root, file), content);
    }, async openPty(options: WorldPtySpec) {
      spec = options;
      return { onData: () => () => {}, onExit: () => () => {}, write: async () => {}, resize: async () => {}, close: async () => {} };
    } } as unknown as World;
    try {
      await installMemoryGuard(world);
      const child = spawnRemoteAgentProcess({ world, provider: 'claude', command: '/sdk/claude', args: ['--output-format', 'stream-json'],
        cwd: root, env: { CLAUDE_CONFIG_DIR: home } });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const run = spawnSync('bash', ['-c', spec!.command!], { cwd: root, encoding: 'utf8',
        env: { ...process.env, ...spec!.env, PATH: `${stubs}:${process.env.PATH}` } });
      expect(run.stdout).toContain('\u001eKARMAX_AGENT_READY\u001e');
      expect(run.stdout).toContain('parent=node args=--print --output-format stream-json');
      const snapshot = await child.startupDiagnostics() as any;
      expect(snapshot.sandbox.status).toBe('ok');
      expect(snapshot.sandbox.steps.map((step: any) => step.phase)).toEqual([
        'shell-started', 'previous-process-check', 'previous-process-stopped', 'protocol-ready',
        'cli-version-check', 'cli-resolve', 'cli-exec', 'relay-started', 'child-spawned', 'child-exited',
      ]);
      expect(snapshot.sandbox.steps.at(-1).exitCode).toBe(0);
      expect(snapshot.sandbox.memory.totalKb).toBeGreaterThan(0);
      const journals = fs.readdirSync(home).filter(file => file.startsWith('startup-'));
      expect(journals).toHaveLength(1);
      expect(fs.statSync(path.join(home, journals[0]!)).mode & 0o777).toBe(0o600);
      const guardPid = Number(fs.readFileSync(path.join(injection, 'memory-guard.pid'), 'utf8'));
      expect(spawnSync('kill', ['-0', String(guardPid)]).status).toBe(0);
      process.kill(guardPid, 'SIGTERM');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  // Tasks 361/362: Daytona types the launcher into an interactive shell whose
  // terminal is still in canonical mode, where the kernel keeps only 4095 bytes
  // of a line. The ~9 KiB Claude launcher lost its tail, the shell waited for a
  // closing quote, and the agent never started. Drive a real kernel PTY.
  it.skipIf(spawnSync('script', ['--version']).status !== 0)('starts the agent through a canonical-mode PTY that truncates long lines', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-remote-canonical-'));
    const stubs = path.join(root, 'stubs');
    const home = path.join(root, '.karmax-injection', 'agent', 'claude', 'home');
    fs.mkdirSync(stubs); fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(stubs, 'npx'), `#!/bin/sh\necho ${stubs}/claude\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(stubs, 'claude'), '#!/bin/sh\nread line; echo "agent received $line"\n', { mode: 0o755 });
    let typed = '';
    const world = { handle: { root, id: 'canonical' },
      async exec(command: string, args: string[]) {
        const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
        return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
      },
      async writeFile(file: string, content: string) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), content);
      },
      async openPty(spec: WorldPtySpec): Promise<WorldPty> {
        // A plain `sh` has no line editor, so the terminal stays canonical.
        const terminal = spawn('script', ['-qefc', 'sh', '/dev/null'], { cwd: root,
          env: { ...process.env, ...spec.env, PATH: `${stubs}:${process.env.PATH}` } });
        typed = spec.command ?? '';
        terminal.stdin.write(`${typed}\n`);
        return {
          onData: (listener) => { const read = (data: Buffer) => listener(data.toString()); terminal.stdout.on('data', read); return () => terminal.stdout.off('data', read); },
          onExit: (listener) => { terminal.once('exit', (code) => listener(code)); return () => {}; },
          write: async (data) => { terminal.stdin.write(data); },
          resize: async () => {},
          close: async () => { terminal.kill('SIGKILL'); },
        };
      } } as unknown as World;
    try {
      const child = spawnRemoteAgentProcess({ world, provider: 'claude', command: '/sdk/claude',
        args: ['--output-format', 'stream-json'], cwd: root, env: { CLAUDE_CONFIG_DIR: home } });
      let output = '';
      child.stdout.on('data', (data) => { output += data; });
      child.stdin.write('{"type":"control_request"}\n');
      const exited = new Promise((resolve) => child.once('exit', resolve));
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 15_000))]);
      expect(output).toContain('agent received {"type":"control_request"}');
      expect(Buffer.byteLength(typed)).toBeLessThan(1024);
      await child.stop().catch(() => undefined);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  it('reports a signal as a signal and a lost sandbox stream as a transport failure, never as exit -1', async () => {
    const ending = async (termination: WorldPtyTermination) => {
      let exit!: (code: number | null, termination?: WorldPtyTermination) => void;
      const world = fakeWorld();
      world.openPty = async () => ({
        onData: () => () => {}, onExit: (listener) => { exit = listener; return () => {}; },
        write: async () => {}, resize: async () => {}, close: async () => {},
      });
      world.exec = async () => ({ code: 0, stdout: '', stderr: '' });
      const child = new RemoteSpawnedProcess(world, 'command', '/workspace', {}, undefined, '/home/agent-stderr.log');
      const exited = new Promise<unknown[]>((resolve) => child.once('exit', (...args) => resolve(args)));
      await Promise.resolve();
      exit(null, termination);
      return { args: await exited, lost: child.lost };
    };
    expect(await ending({ signal: 'SIGKILL' })).toEqual({ args: [null, 'SIGKILL'], lost: undefined });
    const cause = new Error('[unavailable] upstream connect error or disconnect/reset before headers');
    const { args, lost } = await ending({ lost: cause });
    expect(args).toEqual([null, null]);
    expect(lost?.message).toBe(`lost the connection to the agent in the sandbox; it may still be running there (${cause.message})`);
    expect(lost?.cause).toBe(cause);
    expect(isTransportError(lost)).toBe(true);
  });

  it('keeps Claude refresh authority on the control plane across parallel worlds', async () => {
    localHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-remote-claude-auth-'));
    const credential = {
      claudeAiOauth: {
        accessToken: 'shared-access', refreshToken: 'single-use-refresh',
        expiresAt: Date.now() + 60_000, refreshTokenExpiresAt: Date.now() + 86_400_000,
      },
    };
    fs.writeFileSync(path.join(localHome, '.credentials.json'), JSON.stringify(credential));
    const first = fakeWorld();
    const second = fakeWorld();

    const [a, b] = await Promise.all([
      seedRemoteAgentHome(first, 'claude', localHome),
      seedRemoteAgentHome(second, 'claude', localHome),
    ]);
    for (const [world, home] of [[first, a], [second, b]] as const) {
      const projected = JSON.parse(world.files.get(`${home.relative}/.credentials.json`)!.toString());
      expect(projected.claudeAiOauth.accessToken).toBe('shared-access');
      expect(projected.claudeAiOauth.refreshToken).toBeUndefined();
      expect(projected.claudeAiOauth.refreshTokenExpiresAt).toBeUndefined();
    }

    // A stale task-local credential can never replace the canonical login later.
    first.files.set(`${a.relative}/.credentials.json`, Buffer.from(JSON.stringify({
      claudeAiOauth: { accessToken: 'task-local', refreshToken: 'task-local-refresh', expiresAt: Date.now() + 120_000 },
    })));
    await syncRemoteAgentHome(first, 'claude', a, localHome);
    expect(fs.readFileSync(path.join(localHome, '.credentials.json'), 'utf8')).toBe(JSON.stringify(credential));
  });

  it('refreshes the canonical Claude login before projecting it without refresh authority', async () => {
    localHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-remote-claude-preflight-'));
    fs.writeFileSync(path.join(localHome, '.credentials.json'), JSON.stringify({ claudeAiOauth: {
      accessToken: 'expired-access', refreshToken: 'canonical-refresh', expiresAt: Date.now() - 1,
    } }));
    await ensureClaudeAccessTokenFresh({
      configHome: localHome,
      minValidityMs: 60_000,
      run: async () => {
        fs.writeFileSync(path.join(localHome!, '.credentials.json'), JSON.stringify({ claudeAiOauth: {
          accessToken: 'fresh-access', refreshToken: 'rotated-canonical-refresh',
          expiresAt: Date.now() + 3_600_000,
        } }));
        return '';
      },
    });

    const world = fakeWorld();
    const seeded = await seedRemoteAgentHome(world, 'claude', localHome);
    const projected = JSON.parse(world.files.get(`${seeded.relative}/.credentials.json`)!.toString());
    expect(projected.claudeAiOauth.accessToken).toBe('fresh-access');
    expect(projected.claudeAiOauth.refreshToken).toBeUndefined();
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
      .toEqual(expect.arrayContaining(['@openai/codex@0.156.1', 'app-server']));
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
    expect(fs.readFileSync(path.join(first, 'sessions/forked/session-a.jsonl'), 'utf8')).toBe('durable native session');
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
      command: `${seeded.runtimeBin}/node`,
      args: ['/workspace/.karmax-injection/agent/chrome-cdp-launcher.mjs'],
      env: {
        PLAYWRIGHT_BROWSERS_PATH: '/opt/karmax/browsers',
        KARMAX_CDP_MCP_BIN: '/opt/karmax/bin/chrome-devtools-mcp',
        KARMAX_CDP_CHROME: '/opt/karmax/browsers/chromium',
        KARMAX_CDP_NO_SANDBOX: '1',
        KARMAX_CDP_SET_OVERCOMMIT: '1',
        KARMAX_CDP_KEEP_ALIVE: '1',
        KARMAX_CDP_USER_DATA_DIR: '/workspace/.karmax-injection/agent/browser-profile',
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

  it('transfers nested Codex lineage, then restores it from the durable home', async () => {
    localHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-remote-lineage-'));
    const source = fakeWorld(), destination = fakeWorld();
    const prefix = '.karmax-injection/agent/codex/source-account';
    const rollout = (id: string, base?: string) => Buffer.from(JSON.stringify({ type: 'session_meta',
      payload: { id, history_mode: 'paginated', ...(base ? { history_base: {
        thread_id: base, end_ordinal_exclusive: 2, end_byte_offset: 300,
      } } : {}) } }) + '\n');
    source.files.set(`${prefix}/sessions/rollout-leaf-session.jsonl`, rollout('leaf-session', 'parent-session'));
    source.files.set(`${prefix}/sessions/rollout-parent-session.jsonl`, rollout('parent-session', 'root-session'));
    source.files.set(`${prefix}/archived_sessions/rollout-root-session.jsonl`, rollout('root-session'));
    source.files.set(`${prefix}/sessions/rollout-unrelated.jsonl`, rollout('unrelated'));
    expect(await materializeRemoteSession(source, destination, 'codex', 'leaf-session', localHome)).toBe(true);
    const home = remoteAgentHomeRelative('codex', localHome);
    expect([...destination.files.keys()].filter((file) => !file.endsWith('.karmax-history-publish.sqlite')).sort()).toEqual(['leaf-session', 'parent-session', 'root-session']
      .map((id) => `${home}/sessions/forked/rollout-${id}.jsonl`).sort());
    expect(destination.files.get(`${home}/sessions/forked/rollout-parent-session.jsonl`))
      .toEqual(rollout('parent-session', 'root-session'));
    // Codex may archive an ancestor before the world is checkpointed.
    destination.files.set(`${home}/archived_sessions/rollout-root-session.jsonl`,
      destination.files.get(`${home}/sessions/forked/rollout-root-session.jsonl`)!);
    destination.files.delete(`${home}/sessions/forked/rollout-root-session.jsonl`);
    await syncRemoteAgentHome(destination, 'codex', { absolute: `/workspace/${home}`, relative: home }, localHome);
    const restored = fakeWorld();
    await seedRemoteAgentHome(restored, 'codex', localHome, 'leaf-session');
    for (const [file, content] of destination.files) if (!file.includes('.karmax-history-publish.sqlite')) expect(restored.files.get(`${home}/sessions/forked/${path.basename(file)}`)).toEqual(content);
  });

  it.each(['missing', 'cycle'])('rejects %s remote lineage without exposing a partial session', async (kind) => {
    localHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-remote-lineage-'));
    const source = fakeWorld(), destination = fakeWorld();
    source.files.set('.karmax-injection/agent/codex/source/sessions/rollout-leaf-session.jsonl',
      Buffer.from(JSON.stringify({ type: 'session_meta', payload: { history_base: {
        thread_id: kind === 'cycle' ? 'leaf-session' : 'missing-session',
      } } })));
    // A different account must not satisfy this dependency.
    source.files.set('.karmax-injection/agent/codex/other/sessions/rollout-missing-session.jsonl', Buffer.from('{}'));
    await expect(materializeRemoteSession(source, destination, 'codex', 'leaf-session', localHome)).rejects.toThrow(/missing ancestor|cyclic lineage/);
    expect(destination.files.size).toBe(0);
  });

  it('repairs prefix-compatible aliases throughout the requested lineage only', async () => {
    localHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-remote-aliases-'));
    const world = fakeWorld();
    const relative = remoteAgentHomeRelative('codex', localHome);
    const meta = (base?: string) => JSON.stringify({ type: 'session_meta', payload: {
      ...(base ? { history_base: { thread_id: base } } : {}),
    } }) + '\n';
    const leaf = meta('root-session'), root = meta();
    world.files.set(`${relative}/sessions/forked/rollout-leaf-session.jsonl`, Buffer.from(leaf + '{}\n'));
    world.files.set(`${relative}/sessions/dated/rollout-leaf-session.jsonl`, Buffer.from(leaf));
    world.files.set(`${relative}/sessions/forked/rollout-root-session.jsonl`, Buffer.from(root + '{}\n'));
    world.files.set(`${relative}/archived_sessions/rollout-root-session.jsonl`, Buffer.from(root));
    world.files.set(`${relative}/sessions/rollout-unrelated-session.jsonl`, Buffer.from('unrelated'));
    await reconcileRemoteCodexSessionCopies(world, { relative, absolute: `/workspace/${relative}` }, 'leaf-session');
    expect([...world.files.keys()].filter((file) => !file.includes('.karmax-history-backups') && !file.endsWith('.karmax-history-publish.sqlite')).sort()).toEqual([
      `${relative}/sessions/forked/rollout-leaf-session.jsonl`,
      `${relative}/sessions/forked/rollout-root-session.jsonl`,
      `${relative}/sessions/rollout-unrelated-session.jsonl`,
    ].sort());
  });

  it('preserves all copies when a lineage ancestor contains divergent bytes', async () => {
    localHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-remote-aliases-'));
    const world = fakeWorld();
    const relative = remoteAgentHomeRelative('codex', localHome);
    const leaf = JSON.stringify({ type: 'session_meta', payload: { history_base: { thread_id: 'root-session' } } });
    world.files.set(`${relative}/sessions/forked/rollout-leaf-session.jsonl`, Buffer.from(leaf + '\n'));
    world.files.set(`${relative}/sessions/dated/rollout-leaf-session.jsonl`, Buffer.from(leaf));
    world.files.set(`${relative}/sessions/forked/rollout-root-session.jsonl`, Buffer.from('{}\nnewer'));
    world.files.set(`${relative}/sessions/dated/rollout-root-session.jsonl`, Buffer.from('{}\nother'));
    const before = new Map(world.files);
    await expect(reconcileRemoteCodexSessionCopies(world, { relative, absolute: `/workspace/${relative}` }, 'leaf-session'))
      .rejects.toThrow('histories diverge');
    expect(world.files).toEqual(before);
    expect(world.commands.some((command) => command.startsWith('rm '))).toBe(false);
  });

  it('runs Codex app-server inside the remote PTY with the seeded subscription', async () => {
    localHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-remote-codex-'));
    fs.writeFileSync(path.join(localHome, 'auth.json'), freshCodexAuth());
    const world = fakeWorld(true);
    const secretEnv = { OPENAI_API_KEY: 'project-key', DATABASE_URL: 'project-db', NODE_OPTIONS: '--invalid-project-option' };
    const decoratedWorld = await ProjectResourceService.prototype.withEnvironment.call({ environmentFor: async () => secretEnv } as any, world);
    const sessions: string[] = [];
    const platformCalls: string[] = [];

    const result = await new CodexAdapter().runTurn({
      profile: { id: 'p', name: 'codex', provider: 'codex', role: 'do', capabilities: [] },
      world: decoratedWorld, secretEnv,
      messages: [{ id: 'm', role: 'user', text: 'edit the repository', ts: 0 }],
      systemPrompt: 'Do the task.', role: 'do', resolvedAuth: { configHome: localHome },
    } as any, { emit() {}, emitActivity() {}, onSession: (id: string) => sessions.push(id),
      platformRequest: async (method: string, requestPath: string) => { platformCalls.push(`${method} ${requestPath}`); return [{ type: 'ok' }]; } } as any);

    expect(result).toMatchObject({ termination: { kind: 'success', status: 'completed' }, session: '22222222-2222-4222-8222-222222222222', output: 'done remotely' });
    // The PTY only receives a short line; the launcher arrives through the file API.
    const launcher = world.openedPty?.command?.match(/^exec sh '\/workspace\/([^']+)'$/)?.[1];
    expect(launcher).toMatch(/^\.karmax-injection\/agent\/codex\/[0-9a-f]+\/launch-[0-9a-f-]+\.sh$/);
    const script = world.files.get(launcher!)?.toString() ?? '';
    expect(script).toContain('@openai/codex@0.156.1');
    expect(script).toContain('/opt/karmax/bin/codex');
    expect(script).toContain('app-server');
    expect(script).toContain('stty raw -echo');
    expect(script).toContain('exec sh -c');
    expect(script).toContain('karmax-agent.pid');
    expect(script).not.toContain('\u001eKARMAX_AGENT_READY\u001e');
    expect(spawnSync('sh', ['-n', '-c', script]).status).toBe(0);
    expect(world.openedPty?.env?.DATABASE_URL).toBeUndefined();
    expect(world.openedPty?.env?.NODE_OPTIONS).not.toBe('--invalid-project-option');
    expect(world.openedPty?.env?.OPENAI_API_KEY).toBe('');
    const remoteHome = remoteAgentHomeRelative('codex', localHome);
    expect(world.openedPty?.env).toMatchObject({ CODEX_HOME: `/workspace/${remoteHome}` });
    expect(world.files.get(`${remoteHome}/auth.json`)?.toString()).toContain('chatgpt');
    expect(sessions).toContain('22222222-2222-4222-8222-222222222222');
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
      session: '22222222-2222-4222-8222-222222222222', output: 'done remotely',
    });
    expect(activities).toContainEqual(expect.objectContaining({
      kind: 'error', phase: 'failed', title: expect.stringMatching(/remote Codex state/i),
      detail: expect.stringContaining('Request handshake timed out'),
    }));
  });

  it.each(['new', 'resume', 'fork', 'cancelled'])('centrally refreshes and resumes once when a remote access-only token expires (%s)', async (mode) => {
    const fork = mode === 'fork';
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
    if (mode !== 'new') writeFakeHistory(world, localHome, '11111111-1111-4111-8111-111111111111');
    const activities: any[] = [];
    const controller = new AbortController();

    const result = await new CodexAdapter().runTurn({
      profile: { id: 'p', name: 'codex', provider: 'codex', role: 'do', capabilities: [] },
      world, session: mode === 'new' ? undefined : '11111111-1111-4111-8111-111111111111', fork,
      messages: [{ id: 'm', role: 'user', text: 'continue safely', ts: 0 }],
      systemPrompt: 'Do the task.', role: 'do', resolvedAuth: { configHome: localHome },
    } as any, { signal: controller.signal, emit() {}, emitActivity: (activity: any) => {
      activities.push(activity);
      if (mode === 'cancelled' && activity.id === 'codex-credential-recovery' && activity.phase === 'started') controller.abort();
    },
      platformRequest: async () => [{ type: 'ok' }] } as any).catch(error => error);

    if (mode === 'cancelled') {
      expect(result).toBeInstanceOf(Error);
      expect(world.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
      return;
    }

    expect(result).toMatchObject({ termination: { kind: 'success' }, session: fork ? '33333333-3333-4333-8333-333333333333' : mode === 'new' ? '22222222-2222-4222-8222-222222222222' : '11111111-1111-4111-8111-111111111111' });
    expect(world.requests.filter((request) => request.method === 'turn/start')).toHaveLength(2);
    expect(world.requests.filter((request) => request.method === 'thread/fork')).toHaveLength(fork ? 1 : 0);
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
    expect(projected.tokens.refresh_token).toBe(CODEX_REMOTE_REFRESH_SENTINEL);
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
    const original = fs.readFileSync(path.join(directory, `rollout-${session}.jsonl`));
    expect(world.files.get(`${remoteHome}/sessions/forked/rollout-${session}.jsonl`)).toEqual(original);
    const prepared = world.requests.find((request) => request.method === method).params.threadId;
    expect(prepared).not.toBe(session);
    const rollout = world.files.get([...world.files.keys()].find((file) => file.endsWith(`${prepared}.jsonl`))!)!.toString();
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
      if (command === 'rm' && args[0] === '-f' && args[1] === '--') {
        for (const file of args.slice(2)) files.delete(file.replace('/workspace/', ''));
        return { stdout: '', stderr: '', code: 0 };
      }
      if (path.posix.basename(command) === 'node' && args[0] === '-e' && args[1]?.includes('.karmax-history-publish.sqlite')) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-remote-publish-'));
        try {
          for (const [file, content] of files) {
            const target = path.join(root, file);
            fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content);
          }
          const result = spawnSync(process.execPath, [args[0]!, args[1]!, ...args.slice(2).map((arg) => arg.replace('/workspace/', root + '/'))], { encoding: 'utf8' });
          files.clear();
          const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              const file = path.join(dir, entry.name);
              if (entry.isDirectory()) walk(file);
              else files.set(path.relative(root, file), fs.readFileSync(file));
            }
          };
          walk(root);
          return { stdout: result.stdout, stderr: result.stderr, code: result.status ?? 1 };
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
      }
      if (path.posix.basename(command) === 'node' && args[0] === '-e' && args[1]?.includes('process.versions.node'))
        return { stdout: '', stderr: '', code: 0 };
      if (browserReady && path.posix.basename(command) === 'node' && args[0] === '-e' && args[1]?.includes('executablePath'))
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
              writeFakeHistory(world, undefined, '22222222-2222-4222-8222-222222222222');
              send({ id: request.id, result: { thread: { id: '22222222-2222-4222-8222-222222222222' } } });
            }
            else if (request.method === 'thread/resume')
              send({ id: request.id, result: { thread: { id: request.params.threadId } } });
            else if (request.method === 'thread/fork') {
              writeFakeHistory(world, undefined, '33333333-3333-4333-8333-333333333333');
              send({ id: request.id, result: { thread: { id: '33333333-3333-4333-8333-333333333333' } } });
            }
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
              send({ id: 99, method: 'item/tool/call', params: { threadId: '22222222-2222-4222-8222-222222222222', turnId: 'remote-turn',
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

function writeFakeHistory(world: ReturnType<typeof fakeWorld>, localHome: string | undefined, id: string) {
  const prefix = localHome ? remoteAgentHomeRelative('codex', localHome)
    : String(world.openedPty?.env?.CODEX_HOME).replace('/workspace/', '');
  world.files.set(`${prefix}/sessions/forked/rollout-2026-09-09T00-00-00-${id}.jsonl`, Buffer.from(JSON.stringify({
    ordinal: 0, type: 'session_meta', payload: { id, timestamp: '2026-09-09T00:00:00Z', history_mode: 'paginated', dynamic_tools: codexDynamicTools(true) },
  }) + '\n'));
}
