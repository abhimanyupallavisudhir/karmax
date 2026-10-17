import fs from 'node:fs';
import path from 'node:path';
import { olderVersion } from '../domain/cli-version.js';
import { cacheDir } from './config.js';

const LATEST = 'https://registry.npmjs.org/@tavya/cli/latest';
const DAY = 24 * 60 * 60 * 1000;

/** How this copy was installed, stamped by scripts/build-cli.mjs (`define` replaces the global
 * `process.env.TAVYA_PACKAGING`): `npm` (the package) or `binary` (a single executable). Unset when
 * run from a checkout, which never looks for updates. */
export const PACKAGING: string | undefined = process.env.TAVYA_PACKAGING;

/** The command that updates this copy of tavya. */
export function updateCommand(how = PACKAGING, script = process.argv[1] ?? '', platform = process.platform): string {
  if (how === 'binary') return platform === 'win32'
    ? 'download tavya-windows-x64.exe from https://github.com/abhimanyupallavisudhir/karmax/releases/latest'
    : 'curl -fsSL https://tavya.io/cli/install.sh | sh';
  // npx keeps using an installed copy over the newest one unless asked for @latest.
  return /[\\/]_npx[\\/]/.test(script) ? 'npx @tavya/cli@latest' : 'npm install -g @tavya/cli@latest';
}

/** Look for updates only where someone will read the notice: a released copy on a terminal, not --json. */
export function updateCheckWanted(argv: string[], interactive: boolean, how = PACKAGING, env: NodeJS.ProcessEnv = process.env): boolean {
  const own = argv.includes('--') ? argv.slice(0, argv.indexOf('--')) : argv;
  return Boolean(how) && !env.TAVYA_NO_UPDATE_CHECK && interactive && !own.includes('--json')
    && own[0] !== 'git-credential';
}

/**
 * The newest @tavya/cli on npm, asked at most once a day (remembered in the cache directory) while
 * the command runs. `notice()` names it when this copy is older; a slow or failed lookup is silent.
 */
export function updateCheck(current: string, options: { now?: number; fetch?: typeof fetch; timeoutMs?: number } = {}) {
  const file = path.join(cacheDir(), 'update-check.json');
  const now = options.now ?? Date.now();
  let state: { checkedAt?: number; latest?: string } = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* never checked */ }
  const fresh = typeof state.checkedAt === 'number' && state.checkedAt <= now && now - state.checkedAt < DAY;
  const latest: Promise<string | undefined> = fresh ? Promise.resolve(state.latest) : (async () => {
    let found: string | undefined;
    try {
      const response = await (options.fetch ?? fetch)(LATEST, { headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(options.timeoutMs ?? 2000) });
      const version = response.ok ? (await response.json() as { version?: unknown }).version : undefined;
      if (typeof version === 'string') found = version;
    } catch { /* offline, or npm unreachable: ask again tomorrow */ }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({ checkedAt: now, latest: found ?? state.latest })}\n`);
    } catch { /* an unwritable cache only means asking again */ }
    return found ?? state.latest;
  })();
  return {
    async notice(): Promise<string | undefined> {
      const version = await latest;
      return version && olderVersion(current, version)
        ? `tavya ${version} is available (this is ${current}). Update: ${updateCommand()}` : undefined;
    },
  };
}
