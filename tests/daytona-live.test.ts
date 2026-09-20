import { describe, expect, it } from 'vitest';
import { DaytonaWorldProvider } from '../src/world/daytona.js';
import { CodexAppServerClient } from '../src/agent/codex-app-server-client.js';
import { ensureRemoteNode, spawnRemoteAgentProcess } from '../src/agent/remote-process.js';
import type { World } from '../src/world/types.js';

// Opt in with DAYTONA_API_KEY. These tests spend provider credit and always
// delete their own sandboxes. They never reap other tasks' sandboxes.
const live = process.env.KARMAX_SKIP_LIVE !== '1' && !!process.env.DAYTONA_API_KEY;
const deadline = <T>(promise: Promise<T>, ms = 30_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Live operation timed out')), ms);
  })]).finally(() => clearTimeout(timer));
};

async function checkCommand(world: World, command: string, args: string[]) {
  const result = await world.exec(command, args);
  expect(result, JSON.stringify(result)).toMatchObject({ code: 0 });
  return result.stdout;
}

describe.skipIf(!live)('Daytona live lifecycle', () => {
  it('runs the API-key-only path through files, stdin, processes, PTY, previews, archive, cold reopen and deletion', async () => {
    const provider = new DaytonaWorldProvider();
    const taskId = `live-daytona-${Date.now()}`;
    const world = await provider.create({ taskId, base: 'main', network: { unrestricted: true }, resources: { cpu: 2, memoryMb: 2048, gpu: 0 } });
    try {
      const runtimeBin = await ensureRemoteNode(world);
      expect(await checkCommand(world, `${runtimeBin}/node`, ['--version'])).toMatch(/^v22\./);
      // Exercise the actual native agent transport and the runtime PATH used by
      // the Codex adapter. The image's interactive shell may select its own Node.
      await world.writeFile('.fixture/codex/.keep', '');
      const agent = spawnRemoteAgentProcess({ world, provider: 'codex', command: 'codex', args: ['app-server'],
        cwd: world.handle.root, env: { CODEX_HOME: `${world.handle.root}/.fixture/codex`,
          PATH: `${runtimeBin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` } });
      agent.on('error', () => {});
      try {
        const rpc = new CodexAppServerClient(agent.stdin, agent.stdout);
        await deadline(rpc.request('initialize', { clientInfo: { name: 'daytona-test', version: '1' },
          capabilities: { experimentalApi: true } }), 120_000);
        rpc.notify('initialized');
        expect(await deadline(rpc.request('thread/list', { limit: 10 }))).toHaveProperty('data');
      } finally { await agent.stop(); }
      expect(await checkCommand(world, 'echo', ['karmax-live-check'])).toContain('karmax-live-check');
      await world.writeFile('nested/live.txt', 'round-trip');
      expect(await world.readFile('nested/live.txt')).toBe('round-trip');
      expect(await world.listFiles()).toContain('nested/live.txt');
      expect(await world.exec('cat', [], { input: 'test-stdin\n' })).toMatchObject({ code: 0, stdout: 'test-stdin\n' });
      expect(await world.exec('bash', ['-c', 'exit 23'])).toMatchObject({ code: 23 });
      expect(await provider.probe(world.handle)).toBe('ready');
      expect((await provider.listSandboxes()).some((entry) => entry.taskId === taskId && entry.matches!(world.handle))).toBe(true);

      const process = await world.startProcess({ command: "printf 'process-output'; exit 7" });
      let output = '';
      process.onOutput((chunk) => { output += chunk; });
      expect(await deadline(new Promise((resolve) => process.onExit(resolve)))).toBe(7);
      expect(output).toContain('process-output');

      const terminal = await world.openPty();
      try {
        await terminal.resize(100, 30);
        let terminalOutput = '';
        terminal.onData((chunk) => { terminalOutput += chunk; });
        const exited = new Promise((resolve) => terminal.onExit(resolve));
        await terminal.write("printf 'pty-%s\\n' success; exit 0\n");
        expect(await deadline(exited)).toBe(0);
        expect(terminalOutput).toContain('pty-success');
      } finally { await terminal.close(); }

      await world.writeFile('preview.cjs', `require('http').createServer((req,res)=>{res.end('preview:'+req.url)}).listen(3000,'0.0.0.0')`);
      const server = await world.startProcess({ command: 'node preview.cjs' });
      try {
        await checkCommand(world, 'bash', ['-c', 'for i in $(seq 1 30); do curl -fsS http://localhost:3000/ && exit 0; sleep 1; done; exit 1']);
        const response = await deadline(world.fetchPort!(3000, '/check?value=1'));
        expect(response.status).toBe(200);
        expect(response.body.toString()).toContain('preview:/check?');
        expect(response.body.toString()).toContain('value=1');
        expect((await world.previewSocketTarget!(3000, '/socket')).url).toMatch(/^wss?:/);
      } finally { await server.kill(); }

      await checkCommand(world, 'curl', ['-fsS', '--max-time', '20', 'https://registry.npmjs.org/typescript/latest']);

      await provider.park(world.handle);
      expect(await provider.probe(world.handle)).toBe('parked');
      // A fresh adapter has no cached Sandbox or lifecycle state.
      const reopened = await new DaytonaWorldProvider().open(world.handle);
      expect(await reopened.readFile('nested/live.txt')).toBe('round-trip');
      expect(await checkCommand(reopened, 'echo', ['resumed'])).toContain('resumed');
    } finally { await world.destroy(); }
    expect(await provider.probe(world.handle)).toBe('missing');
  }, 600_000);

  it('provisions a real Git checkout, removes clone credentials and adds a sibling branch', async () => {
    const repo = 'git@github.com:octocat/Hello-World.git';
    const provider = new DaytonaWorldProvider();
    const world = await provider.create({ taskId: `live-daytona-git-${Date.now()}`, base: 'master', network: { unrestricted: true },
      repo, layout: 'nested', gitIdentity: { name: 'Karmax Test', email: 'test@example.invalid' },
      // This public fixture needs no authentication. Supplying a harmless
      // placeholder exercises the same HTTPS rewrite and cleanup as App auth.
      gitCredentials: { httpsTokens: { [repo]: 'public-fixture-unused' } } });
    try {
      expect(await world.readFile('Hello-World/README')).toContain('Hello World');
      expect(await checkCommand(world, 'bash', ['-c', 'find "$HOME/.ssh" -name "karmax-auth-*"'])).toBe('');
      const added = await world.addCheckout!({ name: 'second' });
      expect(added.repos?.map((repo) => repo.name)).toContain('second');
      await world.writeFile('second/live.txt', 'branch works');
      await checkCommand(world, 'git', ['-C', added.repos!.find((repo) => repo.name === 'second')!.root, 'add', 'live.txt']);
      await checkCommand(world, 'git', ['-C', added.repos!.find((repo) => repo.name === 'second')!.root, 'commit', '-m', 'Live verification']);
      expect(await world.readFile('second/live.txt')).toBe('branch works');
    } finally { await world.destroy(); }
  }, 600_000);

  it('enforces a restricted policy or explicitly reports an unsupported account tier', async () => {
    const provider = new DaytonaWorldProvider();
    const taskId = `live-daytona-network-${Date.now()}`;
    let world: World;
    try { world = await provider.create({ taskId, base: 'main', network: { unrestricted: false } }); }
    catch (error) {
      expect(String(error)).toContain('Daytona Tier 3');
      expect((await provider.listSandboxes()).filter((entry) => entry.taskId === taskId)).toEqual([]);
      return;
    }
    try {
      await checkCommand(world, 'curl', ['-fsS', '--max-time', '20', 'https://registry.npmjs.org/typescript/latest']);
      const denied = await world.exec('curl', ['-fsS', '--max-time', '5', 'https://example.com']);
      expect(denied.code).not.toBe(0);
    } finally { await world.destroy(); }
  }, 180_000);

  it('starts the default desktop and exposes a working signed viewer', async () => {
    const provider = new DaytonaWorldProvider();
    const world = await provider.create({ taskId: `live-daytona-desktop-${Date.now()}`, base: 'main', network: { unrestricted: true },
      resources: { cpu: 2, memoryMb: 2048, gpu: 0 }, environment: { flavor: 'desktop' } });
    try {
      const desktop = await world.desktopSession!();
      expect(desktop.provider).toBe('daytona');
      const response = await fetch(desktop.url, { signal: AbortSignal.timeout(30_000) });
      expect(response.ok).toBe(true);
      await provider.park(world.handle);
      const reopened = await new DaytonaWorldProvider().open(world.handle);
      expect((await reopened.desktopSession!()).url).toMatch(/^https:/);
    } finally { await world.destroy(); }
  }, 600_000);
});
