#!/usr/bin/env node
/**
 * Browser MCP launcher (wiki plans/PLAN-passwords §5B, finding: browser↔fill wiring).
 *
 * `chrome-devtools-mcp` launches its own Chrome over a DevTools *pipe*, which
 * has no loopback HTTP endpoint — so karmax's host-side `fill_credential`
 * (which types secrets into the page over CDP at http://127.0.0.1:PORT) cannot
 * reach the very browser the agent is driving. Chrome also ignores
 * `--remote-debugging-port` whenever a pipe is requested, so the two halves of
 * the zero-exposure fill can never meet under the default config.
 *
 * This wrapper closes the gap: it opens ONE Chrome with a real
 * `--remote-debugging-port`, then runs `chrome-devtools-mcp` in `--browserUrl`
 * attach mode against it. The agent drives that browser through the MCP and
 * karmax fills into the same browser over the same port. Chrome normally lives
 * only for the MCP's lifetime. Task-isolated remote worlds opt into keeping it
 * alive across turns, including human approvals. If Chrome can't be found or
 * launched, we fall back to the plain pipe MCP
 * so the browser tools still work (fill just won't reach it — today's behavior;
 * never a regression).
 *
 * Config via env (set by config-homes.mcpServerMap):
 *   KARMAX_CDP_PORT         loopback debug port (default 9222)
 *   KARMAX_CDP_MCP_VERSION  chrome-devtools-mcp version to run via npx
 *   KARMAX_CDP_CHROME       explicit Chrome executable (else auto-detected)
 *   KARMAX_CDP_USER_DATA_DIR  Chrome profile dir (default a temp dir)
 *   KARMAX_CDP_KEEP_ALIVE=1  keep Chrome until its isolated world is stopped
 *   KARMAX_CDP_HEADFUL=1     launch a visible browser (default headless=new)
 * Any extra argv is forwarded to chrome-devtools-mcp.
 */
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const PORT = Number(process.env.KARMAX_CDP_PORT) || 9222;
// Never `latest`: an unreviewed release would run with the agent's browser.
// Keep in step with CHROME_DEVTOOLS_MCP_VERSION (src/autonomy/config-homes.ts).
const VERSION = process.env.KARMAX_CDP_MCP_VERSION || '1.6.0';
// In a remote sandbox the chrome-devtools-mcp binary is already baked/installed;
// point at it directly instead of resolving through npx.
const MCP_BIN = process.env.KARMAX_CDP_MCP_BIN || '';
const KEEP_ALIVE = process.env.KARMAX_CDP_KEEP_ALIVE === '1';
const EXTRA = process.argv.slice(2);
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function log(msg) { process.stderr.write(`[chrome-cdp-launcher] ${msg}\n`); }

function cdpUp(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 800 }, (r) => {
      r.resume(); resolve(r.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function findChrome() {
  if (process.env.KARMAX_CDP_CHROME) return process.env.KARMAX_CDP_CHROME;
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'google-chrome', 'chromium']
    : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['--version'], { stdio: 'ignore' });
      if (r.status === 0) return c;
    } catch { /* try next */ }
  }
  return undefined;
}

/**
 * Chrome's V8 renderer reserves a large *virtual* CodeRange at startup. In a
 * memory-constrained sandbox with vm.overcommit_memory=0 (heuristic overcommit,
 * e.g. the default ~512MB E2B sandbox) the kernel refuses that reservation and
 * the renderer dies with "V8 process OOM (CodeRange)", so any page-level CDP
 * hangs. Setting vm.overcommit_memory=1 (always overcommit — the reservation is
 * virtual, not committed) fixes it. Best-effort and remote-only: gated on
 * KARMAX_CDP_SET_OVERCOMMIT so we never touch a developer's local host sysctl.
 */
function ensureOvercommit() {
  if (process.env.KARMAX_CDP_SET_OVERCOMMIT !== '1') return;
  const already = (() => { try { return fs.readFileSync('/proc/sys/vm/overcommit_memory', 'utf8').trim(); } catch { return ''; } })();
  if (already === '1') return;
  let isRoot = false;
  try { isRoot = typeof process.getuid === 'function' && process.getuid() === 0; } catch { /* non-posix */ }
  try {
    if (isRoot) fs.writeFileSync('/proc/sys/vm/overcommit_memory', '1');
    else spawnSync('sudo', ['-n', 'sysctl', '-w', 'vm.overcommit_memory=1'], { stdio: 'ignore' });
  } catch { /* best-effort; Chrome may still fail and the launcher falls back */ }
  const now = (() => { try { return fs.readFileSync('/proc/sys/vm/overcommit_memory', 'utf8').trim(); } catch { return '?'; } })();
  log(`vm.overcommit_memory now ${now} (was ${already || '?'})`);
}

function runMcp(browserUrl) {
  // Baked bin (remote sandbox) → exec directly; otherwise resolve via npx.
  const command = MCP_BIN || npx;
  const args = MCP_BIN ? [] : ['-y', `chrome-devtools-mcp@${VERSION}`];
  if (browserUrl) args.push('--browserUrl', browserUrl);
  args.push(...EXTRA);
  // Usage statistics add a resident watchdog process (~80 MB, a real share of
  // a 2 GB sandbox) and would report tenants' browser-tool use to Google.
  const mcp = spawn(command, args, { stdio: 'inherit', env: { ...process.env, CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1' } });
  const forward = (sig) => { try { mcp.kill(sig); } catch { /* already gone */ } };
  process.on('SIGTERM', () => forward('SIGTERM'));
  process.on('SIGINT', () => forward('SIGINT'));
  return mcp;
}

async function main() {
  // Keep local launchers exclusive for their whole lifetime. Remote worlds
  // have their own network namespace and may deliberately retain one browser.
  if (!KEEP_ALIVE) {
    const lock = path.join(os.tmpdir(), `karmax-cdp-${PORT}.lock`);
    if (process.platform === 'linux') {
      // flock shares the parent's open file description; process death releases
      // it automatically, including SIGKILL. Never unlink a kernel lock file.
      const fd = fs.openSync(lock, 'a', 0o600);
      const acquired = spawnSync('flock', ['--exclusive', '--nonblock', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', fd], timeout: 5000,
      });
      if (acquired.status !== 0) {
        fs.closeSync(fd);
        throw new Error(`CDP port ${PORT} is already in use or its lock is unavailable`);
      }
      process.on('exit', () => fs.closeSync(fd));
    } else {
      try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
      catch { throw new Error(`CDP port ${PORT} is already in use; if its launcher has exited, remove ${lock}`); }
      process.on('exit', () => fs.rmSync(lock, { force: true }));
    }
  }
  const profile = process.env.KARMAX_CDP_USER_DATA_DIR;
  const ownerFile = profile ? path.join(profile, '.karmax-browser-owner.json') : undefined;
  if (await cdpUp(PORT)) {
    let owner;
    try { owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); } catch { /* unowned endpoint */ }
    if (!KEEP_ALIVE || owner?.port !== PORT || !Number.isSafeInteger(owner?.pid))
      throw new Error(`CDP port ${PORT} is already in use by an unowned browser`);
    try { process.kill(owner.pid, 0); }
    catch { throw new Error(`CDP port ${PORT} is already in use by an unowned browser`); }
    log(`reusing existing CDP browser on :${PORT}`);
    const mcp = runMcp(`http://127.0.0.1:${PORT}`);
    mcp.on('exit', (code) => process.exit(code ?? 0));
    return;
  }

  const chrome = findChrome();
  if (!chrome) {
    log('no Chrome executable found — falling back to chrome-devtools-mcp pipe mode (fill_credential will be unavailable)');
    const mcp = runMcp(undefined);
    mcp.on('exit', (code) => process.exit(code ?? 0));
    return;
  }

  ensureOvercommit(); // remote sandboxes: let Chrome's V8 renderer reserve its CodeRange
  const userDataDir = process.env.KARMAX_CDP_USER_DATA_DIR
    || fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-cdp-'));
  const createdProfile = !profile || !fs.existsSync(userDataDir);
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  if (!KEEP_ALIVE && createdProfile) process.on('exit', () => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const headless = process.env.KARMAX_CDP_HEADFUL === '1' ? [] : ['--headless=new'];
  const chromeArgs = [
    ...headless, `--remote-debugging-port=${PORT}`, '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${userDataDir}`, '--no-first-run', '--no-default-browser-check',
    '--disable-features=Translate', 'about:blank',
  ];
  // --no-sandbox is required when running as root (common in containers/sandboxes)
  // or when the caller forces it (remote worlds pass KARMAX_CDP_NO_SANDBOX=1).
  let isRoot = false;
  try { isRoot = typeof process.getuid === 'function' && process.getuid() === 0; } catch { /* non-posix */ }
  if (isRoot || process.env.KARMAX_CDP_NO_SANDBOX === '1') chromeArgs.unshift('--no-sandbox');

  let browser;
  try {
    browser = spawn(chrome, chromeArgs, { stdio: 'ignore', detached: KEEP_ALIVE });
    if (KEEP_ALIVE) browser.unref();
  } catch (e) {
    log(`failed to spawn Chrome (${e?.message ?? e}) — falling back to pipe mode`);
    const mcp = runMcp(undefined);
    mcp.on('exit', (code) => process.exit(code ?? 0));
    return;
  }

  let browserDead = false;
  browser.on('exit', () => { browserDead = true; });

  // Wait for the DevTools endpoint (up to ~12s).
  let ready = false;
  for (let i = 0; i < 48 && !browserDead; i++) {
    if (await cdpUp(PORT)) { ready = true; break; }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) {
    log('Chrome did not expose its DevTools port in time — falling back to pipe mode');
    try { browser.kill('SIGKILL'); } catch { /* ignore */ }
    const mcp = runMcp(undefined);
    mcp.on('exit', (code) => process.exit(code ?? 0));
    return;
  }

  if (KEEP_ALIVE && ownerFile) fs.writeFileSync(ownerFile, JSON.stringify({ port: PORT, pid: browser.pid }), { mode: 0o600 });
  log(`Chrome ready on :${PORT}; attaching chrome-devtools-mcp`);
  const mcp = runMcp(`http://127.0.0.1:${PORT}`);
  const killChrome = () => { try { browser.kill('SIGKILL'); } catch { /* ignore */ } };
  if (!KEEP_ALIVE) process.on('exit', killChrome);
  mcp.on('exit', (code) => { if (!KEEP_ALIVE) killChrome(); process.exit(code ?? 0); });
}

main().catch((e) => { log(`fatal: ${e?.message ?? e}`); process.exit(1); });
