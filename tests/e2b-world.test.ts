import { describe, expect, it } from 'vitest';
import { E2BWorldProvider, type E2BFactory, type E2BSandboxLike } from '../src/world/e2b.js';
import { serviceHomeLabel } from '../src/world/services.js';

describe('E2B cloud world provider', () => {
  it('normalizes only this deployment\'s completed provider executions for billing', async () => {
    const sandbox = fakeSandbox(() => undefined);
    const factory: E2BFactory = {
      async create() { return sandbox; },
      async connect() { return sandbox; },
      async events() {
        return [
          { id: 'pause-1', type: 'sandbox.lifecycle.paused', timestamp: '2026-07-31T10:05:00Z',
            sandbox_id: 'sandbox-1', sandbox_execution_id: 'execution-1', event_data: {
              sandbox_metadata: { karmaxHome: serviceHomeLabel(), karmaxTaskId: 'task-1' },
              execution: { started_at: '2026-07-31T10:00:00Z', execution_time: 300_000,
                vcpu_count: 2, memory_mb: 512 },
            } },
          { id: 'foreign', type: 'sandbox.lifecycle.paused', timestamp: '2026-07-31T10:05:00Z',
            sandbox_id: 'sandbox-2', sandbox_execution_id: 'execution-2', event_data: {
              sandbox_metadata: { karmaxHome: 'another-install', karmaxTaskId: 'task-2' },
              execution: { started_at: '2026-07-31T10:00:00Z', execution_time: 300_000,
                vcpu_count: 8, memory_mb: 8192 },
            } },
          { id: 'resume', type: 'sandbox.lifecycle.resumed', timestamp: '2026-07-31T10:06:00Z',
            sandbox_id: 'sandbox-1', sandbox_execution_id: 'execution-3', event_data: {
              sandbox_metadata: { karmaxHome: serviceHomeLabel(), karmaxTaskId: 'task-1' },
            } },
        ];
      },
    };
    const provider = new E2BWorldProvider(factory, undefined, undefined,
      () => ({ organizationId: 'org-1', provider: 'e2b', apiKey: 'secret', config: {} }));

    expect(await provider.listUsageEvents!('org-1')).toEqual([{
      id: 'execution-1', sandboxId: 'sandbox-1', taskId: 'task-1',
      startedAt: Date.UTC(2026, 6, 31, 10), endedAt: Date.UTC(2026, 6, 31, 10, 5),
      activeMs: 300_000, cpu: 2, memoryMb: 512,
    }]);
  });

  it('uses E2B\'s built-in codex template when no headless template is configured', async () => {
    let createdOptions: Parameters<E2BFactory['create']>[0] | undefined;
    const sandbox = fakeSandbox(() => undefined);
    const factory: E2BFactory = {
      async create(options) { createdOptions = options; return sandbox; },
      async connect() { return sandbox; },
    };
    const prior = process.env.KARMAX_E2B_TEMPLATE;
    delete process.env.KARMAX_E2B_TEMPLATE;
    try {
      const provider = new E2BWorldProvider(factory);
      await provider.create({ taskId: 'default-template', base: 'main' });
      expect(createdOptions?.template).toBe('codex');
    } finally {
      if (prior === undefined) delete process.env.KARMAX_E2B_TEMPLATE;
      else process.env.KARMAX_E2B_TEMPLATE = prior;
    }
  });

  it('creates an auto-pausing world and routes files, processes, PTYs, park, and resume through the SDK', async () => {
    const files = new Map<string, string | Uint8Array>();
    let paused = 0;
    let killed = 0;
    let connected = 0;
    let processKilled = 0;
    let ptyKilled = 0;
    let ptyInput = '';
    let ptySize = { cols: 0, rows: 0 };
    let ptyData: ((data: unknown) => void) | undefined;
    let ptyOptions: any;
    let createdOptions: any;
    const networkUpdates: any[] = [];
    let timeoutRefreshes = 0;

    const sandbox: E2BSandboxLike = {
      sandboxId: 'sbx_test',
      trafficAccessToken: 'provider-secret',
      commands: {
        async run(command, options: any = {}) {
          if (options.background) {
            options.onStdout?.('booted\n'); // deliberately before caller attaches
            return {
              wait: () => new Promise(() => {}),
              async kill() { processKilled++; },
            };
          }
          if (command.includes('find . -type f')) return { stdout: 'a.txt\n', stderr: '', exitCode: 0 };
          if (command.includes("'printf'")) return { stdout: 'hello', stderr: '', exitCode: 0 };
          if (command.includes('rev-parse')) return { stdout: `${'a'.repeat(40)}\n`, stderr: '', exitCode: 0 };
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      },
      files: {
        async read(file, options: any = {}) {
          const value = files.get(file);
          if (value === undefined) throw new Error('not found');
          if (options.format === 'bytes') return typeof value === 'string' ? new TextEncoder().encode(value) : value;
          return typeof value === 'string' ? value : new TextDecoder().decode(value);
        },
        async write(file, data) { files.set(file, data); },
      },
      pty: {
        async create(options: any) {
          ptyOptions = options;
          ptyData = options.onData;
          return { pid: 41, wait: () => new Promise(() => {}), async kill() { ptyKilled++; } };
        },
        async sendInput(_pid, data) { ptyInput += new TextDecoder().decode(data); },
        async resize(_pid, size) { ptySize = size; },
        async kill() { ptyKilled++; },
      },
      async pause() { paused++; },
      async kill() { killed++; },
      async updateNetwork(network) { networkUpdates.push(network); },
      async setTimeout(value) { expect(value).toBe(123_000); timeoutRefreshes++; },
    };
    const factory: E2BFactory = {
      async create(options) { createdOptions = options; return sandbox; },
      async connect(id) { expect(id).toBe('sbx_test'); connected++; return sandbox; },
    };
    const provider = new E2BWorldProvider(factory, 123_000, 'karmax-template');
    const world = await provider.create({ taskId: 'task-cloud', base: 'main' });

    expect(createdOptions).toMatchObject({
      template: 'karmax-template',
      timeoutMs: 123_000,
      lifecycle: { onTimeout: 'pause', autoResume: true },
      metadata: { karmaxTaskId: 'task-cloud' },
      allowInternetAccess: true,
    });
    expect(createdOptions.network).toBeUndefined();
    expect(networkUpdates).toEqual([{
      allowOut: expect.arrayContaining(['github.com']),
      denyOut: ['0.0.0.0/0'],
    }]);
    expect(world.handle).toMatchObject({ version: 2, kind: 'e2b', provider: 'e2b', root: '/home/user/karmax' });
    expect(world.handle.sealedProviderRef).toBeTruthy();
    expect(JSON.stringify(world.handle)).not.toContain('sbx_test');

    await world.writeFile('a.txt', 'cloud data');
    expect(await world.readFile('a.txt')).toBe('cloud data');
    expect((await world.readFileBuffer('a.txt')).toString()).toBe('cloud data');
    await expect(world.readFile('../secret')).rejects.toThrow('escapes world');
    expect(await world.listFiles()).toEqual(['a.txt']);
    expect(await world.exec('printf', ['hello'])).toMatchObject({ stdout: 'hello', code: 0 });

    const proc = await world.startProcess({ command: 'npm start' });
    let output = '';
    proc.onOutput((chunk) => { output += chunk; });
    expect(output).toBe('booted\n');
    await proc.kill();
    expect(processKilled).toBe(1);

    const terminal = await world.openPty({ command: 'exec agent' });
    let terminalOutput = '';
    terminal.onData((chunk) => { terminalOutput += chunk; });
    ptyData?.(new TextEncoder().encode('ready'));
    await terminal.write('pwd\n');
    await terminal.resize(120, 40);
    await terminal.close();
    expect(timeoutRefreshes).toBeGreaterThanOrEqual(2); // process + PTY leases
    expect(terminal.pid).toBeUndefined(); // remote pid must never enter the host process registry
    expect(ptyOptions.cmd).toBeUndefined();
    expect(terminalOutput).toBe('ready');
    expect(ptyInput).toBe('exec agent\npwd\n');
    expect(await world.previewSocketTarget!(3000, '/hmr?x=1')).toMatchObject({
      url: 'wss://3000-sbx_test.e2b.app/hmr?x=1', headers: { 'x-access-token': 'provider-secret' },
    });
    const originalFetch = globalThis.fetch;
    let proxyRequest: { url: string; method?: string; token?: string; body?: string } | undefined;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      proxyRequest = { url: String(input), method: init?.method,
        token: new Headers(init?.headers).get('x-access-token') ?? undefined,
        body: init?.body ? Buffer.from(init.body as any).toString() : undefined };
      return new Response('ok');
    }) as typeof fetch;
    try {
      await world.fetchPort!(3000, '/save?x=1', { method: 'POST', body: Buffer.from('data') });
      expect(proxyRequest).toEqual({ url: 'https://3000-sbx_test.e2b.app/save?x=1', method: 'POST',
        token: 'provider-secret', body: 'data' });
    } finally { globalThis.fetch = originalFetch; }
    expect(ptySize).toEqual({ cols: 120, rows: 40 });
    expect(ptyKilled).toBe(1);

    await provider.park(world.handle);
    expect(paused).toBe(1);
    expect(await provider.status(world.handle)).toBe('parked');
    await provider.open(world.handle);
    expect(connected).toBe(1);
    expect(await provider.status(world.handle)).toBe('ready');
    await world.destroy();
    expect(killed).toBe(1);
  });

  it('rejects local and HTTPS repositories before a cloud checkout is exposed', async () => {
    let killed = 0;
    const sandbox = fakeSandbox(() => { killed++; });
    const provider = new E2BWorldProvider({ create: async () => sandbox, connect: async () => sandbox });
    await expect(provider.create({ taskId: 'bad', base: 'main', repo: '/tmp/repo' })).rejects.toThrow('SSH Git URLs');
    await expect(provider.create({ taskId: 'bad2', base: 'main', repo: 'https://github.com/acme/repo.git' })).rejects.toThrow('SSH Git URLs');
    expect(killed).toBe(2);
  });

  it('uses an SSH credential only for clone and never persists it in the handle', async () => {
    const commands: string[] = [];
    const writes = new Map<string, string>();
    const sandbox = fakeSandbox(() => undefined);
    sandbox.commands.run = async (command) => {
      commands.push(command);
      return { stdout: command.includes('rev-parse') ? `${'b'.repeat(40)}\n` : '', stderr: '', exitCode: 0 };
    };
    sandbox.files.write = async (file, data) => { writes.set(file, String(data)); };
    const provider = new E2BWorldProvider({ create: async () => sandbox, connect: async () => sandbox });
    const world = await provider.create({
      taskId: 'private',
      base: 'main',
      repo: 'git@github.com:acme/private.git',
      gitCredentials: { sshKey: 'PRIVATE CLONE KEY' },
    });

    expect(writes.get('/home/user/.ssh/karmax-auth-0')).toContain('PRIVATE CLONE KEY');
    expect(commands.some((command) => command.includes('GIT_SSH_COMMAND=') && command.includes('git clone'))).toBe(true);
    expect(commands.at(-1)).toContain('rm -f /home/user/.ssh/karmax-auth*');
    expect(JSON.stringify(world.handle)).not.toContain('PRIVATE CLONE KEY');
  });

  it('surfaces E2B command stderr instead of an opaque exit status', async () => {
    const sandbox = fakeSandbox(() => undefined);
    sandbox.commands.run = async (command) => {
      if (!command.includes('git clone')) return { stdout: '', stderr: '', exitCode: 0 };
      throw Object.assign(new Error('exit status 128'), {
        name: 'CommandExitError', exitCode: 128, stdout: '',
        stderr: 'fatal: Could not read from remote repository',
      });
    };
    const previous = process.env.KARMAX_WORLD_CLONE_RETRIES;
    process.env.KARMAX_WORLD_CLONE_RETRIES = '0';
    try {
      const provider = new E2BWorldProvider({ create: async () => sandbox, connect: async () => sandbox });
      await expect(provider.create({ taskId: 'clone-error', base: 'main',
        repo: 'git@github.com:acme/private.git' })).rejects.toThrow('Could not read from remote repository');
    } finally {
      if (previous === undefined) delete process.env.KARMAX_WORLD_CLONE_RETRIES;
      else process.env.KARMAX_WORLD_CLONE_RETRIES = previous;
    }
  });

  it('fails rather than silently reviewing the wrong branch', async () => {
    const sandbox = fakeSandbox(() => undefined);
    sandbox.commands.run = async (command) => ({
      stdout: '', stderr: '', exitCode: command.includes('show-ref --verify') ? 1 : 0,
    });
    const provider = new E2BWorldProvider({ create: async () => sandbox, connect: async () => sandbox });
    await expect(provider.create({
      taskId: 'review',
      base: 'main',
      branch: 'feature/missing',
      repo: 'git@github.com:acme/private.git',
    })).rejects.toThrow('no remote branch "feature/missing"');
  });

  it('honors each hosted repository attachment\'s base and target branches', async () => {
    const commands: string[] = [];
    const sandbox = fakeSandbox(() => undefined);
    sandbox.commands.run = async (command) => {
      commands.push(command);
      return { stdout: command.includes('rev-parse') ? `${'c'.repeat(40)}\n` : '', stderr: '', exitCode: 0 };
    };
    const provider = new E2BWorldProvider({ create: async () => sandbox, connect: async () => sandbox });
    const api = 'git@github.com:acme/api.git';
    const web = 'git@github.com:acme/web.git';
    const world = await provider.create({ taskId: 'multi', repos: [api, web], base: 'main', target: 'main',
      repositoryBranches: { [api]: { base: 'trunk', target: 'production' },
        [web]: { base: 'develop', target: 'release' } } });
    expect(world.handle.repos).toEqual([
      expect.objectContaining({ repo: api, base: 'trunk', target: 'production' }),
      expect.objectContaining({ repo: web, base: 'develop', target: 'release' }),
    ]);
    expect(commands.some((command) => command.includes('origin/trunk'))).toBe(true);
    expect(commands.some((command) => command.includes('origin/develop'))).toBe(true);
  });

  it('uses the desktop SDK flavor for creation, reconnect, and authenticated viewing', async () => {
    const sandbox = fakeSandbox(() => undefined);
    let created: any;
    let connected: any;
    let streamStarts = 0;
    sandbox.stream = {
      async start(options) { expect(options).toEqual({ requireAuth: true }); streamStarts++; },
      getAuthKey: () => 'viewer-secret',
      getUrl: (options) => `https://desktop.invalid/?auth=${options?.authKey}`,
    };
    const provider = new E2BWorldProvider({
      async create(options) { created = options; return sandbox; },
      async connect(_id, options) { connected = options; return sandbox; },
    }, 120_000, undefined, undefined, 'karmax-desktop');
    const world = await provider.create({ taskId: 'desktop', base: 'main', environment: { flavor: 'desktop' } });
    expect(created).toMatchObject({ template: 'karmax-desktop', desktop: true });
    expect(await world.desktopSession!()).toEqual({ provider: 'e2b', url: 'https://desktop.invalid/?auth=viewer-secret' });
    await provider.park(world.handle);
    await provider.open(world.handle);
    expect(connected).toMatchObject({ desktop: true });
    expect(streamStarts).toBe(1);
  });

  it('replays a PTY exit that happens before the caller attaches', async () => {
    const sandbox = fakeSandbox(() => undefined);
    sandbox.pty.create = async () => ({ pid: 9, async wait() { return { exitCode: 23 }; } });
    const provider = new E2BWorldProvider({ create: async () => sandbox, connect: async () => sandbox });
    const world = await provider.create({ taskId: 'fast-exit', base: 'main' });
    const pty = await world.openPty();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const code = await new Promise<number | null>((resolve) => pty.onExit(resolve));
    expect(code).toBe(23);
  });
});

function fakeSandbox(onKill: () => void): E2BSandboxLike {
  return {
    sandboxId: Math.random().toString(),
    commands: { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    files: { read: async () => '', write: async () => undefined },
    pty: {
      create: async () => ({ pid: 1 }),
      sendInput: async () => undefined,
      resize: async () => undefined,
      kill: async () => undefined,
    },
    pause: async () => undefined,
    kill: async () => { onKill(); },
    updateNetwork: async () => undefined,
  };
}
