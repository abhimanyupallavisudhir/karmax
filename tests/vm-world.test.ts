import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import ssh2 from 'ssh2';
import { generateSshKeyPair, SshTransport } from '../src/world/vm/ssh.js';
import { VmWorld } from '../src/world/vm/world.js';
import type { WorldHandle, WorldPtyTermination } from '../src/world/types.js';
import { sshdAvailable, startLocalSshd, type LocalSshd } from './helpers/local-sshd.js';

describe('VM world keys', () => {
  // ssh2's own generator writes about one ed25519 key in 400 that ssh2 then
  // rejects as malformed; a world holding one could never be reached.
  it('generates OpenSSH ed25519 keys that ssh2 and OpenSSH both read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-keys-'));
    for (let i = 0; i < 1500; i++) {
      const pair = generateSshKeyPair(`karmax-task_${i}`);
      const parsed = ssh2.utils.parseKey(pair.privateKey) as any;
      expect(parsed).not.toBeInstanceOf(Error);
      expect(`${parsed.type} ${parsed.getPublicSSH().toString('base64')} karmax-task_${i}`).toBe(pair.publicKey);
      if (i < 5 && sshdAvailable) {
        fs.writeFileSync(path.join(dir, 'key'), pair.privateKey, { mode: 0o600 });
        expect(execFileSync('ssh-keygen', ['-y', '-f', path.join(dir, 'key')]).toString().trim().split(' ').slice(0, 2)).toEqual(pair.publicKey.split(' ').slice(0, 2));
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * The VM world core against a real sshd (tests/helpers/local-sshd.ts): every
 * behaviour karmax relies on from E2B's envd — separate stdout/stderr and exit
 * codes, stdin for secrets, files, a PTY that carries a protocol line of any
 * size, reattach without losing or repeating a byte, previews — over SSH.
 */
describe.skipIf(!sshdAvailable)('VM world over SSH', () => {
  let sshd: LocalSshd;
  let transport: SshTransport;
  let world: VmWorld;
  let destroyed = 0;

  beforeAll(async () => {
    sshd = await startLocalSshd();
    const root = path.join(sshd.home, 'karmax');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    transport = new SshTransport(async () => sshd.endpoint);
    const handle: WorldHandle = { version: 2, kind: 'vmtest', provider: 'vmtest', id: 'task_vm', root, workspaceRoot: root,
      branch: 'karmax/task_vm', base: 'main', sealedProviderRef: 'test' };
    world = new VmWorld(handle, transport, sshd.home, { destroy: async () => { destroyed++; } });
  });
  afterAll(async () => { transport?.close(); await sshd?.stop(); });

  it('runs commands with separate stdout/stderr, exit status, directory, environment and stdin', async () => {
    const result = await world.exec('sh', ['-c', 'echo out; echo err >&2; pwd; echo "$GREETING"; exit 3'],
      { cwd: 'sub', env: { GREETING: "it's here" } });
    expect(result).toEqual({ stdout: `out\n${path.join(sshd.home, 'karmax', 'sub')}\nit's here\n`, stderr: 'err\n', code: 3 });
    // A secret reaches a helper on stdin, never on its command line.
    expect((await world.exec('cat', [], { input: 'secret\n' })).stdout).toBe('secret\n');
  });

  it('times a command out instead of returning its status', async () => {
    const started = Date.now();
    await expect(world.exec('sleep', ['30'], { timeoutMs: 1_000 })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('reads and writes files, creating directories, and streams large ones', async () => {
    await world.writeFile('a/b/c.txt', 'hello');
    expect(await world.readFile('a/b/c.txt')).toBe('hello');
    const big = Buffer.alloc(3 * 1024 * 1024 + 7, 'x');
    await world.writeFileBuffer!('big.bin', big);
    expect((await world.readFileBuffer('big.bin')).equals(big)).toBe(true);
    expect((await world.readFilePrefix!('big.bin', 10)).toString()).toBe('xxxxxxxxxx');
    let streamed = 0;
    for await (const chunk of world.readFileStream!('big.bin')) streamed += chunk.length;
    expect(streamed).toBe(big.length);
    expect(await world.listFiles()).toEqual(expect.arrayContaining(['a/b/c.txt', 'big.bin']));
    // A missing file is a file error, never a missing VM (isMissingSandbox).
    const missing = await world.readFile('nope.txt').catch((error) => error);
    expect(missing).toMatchObject({ name: 'FileNotFoundError', code: 'ENOENT' });
    expect(missing.status).toBeUndefined();
    await expect(world.readFile('../escape')).rejects.toThrow(/escapes world/);
  });

  it('carries a protocol line far over 64 KiB through a raw PTY, both ways', async () => {
    // Like a real agent launch, write only once the terminal is raw: before
    // `stty` runs, a canonical line holds ~4 KiB and input is echoed.
    const pty = await world.openPty({ command: "stty raw -echo; printf 'R\\n'; head -n 1" });
    let output = '';
    pty.onData((chunk) => { output += chunk; });
    const exit = new Promise<number | null>((resolve) => pty.onExit((code) => resolve(code)));
    await waitFor(() => output.includes('R\n'));
    const line = 'y'.repeat(300 * 1024);
    await pty.write(`${line}\n`);
    expect(await exit).toBe(0);
    expect(output).toBe(`R\n${line}\n`);
  });

  it('reattaches a dropped connection to the same process without losing or repeating output', async () => {
    const pty = await world.openPty({ command: 'stty raw -echo; for i in $(seq 1 40); do echo "n$i"; sleep 0.05; done; read reply; echo "got $reply"; exit 5' });
    let output = '';
    pty.onData((chunk) => { output += chunk; });
    const exit = new Promise<[number | null, WorldPtyTermination | undefined]>((resolve) => pty.onExit((code, t) => resolve([code, t])));
    await waitFor(() => output.includes('n10'));
    transport.reset(); // the connection drops mid-stream
    await waitFor(() => output.includes('n40'));
    await pty.write('still-there\n');
    expect(await exit).toEqual([5, undefined]);
    const expected = Array.from({ length: 40 }, (_, i) => `n${i + 1}\n`).join('') + 'got still-there\n';
    expect(output).toBe(expected);
  });

  it('kills the whole process on close and reports the signal', async () => {
    const seconds = `300.${Date.now() % 100_000}`;
    const pty = await world.openPty({ command: `sleep ${seconds}; echo done` });
    const exit = new Promise<WorldPtyTermination | undefined>((resolve) => pty.onExit((_code, t) => resolve(t)));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await pty.close();
    expect(await exit).toEqual({ signal: 'SIGKILL' });
    expect((await world.exec('sh', ['-c', `pgrep -f "slee[p] ${seconds}" | wc -l`])).stdout.trim()).toBe('0');
  });

  it('runs background processes with output, exit status and kill', async () => {
    const done = await world.startProcess({ command: 'echo started; echo oops >&2; exit 4' });
    let output = '';
    done.onOutput((chunk) => { output += chunk; });
    expect(await new Promise((resolve) => done.onExit(resolve))).toBe(4);
    expect(output).toBe('started\noops\n');
    const long = await world.startProcess({ command: 'sleep 300' });
    const killed = new Promise((resolve) => long.onExit(resolve));
    await long.kill();
    expect(await killed).toBeNull();
  });

  it('previews a port bound to the VM loopback, over HTTP and as a socket upstream', async () => {
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const server = await world.startProcess({ command: `exec node -e "require('http').createServer((q,s)=>s.end('hi '+q.url)).listen(${port},'127.0.0.1'); require('net').createServer(c=>c.pipe(c)).listen(${port + 1},'127.0.0.1')"` });
    try {
      let response;
      for (let attempt = 0; attempt < 50; attempt++) {
        response = await world.fetchPort!(port, '/path?q=1').catch(() => undefined);
        if (response) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(response?.status).toBe(200);
      expect(response?.body.toString()).toBe('hi /path?q=1');
      const target = await world.previewSocketTarget!(port + 1, '/ws');
      const url = new URL(target.url);
      expect(url.hostname).toBe('127.0.0.1');
      const echoed = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(Number(url.port), url.hostname, () => socket.write('ping'));
        socket.on('data', (data) => { resolve(String(data)); socket.destroy(); });
        socket.on('error', reject);
      });
      expect(echoed).toBe('ping');
    } finally {
      await server.kill('SIGKILL');
    }
  });

  it('finds nothing to blame on a healthy VM, and destroys through its driver', async () => {
    expect(await world.diagnose!({ since: Date.now() - 60_000 })).toBeUndefined();
    await world.destroy();
    expect(destroyed).toBe(1);
  });
});

async function waitFor(check: () => boolean, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
