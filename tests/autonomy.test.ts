import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import WebSocket from 'ws';
import { bootHarness, Harness } from './helpers/harness.js';
import { ConfigHomeManager, scrubbedEnv, mcpServerMap, isLoggedIn, isFullyAuthed, capturedToken, tokenToInject } from '../src/autonomy/config-homes.js';
import { LoginManager, defaultLoginCommand, parseLoginPrompt } from '../src/autonomy/login.js';
import { localProviderCli } from '../src/agent/provider-cli.js';
import { RemoteAccessController, remoteAccessPlan } from '../src/remote/access.js';

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
    expect(env.PATH?.split(path.delimiter)[0]).toBe(path.join(os.homedir(), '.local', 'bin'));
    delete process.env.ANTHROPIC_API_KEY;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps same-named organization logins in disjoint homes and preserves legacy personal homes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-ch-org-'));
    const mgr = new ConfigHomeManager(dir);
    const personal = mgr.ensure('claude', 'work');
    const acme = mgr.ensure('claude', 'work', 'org_acme');
    const beta = mgr.ensure('claude', 'work', 'org_beta');

    expect(personal).toBe(path.join(dir, 'claude-work'));
    expect(new Set([personal, acme, beta]).size).toBe(3);
    expect(mgr.list('org_acme').map((home) => home.path)).toEqual([acme]);
    expect(mgr.list('org_beta').map((home) => home.path)).toEqual([beta]);
    expect(mgr.list().map((home) => home.path)).toEqual([personal]);

    await mgr.removeOrganization('org_acme');
    expect(fs.existsSync(acme)).toBe(false);
    expect(fs.existsSync(beta)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves a browser + platform MCP baseline (SPEC §7.5)', () => {
    const servers = mcpServerMap({ browser: 'chrome-devtools', platform: { command: 'node', args: ['mcp.js'] } });
    // chrome-devtools runs through karmax's launcher so its Chrome exposes a
    // loopback DevTools port that host-side fill_credential can reach (§5B).
    const chrome = servers['chrome-devtools']!;
    expect(chrome.command).toBe(process.execPath);
    expect(chrome.args[0]).toMatch(/chrome-cdp-launcher\.mjs$/);
    expect(chrome.env).toMatchObject({ KARMAX_CDP_MCP_VERSION: '1.6.0' });
    // Fills find the task's own browser by its agent's custody marker (AU-14).
    expect(chrome.forwardEnv).toEqual(['KARMAX_CUSTODY_CHAIN']);
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
    expect(spec.command).toBe(process.execPath);
    expect(spec.args).toContain('--import');
    expect(spec.args.some((a) => a.includes('tsx/dist/loader'))).toBe(true);
    expect(spec.args.some((a) => a.includes('stdio'))).toBe(true);
    expect(spec.forwardEnv).toEqual(['KARMAX_TOKEN']);
    expect(spec.env?.KARMAX_GATEWAY_URL).toBe('http://127.0.0.1:4505');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-plat-'));
    const mgr = new ConfigHomeManager(dir);
    const home = mgr.ensure('claude', 'work');
    mgr.writeMcpConfig(home, 'claude', { platform: spec });
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    expect(cfg.mcpServers.karmax.command).toBe(process.execPath);
    expect(cfg.mcpServers.karmax.forwardEnv).toBeUndefined();
    expect(cfg.mcpServers.karmax.env.KARMAX_GATEWAY_URL).toContain('4505');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('idempotently merges the MCP baseline into a Codex home (config.toml)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-mcpc-'));
    const mgr = new ConfigHomeManager(dir);
    const home = mgr.ensure('codex', 'work');
    const file = path.join(home, 'config.toml');
    fs.writeFileSync(file, `model = "custom"\n\n[mcp_servers.keep]\ncommand = "keep"\n\n[mcp_servers.playwright]\ncommand = "old-browser"\n\n[mcp_servers.chrome-devtools]\ncommand = "old"\n\n[mcp_servers.chrome-devtools]\ncommand = "duplicate"\n`);
    const baseline = { browser: 'chrome-devtools' as const, platform: { command: 'node', args: ['mcp.js'], env: { KARMAX_GATEWAY_URL: 'http://localhost:4505' } } };
    mgr.writeMcpConfig(home, 'codex', baseline);
    mgr.writeMcpConfig(home, 'codex', baseline);
    const toml = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    expect(toml.match(/^\[mcp_servers\.chrome-devtools]$/gm)).toHaveLength(1);
    expect(toml.match(/^\[mcp_servers\.karmax]$/gm)).toHaveLength(1);
    expect(toml.match(/^\[mcp_servers\.karmax\.env]$/gm)).toHaveLength(1);
    expect(toml).not.toContain('[mcp_servers.playwright]');
    expect(toml).toContain('chrome-cdp-launcher.mjs'); // chrome-devtools runs through the CDP-port launcher
    expect(toml).toContain('env_vars = ["KARMAX_CUSTODY_CHAIN"]');
    expect(toml).toContain('model = "custom"');
    expect(toml).toContain('[mcp_servers.keep]');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('upgrades managed platform and browser MCPs in existing homes without clobbering other servers', async () => {
    const { platformMcpSpec } = await import('../src/autonomy/config-homes.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-mcp-refresh-'));
    const mgr = new ConfigHomeManager(dir);
    const codexHome = mgr.ensure('codex', 'work');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), `model = "custom"\n\n[mcp_servers.keep]\ncommand = "keep"\n\n[mcp_servers.chrome-devtools]\ncommand = "npx"\nargs = ["-y", "chrome-devtools-mcp"]\n\n[mcp_servers.karmax]\ncommand = "npx"\nargs = ["tsx", "old.ts"]\n`);
    const claudeHome = mgr.ensure('claude', 'work');
    fs.writeFileSync(path.join(claudeHome, '.claude.json'), JSON.stringify({ mcpServers: {
      keep: { command: 'keep', args: [] },
      'chrome-devtools': { command: 'npx', args: ['-y', 'chrome-devtools-mcp'] },
      karmax: { command: 'npx', args: ['tsx', 'old.ts'] },
    } }));

    mgr.refreshManagedMcp('http://127.0.0.1:9876');

    const toml = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    expect(toml.match(/^\[mcp_servers\.karmax]$/gm)).toHaveLength(1);
    expect(toml.match(/^\[mcp_servers\.chrome-devtools]$/gm)).toHaveLength(1);
    expect(toml).toContain(`command = ${JSON.stringify(process.execPath)}`);
    expect(toml).toContain('env_vars = ["KARMAX_TOKEN"]');
    expect(toml).toContain('KARMAX_GATEWAY_URL = "http://127.0.0.1:9876"');
    expect(toml).toContain('chrome-cdp-launcher.mjs');
    expect(toml).not.toContain('args = ["-y", "chrome-devtools-mcp"]');
    expect(toml).toContain('[mcp_servers.keep]');
    expect(toml).toContain('model = "custom"');

    const claude = JSON.parse(fs.readFileSync(path.join(claudeHome, '.claude.json'), 'utf8'));
    expect(claude.mcpServers.keep.command).toBe('keep');
    expect(claude.mcpServers['chrome-devtools']).toEqual(expect.objectContaining({
      command: process.execPath,
      args: [expect.stringMatching(/chrome-cdp-launcher\.mjs$/)],
    }));
    expect(claude.mcpServers.karmax).toEqual(expect.objectContaining({
      command: platformMcpSpec('http://127.0.0.1:9876').command,
      env: { KARMAX_GATEWAY_URL: 'http://127.0.0.1:9876' },
    }));
    expect(claude.mcpServers.karmax.forwardEnv).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('account login (SPEC §7.3 / §6.2)', () => {
  it('uses the provider CLIs shipped with Krmax instead of requiring global installs', () => {
    for (const provider of ['claude', 'codex'] as const) {
      const command = localProviderCli(provider);
      expect(command).not.toBe(provider);
      expect(command).toContain(`${path.sep}node_modules${path.sep}`);
      expect(fs.existsSync(command)).toBe(true);
    }
  });

  it('keeps the running Node executable available to provider package entrypoints', () => {
    const previous = process.env.PATH;
    process.env.PATH = ['/usr/bin', '/bin'].join(path.delimiter);
    try {
      const env = scrubbedEnv({ provider: 'codex', configHome: '/tmp/isolated-codex-home' });
      expect(env.PATH?.split(path.delimiter).slice(0, 2)).toEqual([
        path.join(os.homedir(), '.local', 'bin'),
        path.dirname(process.execPath),
      ]);
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  });

  it('uses Codex device authorization on a hosted deployment', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-login-hosted-'));
    const home = new ConfigHomeManager(dir).ensure('codex', 'work');
    const previousDeployment = process.env.KARMAX_DEPLOYMENT;
    const previousArgs = process.env.KARMAX_CODEX_LOGIN_ARGS;
    process.env.KARMAX_DEPLOYMENT = 'hosted';
    delete process.env.KARMAX_CODEX_LOGIN_ARGS;
    try {
      expect(defaultLoginCommand('codex', home, {})?.args).toEqual(['login', '--device-auth']);
    } finally {
      if (previousDeployment === undefined) delete process.env.KARMAX_DEPLOYMENT;
      else process.env.KARMAX_DEPLOYMENT = previousDeployment;
      if (previousArgs === undefined) delete process.env.KARMAX_CODEX_LOGIN_ARGS;
      else process.env.KARMAX_CODEX_LOGIN_ARGS = previousArgs;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses the ANSI-decorated Codex device code prompt', () => {
    expect(parseLoginPrompt([
      '1. Open this link in your browser and sign in to your account',
      '   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m',
      '2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m',
      '   \u001b[94m7GD3-0JLQ0\u001b[0m',
    ].join('\n'))).toEqual({
      loginUrl: 'https://auth.openai.com/codex/device',
      verificationCode: '7GD3-0JLQ0',
    });
  });

  it('returns a pasted Claude authorization code to the waiting login CLI', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-login-code-'));
    const homes = new ConfigHomeManager(dir);
    const login = new LoginManager(homes, (_provider, home) => ({
      cmd: 'bash',
      args: ['-c', `printf 'Visit https://claude.example/oauth\\nPaste code here if prompted > '; IFS= read -r code; printf '%s' "$code" > "$CLAUDE_CONFIG_DIR/submitted"; printf '%s' '{"claudeAiOauth":{"accessToken":"access"}}' > "$CLAUDE_CONFIG_DIR/.credentials.json"`],
      env: { ...process.env, CLAUDE_CONFIG_DIR: home } as Record<string, string>,
    }));

    const started = await login.connect('claude', 'work', { urlTimeoutMs: 2000 });
    expect(started).toMatchObject({ status: 'awaiting_oauth', requiresCode: true });
    const completed = await login.submitAuthorizationCode('claude', 'work', 'oauth-code-123');
    expect(completed.status).toBe('logged_in');
    expect(fs.readFileSync(path.join(started.configHome, 'submitted'), 'utf8')).toBe('oauth-code-123');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('can force provider OAuth when an existing native credential is stale', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-login-force-'));
    const homes = new ConfigHomeManager(dir);
    const home = homes.ensure('claude', 'work');
    fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'stale' } }));
    let launches = 0;
    const login = new LoginManager(homes, () => {
      launches++;
      return {
        cmd: 'bash', args: ['-c', 'echo "Visit https://example.com/reauth"; sleep 1'],
        env: {} as Record<string, string>,
      };
    });
    try {
      await expect(login.connect('claude', 'work')).resolves.toMatchObject({ status: 'logged_in' });
      expect(launches).toBe(0);
      await expect(login.connect('claude', 'work', { force: true, urlTimeoutMs: 500 }))
        .resolves.toMatchObject({ status: 'awaiting_oauth', loginUrl: 'https://example.com/reauth' });
      expect(launches).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not mistake the predecessor credential for a successful forced authorization code', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-login-force-reject-'));
    const homes = new ConfigHomeManager(dir);
    const home = homes.ensure('claude', 'work');
    fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'stale' } }));
    const login = new LoginManager(homes, () => ({
      cmd: 'bash',
      args: ['-c', "printf 'Visit https://example.com/reauth\\nPaste code here > '; IFS= read -r code; exit 1"],
      env: {} as Record<string, string>,
    }));
    try {
      await expect(login.connect('claude', 'work', { force: true, urlTimeoutMs: 500 }))
        .resolves.toMatchObject({ status: 'awaiting_oauth' });
      await expect(login.submitAuthorizationCode('claude', 'work', 'rejected-code'))
        .resolves.toMatchObject({ status: 'failed' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

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

  it('captures a device URL still in the pipe when the login process exits', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-login-late-'));
    const homes = new ConfigHomeManager(dir);
    // 'exit' can precede the child's last output (a busy event loop, or a helper
    // that still holds the pipe); only 'close' means the output is complete.
    const login = new LoginManager(homes, () => ({
      cmd: 'bash',
      args: ['-c', '(sleep 0.3; echo "Visit https://example.com/late?code=LATE") & exit 0'],
      env: {} as Record<string, string>,
    }));
    try {
      const r = await login.connect('claude', 'work', { urlTimeoutMs: 4000 });
      expect(r).toMatchObject({ status: 'awaiting_oauth', loginUrl: 'https://example.com/late?code=LATE' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses OpenCode auth selectors and preserves a device verification code', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-login-oc-'));
    const homes = new ConfigHomeManager(dir);
    const home = homes.ensure('opencode', 'grok');
    const method = 'xAI Grok OAuth (Headless / Remote / VPS)';
    const spec = defaultLoginCommand('opencode', home, { modelProvider: 'xai', authMethod: method });
    expect(spec?.args).toEqual(['auth', 'login', '--provider', 'xai', '--method', method]);
    expect(spec?.env.XDG_DATA_HOME).toBe(path.join(home, 'data'));

    const login = new LoginManager(homes, () => ({
      cmd: 'bash',
      args: ['-c', 'echo "Open https://x.ai/device on any device and enter code: ABCD-1234"; sleep 0.05'],
      env: {} as Record<string, string>,
    }));
    const result = await login.connect('opencode', 'fresh', {
      modelProvider: 'xai',
      authMethod: method,
      urlTimeoutMs: 2000,
    });
    expect(result.status).toBe('awaiting_oauth');
    expect(result.loginUrl).toBe('https://x.ai/device');
    expect(result.verificationCode).toBe('ABCD-1234');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports logged_in when a credentials file already exists (no relaunch)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-login2-'));
    const homes = new ConfigHomeManager(dir);
    const home = homes.ensure('claude', 'work');
    fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 60_000 },
    }));
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

  it('does not treat Claude logout placeholders as authenticated', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-login-empty-'));
    const homes = new ConfigHomeManager(dir);
    const home = homes.ensure('claude', 'work');
    fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0 },
    }));
    expect(isLoggedIn('claude', home)).toBe(false);
    expect(isFullyAuthed('claude', home)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports a missing login executable directly instead of a URL timeout', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-login-missing-'));
    const homes = new ConfigHomeManager(dir);
    const login = new LoginManager(homes, () => ({
      cmd: `karmax-missing-login-${Date.now()}`,
      args: [],
      env: { ...process.env } as Record<string, string>,
    }));
    // A day-long URL wait cannot elapse inside the test, so the answer can only
    // come from the spawn failure itself; waiting for the URL would time out.
    const result = await login.connect('claude', 'work', { urlTimeoutMs: 24 * 60 * 60_000 });
    expect(result).toEqual(expect.objectContaining({
      status: 'failed',
      detail: expect.stringMatching(/^could not launch karmax-missing-login-.*ENOENT/),
    }));
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
    fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: 'access', refreshToken: 'refresh' },
    }));
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
    fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: 'access', refreshToken: 'refresh' },
    }));
    const moved = await homes.rename('claude', 'old', 'new');
    expect(fs.existsSync(path.join(moved, '.credentials.json'))).toBe(true); // creds carried over
    expect(homes.list().map((h) => h.account)).toContain('new');
    await homes.remove('claude', 'new');
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
    expect(plan.guidance).not.toMatch(/cloudflared|ngrok|funnel/i);
  });
  it('reports a missing Tailscale executable as installable, not logged out', async () => {
    const missing = Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT', stdout: '', stderr: '' });
    const controller = new RemoteAccessController({ port: () => 4173, run: async () => { throw missing; } });
    expect(await controller.status()).toMatchObject({
      method: 'none',
      state: 'unavailable',
      canEnable: false,
    });
  });
  it('does not report ready when the local daemon is running but the node is offline', async () => {
    const controller = new RemoteAccessController({
      port: () => 4173,
      run: async (args) => {
        if (args[0] === 'status') return {
          stdout: JSON.stringify({
            BackendState: 'Running',
            Self: { DNSName: 'host.example.ts.net.', Online: false },
          }),
          stderr: '',
        };
        throw new Error('Serve status must not mask an offline node');
      },
    });
    expect(await controller.status()).toMatchObject({
      method: 'tailscale',
      state: 'error',
      detail: expect.stringMatching(/computer is offline/i),
      setupStage: 'connect',
      canSetup: true,
      fallbackCommands: [
        'sudo systemctl restart tailscaled',
        'sudo tailscale up',
        'sudo tailscale serve --bg --yes http://127.0.0.1:4173',
      ],
      canEnable: false,
    });
  });
  it('detects and enables the private Tailscale route without touching an existing Serve app', async () => {
    let serve = 'No serve config';
    const calls: string[][] = [];
    const controller = new RemoteAccessController({
      port: () => 4173,
      run: async (args) => {
        calls.push(args);
        if (args[0] === 'status') return { stdout: JSON.stringify({
          BackendState: 'Running',
          Self: { DNSName: 'laptop.example.ts.net.' },
        }), stderr: '' };
        if (args.join(' ') === 'serve status --json') return { stdout: serve, stderr: '' };
        if (args[0] === 'serve' && args[1] === '--bg') {
          serve = 'https://laptop.example.ts.net\n|-- / proxy http://127.0.0.1:4173';
          return { stdout: 'Serve started', stderr: '' };
        }
        throw new Error(`unexpected command: ${args.join(' ')}`);
      },
    });
    expect(await controller.status()).toMatchObject({ state: 'available', canEnable: true });
    expect(await controller.enable()).toMatchObject({
      state: 'ready',
      url: 'https://laptop.example.ts.net',
      canDisable: true,
    });
    expect(calls).toContainEqual(['serve', '--bg', 'http://127.0.0.1:4173']);
  });
  it('refuses to overwrite another Tailscale Serve route', async () => {
    const controller = new RemoteAccessController({
      port: () => 4173,
      run: async (args) => args[0] === 'status'
        ? { stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'host.example.ts.net.' } }), stderr: '' }
        : { stdout: 'https://host.example.ts.net\n|-- / proxy http://127.0.0.1:9000', stderr: '' },
    });
    expect(await controller.enable()).toMatchObject({
      state: 'conflict',
      url: 'https://host.example.ts.net',
      detail: expect.stringMatching(/another local service on port 9000/i),
      canEnable: false,
      canDisable: false,
    });
    expect((await controller.status()).fallbackCommands).toBeUndefined();
  });
  it.each([
    'https://host.example.ts.net\n|-- / proxy http://127.0.0.1:41730',
    JSON.stringify({ Web: { 'host.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:41730' } } } } }),
  ])('does not disable a route whose port merely starts with the gateway port', async serve => {
    const calls: string[][] = [];
    const controller = new RemoteAccessController({ port: () => 4173, run: async args => {
      calls.push(args);
      return { stdout: args[0] === 'status'
        ? JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'host.example.ts.net.' } }) : serve, stderr: '' };
    } });
    expect(await controller.disable()).toMatchObject({ state: 'conflict', canDisable: false });
    expect(calls).not.toContainEqual(['serve', 'off']);
  });
  it('turns Linux Serve permission errors into a one-time setup action', async () => {
    const denied = Object.assign(new Error('command failed'), {
      stderr: 'Access denied: serve config denied\nUse sudo tailscale serve.\nTo not require root, use sudo tailscale set --operator=$USER once.',
    });
    const controller = new RemoteAccessController({
      port: () => 4173,
      run: async (args) => {
        if (args[0] === 'status') return {
          stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'host.example.ts.net.' } }),
          stderr: '',
        };
        if (args.join(' ') === 'serve status --json') return { stdout: 'No serve config', stderr: '' };
        throw denied;
      },
    });
    expect(await controller.enable()).toMatchObject({
      state: 'error',
      detail: expect.stringMatching(/one-time permission/i),
      setupCommand: 'sudo tailscale set --operator=$USER',
      canEnable: true,
    });
  });
  it('links the per-device Serve approval when the tailnet has not enabled it', async () => {
    const approval = Object.assign(new Error('command failed'), {
      stderr: 'Serve is not enabled on your tailnet. To enable, visit:\nhttps://login.tailscale.com/f/serve?node=abc123',
    });
    const controller = new RemoteAccessController({
      port: () => 4173,
      run: async (args) => {
        if (args[0] === 'status') return {
          stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'host.example.ts.net.' } }),
          stderr: '',
        };
        if (args.join(' ') === 'serve status --json') return { stdout: 'No serve config', stderr: '' };
        throw approval;
      },
    });
    expect(await controller.enable()).toMatchObject({
      state: 'error',
      helpUrl: 'https://login.tailscale.com/f/serve?node=abc123',
      canEnable: true,
    });
  });
  it('shows both one-time actions when Tailscale reports approval and permission together', async () => {
    const combined = Object.assign(new Error('command failed'), {
      stderr: [
        'Serve is not enabled on your tailnet.',
        'https://login.tailscale.com/f/serve?node=abc123',
        'Access denied: serve config denied',
        'Use sudo tailscale set --operator=$USER once.',
      ].join('\n'),
    });
    const controller = new RemoteAccessController({
      port: () => 4173,
      run: async (args) => {
        if (args[0] === 'status') return {
          stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'host.example.ts.net.' } }),
          stderr: '',
        };
        if (args.join(' ') === 'serve status --json') return { stdout: 'No serve config', stderr: '' };
        throw combined;
      },
    });
    expect(await controller.enable()).toMatchObject({
      state: 'error',
      detail: expect.stringMatching(/two one-time setup steps/i),
      helpUrl: 'https://login.tailscale.com/f/serve?node=abc123',
      setupCommand: 'sudo tailscale set --operator=$USER',
      canEnable: true,
    });
  });
  it('uses native Linux authorization and returns the Tailscale login step', async () => {
    const calls: string[][] = [];
    const elevated: string[][] = [];
    const denied = Object.assign(new Error('Access denied'), { stderr: 'Access denied; use sudo' });
    const login = Object.assign(new Error('timed out'), {
      stdout: 'To authenticate, visit:\nhttps://login.tailscale.com/a/login123',
      stderr: 'timed out waiting for Running state',
    });
    const controller = new RemoteAccessController({
      port: () => 4173,
      platform: 'linux',
      username: 'alice',
      run: async (args) => {
        calls.push(args);
        if (args[0] === 'status') return {
          stdout: JSON.stringify({ BackendState: 'NeedsLogin', Self: {} }),
          stderr: '',
        };
        if (args[0] === 'set') throw denied;
        if (args[0] === 'up') throw login;
        throw new Error(`unexpected command: ${args.join(' ')}`);
      },
      elevate: async (args) => {
        elevated.push(args);
        return { stdout: '', stderr: '' };
      },
    });
    expect(await controller.setup()).toMatchObject({
      state: 'needs-login',
      setupStage: 'login',
      helpUrl: 'https://login.tailscale.com/a/login123',
      detail: expect.stringMatching(/finish signing in/i),
      canSetup: true,
    });
    expect(calls).toContainEqual(['set', '--operator=alice']);
    expect(elevated).toEqual([['set', '--operator=alice']]);
  });
  it('finishes a connected setup by enabling private Serve noninteractively', async () => {
    let serve = 'No serve config';
    const calls: string[][] = [];
    const controller = new RemoteAccessController({
      port: () => 4173,
      platform: 'linux',
      username: 'alice',
      run: async (args) => {
        calls.push(args);
        if (args[0] === 'status') return {
          stdout: JSON.stringify({
            BackendState: 'Running',
            Self: { DNSName: 'host.example.ts.net.', Online: true },
          }),
          stderr: '',
        };
        if (args[0] === 'set') return { stdout: '', stderr: '' };
        if (args.join(' ') === 'serve status --json') return { stdout: serve, stderr: '' };
        if (args.join(' ') === 'serve --bg --yes http://127.0.0.1:4173') {
          serve = 'https://host.example.ts.net\n|-- / proxy http://127.0.0.1:4173';
          return { stdout: 'Serve started', stderr: '' };
        }
        throw new Error(`unexpected command: ${args.join(' ')}`);
      },
    });
    expect(await controller.setup()).toMatchObject({
      state: 'ready',
      setupStage: 'ready',
      url: 'https://host.example.ts.net',
      canSetup: false,
    });
    expect(calls).toContainEqual(['serve', '--bg', '--yes', 'http://127.0.0.1:4173']);
  });
  it('returns the Tailscale Serve approval page as the next guided step', async () => {
    const approval = Object.assign(new Error('Serve is not enabled'), {
      stderr: 'Serve is not enabled on your tailnet.\nhttps://login.tailscale.com/f/serve?node=abc123',
    });
    const controller = new RemoteAccessController({
      port: () => 4173,
      platform: 'linux',
      username: 'alice',
      run: async (args) => {
        if (args[0] === 'status') return {
          stdout: JSON.stringify({
            BackendState: 'Running',
            Self: { DNSName: 'host.example.ts.net.', Online: true },
          }),
          stderr: '',
        };
        if (args[0] === 'set') return { stdout: '', stderr: '' };
        if (args.join(' ') === 'serve status --json') return { stdout: 'No serve config', stderr: '' };
        if (args[0] === 'serve' && args[1] === '--bg') throw approval;
        throw new Error(`unexpected command: ${args.join(' ')}`);
      },
    });
    expect(await controller.setup()).toMatchObject({
      state: 'error',
      setupStage: 'serve',
      helpUrl: 'https://login.tailscale.com/f/serve?node=abc123',
      detail: expect.stringMatching(/approve private HTTPS/i),
      canSetup: true,
    });
  });
  it('falls back cleanly when native system authorization is declined', async () => {
    const denied = Object.assign(new Error('Access denied'), { stderr: 'Access denied; use sudo' });
    const controller = new RemoteAccessController({
      port: () => 4173,
      platform: 'linux',
      username: 'alice',
      run: async (args) => args[0] === 'status'
        ? { stdout: JSON.stringify({ BackendState: 'NeedsLogin', Self: {} }), stderr: '' }
        : Promise.reject(denied),
      elevate: async () => { throw Object.assign(new Error('Not authorized'), { stderr: 'Not authorized' }); },
    });
    expect(await controller.setup()).toMatchObject({
      state: 'error',
      setupStage: 'authorize',
      detail: expect.stringMatching(/authorization was not completed/i),
      fallbackCommands: [
        'sudo tailscale up',
        'sudo tailscale serve --bg --yes http://127.0.0.1:4173',
      ],
      canSetup: true,
    });
  });
  it('coalesces concurrent setup requests so only one OS or Serve action runs', async () => {
    let serve = 'No serve config';
    let serveCalls = 0;
    let releaseServe!: () => void;
    const serveGate = new Promise<void>((resolve) => { releaseServe = resolve; });
    const controller = new RemoteAccessController({
      port: () => 4173,
      platform: 'linux',
      username: 'alice',
      run: async (args) => {
        if (args[0] === 'status') return {
          stdout: JSON.stringify({
            BackendState: 'Running',
            Self: { DNSName: 'host.example.ts.net.', Online: true },
          }),
          stderr: '',
        };
        if (args[0] === 'set') return { stdout: '', stderr: '' };
        if (args.join(' ') === 'serve status --json') return { stdout: serve, stderr: '' };
        if (args[0] === 'serve' && args[1] === '--bg') {
          serveCalls++;
          await serveGate;
          serve = 'https://host.example.ts.net\n|-- / proxy http://127.0.0.1:4173';
          return { stdout: 'Serve started', stderr: '' };
        }
        throw new Error(`unexpected command: ${args.join(' ')}`);
      },
    });
    const first = controller.setup();
    await expect.poll(() => serveCalls).toBe(1);
    const second = controller.setup();
    releaseServe();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ state: 'ready' }),
      expect.objectContaining({ state: 'ready' }),
    ]);
    expect(serveCalls).toBe(1);
  });
  it('runs setup in the background without taking an offline Tailscale node down', async () => {
    let online = false;
    let serve = 'No serve config';
    let releaseUp!: () => void;
    const upGate = new Promise<void>((resolve) => { releaseUp = resolve; });
    const calls: string[][] = [];
    const controller = new RemoteAccessController({
      port: () => 4173,
      platform: 'linux',
      username: 'alice',
      run: async (args) => {
        calls.push(args);
        if (args[0] === 'status') return {
          stdout: JSON.stringify({
            BackendState: 'Running',
            Self: { DNSName: 'host.example.ts.net.', Online: online },
          }),
          stderr: '',
        };
        if (args[0] === 'set') return { stdout: '', stderr: '' };
        if (args[0] === 'up') {
          await upGate;
          online = true;
          return { stdout: '', stderr: '' };
        }
        if (args.join(' ') === 'serve status --json') return { stdout: serve, stderr: '' };
        if (args[0] === 'serve' && args[1] === '--bg') {
          serve = 'https://host.example.ts.net\n|-- / proxy http://127.0.0.1:4173';
          return { stdout: 'Serve started', stderr: '' };
        }
        throw new Error(`unexpected command: ${args.join(' ')}`);
      },
    });

    expect(controller.beginSetup()).toMatchObject({
      setupInProgress: true,
      canSetup: false,
      detail: expect.stringMatching(/continue automatically/i),
    });
    await expect.poll(() => calls.some((args) => args[0] === 'up')).toBe(true);
    await expect(controller.setupStatus()).resolves.toMatchObject({ setupInProgress: true });
    releaseUp();
    await expect.poll(async () => (await controller.setupStatus()).state).toBe('ready');
    expect(calls.some((args) => args[0] === 'down')).toBe(false);
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
    const ticket: any = await (await fetch(`${base}/api/tasks/${task.id}/terminal-ticket`, {
      method: 'POST', headers: auth, body: '{}',
    })).json();
    expect(ticket.gatewayUrl).toBe(base);
    expect(ticket.expiresAt).toBeGreaterThan(Date.now());
    const wsUrl = base.replace('http', 'ws') + `/ws/terminal?taskId=${task.id}&ticket=${encodeURIComponent(ticket.ticket)}`;
    const got = await new Promise<string>((resolve) => {
      const ws = new WebSocket(wsUrl);
      let buf = '';
      let sent = false;
      const timer = setTimeout(() => { ws.close(); resolve(buf); }, 9000);
      ws.on('message', (m) => {
        try { const msg = JSON.parse(m.toString()); if (msg.type === 'data') buf += msg.data; } catch {}
        // send the command once the shell prompt has appeared
        if (!sent && buf.includes('tavya:')) { sent = true; ws.send(JSON.stringify({ type: 'input', data: 'echo TERM_OK_123\n' })); }
        if (buf.includes('TERM_OK_123\r') || /TERM_OK_123\b[\s\S]*\$/.test(buf)) { clearTimeout(timer); ws.close(); resolve(buf); }
      });
      ws.on('error', () => { clearTimeout(timer); resolve(buf); });
    });
    expect(String(got)).toContain('TERM_OK_123');
  }, 60_000);
});
