import { describe, expect, it, vi } from 'vitest';
import { DaytonaWorldProvider, type DaytonaFactory, type DaytonaSandboxLike } from '../src/world/daytona.js';

describe('Daytona cloud world provider', () => {
  it('rejects an unauthenticated legacy sandbox ID before any provider operation (WD-30)', async () => {
    const sandbox = fakeSandbox();
    const connect = vi.fn(async () => sandbox);
    const provider = new DaytonaWorldProvider({ create: async () => sandbox, connect, get: connect } as any);
    const world = await provider.create({ taskId: 'legacy', base: 'main' });
    const forged = { ...world.handle, sealedProviderRef: undefined,
      meta: { ...world.handle.meta, sandboxId: 'another-tenant-sandbox', organizationId: 'victim' } };
    await expect(provider.open(forged)).rejects.toThrow('invalid Daytona world handle');
    await expect(provider.destroy(forged)).rejects.toThrow('invalid Daytona world handle');
    expect(connect).not.toHaveBeenCalled();
    await expect(provider.open(world.handle)).resolves.toBeDefined();
  });

  it('propagates exec transport failures instead of reporting command exit 1 (WD-16)', async () => {
    const sandbox = fakeSandbox();
    const world = await new DaytonaWorldProvider({ create: async () => sandbox, get: async () => sandbox })
      .create({ taskId: 'transport', base: 'main' });
    sandbox.process.executeCommand = async () => { throw new Error('connection reset'); };
    await expect(world.exec('true', [])).rejects.toThrow('connection reset');
  });

  it('evicts destroyed sandboxes and lifecycle cache entries (WD-3, PS-10)', async () => {
    const sandbox = fakeSandbox();
    let opens = 0;
    const provider = new DaytonaWorldProvider({ create: async () => sandbox,
      connect: async () => { opens++; throw new Error('deleted'); },
      get: async () => { opens++; throw new Error('deleted'); } } as any);
    const world = await provider.create({ taskId: 'cache', base: 'main' });
    await world.destroy();
    expect((provider as any).sandboxes.size).toBe(0);
    expect((provider as any).states.size).toBe(0);
    await expect(provider.open(world.handle)).rejects.toThrow('deleted');
    expect(opens).toBe(1);
  });

  it.each([
    [Object.assign(new Error('getaddrinfo ENOTFOUND api.provider'), { code: 'ENOTFOUND' }), undefined],
    [new Error('upstream returned 404 while resolving proxy'), undefined],
    [Object.assign(new Error('deleted'), { status: 404 }), 'missing'],
  ])('requires authoritative missing status (WD-8): %s', async (error, expected) => {
    const sandbox = fakeSandbox();
    const provider = new DaytonaWorldProvider({ create: async () => sandbox, connect: async () => sandbox,
      get: async () => { throw error; } } as any);
    const world = await provider.create({ taskId: 'probe', base: 'main' });
    expect(await provider.probe(world.handle)).toBe(expected);
  });

  it('preserves undecidable sealed references during orphan comparison (WD-1)', async () => {
    const sandbox = fakeSandbox();
    const provider = new DaytonaWorldProvider({ create: async () => sandbox, connect: async () => sandbox,
      get: async () => sandbox, list: async () => [sandbox] } as any);
    const world = await provider.create({ taskId: 'sealed', base: 'main' });
    const [listed] = await provider.listSandboxes();
    expect(listed!.matches!({ ...world.handle, sealedProviderRef: 'unreadable' })).toBeUndefined();
  });

  it('satisfies the opaque world/file/process/PTY/park contract with deny-by-default networking', async () => {
    const files = new Map<string, Buffer>();
    let createOptions: any;
    let archived = 0;
    let started = 0;
    let deleted = 0;
    let sessionDeleted = 0;
    let ptyInput = '';
    let size = { cols: 0, rows: 0 };
    let ptyData: ((data: Uint8Array) => void) | undefined;
    const sandbox: DaytonaSandboxLike = {
      id: 'daytona-secret-id', state: 'started',
      process: {
        async executeCommand(command) {
          if (command.includes('find . -type f')) return { exitCode: 0, result: 'a.txt\n' };
          if (command.includes("'printf'")) return { exitCode: 0, result: 'hello' };
          if (command.includes('rev-parse')) return { exitCode: 0, result: `${'a'.repeat(40)}\n` };
          return { exitCode: 0, result: '' };
        },
        async createSession() {},
        async executeSessionCommand() { return { cmdId: 'cmd-1' }; },
        async getSessionCommand() { return { exitCode: undefined }; },
        async getSessionCommandLogs(_session, _command, stdout) { stdout?.('booted\n'); },
        async deleteSession() { sessionDeleted++; },
        async createPty(options: any) {
          ptyData = options.onData;
          return { async waitForConnection() {}, async sendInput(value: string) { ptyInput += value; },
            async resize(cols: number, rows: number) { size = { cols, rows }; }, wait: () => new Promise(() => {}), async kill() {} };
        },
      },
      fs: {
        async downloadFile(file) { const value = files.get(file); if (!value) throw new Error('not found'); return value; },
        async uploadFile(value, file) { files.set(file, Buffer.from(value)); },
      },
      async getUserHomeDir() { return '/home/daytona'; },
      async getSignedPreviewUrl() { return { url: 'https://preview.invalid/?signed=keep' }; },
      async refreshData() {},
      async start() { started++; sandbox.state = 'started'; },
      async stop() { sandbox.state = 'stopped'; },
      async archive() { expect(sandbox.state).toBe('stopped'); archived++; sandbox.state = 'archived'; },
      async delete() { deleted++; },
    };
    const factory: DaytonaFactory = {
      async create(options) { createOptions = options; return sandbox; },
      async get(id) { expect(id).toBe('daytona-secret-id'); return sandbox; },
    };
    const provider = new DaytonaWorldProvider(factory, 120_000, 'snapshot-v1');
    const world = await provider.create({ taskId: 'task-daytona', base: 'main',
      network: { allowDomains: ['registry.npmjs.org'] }, resources: { cpu: 2, memoryMb: 4096 } });

    expect(createOptions).toMatchObject({ snapshot: 'snapshot-v1', public: false, autoStopInterval: 2,
      domainAllowList: expect.stringContaining('registry.npmjs.org') });
    expect(createOptions).not.toHaveProperty('resources');
    expect(createOptions).not.toHaveProperty('networkBlockAll');
    expect(world.handle).toMatchObject({ version: 2, kind: 'daytona', provider: 'daytona', root: '/home/daytona/karmax' });
    expect(world.handle.sealedProviderRef).toBeTruthy();
    expect(JSON.stringify(world.handle)).not.toContain('daytona-secret-id');

    await world.writeFile('a.txt', 'cloud');
    expect(await world.readFile('a.txt')).toBe('cloud');
    await expect(world.readFile('../escape')).rejects.toThrow('escapes world');
    expect(await world.listFiles()).toEqual(['a.txt']);
    expect(await world.exec('printf', ['hello'])).toMatchObject({ stdout: 'hello', code: 0 });

    const process = await world.startProcess({ command: 'npm start' });
    let output = '';
    process.onOutput((chunk) => { output += chunk; });
    expect(output).toBe('booted\n');
    await process.kill();
    expect(sessionDeleted).toBe(1);

    const terminal = await world.openPty({ command: 'exec agent' });
    let terminalOutput = '';
    terminal.onData((chunk) => { terminalOutput += chunk; });
    ptyData?.(new TextEncoder().encode('ready'));
    await terminal.write('pwd\n');
    await terminal.resize(100, 30);
    await terminal.close();
    expect(terminalOutput).toBe('ready');
    expect(ptyInput).toBe('exec agent\npwd\n');
    expect(size).toEqual({ cols: 100, rows: 30 });
    expect((await world.previewSocketTarget!(3000, '/hmr')).url).toBe('wss://preview.invalid/hmr?signed=keep');
    const originalFetch = globalThis.fetch;
    let proxied: { url: string; method?: string; body?: string } | undefined;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      proxied = { url: String(input), method: init?.method, body: init?.body ? Buffer.from(init.body as any).toString() : undefined };
      return new Response('saved', { status: 201, headers: { 'content-type': 'text/plain' } });
    }) as typeof fetch;
    try {
      const response = await world.fetchPort!(3000, '/submit?draft=1',
        { method: 'POST', headers: { 'content-type': 'text/plain' }, body: Buffer.from('payload') });
      expect(response).toMatchObject({ status: 201, body: Buffer.from('saved') });
      expect(proxied).toEqual({ url: 'https://preview.invalid/submit?signed=keep&draft=1', method: 'POST', body: 'payload' });
    } finally { globalThis.fetch = originalFetch; }

    await provider.park(world.handle);
    expect(archived).toBe(1);
    expect(await provider.status(world.handle)).toBe('parked');
    await provider.open(world.handle);
    expect(started).toBe(1);
    await world.destroy();
    expect(deleted).toBe(1);
  });

  it.each([undefined, 'custom-snapshot'])('never sends resources with snapshot %s, including the API-key-only default', async (snapshot) => {
    const sandbox = fakeSandbox();
    const create = vi.fn(async (_options: Record<string, unknown>) => sandbox);
    await new DaytonaWorldProvider({ create, get: async () => sandbox }, undefined, snapshot)
      .create({ taskId: 'default', base: 'main', resources: { cpu: 2, memoryMb: 2048, gpu: 0 } });
    expect(create.mock.calls[0]![0]).not.toHaveProperty('resources');
  });

  it('passes resource sizes only to image builds', async () => {
    const sandbox = fakeSandbox();
    const create = vi.fn(async (_options: Record<string, unknown>) => sandbox);
    await new DaytonaWorldProvider({ create, get: async () => sandbox })
      .create({ taskId: 'image', base: 'main', environment: { image: 'ubuntu:24.04' }, resources: { cpu: 2, memoryMb: 4096 } });
    expect(create.mock.calls[0]![0]).toMatchObject({ image: 'ubuntu:24.04', resources: { cpu: 2, memory: 4 } });
  });

  it('waits for a starting sandbox before handing it to a caller', async () => {
    const sandbox = fakeSandbox();
    const provider = new DaytonaWorldProvider({ create: async () => sandbox, get: async () => sandbox });
    const world = await provider.create({ taskId: 'resume', base: 'main' });
    sandbox.state = 'starting';
    sandbox.waitUntilStarted = vi.fn(async () => { sandbox.state = 'started'; });
    await provider.open(world.handle);
    expect(sandbox.waitUntilStarted).toHaveBeenCalledWith(120);
  });

  it('rejects unsupported CIDR policies before creating a sandbox', async () => {
    const create = vi.fn(async () => fakeSandbox());
    await expect(new DaytonaWorldProvider({ create, get: async () => fakeSandbox() }).create({
      taskId: 'cidr', base: 'main', network: { allowCidrs: ['10.0.0.0/8'] },
    })).rejects.toThrow(/CIDR/);
    expect(create).not.toHaveBeenCalled();
  });

  it('resizes a snapshot sandbox to the computer: live when it only grows, stopped when the disk changes', async () => {
    const calls: string[] = [];
    const sized = () => {
      const sandbox = fakeSandbox();
      Object.assign(sandbox, { cpu: 1, memory: 1, disk: 3, gpu: 0,
        resize: vi.fn(async (resources: object) => { calls.push(`resize ${JSON.stringify(resources)}`); }),
        stop: vi.fn(async () => { calls.push('stop'); }), start: vi.fn(async () => { calls.push('start'); }) });
      return sandbox;
    };
    const live = sized();
    let world = await new DaytonaWorldProvider({ create: async () => live, get: async () => live }).create({
      taskId: 'grow', base: 'main', resources: { cpu: 2, memoryMb: 4096, gpu: 0 } });
    expect(calls).toEqual(['resize {"cpu":2,"memory":4}']);
    expect(world.handle.warnings).toBeUndefined();
    calls.length = 0;
    const disk = sized();
    world = await new DaytonaWorldProvider({ create: async () => disk, get: async () => disk }).create({
      taskId: 'disk', base: 'main', resources: { cpu: 1, memoryMb: 1024, diskGb: 40 } });
    expect(calls).toEqual(['stop', 'resize {"disk":40}', 'start']);
    // Daytona creates an image at the requested disk directly.
    const created: Array<Record<string, unknown>> = [];
    const create = async (options: Record<string, unknown>) => { created.push(options); return fakeSandbox(); };
    await new DaytonaWorldProvider({ create, get: async () => fakeSandbox() })
      .create({ taskId: 'image-disk', base: 'main', environment: { image: 'ubuntu:24.04' }, resources: { cpu: 2, memoryMb: 2048, diskGb: 40 } });
    expect(created[0]).toMatchObject({ resources: { cpu: 2, memory: 2, disk: 40 } });
  });

  it('keeps the snapshot size and says so when this Daytona cannot resize', async () => {
    const sandbox = fakeSandbox();
    Object.assign(sandbox, { cpu: 4, memory: 2, disk: 10, gpu: 0, resize: async () => { throw new Error('resize is not implemented'); } });
    const world = await new DaytonaWorldProvider({ create: async () => sandbox, get: async () => sandbox }).create({
      taskId: 'size', base: 'main', resources: { cpu: 2, memoryMb: 4096, diskGb: 5, gpu: 0 },
    });
    expect(world.handle.warnings).toEqual([
      'Daytona cannot shrink a disk: this computer keeps the snapshot\'s 10 GB.',
      expect.stringMatching(/runs at the Daytona snapshot's size \(4 CPU · 2 GB · 10 GB disk\): resize is not implemented/),
    ]);
  });

  it('cleans up when snapshot GPU requirements cannot be satisfied', async () => {
    const sandbox = fakeSandbox();
    sandbox.delete = vi.fn(async () => {});
    await expect(new DaytonaWorldProvider({ create: async () => sandbox, get: async () => sandbox }).create({
      taskId: 'gpu', base: 'main', resources: { gpu: 1 },
    })).rejects.toThrow(/GPU snapshot/);
    expect(sandbox.delete).toHaveBeenCalled();
  });

  it('cleans up a background session when launching its command fails', async () => {
    const sandbox = fakeSandbox();
    sandbox.process.createSession = vi.fn(async () => {});
    sandbox.process.executeSessionCommand = vi.fn(async () => { throw new Error('launch failed'); });
    sandbox.process.getSessionCommand = vi.fn();
    sandbox.process.getSessionCommandLogs = vi.fn();
    sandbox.process.deleteSession = vi.fn(async () => {});
    const world = await new DaytonaWorldProvider({ create: async () => sandbox, get: async () => sandbox })
      .create({ taskId: 'launch', base: 'main' });
    await expect(world.startProcess({ command: 'false' })).rejects.toThrow('launch failed');
    expect(sandbox.process.deleteSession).toHaveBeenCalledOnce();
  });

  it('drains output before exit and releases completed background sessions', async () => {
    const sandbox = fakeSandbox();
    sandbox.process.createSession = async () => {};
    sandbox.process.executeSessionCommand = async () => ({ cmdId: 'cmd' });
    sandbox.process.getSessionCommand = async () => ({ exitCode: 7 });
    sandbox.process.getSessionCommandLogs = async (_session, _command, stdout) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      stdout?.('last output');
    };
    sandbox.process.deleteSession = vi.fn(async () => {});
    sandbox.refreshActivity = vi.fn(async () => {});
    const world = await new DaytonaWorldProvider({ create: async () => sandbox, get: async () => sandbox })
      .create({ taskId: 'complete', base: 'main' });
    const process = await world.startProcess({ command: 'echo done' });
    let output = '';
    process.onOutput((chunk) => { output += chunk; });
    const code = await new Promise((resolve) => process.onExit(resolve));
    expect(code).toBe(7);
    expect(output).toBe('last output');
    expect(sandbox.process.deleteSession).toHaveBeenCalledOnce();
    expect(sandbox.refreshActivity).toHaveBeenCalled();
  });

  it('recovers an allocated generation after create times out instead of creating another world', async () => {
    const sandbox = fakeSandbox();
    let labels: Record<string, string> | undefined;
    const create = vi.fn(async (options: Record<string, unknown>) => {
      labels = options.labels as Record<string, string>;
      sandbox.labels = labels;
      throw new Error('request timed out');
    });
    const provider = new DaytonaWorldProvider({ create, get: async () => sandbox,
      list: async () => labels ? [sandbox] : [] });
    const world = await provider.create({ taskId: 'recover', generation: 3, base: 'main' });
    expect(world.handle.id).toBe('recover');
    expect(labels).toMatchObject({ karmaxTaskId: 'recover', karmaxGeneration: '3' });
    expect(create).toHaveBeenCalledOnce();
  });

  it('deletes a sandbox if cancellation happens during allocation', async () => {
    const abort = new AbortController();
    const sandbox = fakeSandbox();
    sandbox.delete = vi.fn(async () => {});
    const provider = new DaytonaWorldProvider({ create: async () => { abort.abort(); return sandbox; }, get: async () => sandbox });
    await expect(provider.create({ taskId: 'cancel', base: 'main', signal: abort.signal })).rejects.toThrow();
    expect(sandbox.delete).toHaveBeenCalledOnce();
  });

  it('keeps SSH provisioning unrestricted then applies task policy after removing credentials', async () => {
    const sandbox = fakeSandbox();
    const commands: string[] = [];
    sandbox.process.executeCommand = async (command) => {
      commands.push(command);
      return { exitCode: 0, result: command.includes('rev-parse') ? 'a'.repeat(40) : '' };
    };
    sandbox.updateNetworkSettings = vi.fn(async () => { expect(commands.at(-1)).toContain('rm -f'); });
    const create = vi.fn(async (_options: Record<string, unknown>) => sandbox);
    await new DaytonaWorldProvider({ create, get: async () => sandbox }).create({
      taskId: 'ssh', base: 'main', repo: 'git@github.com:acme/private.git', gitCredentials: { repositories: { 'git@github.com:acme/private.git': 'test-key' } },
    });
    expect(create.mock.calls[0]![0]).toMatchObject({ networkBlockAll: false });
    expect(create.mock.calls[0]![0]).not.toHaveProperty('domainAllowList');
    expect(sandbox.updateNetworkSettings).toHaveBeenCalledWith({ domainAllowList: expect.stringContaining('github.com') });
  });

  it('lets a project image override the organization snapshot', async () => {
    const sandbox = fakeSandbox();
    const create = vi.fn(async (_options: Record<string, unknown>) => sandbox);
    await new DaytonaWorldProvider({ create, get: async () => sandbox }, undefined, 'organization-snapshot')
      .create({ taskId: 'image-override', base: 'main', environment: { image: 'ubuntu:24.04' } });
    expect(create.mock.calls[0]![0]).toMatchObject({ image: 'ubuntu:24.04' });
    expect(create.mock.calls[0]![0]).not.toHaveProperty('snapshot');
  });

  it('deletes the sandbox if final network enforcement fails', async () => {
    const sandbox = fakeSandbox();
    sandbox.updateNetworkSettings = async () => { throw new Error('network rejected'); };
    sandbox.delete = vi.fn(async () => {});
    await expect(new DaytonaWorldProvider({ create: async () => sandbox, get: async () => sandbox }).create({
      taskId: 'network', base: 'main', gitCredentials: { sshKey: 'test' },
    })).rejects.toThrow('network rejected');
    expect(sandbox.delete).toHaveBeenCalledOnce();
  });

  it('treats deletion of an already removed sandbox as success, including stale listings', async () => {
    const sandbox = fakeSandbox();
    sandbox.delete = vi.fn(async () => { throw Object.assign(new Error('already deleted'), { statusCode: 404 }); });
    const provider = new DaytonaWorldProvider({ create: async () => sandbox, get: async () => sandbox,
      list: async () => [sandbox] });
    const world = await provider.create({ taskId: 'deleted', base: 'main' });
    await world.destroy();
    await (await provider.listSandboxes())[0]!.destroy();
    expect(await provider.status(world.handle)).toBe('missing');
    sandbox.delete = async () => { throw Object.assign(new Error('denied'), { statusCode: 403 }); };
    await expect(world.destroy()).rejects.toThrow('denied');
  });

  it('waits out a state change already in progress before deleting, and still fails if it never settles', async () => {
    const sandbox = fakeSandbox();
    const busy = () => Object.assign(new Error('Sandbox state change in progress'), { statusCode: 409 });
    let attempts = 0;
    sandbox.delete = vi.fn(async () => { if (++attempts < 3) throw busy(); });
    const world = await new DaytonaWorldProvider({ create: async () => sandbox, get: async () => sandbox })
      .create({ taskId: 'busy', base: 'main' });
    vi.useFakeTimers();
    try {
      const destroyed = world.destroy();
      await vi.advanceTimersByTimeAsync(10_000);
      await destroyed;
      expect(sandbox.delete).toHaveBeenCalledTimes(3);
      // Teardown retries a sandbox that never settles later, so the error still surfaces.
      sandbox.delete = vi.fn(async () => { throw busy(); });
      const stuck = world.destroy().catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(await stuck).toMatchObject({ message: 'Sandbox state change in progress' });
    } finally { vi.useRealTimers(); }
  });

  it('cleans up a terminal when connection setup fails', async () => {
    const sandbox = fakeSandbox();
    const kill = vi.fn(async () => {}), disconnect = vi.fn(async () => {});
    sandbox.process.createPty = async () => ({ kill, disconnect,
      waitForConnection: async () => { throw new Error('socket closed'); } });
    const world = await new DaytonaWorldProvider({ create: async () => sandbox, get: async () => sandbox })
      .create({ taskId: 'pty-failure', base: 'main' });
    await expect(world.openPty()).rejects.toThrow('socket closed');
    expect(kill).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('preserves UTF-8 characters split across terminal frames', async () => {
    const sandbox = fakeSandbox();
    let onData: (data: Uint8Array) => void = () => {};
    sandbox.process.createPty = async (options) => {
      onData = options.onData;
      return { wait: () => new Promise(() => {}), sendInput: async () => {}, kill: async () => {} };
    };
    const world = await new DaytonaWorldProvider({ create: async () => sandbox, get: async () => sandbox })
      .create({ taskId: 'utf8', base: 'main' });
    const pty = await world.openPty();
    let output = '';
    pty.onData((chunk) => { output += chunk; });
    const bytes = Buffer.from('🙂');
    onData(bytes.subarray(0, 2));
    onData(bytes.subarray(2));
    await pty.close();
    expect(output).toBe('🙂');
  });

  it('explains restricted-tier failures without retrying with a weaker network policy', async () => {
    const create = vi.fn(async () => { throw new Error('Network access is restricted and cannot be overridden at the sandbox level. Remove domainAllowList from the request.'); });
    await expect(new DaytonaWorldProvider({ create, get: async () => fakeSandbox() }).create({ taskId: 'tier', base: 'main' }))
      .rejects.toThrow('Daytona Tier 3');
    expect(create).toHaveBeenCalledOnce();
  });

  it('runs provisioning in bash even when the image default shell is zsh', async () => {
    const sandbox = fakeSandbox();
    sandbox.process.executeCommand = vi.fn(async () => ({ exitCode: 0, result: '' }));
    await new DaytonaWorldProvider({ create: async () => sandbox, get: async () => sandbox })
      .create({ taskId: 'shell', base: 'main' });
    const commands = vi.mocked(sandbox.process.executeCommand).mock.calls.map(([command]) => command);
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((command) => command.startsWith('bash -c '))).toBe(true);
  });

  it('uses clone keys only during trusted SSH provisioning', async () => {
    const commands: string[] = [];
    const writes = new Map<string, Buffer>();
    const sandbox = fakeSandbox();
    sandbox.process.executeCommand = async (command) => {
      commands.push(command);
      return { exitCode: 0, result: command.includes('rev-parse') ? `${'b'.repeat(40)}\n` : '' };
    };
    sandbox.fs.uploadFile = async (value, file) => { writes.set(file, value); };
    const provider = new DaytonaWorldProvider({ create: async () => sandbox, get: async () => sandbox });
    const world = await provider.create({ taskId: 'private', base: 'main', repo: 'git@github.com:acme/private.git',
      gitCredentials: { repositories: { 'git@github.com:acme/private.git': 'PRIVATE KEY' } } });
    expect(writes.get('/home/daytona/.ssh/karmax-auth-0')?.toString()).toContain('PRIVATE KEY');
    expect(commands.some((command) => command.includes('GIT_SSH_COMMAND=') && command.includes('git clone'))).toBe(true);
    expect(commands.at(-1)).toContain('rm -f');
    expect(JSON.stringify(world.handle)).not.toContain('PRIVATE KEY');
  });

  it('starts Daytona Computer Use and returns its signed noVNC viewer', async () => {
    const sandbox = fakeSandbox();
    let options: any;
    let computerStarts = 0;
    let previewPort = 0;
    sandbox.computerUse = { async start() { computerStarts++; } };
    sandbox.getSignedPreviewUrl = async (port) => { previewPort = port; return { url: 'https://desktop.invalid/signed' }; };
    const provider = new DaytonaWorldProvider({
      async create(value) { options = value; return sandbox; },
      async get() { return sandbox; },
    }, 120_000, undefined, undefined, undefined, 'desktop-snapshot');
    const world = await provider.create({ taskId: 'desktop', base: 'main', environment: { flavor: 'desktop' } });
    expect(options).toMatchObject({ snapshot: 'desktop-snapshot' });
    expect(computerStarts).toBe(1);
    expect(await world.desktopSession!()).toEqual({ provider: 'daytona', url: 'https://desktop.invalid/signed' });
    expect(previewPort).toBe(6080);
  });

  it('replays a PTY exit that happens before the caller attaches', async () => {
    const sandbox = fakeSandbox();
    sandbox.process.createPty = async () => ({
      async waitForConnection() {}, async wait() { return { exitCode: 29 }; },
      async sendInput() {}, async resize() {}, async kill() {},
    });
    const provider = new DaytonaWorldProvider({ create: async () => sandbox, get: async () => sandbox });
    const world = await provider.create({ taskId: 'fast-exit', base: 'main' });
    const pty = await world.openPty();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const code = await new Promise<number | null>((resolve) => pty.onExit(resolve));
    expect(code).toBe(29);
  });
});

function fakeSandbox(): DaytonaSandboxLike {
  return {
    id: 'fake', state: 'started', updateNetworkSettings: async () => {},
    process: { executeCommand: async () => ({ exitCode: 0, result: '' }),
      createPty: async () => ({ waitForConnection: async () => {}, wait: () => new Promise(() => {}) }) },
    fs: { downloadFile: async () => Buffer.alloc(0), uploadFile: async () => {} },
    getUserHomeDir: async () => '/home/daytona', getSignedPreviewUrl: async () => ({ url: 'https://invalid/' }),
    start: async () => {}, stop: async () => {}, archive: async () => {}, delete: async () => {},
  };
}
