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
   * owns its --remote-debugging-port, and it says so on stdout once it does. */
  const run = (args: string[], custody?: string, listen?: number) => {
    const child = spawn(process.execPath, ['-e', listen
      ? `require('node:net').createServer().listen(${listen}, '127.0.0.1', () => console.log('listening')); ${idle}` : idle,
    '--', ...args], { stdio: ['ignore', listen ? 'pipe' : 'ignore', 'ignore'],
      env: { PATH: process.env.PATH ?? '', ...(custody ? { [CUSTODY_ENV]: custody } : {}) } });
    children.push(child);
    return child;
  };
  /** A loopback port nobody listens on (fixed ports collide with whatever else the runner has open). */
  const freePort = () => new Promise<number>((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
  /** A browser stand-in on a free port, resolved once it owns that port itself:
   * a busy runner can take longer than any fixed pause to start a process, and
   * a port merely being open may be someone else's. */
  const browser = async (custody?: string): Promise<number> => {
    for (let attempt = 1; ; attempt++) {
      const port = await freePort();
      const child = run([`--remote-debugging-port=${port}`], custody, port);
      const owned = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 10_000);
        child.stdout!.once('data', () => { clearTimeout(timer); resolve(true); });
        child.once('exit', () => { clearTimeout(timer); resolve(false); }); // taken in between: try another
      });
      if (owned) return port;
      child.kill('SIGKILL');
      if (attempt === 3) throw new Error('stand-in browser never listened');
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
      const other = await browser('outer,custody-b');
      await browser();
      await settle();
      expect(() => localTaskBrowserUrl('task_a')).toThrow(/no browser of its own/);
      const own = await browser('outer,custody-a');
      await settle();
      expect(localTaskBrowserUrl('task_a')).toBe(`http://127.0.0.1:${own}`);
      expect(localTaskBrowserUrl('task_b')).toBe(`http://127.0.0.1:${other}`);
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
      const theirs = await browser(); // someone else's debug-enabled browser (or a fake CDP server)
      run([`--remote-debugging-port=${theirs}`], 'custody-a'); // names that port, owns nothing
      await settle();
      expect(() => localTaskBrowserUrl('task_a')).toThrow(/no browser of its own/);
      const own = await browser('custody-a');
      await settle();
      expect(localTaskBrowserUrl('task_a')).toBe(`http://127.0.0.1:${own}`);
    } finally { Object.defineProperty(process, 'platform', { value: real }); }
  });

  // #367 review item 13: a marked process holding only an IPv6 wildcard
  // socket on the port does not own what 127.0.0.1:N reaches.
  it('does not count an IPv6 listener when another process owns the IPv4 one', async () => {
    if (process.platform !== 'linux') return;
    agent('task_a', 'custody-a');
    const port = await browser(); // someone else's, on 127.0.0.1
    const v6 = spawn(process.execPath, ['-e', `require('node:net').createServer().listen({ port: ${port}, host: '::', ipv6Only: true }); ${idle}`,
      '--', `--remote-debugging-port=${port}`], { stdio: 'ignore', env: { PATH: process.env.PATH ?? '', [CUSTODY_ENV]: 'custody-a' } });
    children.push(v6);
    await settle();
    expect(() => localTaskBrowserUrl('task_a')).toThrow(/no browser of its own/);
  });

  // #367 review item 11: the Messages and Responses rails start the browser MCP
  // server themselves, with no agent process whose marker Chrome could inherit.
  it('finds the browser an API-key turn\'s own MCP server launched', async () => {
    if (process.platform !== 'linux') return;
    const port = await freePort();
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
