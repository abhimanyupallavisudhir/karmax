import { timed } from '../timing/index.js';
import { mapBatches } from '../util/async-batch.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { Provider } from '../domain/types.js';
import type { World, WorldPty, WorldPtyTermination } from '../world/types.js';
import { fileURLToPath } from 'node:url';
import { CODEX_PACKAGE as PINNED_CODEX_PACKAGE, CodexHistoryError, prepareCodexHistory, selectCodexHistoryCopy } from './codex-history.js';
import { atomicPrivateWrite, publishLocalCodexHistory } from './codex-history-files.js';
import { publishRemoteCodexHistory } from './codex-history-remote.js';
import { codexHistoryBase, codexSessionFiles } from './fork.js';
import { CHROME_DEVTOOLS_MCP_VERSION, PLAYWRIGHT_MCP_VERSION, PLAYWRIGHT_VERSION, KARMAX_TOKEN_FILE } from '../autonomy/config-homes.js';
import { DEFAULT_CDP_PORT } from '../autonomy/cdp-endpoint.js';
import { exposeRemoteNodeCommand, installRemoteNodeCommand, PINNED_REMOTE_NODE_VERSION, PINNED_REMOTE_NPM_VERSION } from './remote-node.js';
import { collectStartupProbe, StartupProtocolTrace } from './startup-diagnostics.js';

// CheckpointService already excludes this injection surface. Keep it under the
// world root only because every remote provider exposes that portable write API.
const REMOTE_ROOT = '.karmax-injection/agent';
const CODEX_PACKAGE = process.env.KARMAX_REMOTE_CODEX_PACKAGE ?? PINNED_CODEX_PACKAGE;
const REMOTE_NODE_VERSION = process.env.KARMAX_REMOTE_NODE_VERSION ?? PINNED_REMOTE_NODE_VERSION;
const REMOTE_NPM_VERSION = process.env.KARMAX_REMOTE_NPM_VERSION ?? PINNED_REMOTE_NPM_VERSION;
const READY = '\u001eKARMAX_AGENT_READY\u001e';
const MEMORY_GUARD = `${REMOTE_ROOT}/memory-guard.sh`;

/** Ship the sandbox memory guard (src/agent/memory-guard.sh); every remote
 * agent start launches it if it is not already running. */
export async function installMemoryGuard(world: World): Promise<void> {
  await world.writeFile(MEMORY_GUARD, fs.readFileSync(fileURLToPath(new URL('./memory-guard.sh', import.meta.url)), 'utf8'));
}
/** Current Codex treats refresh-token *presence* as the ChatGPT login marker,
 * even with fresh ID/access tokens. Remote worlds receive this inert value so
 * the real rotating credential remains exclusively host-owned. */
export const CODEX_REMOTE_REFRESH_SENTINEL = 'karmax-host-managed-refresh';

/** A V2 provider world is the execution boundary: native agent subprocesses must
 * run there, not on the control-plane host against a virtual cwd. */
export function isRemoteAgentWorld(world: World): boolean {
  return world.handle.kind === 'container' || (world.handle.version === 2 && Boolean(world.handle.sealedProviderRef));
}

export interface RemoteAgentHome {
  absolute: string;
  relative: string;
  /** Optional sandbox-local modern Node bin directory for old provider images. */
  runtimeBin?: string;
  /** Browser entries rewritten to sandbox-local, pinned executables. */
  browserMcp?: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
}

/** Seed the leased subscription credentials/config into this task's persistent
 * sandbox. Provider session/cache directories are deliberately left sandbox-
 * local. OAuth remains control-plane-owned: every turn replaces the sandbox
 * projection and withholds rotating refresh tokens, so parallel task worlds
 * cannot fork and revoke one shared login's token family. */
export async function seedRemoteAgentHome(world: World, provider: Provider, localHome: string,
  session?: string, browserOverride?: 'none', onStartupStep?: (step: string) => Promise<void>): Promise<RemoteAgentHome> {
  if (!localHome) throw new Error(`${provider} subscription has no config home to seed`);
  const relative = remoteAgentHomeRelative(provider, localHome);
  const absolute = path.posix.join(world.handle.root, relative);
  await onStartupStep?.('prepare-runtime');
  const runtimeBin = await timed('bootstrap.node', () => ensureRemoteNode(world));
  if (provider === 'codex') await timed('bootstrap.quiesce', () => quiesceRemoteCodexHome(world, absolute));
  // A single-repo world's root is itself a checkout. Keep injected auth out of
  // `git add -A` without modifying the user's tracked .gitignore.
  await world.exec('bash', ['-lc', "exclude=$(git rev-parse --git-path info/exclude 2>/dev/null) && mkdir -p \"$(dirname \"$exclude\")\" && { grep -qxF '.karmax-injection/' \"$exclude\" 2>/dev/null || printf '%s\\n' '.karmax-injection/' >> \"$exclude\"; } || true"]);
  await onStartupStep?.('prepare-config');
  const existing = await timed('bootstrap.list-home', () => remoteHomeFiles(world, absolute));
  const files = configFiles(localHome, provider, session);
  const rollouts = files.filter(file => provider === 'codex' && codexRolloutIdentity(file.relative.split(path.sep).join('/')));
  async function seed(file: { relative: string; content: Buffer }) {
    const target = `${relative}/${file.relative.split(path.sep).join('/')}`;
    if (!world.writeFileBuffer) throw new Error('remote world cannot receive subscription config files');
    // Codex resolves rollout identity across the entire home, not by directory.
    // A cloud fork may already have a newer copy under sessions/forked while the
    // host cache still has an older dated copy. Never seed a second identity.
    const rollout = provider === 'codex' ? codexRolloutIdentity(file.relative.split(path.sep).join('/')) : undefined;
    if (rollout) {
      const id = path.posix.basename(file.relative).replace(/\.jsonl$/, '').match(/([0-9a-f-]{36})$/i)?.[1]
        ?? path.posix.basename(file.relative).replace(/^rollout-/, '').replace(/\.jsonl$/, '');
      await publishRemoteCodexHistory(world, { absolute, relative, runtimeBin }, { file: file.relative, content: file.content }, id);
      return;
    }
    const controlledAuth = isControlPlaneAuth(provider, file.relative);
    const content = controlledAuth ? remoteAuthProjection(provider, file.relative, file.content) : file.content;
    if (!existing.has(target) || controlledAuth) {
      await world.writeFileBuffer(target, content);
    } else if (authFreshness(provider, file.relative, file.content) !== undefined) {
      const remote = await world.readFileBuffer(target);
      if (authIsNewer(provider, file.relative, file.content, remote))
        await world.writeFileBuffer(target, content);
    }
  }
  // Ordinary files have distinct paths and no live reader until startup. Rollout
  // publication reconciles shared session identity, so keep it serialized.
  const rolloutSet = new Set(rollouts);
  await Promise.all([
    timed('bootstrap.seed-files', () => mapBatches(files.filter(file => !rolloutSet.has(file)), seed)),
    // A safety net, not a requirement: never fail a turn over it.
    installMemoryGuard(world).catch(() => undefined),
  ]);
  for (const file of rollouts) await seed(file);
  // Retries may restore exclusively from the host after the source world has
  // been deleted. Repair prior duplicate copies here too, before Codex opens its
  // persistent index; live-world transfer is not guaranteed to run.
  if (provider === 'codex' && session)
    await timed('bootstrap.reconcile-session', () => reconcileRemoteCodexSessionCopies(world, { absolute, relative, runtimeBin }, session));
  const home = { absolute, relative, ...(runtimeBin ? { runtimeBin } : {}) };
  const browser = browserOverride === 'none' ? undefined : configuredBrowser(localHome, provider);
  await onStartupStep?.('prepare-browser');
  const browserMcp = browser ? await timed('bootstrap.browser', () => ensureRemoteBrowser(world, browser, runtimeBin)) : undefined;
  if (provider === 'codex') await timed('bootstrap.config', () => seedRemoteCodexConfig(world, localHome, home, browserMcp));
  await onStartupStep?.('protect-config');
  const permissions = await world.exec('bash', ['-lc',
    `if [ -d ${quote(absolute)} ]; then find ${quote(absolute)} -type d -exec chmod 700 {} + && find ${quote(absolute)} -type f -exec chmod 600 {} +; fi`]);
  if (permissions.code !== 0) throw new Error(`could not protect remote subscription files: ${permissions.stderr || permissions.stdout}`);
  return { ...home, ...(browserMcp ? { browserMcp } : {}) };
}

/** A world can rotate between several subscription accounts. Keep each native
 * home isolated by the stable control-plane config-home identity so preserving
 * refreshed auth for account A can never cause a later lease for B to run as A. */
export function remoteAgentHomeRelative(provider: Provider, localHome: string): string {
  const identity = crypto.createHash('sha256').update(path.resolve(localHome)).digest('hex').slice(0, 20);
  return `${REMOTE_ROOT}/${provider}/${identity}`;
}

/** Export only provider-owned authentication and native conversation files.
 * Remote MCP/browser rewrites, logs, caches, and process-control files remain
 * sandbox-local. Atomic 0600 writes make OAuth token rotation durable without
 * allowing a partial download to corrupt the account's control-plane home. */
export async function syncRemoteAgentHome(world: World, provider: Provider, remoteHome: RemoteAgentHome,
  localHome: string): Promise<void> {
  if (!localHome) return;
  const listed = await world.exec('bash', ['-lc',
    `if [ -d ${quote(remoteHome.absolute)} ]; then find ${quote(remoteHome.absolute)} -type f -print; fi`]);
  if (listed.code !== 0) throw new Error(`could not export remote ${provider} state: ${listed.stderr || listed.stdout}`);
  const root = world.handle.root.replace(/\/+$/, '');
  const homePrefix = `${remoteHome.relative}/`;
  const files = listed.stdout.split('\n').map((file) => file.trim()).filter(Boolean).map((file) =>
    file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file).filter((file) => file.startsWith(homePrefix));
  const auth = new Set(provider === 'codex'
    ? ['auth.json', 'karmax-oauth.json']
    : ['.credentials.json', '.claude/.credentials.json', 'karmax-oauth.json']);
  for (const remoteFile of files) {
    const relative = remoteFile.slice(homePrefix.length);
    const session = provider === 'codex'
      ? (relative.startsWith('sessions/') || relative.startsWith('archived_sessions/')) && relative.endsWith('.jsonl')
      : relative.startsWith('projects/') && relative.endsWith('.jsonl');
    const recovery = provider === 'codex' && /^\.karmax-history-recovery\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.json$/.test(relative);
    if (!auth.has(relative) && !session && !recovery) continue;
    // Remote provider processes receive refresh-token-free projections. They are
    // intentionally never refresh authority and must never overwrite the one
    // canonical credential shared by every task using this login.
    if (isControlPlaneAuth(provider, relative)) continue;
    // The listing came from a shell inside the sandbox, which the agent controls:
    // a `..` segment would write anywhere the control plane's user can.
    const segments = relative.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) continue;
    const destination = path.join(localHome, ...segments);
    if (!destination.startsWith(path.resolve(localHome) + path.sep)) continue;
    const data = await world.readFileBuffer(remoteFile);
    if (recovery) { atomicPrivateWrite(destination, data); continue; }
    if (provider === 'codex' && session) {
      const id = path.posix.basename(relative).match(/([0-9a-f-]{36})\.jsonl$/i)?.[1]
        ?? path.posix.basename(relative).replace(/^rollout-/, '').replace(/\.jsonl$/, '');
      publishLocalCodexHistory(localHome, { file: relative, content: data }, id);
      continue;
    }
    // A task cleanup can race a human re-login on the control plane. Do not let
    // an older persistent world restore the token the user just replaced.
    if (auth.has(relative) && fs.existsSync(destination)) {
      const local = fs.readFileSync(destination);
      if (authIsNewer(provider, relative, local, data)) continue;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    const temp = `${destination}.${crypto.randomBytes(6).toString('hex')}.karmax-tmp`;
    try {
      fs.writeFileSync(temp, data, { mode: 0o600 });
      fs.renameSync(temp, destination);
      fs.chmodSync(destination, 0o600);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }
}

function isControlPlaneAuth(provider: Provider, relative: string): boolean {
  const normalized = relative.split(path.sep).join('/');
  // The captured setup token is injected into every later turn of this login
  // (`CLAUDE_CODE_OAUTH_TOKEN`); a sandbox that could replace it would make
  // those turns authenticate as whoever it chose.
  if (normalized === KARMAX_TOKEN_FILE) return true;
  return provider === 'codex'
    ? normalized === 'auth.json'
    : provider === 'claude'
      && (normalized === '.credentials.json' || normalized === '.claude/.credentials.json');
}

/** Replace rotating refresh credentials with access-only sandbox projections.
 * Codex needs an inert presence marker or current app-server silently discards
 * its otherwise-valid access token. Claude's SDK has an explicit host refresh
 * callback, so its refresh token is removed completely. */
function remoteAuthProjection(provider: Provider, relative: string, content: Buffer): Buffer {
  try {
    const parsed = JSON.parse(content.toString('utf8'));
    if (provider === 'codex' && isControlPlaneAuth(provider, relative)) {
      if (parsed?.tokens && typeof parsed.tokens === 'object') {
        parsed.tokens.refresh_token = CODEX_REMOTE_REFRESH_SENTINEL;
        delete parsed.tokens.refreshToken;
      }
      delete parsed.refresh_token;
      delete parsed.refreshToken;
    } else if (provider === 'claude' && isControlPlaneAuth(provider, relative)) {
      for (const oauth of [parsed?.claudeAiOauth, parsed?.oauthAccount]) {
        if (!oauth || typeof oauth !== 'object') continue;
        delete oauth.refreshToken;
        delete oauth.refreshTokenExpiresAt;
        delete oauth.refresh_token;
        delete oauth.refresh_token_expires_at;
      }
    }
    return Buffer.from(JSON.stringify(parsed));
  } catch {
    // Preserve legacy/unrecognized auth shapes rather than corrupting them. A
    // current native auth.json is JSON and always follows the projection path.
    return content;
  }
}

/** Provider-native monotonic-ish credential freshness for Claude, whose remote
 * SDK still owns refresh. Codex is deliberately excluded: one canonical host
 * owns its rotating refresh token, independent of task-local timestamps. */
function authFreshness(provider: Provider, relative: string, content: Buffer): number | undefined {
  const normalized = relative.split(path.sep).join('/');
  const isClaude = provider === 'claude'
    && (normalized === '.credentials.json' || normalized === '.claude/.credentials.json');
  if (!isClaude) return undefined;
  try {
    const parsed = JSON.parse(content.toString('utf8'));
    const expiry = Number(parsed?.claudeAiOauth?.expiresAt ?? parsed?.oauthAccount?.expiresAt);
    return Number.isFinite(expiry) && expiry > 0 ? expiry : undefined;
  } catch {
    return undefined;
  }
}

function authIsNewer(provider: Provider, relative: string, candidate: Buffer, current: Buffer): boolean {
  const next = authFreshness(provider, relative, candidate);
  const prior = authFreshness(provider, relative, current);
  return next !== undefined && (prior === undefined || next > prior);
}

/** Remote auth/session export is a durability enhancement, not the provider
 * turn's terminal result. Return a diagnostic instead of throwing so a control-
 * plane timeout during cleanup cannot replace a verified successful turn. */
export async function syncRemoteAgentHomeBestEffort(world: World, provider: Provider,
  remoteHome: RemoteAgentHome, localHome: string): Promise<Error | undefined> {
  try {
    await syncRemoteAgentHome(world, provider, remoteHome, localHome);
    return undefined;
  } catch (error) {
    if (error instanceof CodexHistoryError) throw error;
    return error instanceof Error ? error : new Error(String(error));
  }
}

/** Minimal environment passed across the trust boundary. Authentication lives in
 * the seeded home; only explicit turn-scoped values and provider tuning cross.
 * `forward` is the caller-vouched allowlist of project secret/service names. */
export function remoteAgentEnv(provider: Provider, home: string, source: Record<string, string | undefined>,
  forward: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {
    ...(provider === 'claude' ? { CLAUDE_CONFIG_DIR: home } : { CODEX_HOME: home }),
  };
  const homeKey = provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
  for (const key of new Set([
    'KARMAX_TOKEN', 'KARMAX_GATEWAY_URL', 'CLAUDE_CODE_OAUTH_TOKEN',
    // Agent SDK ↔ Claude Code protocol negotiation. Dropping ENTRYPOINT makes
    // the CLI reject stream-json input unless --print; the remaining flags are
    // SDK feature handshakes and must cross a custom-spawn boundary unchanged.
    'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_AGENT_SDK_VERSION',
    'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING', 'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH',
    'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH', 'CLAUDE_CODE_QUESTION_PREVIEW_FORMAT',
    'CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS',
    'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
    ...forward.filter((name) => /^[A-Z_][A-Z0-9_]*$/.test(name)),
  ])) {
    if (key === homeKey) continue;
    const value = source[key];
    if (value) out[key] = value;
  }
  return out;
}

/** Translate the host SDK's bundled executable into the matching published CLI
 * package. npx caches it in the sandbox after the first turn. */
export function remoteAgentCommand(provider: Provider, command: string, args: string[]): { command: string; args: string[] } {
  if (provider === 'claude') {
    const sdkArgs = path.basename(command).startsWith('node') && /(?:^|\/)cli\.js$/.test(args[0] ?? '') ? args.slice(1) : args;
    // The SDK's embedded native binary infers print mode from its entrypoint.
    // The separately published npm CLI still validates stream-json arguments at
    // startup in some sandbox PTYs; make the SDK's intended mode explicit.
    const forwarded = sdkArgs.includes('--print') || sdkArgs.includes('-p') ? sdkArgs : ['--print', ...sdkArgs];
    // The Agent SDK and its embedded Claude Code binary are one tested protocol
    // unit. Resolve the package's declared CLI version instead of maintaining a
    // second hand-written pin that can silently drift on dependency upgrades.
    const packageSpec = process.env.KARMAX_REMOTE_CLAUDE_PACKAGE
      ?? `@anthropic-ai/claude-code@${installedClaudeCodeVersion()}`;
    return { command: 'npx', args: ['--yes', packageSpec, ...forwarded] };
  }
  return { command: 'npx', args: ['--yes', CODEX_PACKAGE, ...args] };
}

/** Version of Claude Code explicitly paired with the installed Agent SDK. */
export function installedClaudeCodeVersion(): string {
  const require = createRequire(import.meta.url);
  let directory = path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk'));
  for (;;) {
    const packageFile = path.join(directory, 'package.json');
    try {
      const metadata = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
      if (metadata.name === '@anthropic-ai/claude-agent-sdk' && typeof metadata.claudeCodeVersion === 'string')
        return metadata.claudeCodeVersion;
    } catch { /* keep walking to the package root */ }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('installed Claude Agent SDK does not declare claudeCodeVersion; set KARMAX_REMOTE_CLAUDE_PACKAGE explicitly');
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
  const startupTrace = path.posix.join(home, `startup-${crypto.randomUUID()}.log`);
  // Separate per-spawn journal: a retry cannot overwrite the failed launch's
  // milestones. All labels are constants; no arguments or environments enter it.
  const trace = (phase: string) => `printf '{"phase":"${phase}","pid":%s,"at":%s}\\n' "$$" "$(date +%s)" >> ${quote(startupTrace)}`;
  const bakedExecutable = `/opt/karmax/bin/${opts.provider}`;
  const packageSpec = executable.args[1] ?? '';
  const forwardedArgs = executable.args.slice(2);
  const expectedVersion = packageSpec.slice(packageSpec.lastIndexOf('@') + 1);
  // A user may keep an older E2B/Daytona template after upgrading Karmax. Only
  // use its baked CLI when it is the version paired with this control-plane
  // adapter; otherwise npx installs the matching package into the sandbox cache.
  const bakedMatches = `[ -x ${quote(bakedExecutable)} ] && ${quote(bakedExecutable)} --version 2>/dev/null | grep -Fq -- ${quote(expectedVersion)}`;
  // `command` is a shell expression (the resolved "$bin"); args are quoted.
  const invocation = (command: string, args: string[]) => {
    if (opts.provider !== 'claude') return [command, ...args.map(quote)].join(' ');
    // World transports are PTYs, but Claude's stream-json/print mode requires
    // non-interactive stdin. This foreground relay gives the CLI a real pipe,
    // forwards termination, and leaves its stdout/stderr on the provider PTY.
    const relay = [
      "const { spawn } = require('node:child_process')",
      `const trace = (phase, pid = process.pid, extra = {}) => { try { require('node:fs').appendFileSync(${JSON.stringify(startupTrace)}, JSON.stringify({ phase, pid, at: Math.floor(Date.now()/1000), ...extra }) + '\\n') } catch {} }`,
      "trace('relay-started'); let received = false",
      "const child = spawn(process.argv[1], process.argv.slice(2), { env: process.env, stdio: ['pipe', 'inherit', 'inherit'] })",
      "child.on('spawn', () => trace('child-spawned', child.pid))",
      "process.stdin.on('data', (data) => { if (!received) { received = true; trace('stdin-received') } const end = data.indexOf(4); if (end < 0) child.stdin.write(data); else { if (end) child.stdin.write(data.subarray(0, end)); trace('stdin-ended'); child.stdin.end(); } })",
      "process.stdin.on('end', () => child.stdin.end())",
      "for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal))",
      "child.on('error', (error) => { trace('child-error', process.pid, { code: error.code }); console.error(error); process.exitCode = 1 })",
      "child.on('exit', (code, signal) => { trace('child-exited', child.pid, { exitCode: code }); if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1) })",
    ].join('; ');
    return [...['node', '-e', relay].map(quote), command, ...args.map(quote)].join(' ');
  };
  // Resolve the paired CLI through npx's cache, then exec it directly: running
  // it *under* npx kept a ~150 MB npm process alive for the whole session.
  const resolved = `npx --yes --package=${quote(packageSpec)} -c ${quote(`command -v ${opts.provider}`)}`;
  const selectedCommand = `${trace('cli-version-check')}; if ${bakedMatches}; then bin=${quote(bakedExecutable)}; else ${trace('cli-resolve')}; bin=$(${resolved}) || exit 127; fi; `
    + `${trace('cli-exec')}; exec ${invocation('"$bin"', forwardedArgs)}`;
  const commandLine = `sh -c ${quote(selectedCommand)}`;
  // Raw mode is required for the line-oriented JSON protocols: canonical PTYs
  // truncate single lines around MAX_CANON (~4 KiB). The sandbox-local pidfile
  // also lets a Temporal retry reap an agent left behind by a worker crash
  // before starting a second writer in the same world. Keep the app-server in
  // the PTY foreground: `setsid` detaches its controlling terminal, after which
  // the real E2B process stays alive but never receives JSON-RPC input.
  const shell = [
    'stty raw -echo',
    `(umask 077; ${trace('shell-started')})`,
    `pidfile=${quote(pidFile)}`,
    trace('previous-process-check'),
    `if [ -s "$pidfile" ]; then old=$(cat "$pidfile" 2>/dev/null); cmd=$(tr '\\0' ' ' < "/proc/$old/cmdline" 2>/dev/null || true); case "$cmd" in *${opts.provider}*) kill -TERM -- "-$old" 2>/dev/null || kill -TERM "$old" 2>/dev/null || true; i=0; while kill -0 "$old" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i+1)); done; kill -KILL -- "-$old" 2>/dev/null || kill -KILL "$old" 2>/dev/null || true;; esac; rm -f "$pidfile"; fi`,
    'printf \'%s\\n\' "$$" > "$pidfile"',
    trace('previous-process-stopped'),
    `guard=${quote(path.posix.join(opts.world.handle.root, MEMORY_GUARD))}; [ -f "$guard" ] && sh "$guard" start >/dev/null 2>&1`,
    // Assemble the sentinel at runtime so no echo of the launcher can open the
    // protocol gate before `exec agent` and let the shell consume the JSON
    // initialize line. The newline also forces prompt delivery through provider
    // PTY streams that coalesce partial output.
    trace('protocol-ready'),
    "printf '\\036KARMAX_AGENT_%s\\036\\n' READY",
    `exec ${commandLine} 2>${quote(stderr)}`,
  ].join('; ');
  // Never type the launcher itself. Providers type the PTY command into an
  // interactive shell, and one whose terminal is still canonical (Daytona's zsh
  // before its line editor starts) keeps only 4095 bytes of a line: the ~9 KiB
  // Claude launcher lost its closing quote and the shell waited forever (tasks
  // 361/362). Upload it through the file API and type a line of a few dozen bytes.
  const launcher = path.posix.join(home, `launch-${crypto.randomUUID()}.sh`);
  const relative = path.posix.relative(opts.world.handle.root, launcher);
  if (relative.startsWith('..') || path.posix.isAbsolute(relative))
    throw new Error(`remote agent home ${home} is outside the world root`);
  return new RemoteSpawnedProcess(opts.world, `exec sh ${quote(launcher)}`, opts.cwd, opts.env, opts.signal,
    stderr, startupTrace, { path: relative, script: `rm -f -- "$0"; ${shell}\n` });
}

export class RemoteSpawnedProcess extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = undefined;
  killed = false;
  exitCode: number | null = null;
  /** Set when the provider stream ended without the process exiting. The
   * ChildProcess contract has no such state, so adapters must check it. */
  lost?: Error;
  private pty?: WorldPty;
  private ready: Promise<WorldPty>;
  private protocolGate: Promise<void>;
  private openProtocolGate!: () => void;
  private preamble = '';
  private protocolReady = false;
  private finished = false;
  private finishing = false;
  private startup = true;
  private startedAt = Date.now();
  private openedAt?: number;
  private readyAt?: number;
  private readBytes = 0;
  private writesStarted = 0;
  private writesCompleted = 0;
  private sent = new StartupProtocolTrace();
  private received = new StartupProtocolTrace();

  constructor(private world: World, command: string, cwd: string, env: Record<string, string>, signal?: AbortSignal,
    private stderrFile?: string, private startupTraceFile?: string, launcher?: { path: string; script: string }) {
    super();
    this.protocolGate = new Promise<void>((resolve) => { this.openProtocolGate = resolve; });
    const open = () => world.openPty({ command, cwd, env, cols: 200, rows: 40 });
    this.ready = (launcher ? world.writeFile(launcher.path, launcher.script).then(open) : open()).then((pty) => {
      this.pty = pty;
      this.openedAt = Date.now();
      pty.onData((chunk) => this.onData(chunk));
      pty.onExit((code, termination) => this.finish(code, termination));
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
    // The SDK may write initialize before the provider opens the PTY or before
    // its login shell reaches `exec agent`. Gate every byte on READY; otherwise
    // the shell can consume JSON as its next command.
    this.stdin = new Writable({
      write: (chunk, _encoding, done) => {
        if (this.startup) { this.writesStarted++; this.sent.read(Buffer.from(chunk).toString()); }
        Promise.all([this.ready, this.protocolGate]).then(([pty]) => pty.write(Buffer.from(chunk).toString()))
          .then(() => { if (this.startup) this.writesCompleted++; done(); }, done);
      },
      final: (done) => { Promise.all([this.ready, this.protocolGate]).then(([pty]) => pty.write('\x04')).then(() => done(), done); },
    });
    // ChildProcess stdin streams own an error listener internally; our
    // ChildProcess-shaped stream must do the same. Claude's SDK observes the
    // authoritative process exit but does not subscribe to stdin errors, so an
    // E2B write racing a fast CLI exit would otherwise crash Node as an
    // unhandled Writable error before the adapter can report stderr.
    this.stdin.on('error', () => {});
    const abort = () => { this.kill('SIGTERM'); };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  }

  /** Clear the bounded protocol buffers as soon as the SDK yields. */
  startupComplete(): void { this.startup = false; this.sent.clear(); this.received.clear(); }

  async startupDiagnostics(): Promise<Record<string, unknown>> {
    const transport = { elapsedMs: Date.now() - this.startedAt, ptyOpened: this.openedAt !== undefined,
      ptyOpenMs: this.openedAt === undefined ? undefined : this.openedAt - this.startedAt,
      protocolReady: this.protocolReady, readyMs: this.readyAt === undefined ? undefined : this.readyAt - this.startedAt,
      readBytes: this.readBytes, writesStarted: this.writesStarted, writesCompleted: this.writesCompleted,
      exited: this.finishing, exitCode: this.exitCode, connectionLost: !!this.lost,
      sentFrames: this.sent.snapshot(), receivedFrames: this.received.snapshot() };
    const sandbox = this.startupTraceFile && this.stderrFile
      ? await collectStartupProbe(this.world, this.startupTraceFile, this.stderrFile) : { status: 'unavailable' };
    return { transport, sandbox };
  }

  async stop(): Promise<void> {
    this.killed = true;
    const pty = await this.ready;
    await pty.close();
    if (this.finished) return;
    await new Promise<void>((resolve, reject) => {
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        this.off('exit', done);
        reject(new Error('remote agent exit was not confirmed; refusing to synchronize a live history'));
      }, 15_000);
      this.once('exit', done);
    });
  }

  kill(_signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.killed) return false;
    this.killed = true;
    void this.ready.then(async (pty) => (await pty.close())).catch(() => undefined);
    return true;
  }

  private async finish(code: number | null, termination?: WorldPtyTermination | NodeJS.Signals | null): Promise<void> {
    if (this.finishing) return;
    this.finishing = true;
    this.exitCode = code;
    // Tolerate providers that forward Node's exit(code, signal) verbatim.
    const ending: WorldPtyTermination | undefined = typeof termination === 'string' ? { signal: termination }
      : termination && typeof termination === 'object' ? termination : undefined;
    const signal = ending && 'signal' in ending ? ending.signal : null;
    if (ending && 'lost' in ending) this.lost = new Error(
      `lost the connection to the agent in the sandbox; it may still be running there (${ending.lost.message})`,
      { cause: ending.lost });
    this.openProtocolGate();
    // The protocol owns PTY stdout; native stderr is redirected to a file.
    // Recover a bounded tail before close so startup failures retain their cause.
    if (this.stderrFile) {
      try {
        const result = await this.world.exec('tail', ['-c', '8192', this.stderrFile], { timeoutMs: 5000 });
        if (result.code === 0 && result.stdout) this.stderr.write(result.stdout);
      } catch { /* diagnostics must not replace the process failure */ }
    }
    this.finished = true;
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }

  private onData(chunk: string): void {
    if (this.startup) this.readBytes += Buffer.byteLength(chunk);
    if (this.protocolReady) { if (this.startup) this.received.read(chunk); this.stdout.write(chunk); return; }
    this.preamble += chunk;
    const marker = this.preamble.indexOf(READY);
    if (marker < 0) {
      // Bound shell banners/prompts while waiting for the marker.
      if (this.preamble.length > 16_384) this.preamble = this.preamble.slice(-READY.length);
      return;
    }
    this.protocolReady = true;
    this.readyAt = Date.now();
    this.openProtocolGate();
    const rest = this.preamble.slice(marker + READY.length);
    this.preamble = '';
    if (rest) { if (this.startup) this.received.read(rest); this.stdout.write(rest); }
  }
}

function configFiles(root: string, provider: Provider, session?: string): Array<{ relative: string; content: Buffer }> {
  const files: Array<{ relative: string; content: Buffer }> = [];
  const walk = (dir: string, relative = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = path.join(relative, entry.name);
      const full = path.join(dir, entry.name);
      const segments = rel.split(path.sep).map((segment) => segment.toLowerCase());
      const top = segments[0]!;
      // Native homes contain large, live provider state that is neither required
      // to authenticate nor safe to snapshot file-by-file (SQLite + WAL pairs).
      // Codex currently names these logs_2.sqlite/state_5.sqlite and stores tens
      // of MiB in shell_snapshots and nested plugin caches. Uploading them made a
      // real E2B filesystem request time out. Durable config, skills, rules,
      // commands, hooks, and plugin manifests continue through this walk; the one
      // requested session is materialized separately below.
      if (top.startsWith('.karmax-history') || ['projects', 'sessions', 'archived_sessions', 'logs', 'log', 'debug', 'tmp', '.tmp', 'cache', 'telemetry', 'shell_snapshots'].includes(top)
        || segments.some((segment) => ['cache', '.remote-plugin-install-staging'].includes(segment))
        || /^(?:logs?|state|goals|memories)(?:[_-].*)?\.sqlite(?:-(?:wal|shm))?$/.test(entry.name.toLowerCase())
        || ['history.jsonl', 'models_cache.json'].includes(entry.name.toLowerCase())) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) files.push({ relative: rel, content: fs.readFileSync(full) });
    }
  };
  walk(root);
  if (session && provider === 'codex') {
    const lineage = codexSessionFiles({ session, forkHome: root });
    if (lineage) for (const file of lineage)
      files.push({ relative: path.relative(root, file), content: fs.readFileSync(file) });
  } else if (session) {
    const sessionRoot = path.join(root, 'projects');
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

/** Rollout filenames retain their UUID even when moved between active, archived,
 * and imported directories. Legacy non-UUID fixtures use their whole filename. */
function codexRolloutIdentity(file: string): string | undefined {
  if (!/^(sessions|archived_sessions)\//.test(file) || !file.endsWith('.jsonl')) return undefined;
  const name = path.posix.basename(file);
  return name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1] ?? name;
}

async function remoteHomeFiles(world: World, absolute: string): Promise<Set<string>> {
  const result = await world.exec('bash', ['-lc',
    `if [ -d ${quote(absolute)} ]; then find ${quote(absolute)} -type f -print; fi`]);
  if (result.code !== 0) throw new Error(`could not inspect remote subscription home: ${result.stderr || result.stdout}`);
  const root = world.handle.root.replace(/\/+$/, '');
  return new Set(result.stdout.split('\n').map((file) => file.trim()).filter(Boolean).map((file) =>
    file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file));
}

/** Repair stale aliases left by earlier seeding, including on host-only retries.
 * Rollouts are append-only: remove a shorter copy only after verifying it is an
 * exact byte prefix of the retained copy. Never guess between divergent histories.
 * Validate the whole selected lineage before removing anything; leave unrelated
 * sessions and Codex's derived SQLite indexes alone. */
export async function reconcileRemoteCodexSessionCopies(world: World, home: RemoteAgentHome,
  session: string): Promise<void> {
  const prefix = `${home.relative}/`;
  const files = [...await remoteHomeFiles(world, home.absolute)]
    .filter((file) => file.startsWith(prefix) && codexRolloutIdentity(file.slice(prefix.length)));
  const seen = new Set<string>();
  const publications: Array<{ session: string; file: string; content: Buffer }> = [];
  let current: string | undefined = session;
  while (current) {
    if (seen.has(current)) throw new CodexHistoryError(`cyclic lineage for ${session}`);
    seen.add(current);
    const candidates: { file: string; content: Buffer }[] = [];
    for (const file of files.filter((candidate) => path.posix.basename(candidate).endsWith(`${current}.jsonl`)))
      candidates.push({ file, content: await world.readFileBuffer(file) });
    if (!candidates.length && current === session) break;
    const kept = selectCodexHistoryCopy(candidates, current);
    publications.push({ session: current, ...kept });
    current = codexHistoryBase(kept.content);
  }
  for (const entry of publications) await publishRemoteCodexHistory(world, home, entry, entry.session);
}

/** Prepare tools on a new rollout identity; never rewrite source bytes. */
export async function ensureRemoteCodexSessionTools(world: World, home: RemoteAgentHome,
  session: string, dynamicTools: unknown[]): Promise<string | undefined> {
  if (!world.writeFileBuffer) return undefined;
  const files = [...await remoteHomeFiles(world, home.absolute)]
    .filter((file) => file.startsWith(`${home.relative}/sessions/`) || file.startsWith(`${home.relative}/archived_sessions/`));
  const snapshot = await prepareCodexHistory(session, async (id) => {
    const candidates = [];
    for (const file of files.filter((candidate) => path.posix.basename(candidate).endsWith(`${id}.jsonl`)))
      candidates.push({ file, content: await world.readFileBuffer(file) });
    return selectCodexHistoryCopy(candidates, id);
  }, { dynamicTools });
  if (!snapshot) return session;
  await publishRemoteCodexHistory(world, home, { file: snapshot.filename, content: snapshot.content }, snapshot.session);
  const { content: _, ...manifest } = snapshot;
  await world.writeFileBuffer(`${home.relative}/.karmax-history-recovery/${session}/${snapshot.session}.json`,
    Buffer.from(JSON.stringify({ original: session, ...manifest })));
  return snapshot.session;
}

/** Copy a native session and its physical history dependencies between worlds.
 * The source remains untouched; unrelated conversations are never copied. */
export async function materializeRemoteSession(source: World, destination: World,
  provider: Provider, session: string, destinationLocalHome: string): Promise<boolean> {
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
    : (file.includes('/sessions/') || file.includes('/archived_sessions/')) && path.posix.basename(file).endsWith(`${session}.jsonl`));
  if (!sourceFile) return false;
  try {
    const pending: { file: string; content: Buffer }[] = [];
    let file: string | undefined = sourceFile;
    const seen = new Set<string>();
    // Stay within the selected source account home while resolving ancestors.
    const sourceHome = sourceFile.split(/\/(?:sessions|archived_sessions)\//)[0];
    while (file) {
      if (seen.has(file)) throw new CodexHistoryError(`cyclic lineage for ${session}`);
      seen.add(file);
      let content = await source.readFileBuffer(file);
      if (provider === 'codex') {
        const id = path.posix.basename(file).match(/([0-9a-f-]{36})\.jsonl$/i)?.[1]
          ?? path.posix.basename(file).replace(/^rollout-/, '').replace(/\.jsonl$/, '');
        const candidates = [];
        for (const candidate of files.filter((candidate) =>
          (candidate.startsWith(`${sourceHome}/sessions/`) || candidate.startsWith(`${sourceHome}/archived_sessions/`))
          && path.posix.basename(candidate).endsWith(`${id}.jsonl`)))
          candidates.push({ file: candidate, content: await source.readFileBuffer(candidate) });
        const kept = selectCodexHistoryCopy(candidates, id);
        file = kept.file; content = kept.content;
      }
      pending.push({ file, content });
      const base = provider === 'codex' ? codexHistoryBase(content) : undefined;
      if (!base) break;
      file = files.find((candidate) =>
        (candidate.startsWith(`${sourceHome}/sessions/`) || candidate.startsWith(`${sourceHome}/archived_sessions/`))
        && path.posix.basename(candidate).endsWith(`${base}.jsonl`));
      if (!file) throw new CodexHistoryError(`missing ancestor ${base}`);
    }
    const destinationPrefix = `${remoteAgentHomeRelative(provider, destinationLocalHome)}/`;
    const runtimeBin = provider === 'codex' ? await ensureRemoteNode(destination) : undefined;
    if (provider === 'codex') await quiesceRemoteCodexHome(destination, path.posix.join(destination.handle.root, destinationPrefix));
    for (const entry of pending.reverse()) {
      if (provider === 'codex') {
        const id = path.posix.basename(entry.file).match(/([0-9a-f-]{36})\.jsonl$/i)?.[1]
          ?? path.posix.basename(entry.file).replace(/^rollout-/, '').replace(/\.jsonl$/, '');
        await publishRemoteCodexHistory(destination, { relative: destinationPrefix.slice(0, -1),
          absolute: path.posix.join(destination.handle.root, destinationPrefix), runtimeBin }, entry, id);
      } else {
        const file = `${destinationPrefix}projects/${claudeCwdSlug(destination.handle.root)}/${session}.jsonl`;
        await destination.writeFileBuffer(file, entry.content);
        const chmod = await destination.exec('chmod', ['600', path.posix.join(destination.handle.root, file)]);
        if (chmod.code !== 0) return false;
      }
    }
    return true;
  } catch (error) {
    if (error instanceof CodexHistoryError) throw error;
    return false;
  }
}

/** Reap an interrupted attempt before any history publication, not merely
 * before starting its replacement. The pid belongs to this account/task home. */
async function quiesceRemoteCodexHome(world: World, absolute: string): Promise<void> {
  const result = await world.exec('bash', ['-lc', `pidfile=${quote(path.posix.join(absolute, 'karmax-agent.pid'))};
if [ -s "$pidfile" ]; then
  old=$(cat "$pidfile"); case "$old" in ''|*[!0-9]*) exit 1;; esac
  cmd=$(tr '\\0' ' ' < "/proc/$old/cmdline" 2>/dev/null || true)
  case "$cmd" in *codex*)
    kill -TERM -- "-$old" 2>/dev/null || kill -TERM "$old" 2>/dev/null || true
    i=0; while kill -0 "$old" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i+1)); done
    if kill -0 "$old" 2>/dev/null; then kill -KILL -- "-$old" 2>/dev/null || kill -KILL "$old" 2>/dev/null || true; fi
    i=0; while kill -0 "$old" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i+1)); done
    if kill -0 "$old" 2>/dev/null; then echo 'previous Codex writer did not stop' >&2; exit 1; fi;;
  esac
  rm -f "$pidfile"
fi`]);
  if (result.code !== 0) throw new CodexHistoryError(`could not stop previous writer: ${result.stderr || result.stdout}`);
}

function claudeCwdSlug(worldPath: string): string { return worldPath.replace(/[^a-zA-Z0-9]/g, '-'); }

/** Browser MCPs execute in the sandbox, while Karmax platform tools cross the
 * existing app-server stdio channel and execute on the trusted host. Remove the
 * old host-specific Karmax MCP table and preserve every other user entry. */
async function seedRemoteCodexConfig(world: World, localHome: string, home: RemoteAgentHome,
  browserMcp?: RemoteAgentHome['browserMcp']): Promise<void> {
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
export async function ensureRemoteBrowser(world: World, browser: BrowserKind, runtimeBin?: string): Promise<NonNullable<RemoteAgentHome['browserMcp']>> {
  const relative = `${REMOTE_ROOT}/tools/browser-${PLAYWRIGHT_VERSION}`;
  const absolute = path.posix.join(world.handle.root, relative);
  const bin = path.posix.join(absolute, 'node_modules/.bin');
  const browserCache = path.posix.join(absolute, 'browsers');
  const marker = `${relative}/ready.json`;
  let chromium = '';
  let resolvedBin = bin;
  let resolvedCache = browserCache;
  const nodeCommand = runtimeBin ? path.posix.join(runtimeBin, 'node') : 'node';
  const pathEnv = runtimeBin ? `${runtimeBin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` : undefined;
  const bakedRoot = '/opt/karmax/browser';
  const bakedCache = '/opt/karmax/browsers';
  const baked = await world.exec('bash', ['-lc', 'test -x /opt/karmax/bin/playwright-mcp && test -x /opt/karmax/bin/chrome-devtools-mcp && test -f /opt/karmax/smoke.mjs']);
  if (baked.code === 0) {
    const executable = await world.exec(nodeCommand, ['-e', "process.stdout.write(require('playwright').chromium.executablePath())"], {
      env: { NODE_PATH: path.posix.join(bakedRoot, 'node_modules'), PLAYWRIGHT_BROWSERS_PATH: bakedCache,
        ...(pathEnv ? { PATH: pathEnv } : {}) }, timeoutMs: 30_000,
    });
    const smoke = await world.exec(nodeCommand, ['/opt/karmax/smoke.mjs'], {
      env: { PLAYWRIGHT_BROWSERS_PATH: bakedCache, ...(pathEnv ? { PATH: pathEnv } : {}) }, timeoutMs: 60_000 });
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
    const install = await timed('bootstrap.browser.install', () => world.exec('bash', ['-lc', [
      ...(runtimeBin ? [`export PATH=${quote(pathEnv!)}\${PATH:+:$PATH}`] : []),
      `mkdir -p ${quote(absolute)} ${quote(browserCache)}`,
      `npm install --prefix ${quote(absolute)} --no-audit --no-fund --omit=dev ${packages.map(quote).join(' ')}`,
      `PLAYWRIGHT_BROWSERS_PATH=${quote(browserCache)} ${quote(path.posix.join(bin, 'playwright'))} install chromium`,
    ].join(' && ')], { timeoutMs: 10 * 60_000 }));
    if (install.code !== 0) throw new Error(`remote browser installation failed: ${install.stderr || install.stdout}`);
    const executable = await world.exec(nodeCommand, ['-e', "process.stdout.write(require('playwright').chromium.executablePath())"], {
      cwd: absolute, env: { NODE_PATH: path.posix.join(absolute, 'node_modules'), PLAYWRIGHT_BROWSERS_PATH: browserCache,
        ...(pathEnv ? { PATH: pathEnv } : {}) }, timeoutMs: 30_000,
    });
    if (executable.code !== 0 || !executable.stdout.trim()) throw new Error(`could not locate remote Chromium: ${executable.stderr}`);
    chromium = executable.stdout.trim();
    const smoke = await world.exec(nodeCommand, ['-e', "require('playwright').chromium.launch({headless:true,args:['--no-sandbox']}).then(async b=>{await b.close()}).catch(e=>{console.error(e);process.exit(1)})"], {
      cwd: absolute, env: { NODE_PATH: path.posix.join(absolute, 'node_modules'), PLAYWRIGHT_BROWSERS_PATH: browserCache,
        ...(pathEnv ? { PATH: pathEnv } : {}) }, timeoutMs: 60_000,
    });
    if (smoke.code !== 0) {
      // Stock provider environments frequently have a package manager and
      // passwordless sudo even when browser libraries are absent. Repair that
      // case once; custom locked-down images still fail with an actionable
      // template/image error instead of handing the agent a broken MCP.
      const dependencyInstall = await world.exec('bash', ['-lc', [
        ...(runtimeBin ? [`export PATH=${quote(pathEnv!)}\${PATH:+:$PATH}`] : []),
        `installer=${quote(path.posix.join(bin, 'playwright'))}`,
        'if [ "$(id -u)" = 0 ]; then "$installer" install-deps chromium',
        'elif command -v sudo >/dev/null 2>&1; then sudo -n "$installer" install-deps chromium',
        'else exit 126',
        'fi',
      ].join('; ')], { env: { PLAYWRIGHT_BROWSERS_PATH: browserCache,
        ...(pathEnv ? { PATH: pathEnv } : {}) }, timeoutMs: 10 * 60_000 });
      const repaired = dependencyInstall.code === 0
        ? await world.exec(nodeCommand, ['-e', "require('playwright').chromium.launch({headless:true,args:['--no-sandbox']}).then(async b=>{await b.close()}).catch(e=>{console.error(e);process.exit(1)})"], {
            cwd: absolute, env: { NODE_PATH: path.posix.join(absolute, 'node_modules'), PLAYWRIGHT_BROWSERS_PATH: browserCache,
              ...(pathEnv ? { PATH: pathEnv } : {}) }, timeoutMs: 60_000,
          })
        : dependencyInstall;
      if (repaired.code !== 0) throw new Error(`remote Chromium readiness probe failed; select a Krmax browser template/image or permit Playwright OS-dependency installation: ${repaired.stderr || repaired.stdout || smoke.stderr || smoke.stdout}`);
    }
    await world.writeFile(marker, JSON.stringify({ chromium, playwright: PLAYWRIGHT_VERSION }));
  }
  const env = { PLAYWRIGHT_BROWSERS_PATH: resolvedCache, ...(pathEnv ? { PATH: pathEnv } : {}) };
  if (browser === 'playwright')
    return { playwright: { command: path.posix.join(resolvedBin, 'playwright-mcp'), args: ['--headless', '--no-sandbox', '--isolated'], env } };
  // Run chrome-devtools-mcp through karmax's launcher so the sandbox browser
  // exposes a loopback DevTools port (PLAN-passwords.md §5B, cloud path): the
  // launcher opens Chromium with --remote-debugging-port and attaches the baked
  // chrome-devtools-mcp bin via --browserUrl. That in-world port is what the
  // gateway's remote fill (world-fill.ts, over world.exec) types into. The
  // launcher also sets vm.overcommit_memory=1 first (KARMAX_CDP_SET_OVERCOMMIT):
  // the default ~512MB E2B sandbox ships overcommit=0, under which Chrome's V8
  // renderer cannot reserve its virtual CodeRange and dies, hanging all
  // page-level CDP (see findings/e2b-headless-chrome-overcommit.md). It
  // self-falls-back to pipe mode if the browser can't open, so tools never
  // regress. The dep-free launcher is shipped into the world here.
  const launcherRel = `${REMOTE_ROOT}/chrome-cdp-launcher.mjs`;
  const launcherSource = fs.readFileSync(fileURLToPath(new URL('../autonomy/chrome-cdp-launcher.mjs', import.meta.url)), 'utf8');
  await world.writeFile(launcherRel, launcherSource);
  return { 'chrome-devtools': {
    command: nodeCommand,
    args: [path.posix.join(world.handle.root, launcherRel)],
    env: {
      ...env,
      KARMAX_CDP_MCP_BIN: path.posix.join(resolvedBin, 'chrome-devtools-mcp'),
      KARMAX_CDP_MCP_VERSION: CHROME_DEVTOOLS_MCP_VERSION,
      KARMAX_CDP_CHROME: chromium,
      KARMAX_CDP_PORT: String(DEFAULT_CDP_PORT),
      KARMAX_CDP_NO_SANDBOX: '1',
      KARMAX_CDP_SET_OVERCOMMIT: '1',
      // A human approval ends the provider/MCP turn, not the browser session.
      // The task-isolated world owns this process and its private profile.
      KARMAX_CDP_KEEP_ALIVE: '1',
      KARMAX_CDP_USER_DATA_DIR: path.posix.join(world.handle.root, REMOTE_ROOT, 'browser-profile'),
    },
  } };
}

/** Bring stock provider images up to the minimum runtime required by the pinned
 * Codex/Claude and browser MCP packages. The runtime is installed from npm into
 * the world injection surface, so users do not need to rebuild their selected
 * E2B template merely because its system Node is stale. Reuse the paired runtime
 * on later turns even if task commands replace system Node/npm. */
export async function ensureRemoteNode(world: World): Promise<string> {
  const acceptable = "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)";
  // Task commands can replace system Node with an npx-cache symlink. Its
  // version still passes while npm's inferred prefix is unusable (task 201).
  // Keep the paired, pinned runtime stable across every turn.
  const root = path.posix.join(world.handle.root, `${REMOTE_ROOT}/tools/node-${REMOTE_NODE_VERSION}`);
  const bin = path.posix.join(root, 'bin');
  const node = path.posix.join(bin, 'node');
  const install = await timed('bootstrap.node.install-or-check', () => world.exec('bash', ['-lc', [
    `mkdir -p ${quote(bin)}`,
    installRemoteNodeCommand(root, REMOTE_NODE_VERSION, REMOTE_NPM_VERSION),
    `ln -sfn ../node_modules/node/bin/node ${quote(node)}`,
    `ln -sfn ../node_modules/npm/bin/npm-cli.js ${quote(path.posix.join(bin, 'npm'))}`,
    `ln -sfn ../node_modules/npm/bin/npx-cli.js ${quote(path.posix.join(bin, 'npx'))}`,
    `${quote(node)} -e ${quote(acceptable)}`,
  ].join(' && ')], { timeoutMs: 5 * 60_000 }));
  if (install.code !== 0) throw new Error(`remote world needs Node 22.12+ and automatic runtime installation failed: ${install.stderr || install.stdout}`);
  // Login shells reset PATH in /etc/profile. Publish the whole paired toolchain
  // at the standard sandbox location, including on resumed worlds.
  const expose = await world.exec('bash', ['-lc', exposeRemoteNodeCommand(bin)]);
  if (expose.code !== 0) throw new Error(`could not make managed Node/npm the sandbox default (requires writable /usr/local/bin or passwordless sudo): ${expose.stderr || expose.stdout}`);
  return bin;
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
