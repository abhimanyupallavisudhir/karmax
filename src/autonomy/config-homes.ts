import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from '../config/paths.js';
import { replaceFileSync } from '../util/replace-file.js';
import { DEFAULT_CDP_PORT } from './cdp-endpoint.js';
import { CUSTODY_ENV } from '../agent/custody.js';
import { Provider } from '../domain/types.js';
import { acpHomeEnv, apiKeyEnv, hasAcpHomeLogin, isAcpProvider, MODEL_PROVIDERS } from '../agent/provider-registry.js';
import type { ModelLogins } from './model-logins.js';

const DISCONNECTED_HOME = '.karmax-disconnected';

/**
 * Config homes (SPEC §7.3). karmax mints one config home per
 * (organization × account × profile)
 * and injects the right CODEX_HOME / CLAUDE_CONFIG_DIR at process spawn — the
 * official isolation mechanism for each admitted tool (auth, settings,
 * sessions, MCP).
 *
 * Gotcha (§7.3): spawn each agent with a SCRUBBED, fully isolated environment —
 * unset inherited API keys so they don't leak across profiles.
 */
export class ConfigHomeManager {
  /** `logins`: the credentials live in the vault and these homes cache them
   * (data epoch 6, `model-logins.ts`). Without it (tests, tools) the files are the login. */
  constructor(private root = paths().configHomes, readonly logins?: ModelLogins) {}

  /** Ensure (and return) the config home dir for an organization × account × provider.
   * Historical flat homes belong only to the personal organization. */
  ensure(provider: Provider, account: string, organizationId = 'org_personal'): string {
    const dir = path.join(this.organizationRoot(organizationId), `${provider}-${sanitize(account)}`);
    // Provider CLIs write OAuth tokens here at their own default modes; the
    // directory itself is what keeps other local users out.
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* not the owner; leave it */ }
    return dir;
  }

  /** Only an explicit login attempt reactivates a disconnected home. Status
   * polling also calls ensure(), and must not make a removed account reappear. */
  prepareLogin(provider: Provider, account: string, organizationId = 'org_personal'): string {
    const dir = this.ensure(provider, account, organizationId);
    fs.rmSync(path.join(dir, DISCONNECTED_HOME), { force: true });
    return dir;
  }

  /** Disconnect credentials, not the task histories sharing this home. Tasks keep
   * absolute sessionmeta.home references, so retained history must stay in place.
   * Account discovery hides this history-only home until an explicit reconnect. */
  async remove(provider: Provider, account: string, organizationId = 'org_personal'): Promise<void> {
    const dir = path.join(this.organizationRoot(organizationId), `${provider}-${sanitize(account)}`);
    // The credential first: a cache pruned while the vault still held it would come back.
    await this.logins?.forget(dir);
    if (!fs.existsSync(dir)) return;
    if (!fs.lstatSync(dir).isDirectory()) {
      fs.rmSync(dir, { force: true });
      return;
    }
    const history = provider === 'codex'
      ? ['sessions', 'archived_sessions', '.karmax-history-recovery', '.karmax-history-backups']
      : provider === 'claude' ? ['projects']
      : provider === 'opencode' ? ['data/opencode'] : [];
    if (!history.length) {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    }
    // Mark before pruning so an interrupted disconnect cannot re-admit a login.
    // An account home is provider-writable; never follow a pre-existing marker symlink.
    fs.rmSync(path.join(dir, DISCONNECTED_HOME), { force: true });
    fs.writeFileSync(path.join(dir, DISCONNECTED_HOME), '', { mode: 0o600 });
    const prune = (relative: string) => {
      for (const entry of fs.readdirSync(path.join(dir, relative), { withFileTypes: true })) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (name === DISCONNECTED_HOME) continue;
        // OpenCode stores its credential alongside the native database/storage.
        const credential = name === 'data/opencode/auth.json';
        const retained = !credential && history.some(prefix => name === prefix || name.startsWith(`${prefix}/`));
        const ancestor = history.some(prefix => prefix.startsWith(`${name}/`));
        if (entry.isDirectory() && (retained || ancestor)) prune(name);
        else if (!retained || entry.isSymbolicLink())
          fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      }
    };
    prune('');
  }

  /** Rename a login (move its config home so credentials carry over). */
  async rename(provider: Provider, from: string, to: string, organizationId = 'org_personal'): Promise<string> {
    const root = this.organizationRoot(organizationId);
    const src = path.join(root, `${provider}-${sanitize(from)}`);
    const dst = path.join(root, `${provider}-${sanitize(to)}`);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      await this.logins?.rename(src, dst);
      fs.renameSync(src, dst);
    } else fs.mkdirSync(dst, { recursive: true });
    return dst;
  }

  list(organizationId = 'org_personal'): { provider: string; account: string; path: string; loggedIn: boolean; modelProvider?: string }[] {
    const root = this.organizationRoot(organizationId);
    return readHomesDirectory(root)
      .filter((entry) => entry.isDirectory() && !(organizationId === 'org_personal' && entry.name === 'organizations'))
      .filter((entry) => !fs.existsSync(path.join(root, entry.name, DISCONNECTED_HOME)))
      .map(({ name }) => {
      const [provider, ...rest] = name.split('-');
      const dir = path.join(root, name);
      const modelProvider = provider === 'opencode' ? this.modelProvider(dir) : undefined;
      return {
        provider: provider ?? '',
        account: rest.join('-'),
        path: dir,
        loggedIn: isLoggedIn(provider ?? '', dir),
        ...(modelProvider ? { modelProvider } : {}),
      };
      });
  }

  /** Persist the vendor selected by an OpenCode subscription login. */
  setModelProvider(home: string, modelProvider: string): void {
    replaceFileSync(path.join(home, KARMAX_LOGIN_META_FILE), JSON.stringify({ modelProvider }));
  }

  /** Read Karmax metadata, falling back to a single provider in old auth.json files. */
  modelProvider(home: string): string | undefined {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(home, KARMAX_LOGIN_META_FILE), 'utf8')).modelProvider;
      if (typeof value === 'string' && value) return value;
    } catch {
      /* historical login without Karmax metadata */
    }
    return openCodeAuthProvider(path.join(home, 'data', 'opencode', 'auth.json'));
  }

  /** Every managed login, for the host-wide lease coordinator. Ambient homes and
   * environment keys are intentionally not included here: those legacy host
   * credentials belong only to org_personal. */
  listAll(organizationIds: string[]): Array<{ organizationId: string; provider: string; account: string; path: string; loggedIn: boolean; modelProvider?: string }> {
    return organizationIds.flatMap((organizationId) =>
      this.list(organizationId).map((login) => ({ organizationId, ...login })),
    );
  }

  async removeOrganization(organizationId: string): Promise<void> {
    if (organizationId === 'org_personal') throw new Error('cannot remove the personal organization config-home namespace');
    await this.logins?.forgetOrganization(organizationId);
    fs.rmSync(this.organizationRoot(organizationId), { recursive: true, force: true });
  }

  /** Bring a home's cached credential up to date with the vault before it is
   * used, and a change a CLI made here into the vault (data epoch 6). */
  async sync(home: string): Promise<void> {
    await this.logins?.sync(home);
  }

  /**
   * Write a baseline `mcpServers` set into a config home (SPEC §7.5/§7.3) — a
   * browser MCP for automation plus the karmax platform MCP — so every agent on
   * this profile inherits the tool set. Claude reads `.claude.json`; Codex reads
   * `config.toml [mcp_servers]`. Merges with any existing config.
   */
  writeMcpConfig(home: string, provider: Provider, spec: McpBaseline): void {
    const servers = mcpServerMap(spec);
    if (provider === 'claude') {
      const file = path.join(home, '.claude.json');
      const cur = readJson(file);
      cur.mcpServers = {
        ...(cur.mcpServers ?? {}),
        ...Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, claudeMcpServer(server)])),
      };
      replaceFileSync(file, JSON.stringify(cur, null, 2));
    } else if (provider === 'codex') {
      // Minimal TOML for [mcp_servers.<name>] (command + args + env).
      const file = path.join(home, 'config.toml');
      const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      // Account connect can run more than once for an existing home. Replace the
      // tables karmax owns instead of appending duplicate TOML table declarations.
      const preserved = removeTomlTables(existing, [
        'mcp_servers.chrome-devtools',
        'mcp_servers.playwright',
        'mcp_servers.karmax',
      ]);
      const toml = Object.entries(servers).map(([name, server]) => codexMcpServer(name, server)).join('');
      replaceFileSync(file, preserved.trimEnd() + toml);
    }
    // ACP transports receive MCP servers in session/new and session/load.
    // Keeping them out of provider-specific files avoids duplicate servers.
  }

  /**
   * Refresh karmax's managed MCPs in every existing config home.
   *
   * Account homes outlive application versions, so limiting MCP configuration to
   * the one-time login flow strands old launch commands forever. This upgrades
   * both the platform bridge and any already-selected browser: notably, bare
   * `chrome-devtools-mcp` launches Chrome over a private pipe that zero-exposure
   * credential fill cannot reach, while the current launcher exposes the guarded
   * loopback CDP endpoint. Browser MCPs are never added to profiles that did not
   * already select one, and unrelated user servers are preserved.
   */
  refreshManagedMcp(gatewayUrl: string): void {
    const platform = platformMcpSpec(gatewayUrl);
    const managedBrowsers = mcpServerMap({ browser: 'chrome-devtools' });
    Object.assign(managedBrowsers, mcpServerMap({ browser: 'playwright' }));
    for (const { provider, path: home } of this.allHomes()) {
      if (provider === 'claude') {
        const file = path.join(home, '.claude.json');
        const cur = readJson(file);
        const existing = cur.mcpServers ?? {};
        const refreshed = Object.fromEntries(
          Object.entries(managedBrowsers)
            .filter(([name]) => existing[name])
            .map(([name, server]) => [name, claudeMcpServer(server)]),
        );
        cur.mcpServers = { ...existing, ...refreshed, karmax: claudeMcpServer(platform) };
        const updated = JSON.stringify(cur, null, 2);
        if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== updated) replaceFileSync(file, updated);
      } else if (provider === 'codex') {
        const file = path.join(home, 'config.toml');
        const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        const selectedBrowsers = Object.entries(managedBrowsers)
          .filter(([name]) => new RegExp(`^\\s*\\[mcp_servers\\.${name}]\\s*$`, 'm').test(existing));
        const preserved = removeTomlTables(existing, [
          'mcp_servers.karmax',
          ...selectedBrowsers.map(([name]) => `mcp_servers.${name}`),
        ]);
        const browserToml = selectedBrowsers.map(([name, server]) => codexMcpServer(name, server)).join('');
        const updated = preserved.trimEnd() + browserToml + codexMcpServer('karmax', platform);
        if (existing !== updated) replaceFileSync(file, updated);
      }
    }
  }

  private organizationRoot(organizationId: string): string {
    // Existing installations stored personal homes directly under config-homes.
    // Keeping that path is the migration: no credentials move, and no other
    // organization ever enumerates the directory.
    return organizationId === 'org_personal'
      ? this.root
      : path.join(this.root, 'organizations', sanitize(organizationId));
  }

  allHomes(): Array<{ provider: string; path: string }> {
    if (!fs.existsSync(this.root)) return [];
    const homes = this.list().map(({ provider, path: home }) => ({ provider, path: home }));
    const organizations = path.join(this.root, 'organizations');
    if (!fs.existsSync(organizations)) return homes;
    for (const org of readHomesDirectory(organizations).filter((entry) => entry.isDirectory())) {
      for (const { provider, path: home } of this.list(org.name)) homes.push({ provider, path: home });
    }
    return homes;
  }
}

function readHomesDirectory(directory: string) {
  try { return fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) {
    // A primary may remove an organization while the execution process is
    // discovering accounts. Missing homes mean no available credentials.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function claudeMcpServer(server: McpServerSpec): Omit<McpServerSpec, 'forwardEnv'> {
  const { forwardEnv: _forwardEnv, ...config } = server;
  return config;
}

function codexMcpServer(name: string, server: McpServerSpec): string {
  const envLines = server.env ? Object.entries(server.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join('\n') : '';
  const forwarded = server.forwardEnv?.length ? `env_vars = ${JSON.stringify(server.forwardEnv)}\n` : '';
  return `\n[mcp_servers.${name}]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\n${forwarded}${server.env ? `\n[mcp_servers.${name}.env]\n${envLines}\n` : ''}`;
}

/** Remove TOML tables (and their child tables) while leaving all other text intact. */
function removeTomlTables(source: string, tables: string[]): string {
  if (tables.length === 0) return source;
  let remove = false;
  return source
    .split(/(?<=\n)/)
    .filter((line) => {
      const header = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?(?:\r?\n)?$/);
      if (header) {
        const table = header[1]!.trim();
        remove = tables.some((owned) => table === owned || table.startsWith(`${owned}.`));
      }
      return !remove;
    })
    .join('');
}

export type BrowserMcp = 'chrome-devtools' | 'playwright' | 'none';
export interface McpServerSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Parent-process variables Codex must explicitly allow into the MCP child. */
  forwardEnv?: string[];
}
export interface McpBaseline {
  browser?: BrowserMcp;
  /** karmax platform MCP (SPEC §3.4) — a stdio bridge to the gateway. */
  platform?: McpServerSpec;
}

export const CHROME_DEVTOOLS_MCP_VERSION = '1.6.0';
export const PLAYWRIGHT_MCP_VERSION = '0.0.78';
export const PLAYWRIGHT_VERSION = '1.61.1';

/** Resolve a baseline spec to concrete stdio MCP server commands. */
export function mcpServerMap(spec: McpBaseline): Record<string, McpServerSpec> {
  const out: Record<string, McpServerSpec> = {};
  if (spec.browser === 'chrome-devtools') {
    // Run chrome-devtools-mcp through karmax's launcher so it drives a Chrome
    // that also exposes a loopback DevTools port — the same port host-side
    // fill_credential types into (wiki plans/PLAN-passwords §5B). Bare
    // `chrome-devtools-mcp` uses a pipe with no HTTP endpoint, so the fill
    // could never reach the agent's browser. The launcher falls back to plain
    // pipe mode if Chrome is unavailable, so browser tools never regress.
    const launcher = fileURLToPath(new URL('./chrome-cdp-launcher.mjs', import.meta.url));
    out['chrome-devtools'] = {
      command: process.execPath,
      args: [launcher],
      env: { KARMAX_CDP_MCP_VERSION: CHROME_DEVTOOLS_MCP_VERSION, KARMAX_CDP_PORT: String(DEFAULT_CDP_PORT) },
      // The custody marker is how a fill finds this task's browser (task-browser.ts);
      // Codex passes an MCP server only the variables it is told to.
      forwardEnv: [CUSTODY_ENV],
    };
  } else if (spec.browser === 'playwright') out['playwright'] = { command: 'npx', args: ['-y', `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`] };
  if (spec.platform) out['karmax'] = spec.platform;
  return out;
}

/**
 * The karmax platform MCP server entry for a config home (SPEC §3.4). Points at
 * the stdio entrypoint and carries only the gateway URL. Karmax injects a
 * short-lived KARMAX_TOKEN for each actual turn; the bridge never borrows a
 * human's Better Auth cookie or silently upgrades itself to a browser session.
 */
export function platformMcpSpec(gatewayUrl: string): McpServerSpec {
  const entry = fileURLToPath(new URL('../mcp/stdio.ts', import.meta.url));
  // Launch through karmax's own tsx loader. `npx tsx` resolves from the agent's
  // worktree and expands into npm -> shell -> tsx CLI -> Node; if any wrapper is
  // killed, Codex reports only "Stream closed". This is one process, starts
  // faster, and is independent of the task world's node_modules.
  const loader = import.meta.resolve('tsx');
  return {
    command: process.execPath,
    args: ['--import', loader, entry],
    env: { KARMAX_GATEWAY_URL: gatewayUrl },
    // Codex intentionally does not inherit arbitrary parent env vars into stdio
    // MCP servers. The token is short-lived and task-scoped; explicitly forward
    // that one value instead of persisting it in the durable config home.
    forwardEnv: ['KARMAX_TOKEN'],
  };
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/** Is a config home logged in? Checks the provider's own credential file and the
 *  karmax token file we write when a `setup-token` flow prints a token. */
export function isLoggedIn(provider: string, home: string): boolean {
  if (fs.existsSync(path.join(home, DISCONNECTED_HOME))) return false;
  if (isAcpProvider(provider) && hasAcpHomeLogin(provider, home)) return true;
  if (provider === 'claude') {
    return hasClaudeNativeCredential(home) || !!capturedToken(home);
  }
  const candidates = provider === 'codex' ? ['auth.json', KARMAX_TOKEN_FILE] : [KARMAX_TOKEN_FILE];
  return candidates.some((f) => fs.existsSync(path.join(home, f)));
}

/** Where we persist a captured OAuth/setup token for a home. */
export const KARMAX_TOKEN_FILE = 'karmax-oauth.json';
export const KARMAX_LOGIN_META_FILE = 'karmax-login.json';

/** Infer a single model vendor from OpenCode's documented auth.json map. */
export function openCodeAuthProvider(authFile: string): string | undefined {
  try {
    const auth = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    const known = new Set<string>([...MODEL_PROVIDERS, 'claude', 'codex', 'grok']);
    const providers = Object.keys(auth).filter((key) => known.has(key));
    return providers.length === 1 ? providers[0] : undefined;
  } catch {
    return undefined;
  }
}

/** Read a captured token for a home (used to inject into the agent env). */
export function capturedToken(home: string): string | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, KARMAX_TOKEN_FILE), 'utf8')).token;
  } catch {
    return undefined;
  }
}

/** Is the home authenticated with a FULL native credential — `.credentials.json`
 *  from `claude auth login` (claude) / `auth.json` from `codex login` (codex)?
 *  A setup-token-only home (just `karmax-oauth.json`) is NOT fully authed, so
 *  `connect` re-runs login to upgrade it to a full, usage-pollable credential (#6). */
export function isFullyAuthed(provider: string, home: string): boolean {
  if (fs.existsSync(path.join(home, DISCONNECTED_HOME))) return false;
  if (isAcpProvider(provider)) return hasAcpHomeLogin(provider, home);
  if (provider === 'claude') return hasClaudeNativeCredential(home);
  const native = provider === 'codex'
    ? ['auth.json']
    : [];
  return native.some((f) => fs.existsSync(path.join(home, f)));
}

/** The captured setup-token to inject as CLAUDE_CODE_OAUTH_TOKEN — UNLESS the home
 *  already holds a full native `.credentials.json`. The setup-token is restricted
 *  (can't read usage, RESOLVE-PLAN #6) and would shadow the full login, so prefer
 *  the native credential (the Agent SDK reads it directly). */
export function tokenToInject(home: string): string | undefined {
  return hasClaudeNativeCredential(home) ? undefined : capturedToken(home);
}

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_.-]/g, '-');

/** Read Claude's current native OAuth access token. This is intentionally narrower
 * than hasClaudeNativeCredential(): a refresh-token-only home remains logged in,
 * but cannot make a provider metadata request until Claude Code refreshes it. */
export function claudeAccessToken(home: string): string | undefined {
  for (const rel of ['.credentials.json', '.claude/.credentials.json']) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(home, rel), 'utf8'))?.claudeAiOauth?.accessToken;
      if (typeof value === 'string' && value.length > 0) return value;
    } catch {
      /* try the other native credential location */
    }
  }
  return undefined;
}

/** Recorded expiry of Claude's native OAuth access token, when present. Kept
 * separate from claudeAccessToken() so callers never need the refresh-bearing
 * credential object just to validate an access-token refresh. */
export function claudeAccessTokenExpiresAt(home: string): number | undefined {
  for (const rel of ['.credentials.json', '.claude/.credentials.json']) {
    try {
      const value = Number(JSON.parse(fs.readFileSync(path.join(home, rel), 'utf8'))?.claudeAiOauth?.expiresAt);
      if (Number.isFinite(value) && value > 0) return value;
    } catch {
      /* try the other native credential location */
    }
  }
  return undefined;
}

/** When a Claude login's sign-in itself expires. The refresh token has a fixed
 * lifetime (about four weeks from sign-in, not extended by refreshes); after it
 * Anthropic signs the login out and only signing in again restores it. */
export function claudeSignInExpiresAt(home: string): number | undefined {
  const state = claudeSignIn(home);
  return state && !state.signedOut ? state.expiresAt : undefined;
}

/** A Claude login that has ever signed in: when its sign-in lapses (or lapsed),
 * and whether Anthropic has already signed it out (Claude Code blanks the tokens
 * but keeps the rest of the record). A home that never signed in has no record. */
export function claudeSignIn(home: string): { signedOut: boolean; expiresAt: number } | undefined {
  for (const rel of ['.credentials.json', '.claude/.credentials.json']) {
    try {
      const oauth = JSON.parse(fs.readFileSync(path.join(home, rel), 'utf8'))?.claudeAiOauth;
      const expiresAt = Number(oauth?.refreshTokenExpiresAt);
      if (!oauth || !Number.isFinite(expiresAt) || expiresAt <= 0) continue;
      const token = (value: unknown) => typeof value === 'string' && value.length > 0;
      return { signedOut: !token(oauth.accessToken) && !token(oauth.refreshToken), expiresAt };
    } catch {
      /* try the other native credential location */
    }
  }
  return undefined;
}

/** Claude leaves a structurally valid but empty `.credentials.json` behind after
 * logout. File existence alone therefore makes a logged-out account look connected
 * and prevents Connect from launching OAuth again. A refresh token remains useful
 * after an access token expires, so either non-empty token is sufficient here. */
export function hasClaudeNativeCredential(home: string): boolean {
  for (const rel of ['.credentials.json', '.claude/.credentials.json']) {
    try {
      const oauth = JSON.parse(fs.readFileSync(path.join(home, rel), 'utf8'))?.claudeAiOauth;
      if (
        (typeof oauth?.accessToken === 'string' && oauth.accessToken.length > 0)
        || (typeof oauth?.refreshToken === 'string' && oauth.refreshToken.length > 0)
      ) return true;
    } catch {
      /* missing, malformed, or logged-out placeholder */
    }
  }
  return false;
}

/** Names the control plane must never hand to an agent subprocess: every
 *  `KARMAX_*` variable except the few an agent legitimately reads (its gateway
 *  address, the runtime protocol, provider command overrides), plus any
 *  secret-shaped name from another service (Stripe, sandbox providers, cloud
 *  credentials, GitHub tokens). The `*_FILE` indirections are stripped with
 *  their targets so the path to a mounted secret does not leak either. */
const AGENT_VISIBLE_KARMAX_ENV = new Set([
  'KARMAX_GATEWAY_URL', 'KARMAX_PUBLIC_URL', 'KARMAX_TOKEN', 'KARMAX_RUNTIME_PROTOCOL',
  'KARMAX_CUSTODY_CHAIN', 'KARMAX_HOME', 'KARMAX_DEPLOYMENT', 'KARMAX_HOST_LOCAL', 'KARMAX_CELL_ID',
  'KARMAX_ANTHROPIC_BASE_URL', 'KARMAX_OPENAI_BASE_URL', 'KARMAX_KIMI_BASE_URL',
  'KARMAX_CODEX_USE_EXEC', 'KARMAX_CODEX_EXEC_CMD', 'KARMAX_OPENCODE_CMD', 'KARMAX_KIMI_CMD', 'KARMAX_GROK_CMD',
  'KARMAX_AGENT_BG_SETTLE_MS', 'KARMAX_CLAUDE_MODEL', 'KARMAX_OPENAI_MODEL', 'KARMAX_AGENT_PROVIDER',
]);
const FOREIGN_SECRET_ENV = /^(?:STRIPE_|E2B_|DAYTONA_|AWS_(?:SECRET|SESSION|ACCESS)|GH_TOKEN$|GITHUB_TOKEN$|GITHUB_APP_|NPM_TOKEN$|VAULT_TOKEN$|OP_SERVICE_ACCOUNT_TOKEN$|BW_SESSION$)/;
export function isControlPlaneSecretEnv(key: string): boolean {
  const base = key.endsWith('_FILE') ? key.slice(0, -5) : key;
  if (base.startsWith('KARMAX_')) return !AGENT_VISIBLE_KARMAX_ENV.has(base);
  return FOREIGN_SECRET_ENV.test(base);
}

/** Build a clean, isolated environment for an agent spawn (SPEC §7.3 gotcha). */
export function scrubbedEnv(opts: { provider: Provider; configHome?: string; extra?: Record<string, string> }): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  // Provider package entrypoints use `#!/usr/bin/env node`, so they need the
  // running app's Node directory even when a service manager supplied only a
  // system PATH. Native user installs (notably Claude Code's installer) also
  // live in ~/.local/bin. Keep both available to login, model-discovery, usage,
  // and agent subprocesses without depending on the shell that launched Krmax.
  const nodeBin = path.dirname(process.execPath);
  const userBin = path.join(os.homedir(), '.local', 'bin');
  const pathEntries = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  env.PATH = [userBin, nodeBin, ...pathEntries.filter((entry) => entry !== nodeBin && entry !== userBin)].join(path.delimiter);
  // Never let one profile's keys leak into another's process.
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.CODEX_ACCESS_TOKEN;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.KIMI_MODEL_API_KEY;
  delete env.KIMI_MODEL_NAME;
  delete env.KIMI_MODEL_BASE_URL;
  for (const provider of MODEL_PROVIDERS) delete env[apiKeyEnv(provider)];
  // Nor the control plane's own secrets: the agent runs untrusted code, and the
  // vault key, auth secret, database URL, provider and billing keys all live in
  // this process's environment (deployment.ts hydrates them from *_FILE too).
  // Remote worlds cross an allowlist (remote-process.ts); local worlds inherit
  // the host shell, so strip by name and by shape.
  for (const key of Object.keys(env)) if (isControlPlaneSecretEnv(key)) delete env[key];
  if (opts.configHome) {
    if (opts.provider === 'claude') env.CLAUDE_CONFIG_DIR = opts.configHome;
    if (opts.provider === 'codex') env.CODEX_HOME = opts.configHome;
    if (isAcpProvider(opts.provider)) Object.assign(env, acpHomeEnv(opts.provider, opts.configHome));
  }
  return { ...env, ...(opts.extra ?? {}) };
}
