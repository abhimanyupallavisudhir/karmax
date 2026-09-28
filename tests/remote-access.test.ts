import { describe, expect, it } from 'vitest';
import { RemoteAccessController } from '../src/remote/access.js';

/**
 * The `tailscale` CLI as state, so each test says what the machine looks like
 * and asserts what Phone Access did to it. tests/autonomy.test.ts keeps the
 * original scripted cases; these cover the rest of the controller (CI-38f).
 */
function tailscale(initial: {
  backend?: string;
  online?: boolean;
  dns?: string;
  serve?: string;
  /** Older clients: `serve status --json` is not a command. */
  noJsonStatus?: boolean;
  /** Commands (joined by spaces) that fail, with the CLI's output. */
  fail?: Record<string, { stdout?: string; stderr?: string }>;
} = {}) {
  const state = { backend: initial.backend ?? 'Running', online: initial.online ?? true, dns: initial.dns ?? 'laptop.example.ts.net.',
    serve: initial.serve ?? 'No serve config', operator: undefined as string | undefined };
  const calls: string[] = [];
  const run = async (args: string[]) => {
    const command = args.join(' ');
    calls.push(command);
    const failure = initial.fail?.[command];
    if (failure) throw Object.assign(new Error('command failed'), failure);
    if (command === 'status --json') return { stdout: JSON.stringify({ BackendState: state.backend, Self: { DNSName: state.dns, Online: state.online } }), stderr: '' };
    if (command === 'serve status --json') {
      if (initial.noJsonStatus) throw Object.assign(new Error('flag provided but not defined: -json'), { stderr: 'flag provided but not defined: -json' });
      return { stdout: state.serve, stderr: '' };
    }
    if (command === 'serve status') return { stdout: state.serve, stderr: '' };
    if (args[0] === 'set' && args[1]?.startsWith('--operator=')) { state.operator = args[1].slice('--operator='.length); return { stdout: '', stderr: '' }; }
    if (args[0] === 'up') { state.backend = 'Running'; state.online = true; return { stdout: '', stderr: '' }; }
    if (args[0] === 'serve' && args[1] === '--bg') {
      state.serve = `https://${state.dns.replace(/\.$/, '')}\n|-- / proxy ${args.at(-1)}`;
      return { stdout: 'Serve started', stderr: '' };
    }
    if (command === 'serve off') { state.serve = 'No serve config'; return { stdout: '', stderr: '' }; }
    throw new Error(`unexpected command: ${command}`);
  };
  return { state, calls, run };
}

const controller = (cli: ReturnType<typeof tailscale>, extra: Partial<ConstructorParameters<typeof RemoteAccessController>[0]> = {}) =>
  new RemoteAccessController({ port: () => 4173, run: cli.run, platform: 'linux', username: 'alice', ...extra });

describe('Phone Access status', () => {
  it.each(['{}', '[]', 'null', '', 'not configured'])('treats serve status %j as nothing served', async (serve) => {
    expect(await controller(tailscale({ serve })).status()).toMatchObject({ state: 'available', setupStage: 'serve', canEnable: true });
  });

  it('reads the older plain-text serve status when --json is not supported', async () => {
    const cli = tailscale({ noJsonStatus: true, serve: 'https://laptop.example.ts.net:8443 (tailnet only)\n|-- / proxy http://localhost:4173' });
    expect(await controller(cli).status()).toMatchObject({ state: 'ready', url: 'https://laptop.example.ts.net:8443', canDisable: true });
    expect(cli.calls).toEqual(['status --json', 'serve status --json', 'serve status']);
  });

  it('falls back to the node name for the address', async () => {
    const cli = tailscale({ serve: JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { 'x:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4173' } } } } }) });
    expect(await controller(cli).status()).toMatchObject({ state: 'ready', url: 'https://laptop.example.ts.net' });
  });

  it('leaves an unrecognized route alone without guessing its port', async () => {
    const status = await controller(tailscale({ serve: JSON.stringify({ TCP: { 22: { TCPForward: '127.0.0.1:22' } } }) })).status();
    expect(status).toMatchObject({ state: 'conflict', canSetup: false, canEnable: false, canDisable: false,
      detail: 'Tailscale already routes this phone address to another local service. Krmax left that configuration untouched.' });
    expect(status.fallbackCommands).toBeUndefined();
  });

  it('reports a logged-out daemon, and unreadable status, as needing login', async () => {
    expect(await controller(tailscale({ backend: 'NeedsLogin' })).status()).toMatchObject({ state: 'needs-login', setupStage: 'login', canSetup: true,
      fallbackCommands: ['sudo tailscale up', 'sudo tailscale serve --bg --yes http://127.0.0.1:4173'] });
    const garbled = tailscale();
    const run = async (args: string[]) => args[0] === 'status' ? { stdout: 'panic: runtime error', stderr: '' } : garbled.run(args);
    expect(await controller(garbled, { run }).status()).toMatchObject({ method: 'tailscale', state: 'needs-login' });
  });

  it('follows the gateway port it is serving on now', async () => {
    let port = 4173;
    const cli = tailscale({ serve: 'https://laptop.example.ts.net\n|-- / proxy http://127.0.0.1:4173' });
    const phone = controller(cli, { port: () => port });
    expect((await phone.status()).state).toBe('ready');
    port = 4174;
    expect(await phone.status()).toMatchObject({ state: 'conflict', detail: expect.stringContaining('port 4173') });
  });
});

describe('Phone Access enable and disable', () => {
  it('does nothing when already on, or when it cannot be turned on', async () => {
    const on = tailscale({ serve: 'https://laptop.example.ts.net\n|-- / proxy http://127.0.0.1:4173' });
    expect((await controller(on).enable()).state).toBe('ready');
    const offline = tailscale({ backend: 'Stopped' });
    expect((await controller(offline).enable()).state).toBe('needs-login');
    for (const cli of [on, offline]) expect(cli.calls.filter((call) => call.startsWith('serve --bg'))).toEqual([]);
  });

  it('turns its own route off, and nothing when it has none', async () => {
    const cli = tailscale({ serve: 'https://laptop.example.ts.net\n|-- / proxy http://127.0.0.1:4173' });
    expect(await controller(cli).disable()).toMatchObject({ state: 'available', canEnable: true });
    expect(cli.calls).toContain('serve off');
    const idle = tailscale();
    expect((await controller(idle).disable()).state).toBe('available');
    expect(idle.calls).not.toContain('serve off');
  });

  it('reports why Tailscale would not turn the route off', async () => {
    const cli = tailscale({ serve: 'https://laptop.example.ts.net\n|-- / proxy http://127.0.0.1:4173',
      fail: { 'serve off': { stderr: '  daemon went away  ' } } });
    expect(await controller(cli).disable()).toEqual({ method: 'tailscale', state: 'error', detail: 'daemon went away',
      canEnable: false, canDisable: true });
    const silent = tailscale({ serve: 'https://laptop.example.ts.net\n|-- / proxy http://127.0.0.1:4173', fail: { 'serve off': {} } });
    expect((await controller(silent).disable()).detail).toBe('command failed');
  });

  it('passes an unexplained Serve failure through verbatim', async () => {
    const cli = tailscale({ fail: { 'serve --bg http://127.0.0.1:4173': { stderr: 'certificate provisioning failed' } } });
    expect(await controller(cli).enable()).toMatchObject({ state: 'error', detail: 'certificate provisioning failed', canEnable: true });
  });
});

describe('Phone Access guided setup', () => {
  it('stops before touching anything when Tailscale is missing or another route owns the address', async () => {
    const missing = tailscale({ fail: { 'status --json': { stderr: 'spawn tailscale ENOENT' } } });
    expect((await controller(missing).setup()).state).toBe('unavailable');
    const taken = tailscale({ serve: 'https://laptop.example.ts.net\n|-- / proxy http://127.0.0.1:9000' });
    expect((await controller(taken).setup()).state).toBe('conflict');
    for (const cli of [missing, taken]) expect(cli.calls.every((call) => call.includes('status'))).toBe(true);
  });

  it('signs in, connects and serves in one pass, granting the operator only on Linux', async () => {
    const linux = tailscale({ backend: 'NeedsLogin' });
    expect(await controller(linux).setup()).toMatchObject({ state: 'ready', url: 'https://laptop.example.ts.net' });
    expect(linux.state.operator).toBe('alice');
    expect(linux.calls).toEqual(expect.arrayContaining(['set --operator=alice', 'up --timeout=4s', 'serve --bg --yes http://127.0.0.1:4173']));

    const mac = tailscale({ backend: 'NeedsLogin' });
    expect((await controller(mac, { platform: 'darwin' }).setup()).state).toBe('ready');
    expect(mac.state.operator).toBeUndefined();
  });

  it('keeps going when `up` times out but the node connected anyway', async () => {
    const cli = tailscale({ backend: 'NeedsLogin' });
    const run = async (args: string[]) => {
      if (args[0] === 'up') { cli.state.backend = 'Running'; throw Object.assign(new Error('timeout'), { stderr: 'timed out waiting for Running state' }); }
      return cli.run(args);
    };
    expect((await controller(cli, { run }).setup()).state).toBe('ready');
  });

  it('shows why `up` failed when there is no sign-in link to offer', async () => {
    const cli = tailscale({ backend: 'NeedsLogin', fail: { 'up --timeout=4s': { stderr: 'backend error: invalid key: API key does not exist' } } });
    expect(await controller(cli).setup()).toMatchObject({ state: 'error', setupStage: 'login',
      detail: 'backend error: invalid key: API key does not exist', canSetup: true });
    expect(cli.calls).not.toContain('serve --bg --yes http://127.0.0.1:4173');
  });

  it('does not ask for elevation for an error that is not a permission problem', async () => {
    let elevated = 0;
    const cli = tailscale({ fail: { 'set --operator=alice': { stderr: 'unknown flag --operator' } } });
    const status = await controller(cli, { elevate: async () => { elevated++; return { stdout: '', stderr: '' }; } }).setup();
    expect(status).toMatchObject({ state: 'error', setupStage: 'authorize', detail: 'unknown flag --operator' });
    expect(elevated).toBe(0);
    expect(cli.calls).not.toContain('serve --bg --yes http://127.0.0.1:4173');
  });

  it('reports a finished setup once, then live status', async () => {
    const cli = tailscale();
    const phone = controller(cli);
    expect(phone.beginSetup()).toMatchObject({ setupInProgress: true });
    await expect.poll(async () => (await phone.setupStatus()).setupInProgress).toBeUndefined();
    cli.state.serve = 'No serve config'; // turned off elsewhere
    expect((await phone.setupStatus()).state).toBe('available');
  });
});
