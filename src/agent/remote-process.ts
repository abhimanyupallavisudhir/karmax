import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { Provider } from '../domain/types.js';
import type { World, WorldPty } from '../world/types.js';
import { CHROME_DEVTOOLS_MCP_VERSION, PLAYWRIGHT_MCP_VERSION, PLAYWRIGHT_VERSION } from '../autonomy/config-homes.js';

// CheckpointService already excludes this injection surface. Keep it under the
// world root only because every remote provider exposes that portable write API.
const REMOTE_ROOT = '.karmax-injection/agent';
const CLAUDE_PACKAGE = process.env.KARMAX_REMOTE_CLAUDE_PACKAGE ?? '@anthropic-ai/claude-code@2.1.212';
const CODEX_PACKAGE = process.env.KARMAX_REMOTE_CODEX_PACKAGE ?? '@openai/codex@0.144.5';
const READY = '\u001eKARMAX_AGENT_READY\u001e';

/** A V2 provider world is the execution boundary: native agent subprocesses must
 * run there, not on the control-plane host against a virtual cwd. */
export function isRemoteAgentWorld(world: World): boolean {
  return world.handle.version === 2 && Boolean(world.handle.sealedProviderRef);
}

export interface RemoteAgentHome {
  absolute: string;
  relative: string;
  /** Browser entries rewritten to sandbox-local, pinned executables. */
  browserMcp?: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
}

/** Seed the leased subscription credentials/config into this task's persistent
 * sandbox. Provider session/cache directories are deliberately left sandbox-
 * local; files are copied non-destructively, so remote sessions survive turns. */
export async function seedRemoteAgentHome(world: World, provider: Provider, localHome: string,
  session?: string): Promise<RemoteAgentHome> {
  if (!localHome) throw new Error(`${provider} subscription has no config home to seed`);
  const relative = `${REMOTE_ROOT}/${provider}`;
  const absolute = path.posix.join(world.handle.root, relative);
  // A single-repo world's root is itself a checkout. Keep injected auth out of
  // `git add -A` without modifying the user's tracked .gitignore.
  await world.exec('bash', ['-lc', "exclude=$(git rev-parse --git-path info/exclude 2>/dev/null) && mkdir -p \"$(dirname \"$exclude\")\" && { grep -qxF '.karmax-injection/' \"$exclude\" 2>/dev/null || printf '%s\\n' '.karmax-injection/' >> \"$exclude\"; } || true"]);
  const existing = await remoteHomeFiles(world, absolute);
  for (const file of configFiles(localHome, provider, session)) {
    const target = `${relative}/${file.relative.split(path.sep).join('/')}`;
    if (!world.writeFileBuffer) throw new Error('remote world cannot receive subscription config files');
    // Provider CLIs refresh OAuth state in-place. Never replace a sandbox copy
    // with the older control-plane copy on a later turn.
    if (!existing.has(target)) await world.writeFileBuffer(target, file.content);
  }
  const home = { absolute, relative };
  const browser = configuredBrowser(localHome, provider);
  const browserMcp = browser ? await ensureRemoteBrowser(world, browser) : undefined;
  if (provider === 'codex') await seedRemotePlatformMcp(world, localHome, home, browserMcp);
  const permissions = await world.exec('bash', ['-lc',
    `if [ -d ${quote(absolute)} ]; then find ${quote(absolute)} -type d -exec chmod 700 {} + && find ${quote(absolute)} -type f -exec chmod 600 {} +; fi`]);
  if (permissions.code !== 0) throw new Error(`could not protect remote subscription files: ${permissions.stderr || permissions.stdout}`);
  return { ...home, ...(browserMcp ? { browserMcp } : {}) };
}

/** Minimal environment passed across the trust boundary. Authentication lives in
 * the seeded home; only explicit turn-scoped values and provider tuning cross. */
export function remoteAgentEnv(provider: Provider, home: string, source: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {
    ...(provider === 'claude' ? { CLAUDE_CONFIG_DIR: home } : { CODEX_HOME: home }),
  };
  for (const key of [
    'KARMAX_TOKEN', 'KARMAX_GATEWAY_URL', 'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  ]) {
    const value = source[key];
    if (value) out[key] = value;
  }
  return out;
}

/** Translate the host SDK's bundled executable into the matching published CLI
 * package. npx caches it in the sandbox after the first turn. */
export function remoteAgentCommand(provider: Provider, command: string, args: string[]): { command: string; args: string[] } {
  if (provider === 'claude') {
    const forwarded = path.basename(command).startsWith('node') && /(?:^|\/)cli\.js$/.test(args[0] ?? '') ? args.slice(1) : args;
    return { command: 'npx', args: ['--yes', CLAUDE_PACKAGE, ...forwarded] };
  }
  return { command: 'npx', args: ['--yes', CODEX_PACKAGE, ...args] };
}

/** ChildProcess-shaped bridge backed by the provider's bidirectional PTY. This is
 * the process abstraction both the Claude Agent SDK custom-spawn hook and Codex
 * app-server need. stderr is redirected away from the JSON protocol stream. */
export function spawnRemoteAgentProcess(opts: {
  world: World;
  provider: Provider;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  signal?: AbortSignal;
}): RemoteSpawnedProcess {
  const executable = remoteAgentCommand(opts.provider, opts.command, opts.args);
  const home = opts.env[opts.provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']!;
  const pidFile = path.posix.join(home, 'karmax-agent.pid');
  const stderr = path.posix.join(home, 'agent-stderr.log');
  const bakedExecutable = `/opt/karmax/bin/${opts.provider}`;
  const forwardedArgs = executable.args.slice(2);
  const selectedCommand = `if [ -x ${quote(bakedExecutable)} ]; then exec ${[bakedExecutable, ...forwardedArgs].map(quote).join(' ')}; else exec ${[executable.command, ...executable.args].map(quote).join(' ')}; fi`;
  const commandLine = `sh -c ${quote(selectedCommand)}`;
  // Raw mode is required for the line-oriented JSON protocols: canonical PTYs
  // truncate single lines around MAX_CANON (~4 KiB). The sandbox-local pidfile
  // also lets a Temporal retry reap an agent left behind by a worker crash
  // before starting a second writer in the same world.
  const shell = [
    'stty raw -echo',
    `pidfile=${quote(pidFile)}`,
    `if [ -s "$pidfile" ]; then old=$(cat "$pidfile" 2>/dev/null); cmd=$(tr '\\0' ' ' < "/proc/$old/cmdline" 2>/dev/null || true); case "$cmd" in *${opts.provider}*) kill -TERM -- "-$old" 2>/dev/null || kill -TERM "$old" 2>/dev/null || true; i=0; while kill -0 "$old" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i+1)); done; kill -KILL -- "-$old" 2>/dev/null || kill -KILL "$old" 2>/dev/null || true;; esac; rm -f "$pidfile"; fi`,
    `if command -v setsid >/dev/null 2>&1; then setsid ${commandLine} 2>${quote(stderr)} <&0 >&1 & else ${commandLine} 2>${quote(stderr)} <&0 >&1 & fi`,
    'child=$!',
    'printf \'%s\\n\' "$child" > "$pidfile"',
    'cleanup() { kill -TERM -- "-$child" 2>/dev/null || kill -TERM "$child" 2>/dev/null || true; rm -f "$pidfile"; }',
    'trap cleanup HUP INT TERM EXIT',
    `printf ${quote(READY)}`,
    'wait "$child"',
    'status=$?',
    'trap - HUP INT TERM EXIT',
    'rm -f "$pidfile"',
    'exit "$status"',
  ].join('; ');
  return new RemoteSpawnedProcess(opts.world, shell, opts.cwd, opts.env, opts.signal);
}

export class RemoteSpawnedProcess extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = undefined;
  killed = false;
  exitCode: number | null = null;
  private pty?: WorldPty;
  private ready: Promise<WorldPty>;
  private preamble = '';
  private protocolReady = false;

  constructor(world: World, command: string, cwd: string, env: Record<string, string>, signal?: AbortSignal) {
    super();
    this.ready = world.openPty({ command, cwd, env, cols: 200, rows: 40 }).then((pty) => {
      this.pty = pty;
      pty.onData((chunk) => this.onData(chunk));
      pty.onExit((code) => this.finish(code));
      return pty;
    }).catch((error) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      queueMicrotask(() => this.emit('error', failure));
      this.finish(-1);
      return {
        onData: () => () => {}, onExit: () => () => {},
        write: async () => { throw failure; }, resize: async () => {}, close: async () => {},
      } satisfies WorldPty;
    });
    // The SDK may write its initialize message before the provider finishes
    // opening the PTY; Writable callbacks naturally provide backpressure here.
    this.stdin = new Writable({
      write: (chunk, _encoding, done) => { this.ready.then((pty) => pty.write(Buffer.from(chunk).toString())).then(() => done(), done); },
      final: (done) => { this.ready.then((pty) => pty.write('\x04')).then(() => done(), done); },
    });
    const abort = () => { this.kill('SIGTERM'); };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  }

  kill(_signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.killed) return false;
    this.killed = true;
    void this.ready.then((pty) => pty.close()).catch(() => undefined);
    return true;
  }

  private finish(code: number | null): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, null);
    this.emit('close', code, null);
  }

  private onData(chunk: string): void {
    if (this.protocolReady) { this.stdout.write(chunk); return; }
    this.preamble += chunk;
    const marker = this.preamble.indexOf(READY);
    if (marker < 0) {
      // Bound shell banners/prompts while waiting for the marker.
      if (this.preamble.length > 16_384) this.preamble = this.preamble.slice(-READY.length);
      return;
    }
    this.protocolReady = true;
    const rest = this.preamble.slice(marker + READY.length);
    this.preamble = '';
    if (rest) this.stdout.write(rest);
  }
}

function configFiles(root: string, provider: Provider, session?: string): Array<{ relative: string; content: Buffer }> {
  const files: Array<{ relative: string; content: Buffer }> = [];
  const walk = (dir: string, relative = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = path.join(relative, entry.name);
      const full = path.join(dir, entry.name);
      const top = rel.split(path.sep)[0]!.toLowerCase();
      if (['projects', 'sessions', 'logs', 'debug', 'tmp', 'cache', 'telemetry'].includes(top)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) files.push({ relative: rel, content: fs.readFileSync(full) });
    }
  };
  walk(root);
  if (session) {
    const sessionRoot = path.join(root, provider === 'codex' ? 'sessions' : 'projects');
    const stack = [sessionRoot];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')
          && (provider === 'claude' ? entry.name === `${session}.jsonl` : entry.name.includes(session))) {
          const relative = path.relative(root, full);
          if (!files.some((file) => file.relative === relative)) files.push({ relative, content: fs.readFileSync(full) });
        }
      }
    }
  }
  return files;
}

async function remoteHomeFiles(world: World, absolute: string): Promise<Set<string>> {
  const result = await world.exec('bash', ['-lc',
    `if [ -d ${quote(absolute)} ]; then find ${quote(absolute)} -type f -print; fi`]);
  if (result.code !== 0) throw new Error(`could not inspect remote subscription home: ${result.stderr || result.stdout}`);
  const root = world.handle.root.replace(/\/+$/, '');
  return new Set(result.stdout.split('\n').map((file) => file.trim()).filter(Boolean).map((file) =>
    file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file));
}

/** Copy one native provider session between persistent cloud worlds. The source
 * remains untouched; only the requested session is exposed in the destination. */
export async function materializeRemoteSession(source: World, destination: World,
  provider: Provider, session: string): Promise<boolean> {
  if (!destination.writeFileBuffer) return false;
  const prefix = `${REMOTE_ROOT}/${provider}/`;
  let files: string[];
  try {
    const sourceDirectory = path.posix.join(source.handle.root, prefix);
    const listed = await source.exec('bash', ['-lc',
      `if [ -d ${quote(sourceDirectory)} ]; then find ${quote(sourceDirectory)} -type f -print; fi`]);
    if (listed.code !== 0) return false;
    const root = source.handle.root.replace(/\/+$/, '');
    files = listed.stdout.split('\n').map((file) => file.trim()).filter(Boolean).map((file) =>
      file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file).filter((file) => file.startsWith(prefix));
  }
  catch { return false; }
  const sourceFile = files.find((file) => provider === 'claude'
    ? file.includes('/projects/') && path.posix.basename(file) === `${session}.jsonl`
    : file.includes('/sessions/') && path.posix.basename(file).includes(session) && file.endsWith('.jsonl'));
  if (!sourceFile) return false;
  try {
    const destinationFile = provider === 'claude'
      ? `${prefix}projects/${claudeCwdSlug(destination.handle.root)}/${session}.jsonl`
      : `${prefix}sessions/forked/${path.posix.basename(sourceFile)}`;
    await destination.writeFileBuffer(destinationFile, await source.readFileBuffer(sourceFile));
    const protectedFile = path.posix.join(destination.handle.root, destinationFile);
    const chmod = await destination.exec('chmod', ['600', protectedFile]);
    return chmod.code === 0;
  } catch { return false; }
}

function claudeCwdSlug(worldPath: string): string { return worldPath.replace(/[^a-zA-Z0-9]/g, '-'); }

let platformBundle: Promise<Buffer> | undefined;

/** Codex discovers MCP from config.toml rather than through an SDK callback. Put
 * the exact same gateway-backed server in the sandbox and replace only karmax's
 * host-specific table, preserving every user/browser MCP entry. */
async function seedRemotePlatformMcp(world: World, localHome: string, home: RemoteAgentHome,
  browserMcp?: RemoteAgentHome['browserMcp']): Promise<void> {
  const gateway = process.env.KARMAX_REMOTE_GATEWAY_URL ?? process.env.KARMAX_PUBLIC_URL;
  if (!gateway) throw new Error('remote Codex requires KARMAX_REMOTE_GATEWAY_URL or KARMAX_PUBLIC_URL so its platform MCP can reach Karmax');
  platformBundle ??= bundlePlatformMcp();
  const bundle = await platformBundle;
  const bundleRelative = `${home.relative}/karmax-mcp.mjs`;
  if (!world.writeFileBuffer) throw new Error('remote world cannot receive the platform MCP bundle');
  await world.writeFileBuffer(bundleRelative, bundle);

  let config = '';
  // Preserve settings the remote Codex process changed itself; use the host
  // config only for the first seed into a new sandbox.
  try { config = await world.readFile(`${home.relative}/config.toml`); }
  catch { try { config = fs.readFileSync(path.join(localHome, 'config.toml'), 'utf8'); } catch { /* new home */ } }
  config = removeTomlTable(removeTomlTable(removeTomlTable(config,
    'mcp_servers.karmax'), 'mcp_servers.chrome-devtools'), 'mcp_servers.playwright').trimEnd();
  for (const [name, server] of Object.entries(browserMcp ?? {})) {
    config += `\n\n[mcp_servers.${name}]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\n`;
    if (server.env && Object.keys(server.env).length) {
      config += `\n[mcp_servers.${name}.env]\n${Object.entries(server.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n')}\n`;
    }
  }
  config += `\n\n[mcp_servers.karmax]\ncommand = "node"\nargs = [${JSON.stringify(path.posix.join(home.absolute, 'karmax-mcp.mjs'))}]\nenv_vars = ["KARMAX_TOKEN"]\n\n[mcp_servers.karmax.env]\nKARMAX_GATEWAY_URL = ${JSON.stringify(gateway.replace(/\/$/, ''))}\n`;
  await world.writeFile(`${home.relative}/config.toml`, config);
}

type BrowserKind = 'chrome-devtools' | 'playwright';

function configuredBrowser(home: string, provider: Provider): BrowserKind | undefined {
  try {
    if (provider === 'claude') {
      const value = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'))?.mcpServers;
      if (value?.['chrome-devtools']) return 'chrome-devtools';
      if (value?.playwright) return 'playwright';
      return undefined;
    }
    const value = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    if (/^\s*\[mcp_servers\.chrome-devtools]\s*$/m.test(value)) return 'chrome-devtools';
    if (/^\s*\[mcp_servers\.playwright]\s*$/m.test(value)) return 'playwright';
  } catch { /* a home without MCP configuration needs no browser bootstrap */ }
  return undefined;
}

/** Provider templates are the fast path; this sandbox-local installation is the
 * compatibility path for stock/custom environments. The launch smoke test is
 * the actual guarantee: a world is never handed to an agent with a configured
 * browser MCP that cannot start its browser. */
async function ensureRemoteBrowser(world: World, browser: BrowserKind): Promise<NonNullable<RemoteAgentHome['browserMcp']>> {
  const relative = `${REMOTE_ROOT}/tools/browser-${PLAYWRIGHT_VERSION}`;
  const absolute = path.posix.join(world.handle.root, relative);
  const bin = path.posix.join(absolute, 'node_modules/.bin');
  const browserCache = path.posix.join(absolute, 'browsers');
  const marker = `${relative}/ready.json`;
  let chromium = '';
  let resolvedBin = bin;
  let resolvedCache = browserCache;
  const bakedRoot = '/opt/karmax/browser';
  const bakedCache = '/opt/karmax/browsers';
  const baked = await world.exec('bash', ['-lc', 'test -x /opt/karmax/bin/playwright-mcp && test -x /opt/karmax/bin/chrome-devtools-mcp && test -f /opt/karmax/smoke.mjs']);
  if (baked.code === 0) {
    const executable = await world.exec('node', ['-e', "process.stdout.write(require('playwright').chromium.executablePath())"], {
      cwd: bakedRoot, env: { NODE_PATH: path.posix.join(bakedRoot, 'node_modules'), PLAYWRIGHT_BROWSERS_PATH: bakedCache }, timeoutMs: 30_000,
    });
    const smoke = await world.exec('node', ['/opt/karmax/smoke.mjs'], { env: { PLAYWRIGHT_BROWSERS_PATH: bakedCache }, timeoutMs: 60_000 });
    if (executable.code === 0 && executable.stdout.trim() && smoke.code === 0) {
      chromium = executable.stdout.trim();
      resolvedBin = '/opt/karmax/bin';
      resolvedCache = bakedCache;
    }
  }
  if (!chromium) try { chromium = JSON.parse(await world.readFile(marker)).chromium; } catch { /* install below */ }
  if (!chromium) {
    const packages = [
      `playwright@${PLAYWRIGHT_VERSION}`,
      `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`,
      `chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}`,
    ];
    const install = await world.exec('bash', ['-lc', [
      `mkdir -p ${quote(absolute)} ${quote(browserCache)}`,
      `npm install --prefix ${quote(absolute)} --no-audit --no-fund --omit=dev ${packages.map(quote).join(' ')}`,
      `PLAYWRIGHT_BROWSERS_PATH=${quote(browserCache)} ${quote(path.posix.join(bin, 'playwright'))} install chromium`,
    ].join(' && ')], { timeoutMs: 10 * 60_000 });
    if (install.code !== 0) throw new Error(`remote browser installation failed: ${install.stderr || install.stdout}`);
    const executable = await world.exec('node', ['-e', "process.stdout.write(require('playwright').chromium.executablePath())"], {
      cwd: absolute, env: { NODE_PATH: path.posix.join(absolute, 'node_modules'), PLAYWRIGHT_BROWSERS_PATH: browserCache }, timeoutMs: 30_000,
    });
    if (executable.code !== 0 || !executable.stdout.trim()) throw new Error(`could not locate remote Chromium: ${executable.stderr}`);
    chromium = executable.stdout.trim();
    const smoke = await world.exec('node', ['-e', "require('playwright').chromium.launch({headless:true,args:['--no-sandbox']}).then(async b=>{await b.close()}).catch(e=>{console.error(e);process.exit(1)})"], {
      cwd: absolute, env: { NODE_PATH: path.posix.join(absolute, 'node_modules'), PLAYWRIGHT_BROWSERS_PATH: browserCache }, timeoutMs: 60_000,
    });
    if (smoke.code !== 0) {
      // Stock provider environments frequently have a package manager and
      // passwordless sudo even when browser libraries are absent. Repair that
      // case once; custom locked-down images still fail with an actionable
      // template/image error instead of handing the agent a broken MCP.
      const dependencyInstall = await world.exec('bash', ['-lc', [
        `installer=${quote(path.posix.join(bin, 'playwright'))}`,
        'if [ "$(id -u)" = 0 ]; then "$installer" install-deps chromium;',
        'elif command -v sudo >/dev/null 2>&1; then sudo -n "$installer" install-deps chromium;',
        'else exit 126; fi',
      ].join(' ')], { env: { PLAYWRIGHT_BROWSERS_PATH: browserCache }, timeoutMs: 10 * 60_000 });
      const repaired = dependencyInstall.code === 0
        ? await world.exec('node', ['-e', "require('playwright').chromium.launch({headless:true,args:['--no-sandbox']}).then(async b=>{await b.close()}).catch(e=>{console.error(e);process.exit(1)})"], {
            cwd: absolute, env: { NODE_PATH: path.posix.join(absolute, 'node_modules'), PLAYWRIGHT_BROWSERS_PATH: browserCache }, timeoutMs: 60_000,
          })
        : dependencyInstall;
      if (repaired.code !== 0) throw new Error(`remote Chromium readiness probe failed; select a Karmax browser template/image or permit Playwright OS-dependency installation: ${repaired.stderr || repaired.stdout || smoke.stderr || smoke.stdout}`);
    }
    await world.writeFile(marker, JSON.stringify({ chromium, playwright: PLAYWRIGHT_VERSION }));
  }
  const env = { PLAYWRIGHT_BROWSERS_PATH: resolvedCache };
  return browser === 'playwright'
    ? { playwright: { command: path.posix.join(resolvedBin, 'playwright-mcp'), args: ['--headless', '--no-sandbox', '--isolated'], env } }
    : { 'chrome-devtools': { command: path.posix.join(resolvedBin, 'chrome-devtools-mcp'),
        args: ['--headless', '--isolated', '--executablePath', chromium, '--chromeArg=--no-sandbox'], env } };
}

async function bundlePlatformMcp(): Promise<Buffer> {
  const { build } = await import('esbuild');
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../mcp/stdio.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    write: false,
    logLevel: 'silent',
  });
  const output = result.outputFiles?.[0]?.contents;
  if (!output) throw new Error('could not bundle the remote karmax MCP bridge');
  return Buffer.from(output);
}

function removeTomlTable(source: string, owned: string): string {
  let remove = false;
  return source.split(/(?<=\n)/).filter((line) => {
    const header = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?(?:\r?\n)?$/);
    if (header) {
      const table = header[1]!.trim();
      remove = table === owned || table.startsWith(`${owned}.`);
    }
    return !remove;
  }).join('');
}

function quote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
