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

  list(): { provider: string; account: string; path: string }[] {
    if (!fs.existsSync(this.root)) return [];
    return fs.readdirSync(this.root).map((name) => {
      const [provider, ...rest] = name.split('-');
      return { provider: provider ?? '', account: rest.join('-'), path: path.join(this.root, name) };
    });
  }
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
