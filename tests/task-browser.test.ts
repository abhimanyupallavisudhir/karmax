import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CUSTODY_ENV, registerAgent } from '../src/agent/custody.js';
import { localTaskBrowserUrl } from '../src/autonomy/task-browser.js';
import { apiMcpTools } from '../src/mcp/connections/client.js';
import net from 'node:net';

// AU-14/AU-32: a local fill types into the browser that this task's own agent
// launched, found by the custody marker its descendants inherit, never into a
// DevTools endpoint the agent names.
describe('a local task’s own browser', () => {
  let home: string;
  const children: ChildProcess[] = [];
  const idle = 'setInterval(() => {}, 1000)';
  /** A process with `args`; `listen` makes it own that loopback port, as Chrome
   * owns its --remote-debugging-port. */
  const run = (args: string[], custody?: string, listen?: number) => {
    const child = spawn(process.execPath, ['-e', listen ? `require('node:net').createServer().listen(${listen}, '127.0.0.1'); ${idle}` : idle,
      '--', ...args], { stdio: 'ignore', env: { PATH: process.env.PATH ?? '', ...(custody ? { [CUSTODY_ENV]: custody } : {}) } });
    children.push(child);
    return child;
  };
  /** A browser stand-in, resolved once it owns its port: a busy runner can take
   * longer than any fixed pause to start a process. */
  const browser = async (port: number, custody?: string) => {
    run([`--remote-debugging-port=${port}`], custody, port);
    for (const deadline = Date.now() + 10_000; ;) {
      const listening = await new Promise<boolean>((resolve) => {
        const socket = net.connect(port, '127.0.0.1');
        socket.once('connect', () => { socket.destroy(); resolve(true); }).once('error', () => resolve(false));
      });
      if (listening) return;
      if (Date.now() > deadline) throw new Error(`stand-in browser never listened on ${port}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const agent = (taskId: string, custodyId: string) => {
    const child = run([], custodyId);
    registerAgent({ pid: child.pid!, cmd: 'node', taskId, owner: process.pid, custodyId, startedAt: Date.now() });
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-task-browser-'));
    vi.stubEnv('KARMAX_HOME', home);
    // macOS asks lsof which process listens on the port; emulate it with ss.
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'lsof'), `#!/bin/sh
pid=''; port=''
for arg in "$@"; do case "$arg" in -iTCP@127.0.0.1:*) port=\${arg#-iTCP@127.0.0.1:} ;; [0-9]*) pid=$arg ;; esac; done
[ -n "$port" ] && ss -ltnpH "src 127.0.0.1:$port" | grep -q "pid=$pid," && echo "$pid"
`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  });
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it.each(['linux', 'darwin'])('finds it by its agent’s custody marker (%s)', async (platform) => {
    if (process.platform !== 'linux') return;
    const real = process.platform;
    Object.defineProperty(process, 'platform', { value: platform });
    try {
      agent('task_a', 'custody-a');
      agent('task_b', 'custody-b');
      // Another task's browser, and one nobody's agent started.
      await browser(45101, 'outer,custody-b');
      await browser(45102);
      await settle();
      expect(() => localTaskBrowserUrl('task_a')).toThrow(/no browser of its own/);
      await browser(45103, 'outer,custody-a');
      await settle();
      expect(localTaskBrowserUrl('task_a')).toBe('http://127.0.0.1:45103');
      expect(localTaskBrowserUrl('task_b')).toBe('http://127.0.0.1:45101');
      expect(() => localTaskBrowserUrl('task_c')).toThrow(/no agent of this task is running/);
      expect(() => localTaskBrowserUrl(undefined)).toThrow(/call this from a task/);
    } finally { Object.defineProperty(process, 'platform', { value: real }); }
  });

  // #367 review item 15: a marked process naming a port is not enough; it has
  // to own the listening socket, or an agent could aim fills at any
  // debug-enabled Chrome or fake CDP server by starting a process that names it.
  it.each(['linux', 'darwin'])('requires the marked browser to own its DevTools port (%s)', async (platform) => {
    if (process.platform !== 'linux') return;
    const real = process.platform;
    Object.defineProperty(process, 'platform', { value: platform });
    try {
      agent('task_a', 'custody-a');
      await browser(45111); // someone else's debug-enabled browser (or a fake CDP server)
      run(['--remote-debugging-port=45111'], 'custody-a'); // names that port, owns nothing
      await settle();
      expect(() => localTaskBrowserUrl('task_a')).toThrow(/no browser of its own/);
      await browser(45112, 'custody-a');
      await settle();
      expect(localTaskBrowserUrl('task_a')).toBe('http://127.0.0.1:45112');
    } finally { Object.defineProperty(process, 'platform', { value: real }); }
  });

  // #367 review item 13: a marked process holding only an IPv6 wildcard
  // socket on the port does not own what 127.0.0.1:N reaches.
  it('does not count an IPv6 listener when another process owns the IPv4 one', async () => {
    if (process.platform !== 'linux') return;
    agent('task_a', 'custody-a');
    await browser(45121); // someone else's, on 127.0.0.1
    const v6 = spawn(process.execPath, ['-e', `require('node:net').createServer().listen({ port: 45121, host: '::', ipv6Only: true }); ${idle}`,
      '--', '--remote-debugging-port=45121'], { stdio: 'ignore', env: { PATH: process.env.PATH ?? '', [CUSTODY_ENV]: 'custody-a' } });
    children.push(v6);
    await settle();
    expect(() => localTaskBrowserUrl('task_a')).toThrow(/no browser of its own/);
  });

  // #367 review item 11: the Messages and Responses rails start the browser MCP
  // server themselves, with no agent process whose marker Chrome could inherit.
  it('finds the browser an API-key turn\'s own MCP server launched', async () => {
    if (process.platform !== 'linux') return;
    const port = await new Promise<number>((resolve) => {
      const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as net.AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    const world: any = { handle: { id: 'task_api', kind: 'worktree', root: home } };
    const mcp = await apiMcpTools(world, [{ name: 'chrome-devtools', command: process.execPath,
      args: [path.resolve('tests/fixtures/fake-browser-mcp.mjs'), String(port)] } as any]);
    try {
      let url: string | undefined;
      for (let attempt = 0; attempt < 50 && !url; attempt++) {
        try { url = localTaskBrowserUrl('task_api'); } catch { await settle(); }
      }
      expect(url).toBe(`http://127.0.0.1:${port}`);
      expect(() => localTaskBrowserUrl('task_other')).toThrow(/no agent of this task is running/);
    } finally { await mcp.close(); }
    // The turn's end releases the custody record and the browser with it.
    for (let attempt = 0; attempt < 50; attempt++) {
      try { localTaskBrowserUrl('task_api'); } catch (error) { if (/no agent of this task/.test(String(error))) break; }
      await settle();
    }
    expect(() => localTaskBrowserUrl('task_api')).toThrow(/no agent of this task is running/);
  });
});
