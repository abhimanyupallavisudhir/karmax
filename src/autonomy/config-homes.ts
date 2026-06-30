import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config/paths.js';
import { Provider } from '../domain/types.js';

/**
 * Config homes (SPEC §7.3). karmax mints one config home per (account × profile)
 * and injects the right CODEX_HOME / CLAUDE_CONFIG_DIR at process spawn — the
 * official isolation mechanism for both tools (auth, settings, sessions, MCP).
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
      cur.mcpServers = { ...(cur.mcpServers ?? {}), ...servers };
      fs.writeFileSync(file, JSON.stringify(cur, null, 2));
    } else if (provider === 'codex') {
      // Minimal TOML for [mcp_servers.<name>] (command + args).
      const file = path.join(home, 'config.toml');
      const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      const toml = Object.entries(servers)
        .map(([name, s]) => `\n[mcp_servers.${name}]\ncommand = ${JSON.stringify(s.command)}\nargs = ${JSON.stringify(s.args)}\n`)
        .join('');
      fs.writeFileSync(file, existing + toml);
    }
  }
}

export type BrowserMcp = 'chrome-devtools' | 'playwright' | 'none';
export interface McpBaseline {
  browser?: BrowserMcp;
  /** karmax platform MCP as a stdio bridge: { command, args } (optional). */
  platform?: { command: string; args: string[] };
}

/** Resolve a baseline spec to concrete stdio MCP server commands. */
export function mcpServerMap(spec: McpBaseline): Record<string, { command: string; args: string[] }> {
  const out: Record<string, { command: string; args: string[] }> = {};
  if (spec.browser === 'chrome-devtools') out['chrome-devtools'] = { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] };
  else if (spec.browser === 'playwright') out['playwright'] = { command: 'npx', args: ['-y', '@playwright/mcp@latest'] };
  if (spec.platform) out['karmax'] = spec.platform;
  return out;
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/** Is a config home logged in (has a provider credentials file)? */
export function isLoggedIn(provider: string, home: string): boolean {
  const candidates = provider === 'codex' ? ['auth.json'] : ['.credentials.json'];
  return candidates.some((f) => fs.existsSync(path.join(home, f)));
}

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_.-]/g, '-');

/** Build a clean, isolated environment for an agent spawn (SPEC §7.3 gotcha). */
export function scrubbedEnv(opts: { provider: Provider; configHome?: string; extra?: Record<string, string> }): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  // Never let one profile's keys leak into another's process.
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  if (opts.configHome) {
    if (opts.provider === 'claude') env.CLAUDE_CONFIG_DIR = opts.configHome;
    if (opts.provider === 'codex') env.CODEX_HOME = opts.configHome;
  }
  return { ...env, ...(opts.extra ?? {}) };
}
