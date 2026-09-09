import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

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
let visits = 0;
http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ pid: process.pid, visits: req.url === '/visit' ? ++visits : visits }));
}).listen(Number(process.env.KARMAX_CDP_PORT), '127.0.0.1');
`, { mode: 0o700 });
  fs.writeFileSync(mcp, `#!${process.execPath}
fetch('http://127.0.0.1:' + process.env.KARMAX_CDP_PORT + '/visit')
  .then(r => r.text()).then(s => console.log(s));
`, { mode: 0o700 });
  const env = { ...process.env, KARMAX_CDP_PORT: String(port), KARMAX_CDP_CHROME: chrome,
    KARMAX_CDP_MCP_BIN: mcp, KARMAX_CDP_KEEP_ALIVE: keepAlive ? '1' : '0',
    KARMAX_CDP_USER_DATA_DIR: path.join(dir, 'profile'), TEST_BROWSER_PID: pidFile };
  let pid: number | undefined;
  try {
    const first = JSON.parse((await exec(process.execPath, [launcher], { env })).stdout);
    pid = first.pid;
    expect(first.visits).toBe(1);
    if (keepAlive) {
      const second = JSON.parse((await exec(process.execPath, [launcher], { env })).stdout);
      expect(second).toEqual({ pid, visits: 2 });
    } else {
      await expect.poll(async () => {
        try { await fetch(`http://127.0.0.1:${port}/json/version`); return true; }
        catch { return false; }
      }).toBe(false);
    }
  } finally {
    if (!pid && fs.existsSync(pidFile)) pid = Number(fs.readFileSync(pidFile, 'utf8'));
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
