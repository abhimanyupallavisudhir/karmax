import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from '../config/paths.js';
import { Provider } from '../domain/types.js';
import { acpHomeEnv, apiKeyEnv, hasAcpHomeLogin, isAcpProvider, MODEL_PROVIDERS } from '../agent/provider-registry.js';

/**
 * Config homes (SPEC §7.3). karmax mints one config home per (account × profile)
 * and injects the right CODEX_HOME / CLAUDE_CONFIG_DIR at process spawn — the
 * official isolation mechanism for each admitted tool (auth, settings,
 * sessions, MCP).
 *
 * Gotcha (§7.3): spawn each agent with a SCRUBBED, fully isolated environment —
 * unset inherited API keys so they don't leak across profiles.
 */
export class ConfigHomeManager {
  constructor(private root = paths().configHomes) {}

  /** Ensure (and return) the config home dir for an account × provider. */
  ensure(provider: Provider, account: string): string {
    const dir = path.join(this.root, `${provider}-${sanitize(account)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Delete a login's config home (removes its credentials + settings). */
  remove(provider: Provider, account: string): void {
    const dir = path.join(this.root, `${provider}-${sanitize(account)}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /** Rename a login (move its config home so credentials carry over). */
  rename(provider: Provider, from: string, to: string): string {
    const src = path.join(this.root, `${provider}-${sanitize(from)}`);
    const dst = path.join(this.root, `${provider}-${sanitize(to)}`);
    if (fs.existsSync(src) && !fs.existsSync(dst)) fs.renameSync(src, dst);
    else fs.mkdirSync(dst, { recursive: true });
    return dst;
  }

  list(): { provider: string; account: string; path: string; loggedIn: boolean }[] {
    if (!fs.existsSync(this.root)) return [];
    return fs.readdirSync(this.root).map((name) => {
      const [provider, ...rest] = name.split('-');
      const dir = path.join(this.root, name);
      return { provider: provider ?? '', account: rest.join('-'), path: dir, loggedIn: isLoggedIn(provider ?? '', dir) };
    });
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
      fs.writeFileSync(file, JSON.stringify(cur, null, 2));
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
      fs.writeFileSync(file, preserved.trimEnd() + toml);
    }
    // ACP transports receive MCP servers in session/new and session/load.
    // Keeping them out of provider-specific files avoids duplicate servers.
  }

  /**
   * Refresh only karmax's platform bridge in every existing config home.
   *
   * Account homes outlive application versions, so limiting MCP configuration to
   * the one-time login flow strands old launch commands forever. In particular,
   * the historical `npx tsx` bridge depended on the agent's current worktree and
   * did not ask Codex to forward the per-turn KARMAX_TOKEN. Refreshing at boot
   * upgrades those durable homes while preserving their browser and user servers.
   */
  refreshPlatformMcp(gatewayUrl: string): void {
    const platform = platformMcpSpec(gatewayUrl);
    for (const { provider, path: home } of this.list()) {
      if (provider === 'claude') {
        const file = path.join(home, '.claude.json');
        const cur = readJson(file);
        cur.mcpServers = { ...(cur.mcpServers ?? {}), karmax: claudeMcpServer(platform) };
        fs.writeFileSync(file, JSON.stringify(cur, null, 2));
      } else if (provider === 'codex') {
        const file = path.join(home, 'config.toml');
        const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        const preserved = removeTomlTables(existing, ['mcp_servers.karmax']);
        fs.writeFileSync(file, preserved.trimEnd() + codexMcpServer('karmax', platform));
      }
    }
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
  if (spec.browser === 'chrome-devtools') out['chrome-devtools'] = { command: 'npx', args: ['-y', `chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}`] };
  else if (spec.browser === 'playwright') out['playwright'] = { command: 'npx', args: ['-y', `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`] };
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
  if (isAcpProvider(provider) && hasAcpHomeLogin(provider, home)) return true;
  const candidates = provider === 'codex'
    ? ['auth.json', KARMAX_TOKEN_FILE]
    : provider === 'claude'
      ? ['.credentials.json', '.claude/.credentials.json', KARMAX_TOKEN_FILE]
      : [KARMAX_TOKEN_FILE];
  return candidates.some((f) => fs.existsSync(path.join(home, f)));
}

/** Where we persist a captured OAuth/setup token for a home. */
export const KARMAX_TOKEN_FILE = 'karmax-oauth.json';

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
  if (isAcpProvider(provider)) return hasAcpHomeLogin(provider, home);
  const native = provider === 'codex'
    ? ['auth.json']
    : provider === 'claude'
      ? ['.credentials.json', '.claude/.credentials.json']
      : [];
  return native.some((f) => fs.existsSync(path.join(home, f)));
}

/** The captured setup-token to inject as CLAUDE_CODE_OAUTH_TOKEN — UNLESS the home
 *  already holds a full native `.credentials.json`. The setup-token is restricted
 *  (can't read usage, RESOLVE-PLAN #6) and would shadow the full login, so prefer
 *  the native credential (the Agent SDK reads it directly). */
export function tokenToInject(home: string): string | undefined {
  return fs.existsSync(path.join(home, '.credentials.json')) ? undefined : capturedToken(home);
}

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_.-]/g, '-');

/** Build a clean, isolated environment for an agent spawn (SPEC §7.3 gotcha). */
export function scrubbedEnv(opts: { provider: Provider; configHome?: string; extra?: Record<string, string> }): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  // Never let one profile's keys leak into another's process.
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.KIMI_MODEL_API_KEY;
  delete env.KIMI_MODEL_NAME;
  delete env.KIMI_MODEL_BASE_URL;
  for (const provider of MODEL_PROVIDERS) delete env[apiKeyEnv(provider)];
  if (opts.configHome) {
    if (opts.provider === 'claude') env.CLAUDE_CONFIG_DIR = opts.configHome;
    if (opts.provider === 'codex') env.CODEX_HOME = opts.configHome;
    if (isAcpProvider(opts.provider)) Object.assign(env, acpHomeEnv(opts.provider, opts.configHome));
  }
  return { ...env, ...(opts.extra ?? {}) };
}
