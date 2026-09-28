import { afterEach, describe, expect, it, vi } from 'vitest';
import { E2BWorldProvider, DEFAULT_E2B_TEMPLATE, type E2BFactory, type E2BSandboxLike } from '../src/world/e2b.js';
import type { World } from '../src/world/types.js';

/**
 * E2BWorldProvider and E2BWorld against a scripted SDK (CI-38g). The regression
 * tests in e2b-world.test.ts pin individual incidents; this file walks the
 * provider's lifecycle (create, adopt, open, park, probe, destroy, reap) and
 * the world's transport (exec, files, processes, PTYs, ports, desktop) so each
 * branch that talks to E2B has a test. No E2B account, no network.
 */

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

type Script = { run?: (command: string, options?: Record<string, unknown>) => Promise<any> };

function sandbox(id = `sbx-${Math.random().toString(36).slice(2)}`, script: Script = {}) {
  const commands: string[] = [];
  const box = {
    sandboxId: id,
    commands: {
      run: vi.fn(async (command: string, options?: Record<string, unknown>) => {
        commands.push(command);
        return script.run ? script.run(command, options) : { stdout: '', stderr: '', exitCode: 0 };
      }),
    },
    files: { read: vi.fn(async () => ''), write: vi.fn(async () => undefined) },
    pty: { create: vi.fn(async () => ({ pid: 7 })), sendInput: vi.fn(async () => undefined),
      resize: vi.fn(async () => undefined), kill: vi.fn(async () => undefined) } as E2BSandboxLike['pty'],
    pause: vi.fn(async () => undefined),
    kill: vi.fn(async () => undefined),
    updateNetwork: vi.fn(async () => undefined),
  } satisfies E2BSandboxLike;
  return Object.assign(box, { commands: Object.assign(box.commands, { log: commands }) }) as typeof box & E2BSandboxLike;
}

function factory(created: E2BSandboxLike, overrides: Partial<E2BFactory> = {}) {
  return {
    create: vi.fn(async () => created),
    connect: vi.fn(async () => created),
    ...overrides,
  } satisfies E2BFactory;
}

const connection = (apiKey = 'org-key') => async (organizationId: string | undefined, provider: string) =>
  ({ organizationId, provider, apiKey, config: { template: 'org-template', desktopTemplate: 'org-desktop' } }) as any;

describe('E2B provider lifecycle', () => {
  it('creates a paused-on-idle sandbox with the task policy installed before the world is returned', async () => {
    const box = sandbox();
    const sdk = factory(box);
    const provider = new E2BWorldProvider(sdk, 60_000, 'default-template', connection());
    const world = await provider.create({ taskId: 'task-1', base: 'main', organizationId: 'org-1',
      network: { allowDomains: ['example.test'] } });
    expect(sdk.create).toHaveBeenCalledWith(expect.objectContaining({ template: 'org-template', apiKey: 'org-key',
      timeoutMs: 60_000, lifecycle: { onTimeout: 'pause', autoResume: true }, allowInternetAccess: true,
      metadata: expect.objectContaining({ karmaxTaskId: 'task-1', karmaxGeneration: '1' }) }));
    expect(box.updateNetwork).toHaveBeenCalledWith({ allowOut: expect.arrayContaining(['example.test', 'github.com']),
      denyOut: ['0.0.0.0/0'] });
    // Clone credentials never outlive provisioning.
    expect(box.commands.log).toContain('rm -f /home/user/.ssh/karmax-auth*');
    expect(world.handle).toMatchObject({ kind: 'e2b', id: 'task-1', branch: 'karmax/task-1',
      meta: { environmentFlavor: 'headless', environmentArtifact: 'org-template', releaseOnCompletion: true } });
    expect(JSON.stringify(world.handle)).not.toContain(box.sandboxId);
    expect(await provider.status(world.handle)).toBe('ready');
  });

  it('leaves egress open only for an unrestricted task', async () => {
    const box = sandbox();
    await new E2BWorldProvider(factory(box)).create({ taskId: 'open', base: 'main', network: { unrestricted: true } });
    expect(box.updateNetwork).not.toHaveBeenCalled();
  });

  it('chooses the task template, then the organization default, then the installation default', async () => {
    const box = sandbox();
    const sdk = factory(box);
    await new E2BWorldProvider(sdk, 1000, 'installation').create({ taskId: 'a', base: 'main',
      environment: { template: 'task-template' } as any });
    await new E2BWorldProvider(sdk, 1000, 'installation').create({ taskId: 'b', base: 'main' });
    await new E2BWorldProvider(sdk, 1000, 'installation', connection()).create({ taskId: 'c', base: 'main',
      environment: { flavor: 'desktop' } as any });
    await new E2BWorldProvider(sdk, 1000, 'installation', undefined, 'installation-desktop').create({ taskId: 'd',
      base: 'main', environment: { flavor: 'desktop' } as any });
    const calls = sdk.create.mock.calls.map(([options]: any[]) => [options.template, options.desktop ?? false]);
    expect(calls).toEqual([['task-template', false], ['installation', false], ['org-desktop', true],
      ['installation-desktop', true]]);
  });

  it('falls back to E2B_API_KEY and the built-in template without a connection resolver', async () => {
    vi.stubEnv('E2B_API_KEY', 'env-key');
    const box = sandbox();
    const sdk = factory(box);
    await new E2BWorldProvider(sdk).create({ taskId: 'env', base: 'main' });
    expect(sdk.create).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'env-key', template: DEFAULT_E2B_TEMPLATE }));
  });

  it('adopts a sandbox the provider allocated after a timed-out create, and wipes its partial workspace', async () => {
    const box = sandbox('late-sandbox');
    let listed = 0;
    const sdk = factory(box, {
      create: vi.fn(async () => { throw new Error('request timed out'); }),
      // The first inventory (before allocating) is empty; E2B finished the allocation afterwards.
      list: vi.fn(async ({ metadata }: any) => (listed++ === 0 ? []
        : [{ sandboxId: 'late-sandbox', metadata: { ...metadata, karmaxGeneration: '2' } }])),
    });
    const world = await new E2BWorldProvider(sdk).create({ taskId: 'retry', base: 'main', generation: 2 });
    expect(sdk.connect).toHaveBeenCalledWith('late-sandbox', expect.anything());
    expect(box.commands.log[0]).toBe('rm -rf /home/user/karmax && mkdir -p /home/user/karmax');
    expect(world.handle.id).toBe('retry');
  });

  it('rethrows a failed create that left nothing behind, and does not reconcile an aborted one', async () => {
    const list = vi.fn(async () => []);
    const failing = factory(sandbox(), { create: vi.fn(async () => { throw new Error('quota exceeded'); }), list });
    await expect(new E2BWorldProvider(failing).create({ taskId: 'fail', base: 'main' })).rejects.toThrow('quota exceeded');
    expect(list).toHaveBeenCalledTimes(2);

    list.mockClear();
    const controller = new AbortController();
    const aborting = factory(sandbox(), { list,
      create: vi.fn(async () => { controller.abort(); throw new Error('aborted'); }) });
    await expect(new E2BWorldProvider(aborting).create({ taskId: 'stop', base: 'main', signal: controller.signal }))
      .rejects.toThrow('aborted');
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('kills every ambiguous provisioning candidate instead of choosing one', async () => {
    const kill = vi.fn(async () => undefined);
    const sdk = factory(sandbox(), { kill, list: vi.fn(async ({ metadata }: any) => [
      { sandboxId: 'one', metadata: { ...metadata, karmaxGeneration: '1' } },
      { sandboxId: 'two', metadata: { ...metadata, karmaxGeneration: '1' } },
    ]) });
    await expect(new E2BWorldProvider(sdk, 1000, 't', connection('k')).create({ taskId: 'dup', base: 'main', organizationId: 'o' }))
      .rejects.toThrow('multiple E2B sandboxes exist for task generation dup/1');
    expect(kill.mock.calls).toEqual([['one', { apiKey: 'k' }], ['two', { apiKey: 'k' }]]);
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it('adopts a legacy sandbox created before generations were recorded', async () => {
    const box = sandbox('legacy');
    const sdk = factory(box, { list: vi.fn(async () => [{ sandboxId: 'legacy', metadata: { karmaxTaskId: 'old' } }]) });
    await new E2BWorldProvider(sdk).create({ taskId: 'old', base: 'main' });
    expect(sdk.create).not.toHaveBeenCalled();
    expect(sdk.connect).toHaveBeenCalledWith('legacy', expect.anything());
  });

  it('kills the sandbox and forgets it when provisioning fails', async () => {
    const box = sandbox('broken', { run: async (command) => command.startsWith('rm -f')
      ? Promise.reject(new Error('envd unavailable')) : { stdout: '', stderr: '', exitCode: 0 } });
    const provider = new E2BWorldProvider(factory(box));
    await expect(provider.create({ taskId: 'broken', base: 'main' })).rejects.toThrow('envd unavailable');
    expect(box.kill).toHaveBeenCalledTimes(1);
    expect((provider as any).sandboxes.size).toBe(0);
    expect((provider as any).states.size).toBe(0);
  });

  it('parks by pausing, reconnects on the next open, and treats a second park as done', async () => {
    const box = sandbox();
    const sdk = factory(box);
    const provider = new E2BWorldProvider(sdk);
    const world = await provider.create({ taskId: 'park', base: 'main' });
    await provider.open(world.handle);
    expect(sdk.connect).not.toHaveBeenCalled(); // the live sandbox is reused
    expect(await provider.park(world.handle)).toBe(world.handle);
    expect(await provider.park(world.handle)).toBe(world.handle);
    expect(box.pause).toHaveBeenCalledTimes(1);
    expect(await provider.status(world.handle)).toBe('parked');
    await provider.open(world.handle);
    expect(sdk.connect).toHaveBeenCalledTimes(1);
    expect(await provider.status(world.handle)).toBe('ready');
  });

  it('connects to park a sandbox this process has not seen, with the desktop SDK for a desktop world', async () => {
    const box = sandbox();
    const sdk = factory(box);
    const handle = (await new E2BWorldProvider(sdk).create({ taskId: 'desk', base: 'main',
      environment: { flavor: 'desktop' } as any })).handle;
    const restarted = new E2BWorldProvider(sdk);
    expect(await restarted.status(handle)).toBe('ready'); // the provider is authoritative after a restart
    await restarted.park(handle);
    expect(sdk.connect).toHaveBeenCalledWith(box.sandboxId, expect.objectContaining({ desktop: true }));
    expect(box.pause).toHaveBeenCalledTimes(1);
  });

  it('destroys through the control plane, or through a connection when the SDK has no kill', async () => {
    const box = sandbox();
    const kill = vi.fn(async () => undefined);
    const provider = new E2BWorldProvider(factory(box, { kill }), 1000, 't', connection('key'));
    const world = await provider.create({ taskId: 'gone', base: 'main', organizationId: 'org' });
    await provider.destroy(world.handle);
    expect(kill).toHaveBeenCalledWith(box.sandboxId, { apiKey: 'key' });
    expect(await provider.status(world.handle)).toBe('missing');

    const other = sandbox();
    const fallback = new E2BWorldProvider(factory(other));
    const second = await fallback.create({ taskId: 'gone-too', base: 'main' });
    await fallback.destroy(second.handle);
    expect(other.kill).toHaveBeenCalledTimes(1);
    expect(await fallback.status(second.handle)).toBe('missing');
  });

  it.each([
    ['paused', 'parked'], ['Stopping', 'parked'], ['running', 'ready'], ['resuming', 'ready'],
    ['killed', 'missing'], ['', undefined],
  ])('reads control-plane state %j as %s without connecting', async (state, expected) => {
    const box = sandbox();
    const sdk = factory(box, { info: vi.fn(async () => ({ state })) });
    const provider = new E2BWorldProvider(sdk);
    const world = await provider.create({ taskId: 'probe', base: 'main' });
    expect(await provider.probe(world.handle)).toBe(expected);
    expect(sdk.connect).not.toHaveBeenCalled();
    expect(await new E2BWorldProvider(factory(box)).probe(world.handle)).toBeUndefined();
  });

  it('reaps only through the control plane, falling back to a connection without kill', async () => {
    const kill = vi.fn(async () => undefined);
    const list = vi.fn(async () => [{ sandboxId: 'orphan', metadata: { karmaxTaskId: 'task-9' } }, { sandboxId: 'bare' }]);
    const provider = new E2BWorldProvider(factory(sandbox(), { list, kill }), 1000, 't', connection('reaper'));
    const listed = await provider.listSandboxes('org');
    expect(list).toHaveBeenCalledWith({ apiKey: 'reaper', metadata: { karmaxHome: expect.any(String) } });
    expect(listed.map(({ sandboxId, taskId }) => ({ sandboxId, taskId })))
      .toEqual([{ sandboxId: 'orphan', taskId: 'task-9' }, { sandboxId: 'bare', taskId: undefined }]);
    await listed[0]!.destroy();
    expect(kill).toHaveBeenCalledWith('orphan', { apiKey: 'reaper' });

    const orphan = sandbox('orphan');
    const connect = vi.fn(async () => orphan);
    const [viaConnect] = await new E2BWorldProvider({ create: async () => orphan, connect, list }).listSandboxes();
    await viaConnect!.destroy();
    expect(orphan.kill).toHaveBeenCalledTimes(1);
    expect(await new E2BWorldProvider(factory(sandbox())).listSandboxes()).toEqual([]);
  });

  it('matches a listed sandbox to the handle of the world it backs', async () => {
    const box = sandbox('mine');
    // Another generation's sandboxes, so creation allocates rather than adopts.
    const provider = new E2BWorldProvider(factory(box, { list: async () => [
      { sandboxId: 'mine', metadata: { karmaxGeneration: '9' } }, { sandboxId: 'theirs', metadata: { karmaxGeneration: '9' } }] }));
    const world = await provider.create({ taskId: 'match', base: 'main' });
    const [mine, theirs] = await provider.listSandboxes();
    expect(mine!.matches!(world.handle)).toBe(true);
    expect(theirs!.matches!(world.handle)).toBe(false);
    expect(mine!.matches!({ ...world.handle, kind: 'daytona' } as any)).toBe(false);
  });

  it('reports no usage without a lifecycle feed and skips malformed lifecycle events', async () => {
    expect(await new E2BWorldProvider(factory(sandbox())).listUsageEvents('org')).toEqual({ events: [] });
    const { serviceHomeLabel } = await import('../src/world/services.js');
    const execution = { started_at: '2026-07-31T10:00:00Z', execution_time: 1000, vcpu_count: 2, memory_mb: 512 };
    const event = (overrides: Record<string, unknown>) => ({ id: 'e', type: 'sandbox.lifecycle.killed',
      timestamp: '2026-07-31T10:05:00Z', sandbox_id: 's', sandbox_execution_id: 'x',
      event_data: { sandbox_metadata: { karmaxHome: serviceHomeLabel() }, execution }, ...overrides });
    const events = vi.fn(async () => ({ events: [
      event({ type: 'sandbox.lifecycle.created' }),
      event({ event_data: { sandbox_metadata: { karmaxHome: 'someone-else' }, execution } }),
      event({ sandbox_execution_id: '' }),
      event({ event_data: { sandbox_metadata: { karmaxHome: serviceHomeLabel() }, execution: { ...execution, vcpu_count: 0 } } }),
      event({ sandbox_execution_id: 'kept' }),
    ], resumeAt: 300 }));
    const page = await new E2BWorldProvider(factory(sandbox(), { events })).listUsageEvents('org');
    expect(page.resumeAt).toBe(300);
    expect(page.events).toEqual([expect.objectContaining({ id: 'kept', sandboxId: 's', activeMs: 1000, cpu: 2, memoryMb: 512 })]);
    expect(page.events[0]).not.toHaveProperty('taskId');
  });
});

describe('E2B world transport', () => {
  async function world(box = sandbox(), spec: Record<string, unknown> = {}): Promise<{ world: World; box: typeof box }> {
    const created = await new E2BWorldProvider(factory(box), 90_000).create({ taskId: 'w', base: 'main', ...spec });
    box.commands.run.mockClear();
    box.commands.log.length = 0;
    return { world: created, box };
  }

  it('quotes argv, resolves the working directory inside the world and strips host credentials', async () => {
    const { world: w, box } = await world();
    box.commands.run.mockResolvedValueOnce({ stdout: 'out', stderr: 'err', exitCode: 3 });
    expect(await w.exec('printf', ["it's"], { cwd: 'sub/dir', env: { KEEP: '1', GH_TOKEN: 't', GIT_ASKPASS: 'a',
      GIT_SSH_COMMAND: 's' } })).toEqual({ stdout: 'out', stderr: 'err', code: 3 });
    expect(box.commands.run).toHaveBeenCalledWith(`'printf' 'it'\\''s'`,
      { cwd: '/home/user/karmax/sub/dir', envs: { KEEP: '1' }, timeoutMs: 120_000 });
    await w.exec('true', [], { cwd: '/home/user/karmax/abs' });
    await w.exec('true', [], { cwd: '.' });
    expect(box.commands.run.mock.calls.slice(1).map(([, options]: any[]) => options.cwd))
      .toEqual(['/home/user/karmax/abs', '/home/user/karmax']);
    await expect(w.exec('true', [], { cwd: '../outside' })).rejects.toThrow();
  });

  it('returns a nonzero exit as a result and rethrows a transport failure intact', async () => {
    const { world: w, box } = await world();
    box.commands.run.mockRejectedValueOnce(Object.assign(new Error('exit status 2'), { exitCode: 2, stdout: 'partial' }));
    expect(await w.exec('false', [])).toEqual({ stdout: 'partial', stderr: 'exit status 2', code: 2 });
    const lost = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    box.commands.run.mockRejectedValueOnce(lost);
    await expect(w.exec('true', [])).rejects.toBe(lost);
  });

  it('feeds input on stdin and reports the command\'s own exit when it quit before reading', async () => {
    const { world: w, box } = await world();
    const running = { sendStdin: vi.fn(async () => undefined), closeStdin: vi.fn(async () => undefined),
      kill: vi.fn(async () => true), wait: vi.fn(async () => ({ stdout: 'secret accepted', exitCode: 0 })) };
    box.commands.run.mockResolvedValueOnce(running);
    expect(await w.exec('helper', [], { input: 'hunter2' })).toEqual({ stdout: 'secret accepted', stderr: '', code: 0 });
    expect(box.commands.run).toHaveBeenCalledWith(`'helper'`, expect.objectContaining({ background: true, stdin: true }));
    expect(running.sendStdin).toHaveBeenCalledWith('hunter2');
    expect(JSON.stringify(box.commands.run.mock.calls)).not.toContain('hunter2');

    // The helper is already gone (kill finds nothing): its exit explains the failure.
    const exited = { ...running, sendStdin: vi.fn(async () => { throw new Error('stale pid'); }), kill: vi.fn(async () => false),
      wait: vi.fn(async () => { throw Object.assign(new Error('no such file'), { exitCode: 127, stderr: 'helper: not found' }); }) };
    box.commands.run.mockResolvedValueOnce(exited);
    expect(await w.exec('helper', [], { input: 'x' })).toEqual({ stdout: '', stderr: 'helper: not found', code: 127 });

    // Still running but its stdin failed: that failure is the answer.
    const stuck = { ...running, sendStdin: vi.fn(async () => { throw Object.assign(new Error('stdin closed'), { exitCode: 1 }); }) };
    box.commands.run.mockResolvedValueOnce(stuck);
    expect(await w.exec('helper', [], { input: 'x' })).toMatchObject({ code: 1, stderr: 'stdin closed' });
    expect(stuck.kill).toHaveBeenCalled();
  });

  it('reads and writes files only inside the world', async () => {
    const { world: w, box } = await world();
    box.files.read.mockResolvedValueOnce(new TextEncoder().encode('bytes as text') as any);
    expect(await w.readFile('a.txt')).toBe('bytes as text');
    box.files.read.mockResolvedValueOnce('text as bytes');
    expect(await w.readFileBuffer('b.bin')).toEqual(Buffer.from('text as bytes'));
    box.files.read.mockResolvedValueOnce(new Uint8Array([1, 2]).buffer as any);
    expect(await w.readFileBuffer('c.bin')).toEqual(Buffer.from([1, 2]));
    await w.writeFileBuffer!('d.bin', Buffer.from('payload'));
    expect(box.files.write).toHaveBeenCalledWith('/home/user/karmax/d.bin', Buffer.from('payload'));
    await expect(w.readFile('.')).rejects.toThrow('path is a directory');
    await expect(w.writeFile('../escape', 'x')).rejects.toThrow();
    expect(box.files.read.mock.calls.map(([file]: any[]) => file))
      .toEqual(['/home/user/karmax/a.txt', '/home/user/karmax/b.bin', '/home/user/karmax/c.bin']);
  });

  it('stops a prefix download at the limit instead of draining the file', async () => {
    const { world: w, box } = await world();
    let pulled = 0, cancelled = false;
    let signal: AbortSignal | undefined;
    box.files.read.mockImplementationOnce(async (_file: string, options: any) => {
      signal = options.signal;
      return new ReadableStream<Uint8Array>({
        pull(controller) { pulled++; controller.enqueue(new Uint8Array(4).fill(pulled)); },
        cancel() { cancelled = true; },
      }) as any;
    });
    expect(await w.readFilePrefix!('big.log', 6)).toEqual(Buffer.from([1, 1, 1, 1, 2, 2]));
    expect(cancelled).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(pulled).toBeLessThanOrEqual(3);

    box.files.read.mockImplementationOnce(async () => new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([9])); controller.close(); } }) as any);
    expect(await w.readFilePrefix!('small.log', 100)).toEqual(Buffer.from([9]));
  });

  it('lists files through the sandbox shell and surfaces its failure', async () => {
    const { world: w, box } = await world();
    box.commands.run.mockResolvedValueOnce({ stdout: 'a.txt\n dir/b.txt \n\n', stderr: '', exitCode: 0 });
    expect(await w.listFiles()).toEqual(['a.txt', 'dir/b.txt']);
    box.commands.run.mockResolvedValueOnce({ stdout: '', stderr: 'find: permission denied', exitCode: 1 });
    await expect(w.listFiles()).rejects.toThrow('find: permission denied');
  });

  it('replays output a background process wrote before anyone listened, and renews the sandbox lease', async () => {
    const box = Object.assign(sandbox(), { setTimeout: vi.fn(async () => undefined) });
    const { world: w } = await world(box);
    let finish!: (result: unknown) => void;
    box.commands.run.mockImplementationOnce(async (_command: string, options: any) => {
      options.onStdout(new TextEncoder().encode('ready on 3000\n'));
      options.onStderr({ data: 'warn\n' });
      return { wait: () => new Promise((resolve) => { finish = resolve; }), kill: vi.fn(async () => undefined) };
    });
    const process = await w.startProcess({ command: 'npm run dev', cwd: 'app' });
    expect(box.commands.run).toHaveBeenCalledWith('npm run dev', expect.objectContaining({ background: true, timeoutMs: 0,
      cwd: '/home/user/karmax/app' }));
    expect(box.setTimeout).toHaveBeenCalledWith(90_000);
    const seen: string[] = [];
    process.onOutput((chunk) => seen.push(chunk));
    expect(seen).toEqual(['ready on 3000\n', 'warn\n']);
    const exits: Array<number | null> = [];
    process.onExit((code) => exits.push(code));
    finish({ exitCode: 0 });
    await vi.waitFor(() => expect(exits).toEqual([0]));
    // A listener attached after the exit still hears it.
    const late = await new Promise((resolve) => process.onExit(resolve));
    expect(late).toBe(0);
  });

  it('reports a background process\'s nonzero exit, and a lost stream as -1 with its reason', async () => {
    const { world: w, box } = await world();
    box.commands.run.mockResolvedValueOnce({ wait: async () => { throw Object.assign(new Error('exit status 4'), { exitCode: 4 }); } });
    const failed = await w.startProcess({ command: 'false' });
    expect(await new Promise((resolve) => failed.onExit(resolve))).toBe(4);

    const kill = vi.fn(async () => undefined);
    box.commands.run.mockResolvedValueOnce({ wait: async () => { throw new Error('stream reset by peer'); }, kill });
    const lost = await w.startProcess({ command: 'server' });
    const output: string[] = [];
    lost.onOutput((chunk) => output.push(chunk));
    expect(await new Promise((resolve) => lost.onExit(resolve))).toBe(-1);
    expect(output.join('')).toContain('stream reset by peer');
    await lost.kill();
    expect(kill).toHaveBeenCalled();
  });

  it('drives a PTY and maps how it ended', async () => {
    const { world: w, box } = await world();
    let end!: { resolve: (value: unknown) => void; reject: (error: unknown) => void };
    const terminal = { pid: 42, wait: () => new Promise((resolve, reject) => { end = { resolve, reject }; }) };
    (box.pty.create as any).mockImplementationOnce(async (options: any) => { options.onData('$ '); return terminal; });
    const pty = await w.openPty({ command: 'claude', cols: 100, rows: 30 });
    expect(box.pty.create).toHaveBeenCalledWith(expect.objectContaining({ cols: 100, rows: 30, timeoutMs: 0 }));
    expect(box.pty.sendInput).toHaveBeenCalledWith(42, new TextEncoder().encode('claude\n'));
    const data: string[] = [];
    pty.onData((chunk) => data.push(chunk));
    expect(data).toEqual(['$ ']);
    await pty.write('y');
    await pty.resize(120, 40);
    expect(box.pty.resize).toHaveBeenCalledWith(42, { cols: 120, rows: 40 });
    const exits: unknown[] = [];
    pty.onExit((code, termination) => exits.push([code, termination]));
    end.reject(Object.assign(new Error('signal: killed'), { exitCode: -1, error: 'signal: killed' }));
    await vi.waitFor(() => expect(exits).toEqual([[null, { signal: 'SIGKILL' }]]));
    expect(await new Promise((resolve) => pty.onExit((code, termination) => resolve([code, termination]))))
      .toEqual([null, { signal: 'SIGKILL' }]);
    await pty.close();
    expect(box.pty.kill).toHaveBeenCalledWith(42);
  });

  it('follows the same PTY after E2B pauses the sandbox, and reports a lost stream when it cannot', async () => {
    const box = sandbox();
    const connect = vi.fn(async () => undefined);
    const again = { pid: 42, wait: vi.fn(async () => ({ exitCode: 0 })), kill: vi.fn(async () => undefined) };
    const pty = Object.assign(box.pty, { connect: vi.fn(async () => again) });
    const { world: w } = await world(Object.assign(box, { connect, pty }));
    (box.pty.create as any).mockResolvedValueOnce({ pid: 42, wait: async () => { throw new Error('stream dropped'); } });
    const followed = await w.openPty();
    expect(await new Promise((resolve) => followed.onExit(resolve))).toBe(0);
    expect(connect).toHaveBeenCalledWith({ timeoutMs: 90_000, requestTimeoutMs: 60_000 });
    expect(pty.connect).toHaveBeenCalledWith(42, expect.objectContaining({ timeoutMs: 0 }));
    await followed.close();
    expect(again.kill).toHaveBeenCalled(); // the reattached terminal is the one closed

    const { world: plain, box: noReattach } = await world();
    (noReattach.pty.create as any).mockResolvedValueOnce({ pid: 5, wait: async () => { throw new Error('stream dropped'); } });
    const dropped = await plain.openPty();
    const [code, termination] = await new Promise<any[]>((resolve) => dropped.onExit((...args) => resolve(args)));
    expect(code).toBeNull();
    expect(termination.lost.message).toBe('stream dropped');
  });

  it('checks out another branch in place with git worktree', async () => {
    const { world: w, box } = await world(sandbox('co', { run: async (command) => ({ stdout: command.includes('rev-parse')
      ? 'b'.repeat(40) : '', stderr: '', exitCode: 0 }) }), { repos: ['git@github.com:org/repo.git'], layout: 'nested' });
    const handle = await w.addCheckout!({ name: 'second', branch: 'feature', base: 'main' } as any);
    expect(box.commands.log.join('\n')).toContain('worktree');
    expect(handle.repos?.some((repo) => repo.name === 'second' && repo.branch === 'feature')).toBe(true);
  });

  it('diagnoses from control-plane metrics and never lets a failed diagnosis replace the failure', async () => {
    const { world: plain } = await world();
    expect(await plain.diagnose!({ since: 0 })).toBeUndefined();
    const now = Date.UTC(2026, 8, 28, 12);
    const getMetrics = vi.fn(async () => [
      { timestamp: new Date(now - 60_000), memUsed: 1990, memTotal: 2000 },
      { timestamp: new Date(now - 30_000).toISOString(), memUsed: 1995, memTotal: 2000 },
    ]);
    const { world: w } = await world(Object.assign(sandbox(), { getMetrics }));
    const diagnosis = await w.diagnose!({ since: now - 120_000, now });
    expect(getMetrics).toHaveBeenCalledWith({ start: new Date(now - 30 * 60_000), end: new Date(now) });
    expect(diagnosis).toMatchObject({ memoryExhausted: true });
    getMetrics.mockRejectedValueOnce(new Error('control plane down'));
    expect(await w.diagnose!({ since: 0, now })).toBeUndefined();
  });

  it('proxies preview traffic to the sandbox host with its access token and no redirects followed', async () => {
    const box = Object.assign(sandbox('preview'), { trafficAccessToken: 'traffic' });
    const { world: w } = await world(box);
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('hello', { status: 201,
      headers: { 'x-served': 'yes' } }));
    const response = await w.fetchPort!(3000, 'api', { method: 'post', headers: { accept: 'text/plain' },
      body: Buffer.from('payload') });
    expect(fetcher).toHaveBeenCalledWith('https://3000-preview.e2b.app/api', expect.objectContaining({ method: 'POST',
      headers: { accept: 'text/plain', 'x-access-token': 'traffic' }, body: Buffer.from('payload'), redirect: 'manual' }));
    expect(response).toMatchObject({ status: 201, headers: { 'x-served': 'yes' } });
    expect(Buffer.from(response.body).toString()).toBe('hello');
    await w.fetchPort!(3000, '/head', { method: 'GET', body: Buffer.from('ignored') });
    expect(fetcher.mock.calls[1]![1]).not.toHaveProperty('body');
    await expect(w.fetchPort!(0, '/')).rejects.toThrow('invalid preview port');
    await expect(w.fetchPort!(70_000, '/')).rejects.toThrow('invalid preview port');

    expect(await w.previewSocketTarget!(8080, 'ws')).toEqual({ url: 'wss://8080-preview.e2b.app/ws',
      headers: { 'x-access-token': 'traffic' } });
    const custom = Object.assign(sandbox(), { getHost: (port: number) => `custom-${port}.example` });
    const { world: other } = await world(custom);
    expect(await other.previewSocketTarget!(80, '/')).toEqual({ url: 'wss://custom-80.example/' });
    await expect(other.previewSocketTarget!(1.5, '/')).rejects.toThrow('invalid preview port');
  });

  it('streams a desktop world only, and only from a template that can', async () => {
    const { world: headless } = await world();
    await expect(headless.desktopSession!()).rejects.toThrow('this is a headless world');
    const { world: bare } = await world(sandbox(), { environment: { flavor: 'desktop' } });
    await expect(bare.desktopSession!()).rejects.toThrow('does not expose E2B Desktop streaming');
    const stream = { start: vi.fn(async () => undefined), getAuthKey: () => 'auth',
      getUrl: vi.fn((options: any) => `https://stream.example/?key=${options.authKey}`) };
    const { world: desk } = await world(Object.assign(sandbox(), { stream }), { environment: { flavor: 'desktop' } });
    expect(await desk.desktopSession!()).toEqual({ provider: 'e2b', url: 'https://stream.example/?key=auth' });
    expect(stream.start).toHaveBeenCalledWith({ requireAuth: true });
    expect(stream.getUrl).toHaveBeenCalledWith({ authKey: 'auth', autoConnect: true, resize: 'scale' });
  });

  it('kills the sandbox and forgets it on destroy', async () => {
    const box = sandbox();
    const provider = new E2BWorldProvider(factory(box));
    const created = await provider.create({ taskId: 'bye', base: 'main' });
    await created.destroy();
    expect(box.kill).toHaveBeenCalled();
    expect(await provider.status(created.handle)).toBe('missing');
  });
});

describe('default E2B SDK factory', () => {
  it('reads every page of the sandbox inventory and the flat list of older SDKs', async () => {
    const { Sandbox } = await import('e2b') as any;
    const pages = [[{ sandboxId: 'a' }], [{ sandboxId: 'b' }]];
    const nextItems = vi.fn(async () => pages.shift()!);
    const list = vi.spyOn(Sandbox, 'list').mockImplementation(() => ({ get hasNext() { return pages.length > 0; }, nextItems }));
    const provider = new E2BWorldProvider();
    expect((await provider.listSandboxes()).map((ref) => ref.sandboxId)).toEqual(['a', 'b']);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ query: { metadata: { karmaxHome: expect.any(String) },
      state: ['running', 'paused'] } }));
    list.mockImplementation(() => [{ sandboxId: 'flat' }] as any);
    expect((await provider.listSandboxes()).map((ref) => ref.sandboxId)).toEqual(['flat']);
  });

  it('asks the control plane for state and kills by id without connecting', async () => {
    const { Sandbox } = await import('e2b') as any;
    const connect = vi.spyOn(Sandbox, 'connect').mockRejectedValue(new Error('must not connect'));
    const getInfo = vi.spyOn(Sandbox, 'getInfo').mockResolvedValue({ state: 'paused' });
    const kill = vi.spyOn(Sandbox, 'kill').mockResolvedValue(true);
    const created = { sandboxId: 'live', commands: { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
      files: { write: async () => undefined }, updateNetwork: async () => undefined, kill: async () => undefined };
    const create = vi.spyOn(Sandbox, 'create').mockResolvedValue(created);
    const provider = new E2BWorldProvider(undefined, 1000, 'tmpl');
    vi.spyOn(Sandbox, 'list').mockImplementation(() => [] as any);
    const world = await provider.create({ taskId: 'sdk', base: 'main' });
    expect(create).toHaveBeenCalledWith('tmpl', expect.objectContaining({ timeoutMs: 1000 }));
    expect(await provider.probe(world.handle)).toBe('parked');
    expect(getInfo).toHaveBeenCalledWith('live', {});
    await provider.destroy(world.handle);
    expect(kill).toHaveBeenCalledWith('live', {});
    expect(connect).not.toHaveBeenCalled();
  });

  it('surfaces a failed lifecycle-feed request instead of reporting no usage', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('denied', { status: 401 }));
    await expect(new E2BWorldProvider().listUsageEvents('org')).rejects.toThrow('E2B lifecycle events failed (401)');
  });
});
