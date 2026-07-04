import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import WebSocket from 'ws';
import { bootHarness, Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { newId } from '../src/util/id.js';
import { ConfigHomeManager, scrubbedEnv, mcpServerMap, isLoggedIn, isFullyAuthed, capturedToken, tokenToInject } from '../src/autonomy/config-homes.js';
import { LoginManager } from '../src/autonomy/login.js';
import { remoteAccessPlan } from '../src/remote/access.js';

describe('config homes + scrubbed env (SPEC §7.3)', () => {
  it('mints one home per (account × provider) and scrubs inherited keys', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-ch-'));
    const mgr = new ConfigHomeManager(dir);
    const home = mgr.ensure('claude', 'work');
    expect(fs.existsSync(home)).toBe(true);
    expect(mgr.list().map((h) => h.account)).toContain('work');

    process.env.ANTHROPIC_API_KEY = 'leak-me';
    const env = scrubbedEnv({ provider: 'claude', configHome: home });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined(); // never leaks across profiles
    expect(env.CLAUDE_CONFIG_DIR).toBe(home);
    delete process.env.ANTHROPIC_API_KEY;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves a browser + platform MCP baseline (SPEC §7.5)', () => {
    const servers = mcpServerMap({ browser: 'chrome-devtools', platform: { command: 'node', args: ['mcp.js'] } });
    expect(servers['chrome-devtools']).toEqual({ command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] });
    expect(servers['karmax']).toEqual({ command: 'node', args: ['mcp.js'] });
    expect(mcpServerMap({ browser: 'none' })).toEqual({});
  });

  it('writes the MCP baseline into a Claude home (.claude.json) and merges', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-mcp-'));
    const mgr = new ConfigHomeManager(dir);
    const home = mgr.ensure('claude', 'work');
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ existing: true, mcpServers: { keep: { command: 'x', args: [] } } }));
    mgr.writeMcpConfig(home, 'claude', { browser: 'playwright' });
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    expect(cfg.existing).toBe(true); // preserved
    expect(cfg.mcpServers.keep).toBeTruthy(); // merged, not clobbered
    expect(cfg.mcpServers.playwright.command).toBe('npx');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes the karmax platform MCP into a config home with the gateway URL (task #4)', async () => {
    const { platformMcpSpec } = await import('../src/autonomy/config-homes.js');
    const spec = platformMcpSpec('http://127.0.0.1:4505');
    expect(spec.command).toBe('npx');
    expect(spec.args.some((a) => a.includes('stdio'))).toBe(true);
    expect(spec.env?.KARMAX_GATEWAY_URL).toBe('http://127.0.0.1:4505');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-plat-'));
    const mgr = new ConfigHomeManager(dir);
    const home = mgr.ensure('claude', 'work');
    mgr.writeMcpConfig(home, 'claude', { platform: spec });
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    expect(cfg.mcpServers.karmax.command).toBe('npx');
    expect(cfg.mcpServers.karmax.env.KARMAX_GATEWAY_URL).toContain('4505');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes the MCP baseline into a Codex home (config.toml)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-mcpc-'));
    const mgr = new ConfigHomeManager(dir);
    const home = mgr.ensure('codex', 'work');
    mgr.writeMcpConfig(home, 'codex', { browser: 'chrome-devtools' });
    const toml = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    expect(toml).toContain('[mcp_servers.chrome-devtools]');
    expect(toml).toContain('command = "npx"');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('account login (SPEC §7.3 / §6.2)', () => {
  it('mints a home and captures the device URL from the provider login', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-login-'));
    const homes = new ConfigHomeManager(dir);
    // fake login command: prints a URL then exits (real CLIs print then wait)
    const login = new LoginManager(homes, (_provider, home) => ({
      cmd: 'bash',
      args: ['-c', 'echo "Visit https://example.com/device?code=ABC123 to finish"; exit 0'],
      env: { ...process.env, KARMAX_HOME_PROBE: home } as Record<string, string>,
    }));
    const r = await login.connect('claude', 'work', { urlTimeoutMs: 4000 });
    expect(r.status).toBe('awaiting_oauth');
    expect(r.loginUrl).toBe('https://example.com/device?code=ABC123');
    expect(fs.existsSync(r.configHome)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports logged_in when a credentials file already exists (no relaunch)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-login2-'));
    const homes = new ConfigHomeManager(dir);
    const home = homes.ensure('claude', 'work');
    fs.writeFileSync(path.join(home, '.credentials.json'), '{}');
    expect(isLoggedIn('claude', home)).toBe(true);
    let launched = false;
    const login = new LoginManager(homes, () => {
      launched = true;
      return { cmd: 'false', args: [], env: {} };
    });
    const r = await login.connect('claude', 'work');
    expect(r.status).toBe('logged_in');
    expect(launched).toBe(false); // short-circuits, never spawns
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('status() reflects the credentials file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-login3-'));
    const homes = new ConfigHomeManager(dir);
    const login = new LoginManager(homes);
    expect(login.status('codex', 'acme').loggedIn).toBe(false);
    const home = homes.ensure('codex', 'acme');
    fs.writeFileSync(path.join(home, 'auth.json'), '{}');
    expect(login.status('codex', 'acme').loggedIn).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('captures a printed setup-token so the account reads as signed-in (1c)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-tok-'));
    const homes = new ConfigHomeManager(dir);
    // fake login: prints a device URL, then (as if OAuth finished) a token, then exits
    const login = new LoginManager(homes, () => ({
      cmd: 'bash',
      args: ['-c', 'echo "Visit https://example.com/dev?code=X"; echo "Your token: sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"; sleep 0.05'],
      env: {} as Record<string, string>,
    }));
    const r = await login.connect('claude', 'work', { urlTimeoutMs: 2000 });
    expect(r.loginUrl).toContain('example.com');
    // give the background reader a moment to persist the token
    await new Promise((res) => setTimeout(res, 200));
    expect(isLoggedIn('claude', r.configHome)).toBe(true);
    expect(capturedToken(r.configHome)).toMatch(/^sk-ant-oat01-/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Full-login era (#6): a setup-token-only home is signed-in but NOT "fully authed",
  // so `connect` re-runs login to UPGRADE it to a usage-pollable `.credentials.json`.
  it('distinguishes a setup-token home (signed-in but not fully authed) from a full login', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-auth-'));
    const homes = new ConfigHomeManager(dir);
    const home = homes.ensure('claude', 'work');
    // setup-token only:
    fs.writeFileSync(path.join(home, 'karmax-oauth.json'), JSON.stringify({ token: 'sk-ant-oat01-XYZ' }));
    expect(isLoggedIn('claude', home)).toBe(true);      // can run agents
    expect(isFullyAuthed('claude', home)).toBe(false);  // but not usage-pollable → re-login upgrades
    expect(tokenToInject(home)).toBe('sk-ant-oat01-XYZ'); // inject the setup-token (no native cred yet)
    // after a full login writes .credentials.json, prefer the native credential:
    fs.writeFileSync(path.join(home, '.credentials.json'), '{}');
    expect(isFullyAuthed('claude', home)).toBe(true);
    expect(tokenToInject(home)).toBeUndefined();         // native cred shadows the restricted setup-token
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('re-runs login on a setup-token home to upgrade it (does not short-circuit)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-upgrade-'));
    const homes = new ConfigHomeManager(dir);
    const home = homes.ensure('claude', 'work');
    fs.writeFileSync(path.join(home, 'karmax-oauth.json'), JSON.stringify({ token: 'sk-ant-oat01-OLD' }));
    let launched = false;
    const login = new LoginManager(homes, () => {
      launched = true;
      return { cmd: 'bash', args: ['-c', 'echo "Visit https://example.com/dev?code=UP"; sleep 0.05'], env: {} as Record<string, string> };
    });
    const r = await login.connect('claude', 'work', { urlTimeoutMs: 2000 });
    expect(launched).toBe(true);            // NOT short-circuited — the full login runs
    expect(r.status).toBe('awaiting_oauth');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('deletes and renames a login config home (1b)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-mgmt-'));
    const homes = new ConfigHomeManager(dir);
    const home = homes.ensure('claude', 'old');
    fs.writeFileSync(path.join(home, '.credentials.json'), '{}');
    const moved = homes.rename('claude', 'old', 'new');
    expect(fs.existsSync(path.join(moved, '.credentials.json'))).toBe(true); // creds carried over
    expect(homes.list().map((h) => h.account)).toContain('new');
    homes.remove('claude', 'new');
    expect(homes.list().map((h) => h.account)).not.toContain('new');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('remote access plan (SPEC §12)', () => {
  it('recommends tailscale when present, with an auth warning when no password', async () => {
    const plan = await remoteAccessPlan(4173, { hasPassword: false, detect: async (b) => b === 'tailscale' });
    expect(plan.method).toBe('tailscale');
    expect(plan.command).toContain('tailscale serve');
    expect(plan.guidance).toMatch(/KARMAX_PASSWORD/);
  });
  it('falls back to guidance when no tunnel tool is installed', async () => {
    const plan = await remoteAccessPlan(4173, { hasPassword: true, detect: async () => false });
    expect(plan.method).toBe('none');
  });
});

describe('budget coordinator (virtual-card lease, SPEC §7.6)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await bootHarness('mock');
  }, 60_000);
  afterAll(async () => {
    await h?.stop();
  });

  it('grants under threshold, holds over threshold for approval, declines over cap', async () => {
    const grantee = newId('task');
    const ping = await h.client.workflow.start('pingWorkflow', { taskQueue: TASK_QUEUE, workflowId: grantee, args: ['x'] });
    const coord = await h.client.workflow.start('budgetCoordinator', {
      taskQueue: TASK_QUEUE,
      workflowId: 'budget-coordinator-test',
      args: [{ state: { scopes: {}, defaultCap: 1000, threshold: 300, pending: [], processed: 0 } }],
    });
    const budget = () => coord.query('budget') as Promise<any>;

    await coord.signal('requestSpend', { reqId: 'r1', taskId: grantee, scope: 'profA', amount: 100 });
    await expect.poll(async () => (await budget()).scopes.profA?.spent, { timeout: 8000 }).toBe(100);

    // above threshold → held as pending, not spent
    await coord.signal('requestSpend', { reqId: 'r2', taskId: grantee, scope: 'profA', amount: 500 });
    await expect.poll(async () => (await budget()).pending.length, { timeout: 8000 }).toBe(1);
    expect((await budget()).scopes.profA.spent).toBe(100);

    // approve at the review gate → now spent
    await coord.signal('approveSpend', { reqId: 'r2' });
    await expect.poll(async () => (await budget()).scopes.profA.spent, { timeout: 8000 }).toBe(600);

    // over cap → declined (spent unchanged)
    await coord.signal('requestSpend', { reqId: 'r3', taskId: grantee, scope: 'profA', amount: 9999 });
    await new Promise((r) => setTimeout(r, 800));
    expect((await budget()).scopes.profA.spent).toBe(600);

    await ping.signal('finish');
    await ping.result();
    await coord.terminate('done');
  });
});

describe('PTY terminal check-in (SPEC §5.5)', () => {
  let h: Harness;
  let base: string;
  let token: string;
  beforeAll(async () => {
    h = await bootHarness('mock');
    const gw = await h.startGateway();
    base = gw.url;
    token = ((await (await fetch(`${base}/api/session`)).json()) as any).token;
  }, 60_000);
  afterAll(async () => {
    await h?.stop();
  });

  it('streams a real shell over /ws/terminal against the task world', async () => {
    const repo = await h.makeRepo('term');
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const project: any = await (await fetch(`${base}/api/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'T', config: { repos: [repo], defaultBase: 'main', defaultTarget: 'main' } }) })).json();
    const task: any = await (await fetch(`${base}/api/projects/${project.id}/tasks`, { method: 'POST', headers: auth, body: JSON.stringify({ title: 'term', prompt: '@write x.txt :: hi\n@incomplete', workflow: 'software-dev' }) })).json();
    // wait until the world exists (review stage)
    for (let i = 0; i < 60; i++) {
      const v: any = await (await fetch(`${base}/api/tasks/${task.id}`, { headers: auth })).json();
      if (v?.worldPath) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const wsUrl = base.replace('http', 'ws') + `/ws/terminal?taskId=${task.id}`;
    const got = await new Promise<string>((resolve) => {
      const ws = new WebSocket(wsUrl);
      let buf = '';
      let sent = false;
      const timer = setTimeout(() => { ws.close(); resolve(buf); }, 9000);
      ws.on('message', (m) => {
        try { const msg = JSON.parse(m.toString()); if (msg.type === 'data') buf += msg.data; } catch {}
        // send the command once the shell prompt has appeared
        if (!sent && buf.includes('karmax:')) { sent = true; ws.send(JSON.stringify({ type: 'input', data: 'echo TERM_OK_123\n' })); }
        if (buf.includes('TERM_OK_123\r') || /TERM_OK_123\b[\s\S]*\$/.test(buf)) { clearTimeout(timer); ws.close(); resolve(buf); }
      });
      ws.on('error', () => { clearTimeout(timer); resolve(buf); });
    });
    expect(String(got)).toContain('TERM_OK_123');
  }, 60_000);
});
