import { describe, expect, it } from 'vitest';
import { DaytonaWorldProvider, type DaytonaFactory, type DaytonaSandboxLike } from '../src/world/daytona.js';

describe('Daytona cloud world provider', () => {
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
      async stop() {},
      async archive() { archived++; sandbox.state = 'archived'; },
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
      networkBlockAll: true, domainAllowList: expect.stringContaining('registry.npmjs.org'), resources: { cpu: 2, memory: 4 } });
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
      gitCredentials: { sshKey: 'PRIVATE KEY' } });
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
    id: 'fake', state: 'started',
    process: { executeCommand: async () => ({ exitCode: 0, result: '' }),
      createPty: async () => ({ waitForConnection: async () => {}, wait: () => new Promise(() => {}) }) },
    fs: { downloadFile: async () => Buffer.alloc(0), uploadFile: async () => {} },
    getUserHomeDir: async () => '/home/daytona', getSignedPreviewUrl: async () => ({ url: 'https://invalid/' }),
    start: async () => {}, stop: async () => {}, archive: async () => {}, delete: async () => {},
  };
}
