import { ProjectResourceService } from '../src/world/resources.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sdkState = vi.hoisted(() => ({ messages: [] as any[], options: undefined as any,
  run: undefined as undefined | ((options: any) => AsyncGenerator<any>) }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (config: any) => ({ type: 'sdk', name: config.name, instance: {}, tools: config.tools }),
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
  query: (args: any) => {
    sdkState.options = args.options;
    if (sdkState.run) return sdkState.run(args.options);
    return (async function* () {
      for (const message of sdkState.messages) yield message;
    })();
  },
}));

import { ClaudeAdapter } from '../src/agent/claude.js';
import { CUSTODY_ENV } from '../src/agent/custody.js';
import { ProviderFailure, isTransportError } from '../src/agent/limits.js';
import { remoteAgentHomeRelative } from '../src/agent/remote-process.js';
import { localProviderCli } from '../src/agent/provider-cli.js';

const input: any = {
  profile: { id: 'p', name: 'claude', provider: 'claude', role: 'do', capabilities: [] },
  world: { handle: { id: 'w', root: '/tmp', branch: 'task', base: 'main' } },
  messages: [{ id: 'm', role: 'user', text: 'do the task', ts: 0 }],
  systemPrompt: 'Do the task.',
  role: 'do',
  resolvedAuth: { configHome: '/tmp/claude-terminal-test' },
};

const ctx: any = {
  signalCompletion() {},
  createReviewInfo() {},
  createSubTask() {},
  respondToSubTask() {},
  raiseToParent() {},
  waitForSubtasks() {},
  saveSkill() {},
  resolveDecision() {},
  confirmDecision() {},
  requestSpend: async () => ({ status: 'denied' }),
  emit() {},
};

describe('Claude Agent SDK terminal outcome contract', () => {
  beforeEach(() => { sdkState.messages = []; sdkState.options = undefined; sdkState.run = undefined; });

  it('retries a silent SDK startup without waiting for the 45-minute activity timeout', async () => {
    vi.useFakeTimers();
    // A lost startup can leave next() pending even after the SDK is aborted.
    sdkState.run = async function* () { await new Promise(() => {}); };
    let failure: any;
    const activities: any[] = [];
    try {
      const turn = new ClaudeAdapter().runTurn(input, { ...ctx, emitActivity(activity: any) {
        activities.push(activity);
        if (activity.id === 'claude-startup-diagnostics') expect(sdkState.options.abortController.signal.aborted).toBe(false);
      } }).catch(error => { failure = error; });
      await vi.waitFor(() => expect(sdkState.options).toBeDefined());
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toContain('Claude agent did not respond during startup');
      expect(isTransportError(failure)).toBe(true);
      expect(sdkState.options.abortController.signal.aborted).toBe(true);
      const diagnostic = activities.find(a => a.id === 'claude-startup-diagnostics');
      expect(diagnostic).toMatchObject({ kind: 'error', phase: 'failed', title: 'Agent startup stalled' });
      expect(JSON.parse(diagnostic.detail)).toMatchObject({ version: 1, remote: false, process: 'not-observed' });
      await turn;
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('removes the startup deadline after the first SDK event, including during quiet work', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const working = new Promise<void>(resolve => { finish = resolve; });
    sdkState.run = async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'started' };
      await working;
      yield { type: 'result', subtype: 'success', session_id: 'started' };
    };
    try {
      const onSession = vi.fn();
      const turn = new ClaudeAdapter().runTurn(input, { ...ctx, onSession });
      await vi.waitFor(() => expect(onSession).toHaveBeenCalledWith('started'));
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(sdkState.options.abortController.signal.aborted).toBe(false);
      finish();
      expect((await turn).termination.kind).toBe('success');
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('preserves diagnostic evidence and the original error for an early startup failure', async () => {
    const failure = new Error('spawn failed');
    sdkState.run = async function* () { throw failure; };
    const activities: any[] = [];
    await expect(new ClaudeAdapter().runTurn(input, { ...ctx, emitActivity: (activity: any) => { activities.push(activity); } }))
      .rejects.toBe(failure);
    const diagnostic = activities.find(a => a.id === 'claude-startup-diagnostics');
    expect(diagnostic.title).toBe('Agent startup failed');
    expect(JSON.parse(diagnostic.detail)).toMatchObject({ version: 1, reason: 'error', remote: false });
  });

  it('uses one stdio platform server plus a disjoint local-control server', async () => {
    sdkState.messages = [{ type: 'result', subtype: 'success', is_error: false, session_id: 's1', stop_reason: 'end_turn' }];
    await new ClaudeAdapter().runTurn({ ...input, extraEnv: { KARMAX_TOKEN: 'scoped' } }, ctx);
    expect(sdkState.options.strictMcpConfig).toBe(true);
    expect(sdkState.options.mcpServers.karmax).toMatchObject({
      command: process.execPath,
      env: expect.objectContaining({ KARMAX_TOKEN: 'scoped' }),
      alwaysLoad: true,
    });
    expect(sdkState.options.mcpServers.karmax_control).toMatchObject({ type: 'sdk', name: 'karmax_control' });
  });

  it('keeps project secrets out of the harness while preserving Tavya control env', async () => {
    sdkState.messages = [{ type: 'result', subtype: 'success', is_error: false, session_id: 's1', stop_reason: 'end_turn' }];
    await new ClaudeAdapter().runTurn({
      ...input,
      secretEnv: { DATABASE_URL: 'postgres://task-db', KARMAX_TOKEN: 'resource-value' },
      extraEnv: { KARMAX_TOKEN: 'scoped-turn-token' },
    }, ctx);
    expect(sdkState.options.env.DATABASE_URL).toBeUndefined();
    expect(sdkState.options.settings.hooks.SessionStart).toHaveLength(1);
    expect(JSON.stringify(sdkState.options.settings)).not.toContain('postgres://task-db');
    expect(sdkState.options.env).toMatchObject({
      KARMAX_TOKEN: 'scoped-turn-token',
    });
  });

  it('stamps locally spawned Claude processes with inherited custody', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-claude-custody-'));
    const output = path.join(home, 'custody.txt');
    const previousHome = process.env.KARMAX_HOME;
    process.env.KARMAX_HOME = home;
    sdkState.messages = [{ type: 'result', subtype: 'success', is_error: false, session_id: 's1', stop_reason: 'end_turn' }];
    try {
      await new ClaudeAdapter().runTurn(input, ctx);
      const child = sdkState.options.spawnClaudeCodeProcess({
        command: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(output)}, process.env.${CUSTODY_ENV} || '')`],
        cwd: home,
        env: { ...process.env },
        signal: new AbortController().signal,
      });
      await new Promise((resolve) => child.once('close', resolve));
      expect(fs.readFileSync(output, 'utf8')).toMatch(/[0-9a-f-]{36}$/i);
      const record = path.join(home, 'state', 'agents', `${child.pid}.json`);
      const deadline = Date.now() + 2000;
      while (fs.existsSync(record) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fs.existsSync(record)).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.KARMAX_HOME;
      else process.env.KARMAX_HOME = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([undefined, 'leased-setup-token'])('keeps project credentials from overriding the selected Claude login (%s)', async (oauthToken) => {
    sdkState.messages = [{ type: 'result', subtype: 'success', is_error: false, session_id: 's1' }];
    await new ClaudeAdapter().runTurn({
      ...input,
      resolvedAuth: { ...input.resolvedAuth, oauthToken },
      secretEnv: {
        ANTHROPIC_API_KEY: 'project-api-key', ANTHROPIC_AUTH_TOKEN: 'project-bearer',
        CLAUDE_CODE_OAUTH_TOKEN: 'different-account', DATABASE_URL: 'project-db',
      },
    }, ctx);
    expect(sdkState.options.env).toMatchObject({
      ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '',
      CLAUDE_CODE_OAUTH_TOKEN: oauthToken ?? '',
    });
  });

  it('the shipped Claude binary sees the subscription at the final local spawn boundary', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-claude-auth-'));
    fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: {
      accessToken: 'fixture-access', scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x', expiresAt: Date.now() + 3600_000,
    } }));
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
      oauthAccount: { emailAddress: 'fixture@example.com', organizationUuid: 'fixture-org' },
    }));
    sdkState.messages = [{ type: 'result', subtype: 'success', is_error: false, session_id: 's1' }];
    try {
      await new ClaudeAdapter().runTurn({ ...input, resolvedAuth: { configHome: home },
        secretEnv: { ANTHROPIC_API_KEY: 'project-api-key' } }, ctx);
      // auth status is local metadata only: no model request or real credentials.
      const child = sdkState.options.spawnClaudeCodeProcess({
        command: localProviderCli('claude'), args: ['auth', 'status', '--json'], cwd: home,
        env: { ...sdkState.options.env, ANTHROPIC_API_KEY: 'reintroduced-key' },
        signal: new AbortController().signal,
      });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => { output += chunk; });
      const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
      expect(code).toBe(0);
      const status = JSON.parse(output);
      expect(status).toMatchObject({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' });
      expect(status.apiKeySource).toBeUndefined();
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('returns only after an explicit SDK success result', async () => {
    sdkState.messages = [
      { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'done' }] } },
      { type: 'result', subtype: 'success', is_error: false, session_id: 's1', stop_reason: 'end_turn' },
    ];
    const turn = await new ClaudeAdapter().runTurn(input, ctx);
    expect(turn.termination).toEqual({ kind: 'success', status: 'success', reason: 'end_turn' });
    expect(turn.output).toBe('done');
  });

  it('selects the remote Claude spawn rail and keeps all platform tools available', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-remote-claude-'));
    fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: 'subscription', refreshToken: 'host-only-refresh', expiresAt: Date.now() + 60 * 60_000 },
    }));
    const files = new Map<string, Buffer>();
    let spawnedEnv: Record<string, string> | undefined;
    const world: any = {
      handle: { version: 2, kind: 'e2b', provider: 'e2b', sealedProviderRef: 'sealed', id: 'remote',
        root: '/workspace', branch: 'task', base: 'main' },
      async exec(_command: string, args: string[], options: any = {}) {
        expect(options.env?.NODE_OPTIONS).toBeUndefined();
        expect(options.env?.DATABASE_URL).toBeUndefined();
        if (args[1]?.includes('-type f -print')) return { stdout: '', stderr: '', code: 0 };
        return { stdout: '', stderr: '', code: 0 };
      },
      async writeFileBuffer(name: string, value: Buffer) { files.set(name, Buffer.from(value)); },
      async readFile(name: string) { const value = files.get(name); if (!value) throw new Error('missing'); return value.toString(); },
      async readFileBuffer(name: string) { const value = files.get(name); if (!value) throw new Error('missing'); return value; },
      async writeFile(name: string, value: string) { files.set(name, Buffer.from(value)); },
      async listFiles() { return [...files.keys()]; }, async destroy() {},
      async openPty(spec: any) {
        spawnedEnv = spec.env;
        let exit: (code: number) => void = () => {};
        return { onData: () => () => {}, onExit: (fn: typeof exit) => { exit = fn; return () => {}; },
          write: async () => {}, resize: async () => {}, close: async () => { exit(0); } };
      },
    };
    sdkState.messages = [{ type: 'result', subtype: 'success', is_error: false, session_id: 'remote-session', stop_reason: 'end_turn' }];
    try {
      const secretEnv = { ANTHROPIC_API_KEY: 'project-api-key', NODE_OPTIONS: '--invalid-project-option', DATABASE_URL: 'project-db' };
      const decoratedWorld = await ProjectResourceService.prototype.withEnvironment.call({ environmentFor: async () => secretEnv } as any, world);
      await new ClaudeAdapter().runTurn({ ...input, world: decoratedWorld, resolvedAuth: { configHome: home }, secretEnv }, ctx);
      expect(sdkState.options.env.ANTHROPIC_API_KEY).toBe('');
      const child = sdkState.options.spawnClaudeCodeProcess({ command: localProviderCli('claude'), args: [],
        env: { ...sdkState.options.env, ANTHROPIC_API_KEY: 'sdk-key' }, signal: new AbortController().signal });
      const closed = new Promise(resolve => child.once('close', resolve));
      child.kill();
      await closed;
      expect(spawnedEnv?.DATABASE_URL).toBeUndefined();
      expect(spawnedEnv?.NODE_OPTIONS).not.toBe('--invalid-project-option');
      expect(spawnedEnv).toMatchObject({ ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '' });
      expect(sdkState.options.spawnClaudeCodeProcess).toBeTypeOf('function');
      expect(sdkState.options).not.toHaveProperty('getOAuthToken');
      expect(sdkState.options.mcpServers.karmax).toBeUndefined();
      expect(sdkState.options.mcpServers.karmax_control.tools.map((tool: any) => tool.name))
        .toEqual(expect.arrayContaining(['message_agent', 'publish_task_branch', 'import_task_branch', 'refresh_upstream', 'propose_project_resource']));
      expect(files.get(`${remoteAgentHomeRelative('claude', home)}/.credentials.json`)?.toString()).toContain('subscription');
      expect(files.get(`${remoteAgentHomeRelative('claude', home)}/.credentials.json`)?.toString()).not.toContain('host-only-refresh');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  // Task 348: the sandbox froze, E2B dropped the PTY stream, and the SDK saw a
  // process "exit" with no code. The agent was in fact still running remotely.
  it('reports a lost sandbox connection rather than a process exit', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-remote-lost-'));
    const cause = new Error('[unavailable] upstream connect error or disconnect/reset before headers');
    const world: any = {
      handle: { version: 2, kind: 'e2b', provider: 'e2b', sealedProviderRef: 'sealed', id: 'remote',
        root: '/workspace', branch: 'task', base: 'main' },
      async exec() { return { stdout: '', stderr: '', code: 0 }; },
      async writeFileBuffer() {}, async writeFile() {}, async listFiles() { return []; }, async destroy() {},
      async readFile() { throw new Error('missing'); }, async readFileBuffer() { throw new Error('missing'); },
      async openPty() {
        return { onData: () => () => {}, write: async () => {}, resize: async () => {}, close: async () => {},
          onExit(listener: any) { setTimeout(() => listener(null, { lost: cause }), 0); return () => {}; } };
      },
    };
    sdkState.run = async function* (options: any) {
      const child = options.spawnClaudeCodeProcess({ command: 'claude', args: [], env: {}, signal: new AbortController().signal });
      await new Promise((resolve) => child.once('exit', resolve));
    };
    try {
      const failure = await new ClaudeAdapter().runTurn({ ...input, world, resolvedAuth: { configHome: home } }, ctx).catch((e) => e);
      expect(failure.message).toMatch(/^lost the connection to the agent in the sandbox; it may still be running there \(\[unavailable\]/);
      expect(failure.cause).toBe(cause);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('rejects an SDK error result even after partial assistant output', async () => {
    sdkState.messages = [
      { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'partial work' }] } },
      { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 's1', errors: ['stream disconnected'] },
    ];
    await expect(new ClaudeAdapter().runTurn(input, ctx)).rejects.toThrow(/error_during_execution.*stream disconnected/i);
  });

  it('types novel credit-exhaustion wording from an SDK error result', async () => {
    sdkState.messages = [
      {
        type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 's1',
        errors: ['Your prepaid balance has now been fully consumed.'],
      },
    ];
    const failure = await new ClaudeAdapter().runTurn(input, ctx).catch((e) => e);
    expect(failure).toBeInstanceOf(ProviderFailure);
    expect(failure.metadata).toMatchObject({
      kind: 'quota', permanence: 'hard', provider: 'claude', source: 'message',
    });
  });

  it('uses the structured assistant rate-limit signal even when the SDK result lies about success', async () => {
    sdkState.messages = [
      {
        type: 'assistant', session_id: 's1', error: 'rate_limit',
        message: { content: [{ type: 'text', text: "You've hit your session limit · resets 2:20am (America/Los_Angeles)" }] },
      },
      // This is the exact misleading terminal shape observed in task #183.
      { type: 'result', subtype: 'success', is_error: true, session_id: 's1', errors: ['completed'] },
    ];
    const failure = await new ClaudeAdapter().runTurn(input, ctx).catch((e) => e);
    expect(failure).toBeInstanceOf(ProviderFailure);
    expect(failure.metadata).toMatchObject({
      kind: 'quota', permanence: 'transient', provider: 'claude', source: 'structured', window: '5h',
    });
    expect(failure.metadata.resetHint).toBe('2:20am (America/Los_Angeles)');
  });

  it('uses a rejected SDK rate-limit event even without an assistant error frame', async () => {
    sdkState.messages = [
      {
        type: 'rate_limit_event', session_id: 's1',
        rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: Math.floor(Date.now() / 1000) + 120 },
      },
      { type: 'result', subtype: 'success', is_error: false, session_id: 's1' },
    ];
    const failure = await new ClaudeAdapter().runTurn(input, ctx).catch((e) => e);
    expect(failure).toBeInstanceOf(ProviderFailure);
    expect(failure.metadata).toMatchObject({
      kind: 'quota', permanence: 'transient', provider: 'claude', source: 'structured', window: 'model', note: 'opus',
    });
    expect(failure.metadata.resetHint).toMatch(/^in \d+s$/);
  });

  it('does not mistake unavailable paid overage for exhausted subscription quota', async () => {
    sdkState.messages = [
      {
        type: 'rate_limit_event', session_id: 's1',
        rate_limit_info: {
          status: 'allowed', utilization: 0.1, rateLimitType: 'five_hour',
          overageStatus: 'rejected', overageDisabledReason: 'overage_not_provisioned',
        },
      },
      { type: 'result', subtype: 'success', is_error: false, session_id: 's1', stop_reason: 'end_turn' },
    ];
    const turn = await new ClaudeAdapter().runTurn(input, ctx);
    expect(turn.termination).toEqual({ kind: 'success', status: 'success', reason: 'end_turn' });
  });

  it('continues through an exhausted base window when overage is usable', async () => {
    sdkState.messages = [
      {
        type: 'rate_limit_event', session_id: 's1',
        rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', overageStatus: 'allowed', isUsingOverage: true },
      },
      { type: 'result', subtype: 'success', is_error: false, session_id: 's1', stop_reason: 'end_turn' },
    ];
    await expect(new ClaudeAdapter().runTurn(input, ctx)).resolves.toMatchObject({
      termination: { kind: 'success', status: 'success' },
    });
  });

  it('preserves a text-only API transport failure before a misleading success result', async () => {
    sdkState.messages = [
      {
        type: 'assistant', session_id: 's1',
        message: {
          stop_reason: 'stop_sequence',
          content: [{ type: 'text', text: 'API Error: Connection closed mid-response. The response above may be incomplete.' }],
        },
      },
      // Exact terminal envelope observed in task #240.
      { type: 'result', subtype: 'success', is_error: true, session_id: 's1', errors: ['completed'] },
    ];
    const failure = await new ClaudeAdapter().runTurn(input, ctx).catch((e) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ProviderFailure);
    expect(failure.message).toMatch(/transport interruption.*connection closed mid-response/i);
  });

  it.each([
    ['authentication_failed', 'credential'],
    ['billing_error', 'quota'],
  ])('types the structured %s assistant failure as hard %s unavailability', async (code, kind) => {
    sdkState.messages = [{
      type: 'assistant', session_id: 's1', error: code,
      message: { content: [{ type: 'text', text: 'account unavailable' }] },
    }];
    const failure = await new ClaudeAdapter().runTurn(input, ctx).catch((e) => e);
    expect(failure).toBeInstanceOf(ProviderFailure);
    expect(failure.metadata).toMatchObject({ kind, permanence: 'hard', provider: 'claude', source: 'structured' });
  });

  it.each(['overloaded', 'server_error', 'max_output_tokens'])(
    'surfaces the structured %s assistant failure as a retryable interruption',
    async (code) => {
      sdkState.messages = [{
        type: 'assistant', session_id: 's1', error: code,
        message: { content: [{ type: 'text', text: 'provider could not finish' }] },
      }];
      const failure = await new ClaudeAdapter().runTurn(input, ctx).catch((e) => e);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(ProviderFailure);
      expect(failure.message).toMatch(/overloaded|server_error|interrupted before completion/);
    },
  );

  it('rejects a stream that ends without any result event', async () => {
    sdkState.messages = [
      { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'partial work' }] } },
    ];
    await expect(new ClaudeAdapter().runTurn(input, ctx)).rejects.toThrow(/stream ended unexpectedly.*successful result/i);
  });
});
