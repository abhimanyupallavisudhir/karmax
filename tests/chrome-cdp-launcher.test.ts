import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { CHROME_DEVTOOLS_MCP_VERSION } from '../src/autonomy/config-homes.js';

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('../src/autonomy/chrome-cdp-launcher.mjs', import.meta.url));

it.each([false, true])('keeps browser state across MCP exits only when opted in (%s)', async (keepAlive) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-browser-lifetime-'));
  const reservation = http.createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const chrome = path.join(dir, 'chrome');
  const mcp = path.join(dir, 'mcp');
  const pidFile = path.join(dir, 'pid');
  fs.writeFileSync(chrome, `#!${process.execPath}
const fs = require('node:fs');
const http = require('node:http');
fs.writeFileSync(process.env.TEST_BROWSER_PID, String(process.pid));
fs.writeFileSync(process.env.TEST_BROWSER_PID + '.args', JSON.stringify(process.argv));
let visits = 0;
http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ pid: process.pid, visits: req.url === '/visit' ? ++visits : visits }));
}).listen(Number(process.env.KARMAX_CDP_PORT), '127.0.0.1');
`, { mode: 0o700 });
  fs.writeFileSync(mcp, `#!${process.execPath}
fetch('http://127.0.0.1:' + process.env.KARMAX_CDP_PORT + '/visit')
  .then(r => r.json()).then(s => console.log(JSON.stringify({ ...s, telemetry: process.env.CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS ? 'off' : 'on' })));
`, { mode: 0o700 });
  const env = { ...process.env, KARMAX_CDP_PORT: String(port), KARMAX_CDP_CHROME: chrome,
    KARMAX_CDP_MCP_BIN: mcp, KARMAX_CDP_KEEP_ALIVE: keepAlive ? '1' : '0',
    KARMAX_CDP_USER_DATA_DIR: path.join(dir, 'profile'), TEST_BROWSER_PID: pidFile };
  let pid: number | undefined;
  try {
    const first = JSON.parse((await exec(process.execPath, [launcher], { env })).stdout);
    pid = first.pid;
    expect(first.visits).toBe(1);
    expect(fs.readFileSync(pidFile + '.args', 'utf8')).not.toContain('--remote-allow-origins=*');
    // Its telemetry watchdog costs ~80 MB of a 2 GB sandbox and reports tenants' tool use.
    expect(first.telemetry).toBe('off');
    if (keepAlive) {
      const second = JSON.parse((await exec(process.execPath, [launcher], { env })).stdout);
      expect(second).toEqual({ pid, visits: 2, telemetry: 'off' });
    } else {
      await expect.poll(async () => {
        try { await fetch(`http://127.0.0.1:${port}/json/version`); return true; }
        catch { return false; }
      }).toBe(false);
      expect(fs.existsSync(path.join(dir, 'profile'))).toBe(false);
    }
  } finally {
    if (!pid && fs.existsSync(pidFile)) pid = Number(fs.readFileSync(pidFile, 'utf8'));
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


it('refuses to attach to an unowned CDP endpoint (AU-20)', async () => {
  const server = http.createServer((_req, res) => res.end('{}'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await expect(exec(process.execPath, [launcher], { timeout: 3000, env: { ...process.env,
      KARMAX_CDP_PORT: String(port), KARMAX_CDP_KEEP_ALIVE: '0', KARMAX_CDP_MCP_BIN: process.execPath,
    } })).rejects.toThrow(/already in use/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('runs the pinned chrome-devtools-mcp release when no version is configured (CI-33)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-browser-pin-'));
  try {
    // A PATH with no browser and a recording npx: the launcher falls back to
    // pipe mode and shows exactly which package it would install.
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.symlinkSync(execFileSync('sh', ['-c', 'command -v flock'], { encoding: 'utf8' }).trim(), path.join(bin, 'flock'));
    fs.writeFileSync(path.join(bin, 'npx'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${path.join(dir, 'args')}"\n`, { mode: 0o755 });
    const reservation = http.createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    await exec(process.execPath, [launcher], { env: { PATH: bin, HOME: dir, KARMAX_CDP_PORT: String(port) }, timeout: 20_000 });
    const args = fs.readFileSync(path.join(dir, 'args'), 'utf8').trim().split('\n');
    expect(args).toContain(`chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}`);
    // The browser image bakes the same release for remote worlds.
    expect(fs.readFileSync(new URL('../environments/browser/Dockerfile', import.meta.url), 'utf8'))
      .toContain(`ARG CHROME_DEVTOOLS_MCP_VERSION=${CHROME_DEVTOOLS_MCP_VERSION}\n`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A browser left running by a launcher that predates the owner record (or one
// whose record was lost) must not wedge every later turn of its world: the
// deploy of AU-20 made each resumed remote task fail with "MCP connections
// could not start: chrome-devtools" (task #438). The world's own profile proves
// the browser is its own; a browser on any other profile is still refused.
it.each([
  ['an earlier launcher left no owner record', undefined],
  ['its owner record names a process that is gone', { pid: 2 ** 22 + 7 }],
])('replaces a retained browser on the world profile when %s', async (_case, record) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-browser-legacy-'));
  const reservation = http.createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const chrome = path.join(dir, 'chrome');
  const mcp = path.join(dir, 'mcp');
  const profile = path.join(dir, 'profile');
  fs.writeFileSync(chrome, `#!${process.execPath}
const http = require('node:http');
const port = Number(/--remote-debugging-port=(\\d+)/.exec(process.argv.join(' '))[1]);
http.createServer((req, res) => res.end(JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }))).listen(port, '127.0.0.1');
`, { mode: 0o700 });
  fs.writeFileSync(mcp, `#!${process.execPath}
fetch('http://127.0.0.1:' + process.env.KARMAX_CDP_PORT + '/json/version').then(r => r.json()).then(s => console.log(JSON.stringify(s)));
`, { mode: 0o700 });
  fs.mkdirSync(profile, { mode: 0o700 });
  if (record) fs.writeFileSync(path.join(profile, '.karmax-browser-owner.json'), JSON.stringify({ port, ...record }));
  // What the pre-AU-20 launcher ran: detached, wildcard origins, no record.
  const legacy = execFile(chrome, ['--headless=new', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
    '--remote-allow-origins=*', `--user-data-dir=${profile}`, 'about:blank']);
  const pids: number[] = [legacy.pid!];
  try {
    await expect.poll(async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; } }).toBe(true);
    const env = { ...process.env, KARMAX_CDP_PORT: String(port), KARMAX_CDP_CHROME: chrome, KARMAX_CDP_MCP_BIN: mcp,
      KARMAX_CDP_KEEP_ALIVE: '1', KARMAX_CDP_USER_DATA_DIR: profile };
    const attached = JSON.parse((await exec(process.execPath, [launcher], { env, timeout: 20_000 })).stdout);
    pids.push(attached.pid);
    // A fresh, hardened browser on the same (persistent) profile, now recorded.
    expect(attached.pid).not.toBe(legacy.pid);
    expect(attached.args).toContain(`--user-data-dir=${profile}`);
    expect(attached.args).not.toContain('--remote-allow-origins=*');
    expect(legacy.exitCode ?? legacy.signalCode).not.toBeNull();
    expect(JSON.parse(fs.readFileSync(path.join(profile, '.karmax-browser-owner.json'), 'utf8'))).toEqual({ port, pid: attached.pid });
    // …and the next turn reuses it instead of replacing it again.
    expect(JSON.parse((await exec(process.execPath, [launcher], { env, timeout: 20_000 })).stdout).pid).toBe(attached.pid);
  } finally {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('still refuses a retained-world endpoint served from another profile (AU-20)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-browser-foreign-'));
  const server = http.createServer((_req, res) => res.end('{}'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await expect(exec(process.execPath, [launcher], { timeout: 5000, env: { ...process.env,
      KARMAX_CDP_PORT: String(port), KARMAX_CDP_KEEP_ALIVE: '1', KARMAX_CDP_MCP_BIN: process.execPath,
      KARMAX_CDP_USER_DATA_DIR: path.join(dir, 'profile'),
    } })).rejects.toThrow(/already in use by an unowned browser/);
    // The foreign server keeps running.
    expect((await fetch(`http://127.0.0.1:${port}/`)).ok).toBe(true);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A desktop world asks for a visible browser (KARMAX_CDP_HEADFUL). If it
// cannot open its display, a headless browser on the same port must take its
// place: the pipe fallback has no port, so no fill or saved session could
// reach the agent's browser.
it('falls back to a headless browser on the port when the visible one cannot open', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-browser-headful-'));
  const reservation = http.createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const chrome = path.join(dir, 'chrome');
  const mcp = path.join(dir, 'mcp');
  // Like Chrome without an X server: a headful launch exits at once.
  fs.writeFileSync(chrome, `#!${process.execPath}
const http = require('node:http');
if (!process.argv.includes('--headless=new')) process.exit(1);
const port = Number(/--remote-debugging-port=(\\d+)/.exec(process.argv.join(' '))[1]);
http.createServer((req, res) => res.end(JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }))).listen(port, '127.0.0.1');
`, { mode: 0o700 });
  fs.writeFileSync(mcp, `#!${process.execPath}
fetch('http://127.0.0.1:' + process.env.KARMAX_CDP_PORT + '/json/version').then(r => r.json())
  .then(s => console.log(JSON.stringify({ ...s, browserUrl: process.argv.includes('--browserUrl') })));
`, { mode: 0o700 });
  let pid: number | undefined;
  try {
    const env = { ...process.env, KARMAX_CDP_PORT: String(port), KARMAX_CDP_CHROME: chrome, KARMAX_CDP_MCP_BIN: mcp,
      KARMAX_CDP_KEEP_ALIVE: '0', KARMAX_CDP_HEADFUL: '1', KARMAX_CDP_USER_DATA_DIR: path.join(dir, 'profile') };
    const attached = JSON.parse((await exec(process.execPath, [launcher], { env, timeout: 30_000 })).stdout);
    pid = attached.pid;
    expect(attached.args).toContain('--headless=new');
    expect(attached.browserUrl).toBe(true);
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 40_000);
