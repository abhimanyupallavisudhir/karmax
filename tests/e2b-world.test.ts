import { describe, expect, it, vi } from 'vitest';
import { E2BWorldProvider, DEFAULT_E2B_TEMPLATE, type E2BFactory, type E2BSandboxLike } from '../src/world/e2b.js';
import { serviceHomeLabel } from '../src/world/services.js';
import { e2bDiskLimitGb, sizedBuildOptions, sizedTemplateName } from '../src/world/e2b-template.js';
import { isMissingSandbox } from '../src/world/provider-errors.js';

describe('E2B cloud world provider', () => {
  it('rejects an unauthenticated legacy sandbox ID before any provider operation (WD-30)', async () => {
    const sandbox = fakeSandbox(() => undefined);
    const connect = vi.fn(async () => sandbox);
    const provider = new E2BWorldProvider({ create: async () => sandbox, connect, get: connect } as any);
    const world = await provider.create({ taskId: 'legacy', base: 'main' });
    const forged = { ...world.handle, sealedProviderRef: undefined,
      meta: { ...world.handle.meta, sandboxId: 'another-tenant-sandbox', organizationId: 'victim' } };
    await expect(provider.open(forged)).rejects.toThrow('invalid E2B world handle');
    await expect(provider.destroy(forged)).rejects.toThrow('invalid E2B world handle');
    expect(connect).not.toHaveBeenCalled();
    await expect(provider.open(world.handle)).resolves.toBeDefined();
  });

  it('runs a computer of another size on a template built once at that size', async () => {
    const created: Array<string | undefined> = [];
    const ensureTemplate = vi.fn(async () => undefined);
    const factory = { create: async (options: { template?: string }) => { created.push(options.template); return fakeSandbox(() => undefined); },
      connect: async () => fakeSandbox(() => undefined), ensureTemplate };
    const provider = new E2BWorldProvider(factory as any);
    // The default size needs nothing built.
    await provider.create({ taskId: 'default', base: 'main', resources: { cpu: 2, memoryMb: 2048 } });
    expect(created).toEqual([DEFAULT_E2B_TEMPLATE]);
    expect(ensureTemplate).not.toHaveBeenCalled();
    const shape = { cpu: 4, memoryMb: 8192, diskGb: 40 };
    const world = await provider.create({ taskId: 'big', base: 'main', resources: { ...shape, gpu: 0 } });
    await provider.create({ taskId: 'big-too', base: 'main', resources: shape });
    expect(ensureTemplate).toHaveBeenCalledTimes(1);
    expect(ensureTemplate).toHaveBeenCalledWith(DEFAULT_E2B_TEMPLATE, sizedTemplateName(DEFAULT_E2B_TEMPLATE, shape), shape, {});
    expect(created.slice(1)).toEqual([sizedTemplateName(DEFAULT_E2B_TEMPLATE, shape), sizedTemplateName(DEFAULT_E2B_TEMPLATE, shape)]);
    expect(world.handle.warnings ?? []).toEqual([]);
    // A project environment snapshot was built at its project's size already.
    await provider.create({ taskId: 'built', base: 'main', resources: shape, environment: { snapshot: 'env-snapshot' } });
    expect(created.at(-1)).toBe('env-snapshot');
    expect(sizedBuildOptions(shape)).toEqual({ cpuCount: 4, memoryMB: 8192, minFreeDiskMb: 40 * 1024 });
    expect(sizedBuildOptions({ diskGb: 200 }).minFreeDiskMb).toBe(50 * 1024);
  });

  it('builds a disk above the account\'s ceiling at the ceiling, and says so', async () => {
    expect(e2bDiskLimitGb(new Error("400: Minimum free disk can't be higher than 25600 MiB (if you need to increase this limit, please contact support)"))).toBe(25);
    expect(e2bDiskLimitGb(new Error('quota exceeded'))).toBeUndefined();
    const created: Array<string | undefined> = [];
    const provider = new E2BWorldProvider({ create: async (options: { template?: string }) => { created.push(options.template); return fakeSandbox(() => undefined); },
      connect: async () => fakeSandbox(() => undefined),
      ensureTemplate: async () => ({ name: 'karmax-sized-capped', diskGb: 25 }) } as any);
    const world = await provider.create({ taskId: 'capped', base: 'main', resources: { cpu: 4, memoryMb: 4096, diskGb: 30 } });
    expect(created).toEqual(['karmax-sized-capped']);
    expect(world.handle.warnings).toEqual(['This E2B account gives a computer at most 25 GB of free disk, so this one has 25 GB, not 30 GB.']);
  });

  it('never fails a task over its size: it runs at the default size and says why', async () => {
    const created: Array<string | undefined> = [];
    const provider = new E2BWorldProvider({ create: async (options: { template?: string }) => { created.push(options.template); return fakeSandbox(() => undefined); },
      connect: async () => fakeSandbox(() => undefined),
      ensureTemplate: async () => { throw new Error('template build quota exceeded'); } } as any);
    const world = await provider.create({ taskId: 'refused', base: 'main', resources: { diskGb: 30 } });
    expect(created).toEqual([DEFAULT_E2B_TEMPLATE]);
    expect(world.handle.warnings?.join('\n')).toMatch(/could not be prepared as 2 CPU · 2 GB · 30 GB disk.*template build quota exceeded/);
  });

  it('uses one provider inventory request before a new allocation (LT-3)', async () => {
    const sandbox = fakeSandbox(() => undefined);
    const list = vi.fn(async () => []);
    await new E2BWorldProvider({ create: async () => sandbox, connect: async () => sandbox, list })
      .create({ taskId: 'new-allocation', base: 'main' });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('stops lifecycle pagination after the overlapping cursor (WD-18, LT-19)', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const offset = Number(new URL(String(input)).searchParams.get('offset'));
      return Response.json(Array.from({ length: 100 }, (_, index) => ({ timestamp: new Date(10_000 - offset - index).toISOString() })));
    });
    try {
      const provider = new E2BWorldProvider();
      expect((await provider.listUsageEvents('org', 9850)).resumeAt).toBeUndefined();
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { fetcher.mockRestore(); }
  });

  // LT-19: a feed longer than one sweep's page bound returns what it read and
  // where to resume, instead of throwing away the whole scan every sweep.
  it('returns a bounded scan with the offset to resume a long lifecycle feed from', async () => {
    const offsets: number[] = [];
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const offset = Number(new URL(String(input)).searchParams.get('offset'));
      offsets.push(offset);
      return Response.json(Array.from({ length: 100 }, (_, index) => lifecycleEvent(`execution-${offset + index}`)));
    });
    try {
      const provider = new E2BWorldProvider();
      const first = await provider.listUsageEvents('org');
      expect(first.events.length).toBe(offsets.length * 100);
      expect(first.events[0]?.id).toBe('execution-0');
      expect(first.resumeAt).toBe(offsets.length * 100);
      offsets.length = 0;
      const second = await provider.listUsageEvents('org', undefined, first.resumeAt);
      expect(offsets[0]).toBe(first.resumeAt);
      expect(second.events[0]?.id).toBe(`execution-${first.resumeAt}`);
    } finally { fetcher.mockRestore(); }
  });

  it('provisions each recorded checkout branch and directory (WD-11)', async () => {
    const commands: string[] = [];
    const sandbox = fakeSandbox(() => undefined);
    sandbox.commands.run = async command => { commands.push(command); return { stdout: command.includes('rev-parse') ? 'a'.repeat(40) : '', stderr: '', exitCode: 0 }; };
    const provider = new E2BWorldProvider({ create: async () => sandbox, connect: async () => sandbox });
    const world = await provider.create({ taskId: 'restored', base: 'main',
      repos: ['git@github.com:org/repo.git', 'git@github.com:org/repo.git'],
      checkouts: [ { name: 'first', branch: 'saved-one', base: 'main', sourceAuthority: 'origin' },
        { name: 'second', branch: 'saved-two', base: 'main', gitIdentity: { name: 'Saved', email: 'saved@test' } } ] });
    expect(world.handle.repos?.map(repo => [repo.name, repo.branch])).toEqual([['first', 'saved-one'], ['second', 'saved-two']]);
    expect(commands.join('\n')).toContain("checkout -q -B 'saved-two' 'origin/saved-two'");
    expect(commands.join('\n')).toContain("config user.email 'saved@test'");
  });

  it('evicts destroyed sandboxes and lifecycle cache entries (WD-3, PS-10)', async () => {
    const sandbox = fakeSandbox(() => undefined);
    let opens = 0;
    const provider = new E2BWorldProvider({ create: async () => sandbox,
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
    const sandbox = fakeSandbox(() => undefined);
    const provider = new E2BWorldProvider({ create: async () => sandbox, connect: async () => sandbox,
      get: async () => sandbox, info: async () => { throw error; } } as any);
    const world = await provider.create({ taskId: 'probe', base: 'main' });
    expect(await provider.probe(world.handle)).toBe(expected);
  });

  it('preserves undecidable sealed references during orphan comparison (WD-1)', async () => {
    const sandbox = fakeSandbox(() => undefined);
    const provider = new E2BWorldProvider({ create: async () => sandbox, connect: async () => sandbox,
      get: async () => sandbox, list: async () => [sandbox] } as any);
    const world = await provider.create({ taskId: 'sealed', base: 'main' });
    const [listed] = await provider.listSandboxes();
    expect(listed!.matches!({ ...world.handle, sealedProviderRef: 'unreadable' })).toBeUndefined();
  });

  it('normalizes only this deployment\'s completed provider executions for billing', async () => {
    const sandbox = fakeSandbox(() => undefined);
    const factory: E2BFactory = {
      async create() { return sandbox; },
      async connect() { return sandbox; },
      async events() {
        return { events: [
          { id: 'pause-1', type: 'sandbox.lifecycle.paused', timestamp: '2026-07-31T10:05:00Z',
            sandbox_id: 'sandbox-1', sandbox_execution_id: 'execution-1', event_data: {
              sandbox_metadata: { karmaxHome: serviceHomeLabel(), karmaxTaskId: 'task-1', karmaxOrganizationId: 'org-1' },
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
        ] };
      },
    };
    const provider = new E2BWorldProvider(factory, undefined, undefined,
      () => ({ organizationId: 'org-1', provider: 'e2b', apiKey: 'secret', config: {} }));

    expect((await provider.listUsageEvents!('org-1')).events).toEqual([{
      id: 'execution-1', sandboxId: 'sandbox-1', taskId: 'task-1', organizationId: 'org-1',
      startedAt: Date.UTC(2026, 6, 31, 10), endedAt: Date.UTC(2026, 6, 31, 10, 5),
      activeMs: 300_000, cpu: 2, memoryMb: 512,
    }]);
  });

  it('uses the public prebuilt template when no headless template is configured', async () => {
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
      expect(createdOptions?.template).toBe(DEFAULT_E2B_TEMPLATE);
    } finally {
      if (prior === undefined) delete process.env.KARMAX_E2B_TEMPLATE;
      else process.env.KARMAX_E2B_TEMPLATE = prior;
    }
  });

  it('inherits the public default across organizations while preserving explicit selections and keys', async () => {
    const before = process.env.KARMAX_E2B_TEMPLATE;
    delete process.env.KARMAX_E2B_TEMPLATE;
    const created: any[] = [];
    const factory: E2BFactory = {
      async create(options) { created.push(options); return fakeSandbox(() => undefined); },
      async connect() { return fakeSandbox(() => undefined); },
    };
    try {
      const provider = new E2BWorldProvider(factory, undefined, undefined, organizationId => ({
        provider: 'e2b', organizationId, apiKey: `key-${organizationId}`,
        config: organizationId === 'custom' ? { template: 'org-template' } : {},
      }));
      await provider.create({ taskId: 'new-project-a', organizationId: 'new-a', base: 'main' });
      await provider.create({ taskId: 'new-project-b', organizationId: 'new-b', base: 'main' });
      await provider.create({ taskId: 'custom-org', organizationId: 'custom', base: 'main' });
      await provider.create({ taskId: 'custom-project', organizationId: 'custom', base: 'main', environment: { template: 'project-template' } });
      expect(created.map(x => x.template)).toEqual([DEFAULT_E2B_TEMPLATE, DEFAULT_E2B_TEMPLATE, 'org-template', 'project-template']);
      expect(created.map(x => x.apiKey)).toEqual(['key-new-a', 'key-new-b', 'key-custom', 'key-custom']);
    } finally {
      if (before === undefined) delete process.env.KARMAX_E2B_TEMPLATE;
      else process.env.KARMAX_E2B_TEMPLATE = before;
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
      requestTimeoutMs: 120_000,
      lifecycle: { onTimeout: 'pause', autoResume: true },
      metadata: { karmaxTaskId: 'task-cloud', karmaxGeneration: '1' },
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
    for (const byte of new TextEncoder().encode('🌍 नमस्ते')) ptyData?.(new Uint8Array([byte]));
    await terminal.write('pwd\n');
    await terminal.resize(120, 40);
    await terminal.close();
    // One renewal covers every holder within the interval (process, PTY, commands); each keeps renewing while held.
    expect(timeoutRefreshes).toBeGreaterThanOrEqual(1);
    expect(terminal.pid).toBeUndefined(); // remote pid must never enter the host process registry
    expect(ptyOptions.cmd).toBeUndefined();
    expect(terminalOutput).toBe('ready🌍 नमस्ते');
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

  it('adopts an unregistered sandbox for the same task generation instead of creating another', async () => {
    const sandbox = fakeSandbox(() => undefined);
    sandbox.sandboxId = 'already-created';
    let creates = 0;
    let connects = 0;
    const metadata = { karmaxHome: serviceHomeLabel(), karmaxTaskId: 'retry-create', karmaxGeneration: '3' };
    const provider = new E2BWorldProvider({
      async create() { creates++; return sandbox; },
      async connect(id, options) {
        expect(id).toBe('already-created');
        expect(options.requestTimeoutMs).toBe(120_000);
        connects++;
        return sandbox;
      },
      async list(options) {
        // Sandboxes created before the organization label are still adopted.
        expect(options.metadata).not.toHaveProperty('karmaxOrganizationId');
        return options.metadata.karmaxTaskId === 'retry-create'
          ? [{ sandboxId: sandbox.sandboxId, metadata }]
          : [];
      },
    });

    await provider.create({ taskId: 'retry-create', generation: 3, base: 'main', organizationId: 'org-1' });

    expect(creates).toBe(0);
    expect(connects).toBe(1);
  });

  it('reconciles provider truth when the create response times out after allocation', async () => {
    const sandbox = fakeSandbox(() => undefined);
    sandbox.sandboxId = 'late-create';
    let allocated = false;
    let creates = 0;
    let connects = 0;
    const metadata = { karmaxHome: serviceHomeLabel(), karmaxTaskId: 'late', karmaxGeneration: '1' };
    const provider = new E2BWorldProvider({
      async create(options) {
        expect(options.requestTimeoutMs).toBe(120_000);
        creates++;
        allocated = true;
        throw Object.assign(new Error('The operation was aborted due to timeout'), { code: 'ETIMEDOUT' });
      },
      async connect(id) { expect(id).toBe('late-create'); connects++; return sandbox; },
      async list(options) {
        return allocated && options.metadata.karmaxTaskId === 'late'
          ? [{ sandboxId: sandbox.sandboxId, metadata }]
          : [];
      },
    });

    await expect(provider.create({ taskId: 'late', generation: 1, base: 'main' })).resolves.toBeDefined();
    expect(creates).toBe(1);
    expect(connects).toBe(1);
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
      gitCredentials: { repositories: { 'git@github.com:acme/private.git': 'PRIVATE CLONE KEY' } },
    });

    expect(writes.get('/home/user/.ssh/karmax-auth-0')).toContain('PRIVATE CLONE KEY');
    expect(commands.some((command) => command.includes('GIT_SSH_COMMAND=') && command.includes('git clone'))).toBe(true);
    expect(commands.at(-1)).toContain('rm -f /home/user/.ssh/karmax-auth*');
    expect(JSON.stringify(world.handle)).not.toContain('PRIVATE CLONE KEY');
  });

  // legibench3#18 (2026-10-01): the SDK carries every file transfer to a sandbox
  // on one process-wide HTTP/2 session. Once E2B's edge resets that session's
  // streams (NGHTTP2_ENHANCE_YOUR_CALM, after a large upload), every later
  // transfer on it fails until the worker restarts: 18 identical failed turns.
  describe('file transfers the SDK session dropped', () => {
    const reset = () => Object.assign(new TypeError('fetch failed'),
      { cause: new Error('Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM') });
    const signed = (file: string) => `https://49983-sbx.e2b.test/files?path=${encodeURIComponent(file)}&signature=v1_secret`;

    async function droppedSession(respond?: (file: string, init?: RequestInit) => Response | undefined) {
      const sandbox = fakeSandbox(() => undefined) as E2BSandboxLike & Record<string, unknown>;
      const world = await new E2BWorldProvider({ create: async () => sandbox, connect: async () => sandbox })
        .create({ taskId: 'h2-reset', base: 'main' });
      const sdk: string[] = [];
      sandbox.files.write = async (file) => { sdk.push(`write ${file}`); throw reset(); };
      sandbox.files.read = async (file) => { sdk.push(`read ${file}`); throw reset(); };
      sandbox.uploadUrl = async (file: string) => signed(file);
      sandbox.downloadUrl = async (file: string) => signed(file);
      const stored = new Map<string, Buffer>();
      const requests: string[] = [];
      const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const file = new URL(String(input)).searchParams.get('path')!;
        requests.push(`${init?.method ?? 'GET'} ${file}`);
        const custom = respond?.(file, init);
        if (custom) return custom;
        if (init?.method === 'POST') {
          stored.set(file, Buffer.from(await ((init.body as FormData).get('file') as Blob).arrayBuffer()));
          return Response.json([{ path: file }]);
        }
        const data = stored.get(file);
        return data ? new Response(data) : new Response('file not found', { status: 404 });
      });
      return { sandbox, world, sdk, requests, fetcher };
    }

    it('resends it on its own connection, and sends the rest of that sandbox\'s transfers there too', async () => {
      const { world, sdk, requests, fetcher } = await droppedSession();
      try {
        await world.writeFileBuffer!('a.bin', Buffer.from('first'));
        await world.writeFile('b.txt', 'second');
        expect(await world.readFile('b.txt')).toBe('second');
        expect((await world.readFileBuffer('a.bin')).toString()).toBe('first');
        expect((await world.readFilePrefix!('a.bin', 3)).toString()).toBe('fir');
        const streamed: Buffer[] = [];
        for await (const piece of world.readFileStream!('a.bin')) streamed.push(piece);
        expect(Buffer.concat(streamed).toString()).toBe('first');
        // Only the first transfer was tried on the dropped session.
        expect(sdk).toEqual(['write /home/user/karmax/a.bin']);
        expect(requests).toEqual(['POST /home/user/karmax/a.bin', 'POST /home/user/karmax/b.txt',
          'GET /home/user/karmax/b.txt', 'GET /home/user/karmax/a.bin', 'GET /home/user/karmax/a.bin', 'GET /home/user/karmax/a.bin']);
      } finally { fetcher.mockRestore(); }
    });

    it('never reroutes a failure the sandbox itself reported', async () => {
      const { sandbox, world, requests, fetcher } = await droppedSession();
      sandbox.files.write = async () => { throw new Error('500: error opening file: permission denied'); };
      try {
        await expect(world.writeFile('locked.txt', 'x')).rejects.toThrow('permission denied');
        expect(requests).toEqual([]);
      } finally { fetcher.mockRestore(); }
    });

    it('reports a failed direct transfer by its status, never by its signed URL', async () => {
      const { world, fetcher } = await droppedSession(() => new Response('not enough disk space', { status: 507 }));
      try {
        const failure = await world.writeFile('full.txt', 'x').then(() => undefined, (error: Error) => error);
        expect(failure?.message).toMatch(/507.*not enough disk space/);
        expect(failure?.message).not.toContain('signature');
        expect(failure?.message).not.toContain('v1_secret');
      } finally { fetcher.mockRestore(); }
    });

    it('reports a missing file as a missing file, never as a missing sandbox', async () => {
      const { world, fetcher } = await droppedSession();
      try {
        await world.writeFile('present.txt', 'x'); // the session drops; transfers go direct
        const failure = await world.readFile('absent.txt').then(() => undefined, (error: Error) => error);
        expect(failure).toMatchObject({ name: 'FileNotFoundError' });
        expect(isMissingSandbox(failure)).toBe(false);
      } finally { fetcher.mockRestore(); }
    });
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

  it('preserves structured E2B command transport errors for activity classification', async () => {
    const sandbox = fakeSandbox(() => undefined);
    const provider = new E2BWorldProvider({ create: async () => sandbox, connect: async () => sandbox });
    const world = await provider.create({ taskId: 'command-timeout', base: 'main' });
    sandbox.commands.run = async () => {
      throw Object.assign(new Error('E2B command request failed'), { code: 'ETIMEDOUT' });
    };

    await expect(world.exec('pwd', [])).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  });

  it('reports a stdin command that exited before its input arrived by its own exit, not the stale pid', async () => {
    const sandbox = fakeSandbox(() => undefined);
    const provider = new E2BWorldProvider({ create: async () => sandbox, connect: async () => sandbox });
    const world = await provider.create({ taskId: 'stdin-exited', base: 'main' });
    const notFound = () => Promise.reject(Object.assign(new Error('[not_found] process with pid 2185 not found'), { code: 5 }));
    sandbox.commands.run = (async () => ({
      pid: 2185, sendStdin: notFound, closeStdin: notFound, kill: async () => false,
      wait: async () => { throw Object.assign(new Error('exit status 1'), { exitCode: 1, stdout: '',
        stderr: "Error: Cannot find module '/home/user/karmax/repo/.karmax/cdp-fill.mjs'" }); },
    })) as any;

    expect(await world.exec('node', ['.karmax/cdp-fill.mjs'], { input: 'secret' })).toEqual({
      stdout: '', stderr: "Error: Cannot find module '/home/user/karmax/repo/.karmax/cdp-fill.mjs'", code: 1 });
  });

  it('keeps the stdin transport error when the command is still running', async () => {
    const sandbox = fakeSandbox(() => undefined);
    const provider = new E2BWorldProvider({ create: async () => sandbox, connect: async () => sandbox });
    const world = await provider.create({ taskId: 'stdin-transport', base: 'main' });
    let killed = 0;
    sandbox.commands.run = (async () => ({
      pid: 7, closeStdin: async () => undefined, kill: async () => { killed++; return true; },
      sendStdin: async () => { throw Object.assign(new Error('E2B stdin request failed'), { code: 'ECONNRESET' }); },
      wait: async () => { throw new Error('wait must not be awaited for a live command'); },
    })) as any;

    await expect(world.exec('node', ['helper.mjs'], { input: 'secret' })).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(killed).toBe(1);
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

  it('preserves the native exit code from a rejected PTY wait', async () => {
    const sandbox = fakeSandbox(() => undefined);
    sandbox.pty.create = async () => ({ pid: 9, async wait() {
      throw Object.assign(new Error('exit status 254'), { exitCode: 254 });
    } });
    const provider = new E2BWorldProvider({ create: async () => sandbox, connect: async () => sandbox });
    const world = await provider.create({ taskId: 'failed-exit', base: 'main' });
    const pty = await world.openPty();
    expect(await new Promise<number | null>((resolve) => pty.onExit(resolve))).toBe(254);
  });

  // Task 364: E2B's wait() rejects with CommandExitError for any nonzero exit.
  // A review server that failed to bind (EADDRINUSE) must report exit 1, not
  // the -1 reserved for a lost stream, and not echo "exit status 1" as output.
  it('preserves the native exit code of a failed background process', async () => {
    const sandbox = fakeSandbox(() => undefined);
    const provider = new E2BWorldProvider({ create: async () => sandbox, connect: async () => sandbox });
    const world = await provider.create({ taskId: 'process-exit', base: 'main' });
    const endings: unknown[] = [
      Object.assign(new Error('exit status 1'), { name: 'CommandExitError', exitCode: 1, error: 'exit status 1' }),
      Object.assign(new Error('[unavailable] upstream connect error'), { name: 'ConnectError', code: 14 }),
    ];
    const seen: { code: number | null; output: string }[] = [];
    for (const ending of endings) {
      sandbox.commands.run = (async (_command: string, options: any) => {
        options.onStderr?.('Error: listen EADDRINUSE: address already in use :::4173\n');
        return { wait: async () => { throw ending; }, kill: async () => true };
      }) as any;
      const proc = await world.startProcess({ command: 'npm run preview' });
      let output = '';
      proc.onOutput((chunk) => { output += chunk; });
      seen.push({ code: await new Promise<number | null>((resolve) => proc.onExit(resolve)), output });
    }
    expect(seen[0]).toEqual({ code: 1, output: 'Error: listen EADDRINUSE: address already in use :::4173\n' });
    expect(seen[1]!.code).toBe(-1);
    expect(seen[1]!.output).toContain('upstream connect error');
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

  // Task 348: envd reports a signalled process as exit -1 with the reason in
  // `error`, and a dropped stream rejects without any exit status at all. Both
  // used to surface as "exited with code -1" although, in 348, the agent was
  // still running in a sandbox frozen by memory exhaustion.
  it('reports how a PTY process ended instead of a bare -1', async () => {
    const endings = [
      Object.assign(new Error('signal: killed'), { name: 'CommandExitError', exitCode: -1, error: 'signal: killed' }),
      Object.assign(new Error('[unavailable] upstream connect error'), { name: 'ConnectError', code: 14 }),
    ];
    const seen: unknown[] = [];
    for (const ending of endings) {
      const sandbox = fakeSandbox(() => undefined);
      sandbox.pty.create = async () => ({ pid: 9, async wait() { throw ending; } });
      const provider = new E2BWorldProvider({ create: async () => sandbox, connect: async () => sandbox });
      const world = await provider.create({ taskId: 'pty-ending', base: 'main' });
      const pty = await world.openPty();
      seen.push(await new Promise((resolve) => pty.onExit((code, termination) => resolve({ code, termination }))));
    }
    expect(seen[0]).toEqual({ code: null, termination: { signal: 'SIGKILL' } });
    expect(seen[1]).toMatchObject({ code: null, termination: { lost: endings[1] } });
  });

  // Task 350: E2B's Hobby plan pauses a sandbox after one hour of continuous
  // running whatever timeout karmax requests. The pause drops every stream,
  // but the agent survives it, so resume the sandbox and follow the same PTY.
  it('reattaches to a PTY whose stream dropped while its process survived', async () => {
    const dropped = Object.assign(new Error('[unavailable] upstream connect error'), { name: 'ConnectError', code: 14 });
    const run = async (connect: (pid: number, options: any) => Promise<any>, closeFirst = false) => {
      const sandbox = fakeSandbox(() => undefined);
      let drop!: () => void;
      const resumed: unknown[] = [];
      sandbox.pty.create = async () => ({ pid: 9, wait: () => new Promise((_resolve, reject) => { drop = () => reject(dropped); }) });
      sandbox.pty.connect = connect;
      sandbox.connect = async (options) => { resumed.push(options); return sandbox; };
      const provider = new E2BWorldProvider({ create: async () => sandbox, connect: async () => sandbox });
      const world = await provider.create({ taskId: 'pty-reattach', base: 'main' });
      const pty = await world.openPty();
      const output: string[] = [];
      pty.onData((chunk) => output.push(chunk));
      const ended = new Promise((resolve) => pty.onExit((code, termination) => resolve({ code, termination })));
      if (closeFirst) await pty.close();
      drop();
      return { ending: await ended, output, resumed };
    };

    const reattached = await run(async (pid, options) => {
      expect(pid).toBe(9);
      options.onData(new TextEncoder().encode('after the pause'));
      return { pid, wait: async () => ({ exitCode: 0 }) };
    });
    expect(reattached).toMatchObject({ ending: { code: 0 }, output: ['after the pause'], resumed: [expect.any(Object)] });

    const gone = await run(async () => { throw Object.assign(new Error('process with pid 9 not found'), { name: 'NotFoundError' }); });
    expect(gone.ending).toEqual({ code: null, termination: { lost: dropped } });

    // A stream that keeps dropping is not a pause: stop after a few reattaches.
    let reattaches = 0;
    const flapping = await run(async (pid) => { reattaches++; return { pid, wait: async () => { throw dropped; } }; });
    expect(flapping.ending).toEqual({ code: null, termination: { lost: dropped } });
    expect(reattaches).toBe(3);

    // karmax closed it (turn over, world parking): never resume a paused world.
    const closed = await run(async () => { throw new Error('must not reattach'); }, true);
    expect(closed).toMatchObject({ ending: { code: null, termination: { lost: dropped } }, resumed: [] });
  });

  it('diagnoses a sandbox that ran out of memory from provider metrics', async () => {
    const sandbox = fakeSandbox(() => undefined);
    const at = (time: string) => new Date(`2026-09-24T${time}Z`);
    const mb = 2 ** 20;
    let asked: { start?: Date; end?: Date } | undefined;
    sandbox.getMetrics = async (options) => {
      asked = options;
      return [
        { timestamp: at('04:55:00'), memUsed: 796 * mb, memTotal: 1983 * mb },
        { timestamp: at('04:55:30'), memUsed: 1604 * mb, memTotal: 1983 * mb },
        { timestamp: at('04:56:00'), memUsed: 1961 * mb, memTotal: 1983 * mb },
      ];
    };
    const provider = new E2BWorldProvider({ create: async () => sandbox, connect: async () => sandbox });
    const world = await provider.create({ taskId: 'memory', base: 'main' });
    const now = at('04:56:50').getTime();
    const diagnosis = await world.diagnose!({ since: at('04:50:43').getTime(), now });
    expect(diagnosis?.summary).toBe('sandbox memory reached 1961 of 1983 MB (99%) at 04:56:00 UTC');
    expect(asked?.end?.getTime()).toBe(now);

    sandbox.getMetrics = async () => [{ timestamp: at('04:56:30'), memUsed: 900 * mb, memTotal: 1983 * mb }];
    expect(await world.diagnose!({ since: at('04:50:43').getTime(), now })).toBeUndefined();
    sandbox.getMetrics = async () => { throw new Error('metrics service unavailable'); };
    expect(await world.diagnose!({ since: at('04:50:43').getTime(), now })).toBeUndefined();
  });
});

function lifecycleEvent(execution: string) {
  return { type: 'sandbox.lifecycle.paused', timestamp: '2026-07-31T10:05:00Z', sandbox_id: 'sandbox', sandbox_execution_id: execution,
    event_data: { sandbox_metadata: { karmaxHome: serviceHomeLabel() },
      execution: { started_at: '2026-07-31T10:00:00Z', execution_time: 1000, vcpu_count: 1, memory_mb: 512 } } };
}

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
