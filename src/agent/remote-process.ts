import { boundedExec, IncompleteOutputError } from '../world/bounded-exec.js';
import { timed } from '../timing/index.js';
import { mapBatches } from '../util/async-batch.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { Provider } from '../domain/types.js';
import { worldWorkingDirectory, type World, type WorldPty, type WorldPtyTermination } from '../world/types.js';
import { fileURLToPath } from 'node:url';
import { CODEX_PACKAGE as PINNED_CODEX_PACKAGE, CodexHistoryError, codexHistoryMetadata, codexRolloutFilename, prepareCodexHistory,
  selectCodexHistoryCopy, validCodexSessionId, type CodexHistoryFile } from './codex-history.js';
import { codexConfigMcpServers } from './codex-config.js';
import { atomicPrivateWrite, localCodexCopies, publishLocalCodexHistory } from './codex-history-files.js';
import { publishRemoteCodexHistory } from './codex-history-remote.js';
import { codexHistoryBase, codexSessionFiles } from './fork.js';
import { CHROME_DEVTOOLS_MCP_VERSION, PLAYWRIGHT_MCP_VERSION, PLAYWRIGHT_VERSION, KARMAX_TOKEN_FILE } from '../autonomy/config-homes.js';
import { DEFAULT_CDP_PORT } from '../autonomy/cdp-endpoint.js';
import { exposeRemoteNodeCommand, installRemoteNodeCommand, PINNED_REMOTE_NODE_VERSION, PINNED_REMOTE_NPM_VERSION } from './remote-node.js';
import { collectStartupProbe, StartupProtocolTrace } from './startup-diagnostics.js';
import { BRAND } from '../domain/brand.js';

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
  /** Codex lineage the sandbox holds byte for byte, by identity (host bytes, sandbox paths). */
  syncedHistory?: ReadonlyMap<string, CodexHistoryFile>;
  /** Every MCP server the seeded Codex config defines, when karmax can tell without asking Codex. */
  configuredMcpServers?: string[];
}

/** Seed the leased subscription credentials/config into this task's persistent
 * sandbox. Provider session/cache directories are deliberately left sandbox-
 * local. OAuth remains control-plane-owned: every turn replaces the sandbox
 * projection and withholds rotating refresh tokens, so parallel task worlds
 * cannot fork and revoke one shared login's token family.
 *
 * One sandbox command prepares the runtime, stops a previous writer and
 * measures the native history already there (LT-1, AD-12), while the host's
 * config files upload beside it. History the sandbox already holds byte for
 * byte is not sent again (AD-13). */
export async function seedRemoteAgentHome(world: World, provider: Provider, localHome: string,
  session?: string, browserOverride?: 'none', onStartupStep?: (step: string) => Promise<void>): Promise<RemoteAgentHome> {
  if (!localHome) throw new Error(`${provider} subscription has no config home to seed`);
  const relative = remoteAgentHomeRelative(provider, localHome);
  const absolute = path.posix.join(world.handle.root, relative);
  await onStartupStep?.('prepare-runtime');
  const history = hostHistoryFiles(localHome, provider, session);
  const browser = browserOverride === 'none' ? undefined : configuredBrowser(localHome, provider);
  // Without a browser the Codex config is known now and uploads with the rest.
  const codexConfig = provider === 'codex' && !browser ? remoteCodexConfig(localHome) : undefined;
  const files = [...configFiles(localHome).filter(file => provider !== 'codex' || file.relative !== 'config.toml'),
    ...(codexConfig === undefined ? [] : [{ relative: 'config.toml', content: Buffer.from(codexConfig) }])];
  async function seed(file: { relative: string; content: Buffer }) {
    const target = `${relative}/${file.relative.split(path.sep).join('/')}`;
    if (!world.writeFileBuffer) throw new Error('remote world cannot receive subscription config files');
    const controlledAuth = isControlPlaneAuth(provider, file.relative);
    const content = controlledAuth ? remoteAuthProjection(provider, file.relative, file.content) : file.content;
    await world.writeFileBuffer(target, content);
  }
  const request = bootstrapRequest(world, provider, absolute, session, history);
  // The bootstrap also stops a previous writer and protects the home, so
  // nothing below lands before either. One prewarmed for this very home,
  // session and history is used once; a failed one is rerun at once, and one
  // prewarmed for something else is not waited for: the runtime installation
  // it may still be running is locked in the sandbox, and it stops only a
  // writer launched before it was requested, never the agent this seed starts.
  const early = bootstraps.get(world);
  const reused = early?.key === request.key ? early!.bootstrap.catch(() => undefined) : undefined;
  const own = (async () => (await reused) ?? runBootstrap(world, request))();
  bootstraps.set(world, { bootstrap: own, ...(early?.browser ? { browser: early.browser } : {}) });
  const bootstrap = await timed('bootstrap.prepare', () => own);
  const home: RemoteAgentHome = { absolute, relative, runtimeBin: bootstrap.runtimeBin };
  const inventory = trustedInventory(world, provider, session, bootstrap.history);
  const synced = provider === 'codex' ? syncedCodexHistory(relative, history, inventory) : undefined;
  if (synced) home.syncedHistory = synced;
  await onStartupStep?.('prepare-config');
  await Promise.all([
    // Ordinary files have distinct paths and no live reader until startup.
    timed('bootstrap.seed-files', () => mapBatches(files, seed)),
    // A safety net, not a requirement: never fail a turn over it.
    installMemoryGuard(world).catch(() => undefined),
    provider !== 'codex'
      // A transcript the sandbox holds already, or has extended, stays as it is.
      ? timed('bootstrap.history', () => mapBatches(history.filter(file => {
        const copy = inventory?.find(candidate => candidate.file === file.relative.split(path.sep).join('/'));
        return !(copy && copy.size >= file.content.length && copy.prefix === sha256(file.content));
      }), seed))
      // Codex resolves rollout identity across the entire home, not by directory.
      // A cloud fork may already have a newer copy under sessions/forked while the
      // host cache still has an older dated copy. Never seed a second identity.
      // Rollout publication reconciles shared session identity: keep it serialized.
      : synced ? undefined : timed('bootstrap.history', async () => {
        for (const file of history)
          await publishRemoteCodexHistory(world, home, { file: file.relative, content: file.content }, codexFileIdentity(file.relative));
        // Retries may restore exclusively from the host after the source world has
        // been deleted. Repair prior duplicate copies here too, before Codex opens its
        // persistent index; live-world transfer is not guaranteed to run.
        if (session) await reconcileRemoteCodexSessionCopies(world, home, session);
      }),
  ]);
  await onStartupStep?.('prepare-browser');
  const browserMcp = browser ? await timed('bootstrap.browser', () => ensureRemoteBrowser(world, browser, bootstrap.runtimeBin)) : undefined;
  const seededConfig = codexConfig ?? (provider === 'codex' ? remoteCodexConfig(localHome, browserMcp) : undefined);
  if (provider === 'codex' && codexConfig === undefined)
    await timed('bootstrap.config', () => world.writeFile(`${relative}/config.toml`, seededConfig!));
  // Codex reads MCP servers from this config and, when present, a system layer
  // karmax did not write; only then must Codex be asked for their names.
  const configuredMcpServers = seededConfig !== undefined && !bootstrap.systemCodexConfig ? codexConfigMcpServers(seededConfig) : undefined;
  return { ...home, ...(browserMcp ? { browserMcp } : {}), ...(configuredMcpServers ? { configuredMcpServers } : {}) };
}

/** Start the sandbox half of this turn's start-up while the caller prepares
 * its prompt (LT-1, LT-22): the runtime, the agent home when the turn runs on
 * a subscription (`localHome`), and the browser tools its MCP connections (or,
 * without a selection, the account's own config) name, including a first
 * turn's browser smoke test. The seed reuses the home half when provider,
 * home and session match; connection preparation reuses the rest. */
export function prewarmRemoteAgentHome(world: World, provider: Provider, localHome: string | undefined, session?: string,
  mcpConnections?: readonly string[]): void {
  const runtimeWorld = world.withoutProjectEnvironment?.() ?? world;
  if (!isRemoteAgentWorld(runtimeWorld) || bootstraps.has(runtimeWorld)) return;
  const browser = mcpConnections ? mcpConnections.some((id) => id.startsWith('browser:')) : !!localHome && !!configuredBrowser(localHome, provider);
  if (!localHome && !browser) return;
  try {
    const request: BootstrapRequest = localHome
      ? bootstrapRequest(runtimeWorld, provider, path.posix.join(runtimeWorld.handle.root, remoteAgentHomeRelative(provider, localHome)),
        session, hostHistoryFiles(localHome, provider, session))
      : { key: '' };
    const bootstrap = runBootstrap(runtimeWorld, { ...request, browser });
    bootstrap.catch(() => undefined);
    const entry: WorldBootstrap = { ...(localHome ? { key: request.key } : {}), bootstrap };
    if (browser) {
      entry.browser = bootstrap.then((prepared) => readyBrowser(runtimeWorld, prepared.runtimeBin, prepared.browser).catch((error) => {
        if (error && typeof error === 'object') browserFailures.add(error);
        throw error;
      }));
      entry.browser.catch(() => undefined);
    }
    bootstraps.set(runtimeWorld, entry);
  } catch { /* the seed and connection preparation report whatever made this fail */ }
}

/** This turn's bootstrap of a world. World objects live for one activity, so
 * nothing here outlives the turn that measured it. */
interface WorldBootstrap {
  /** The home, session and history a prewarmed bootstrap measured, until a seed uses it. */
  key?: string;
  bootstrap: Promise<RemoteBootstrap>;
  browser?: Promise<BrowserTools>;
}
const bootstraps = new WeakMap<World, WorldBootstrap>();
/** Browser readiness a prewarm tried and failed: reported, not repeated. */
const browserFailures = new WeakSet<object>();

/** The connection to the sandbox broke, by the error's structure alone: a
 * repair's message quotes the sandbox's output, which may name any error, and
 * a command that timed out may still be running there. */
function lostConnection(error: unknown): boolean {
  for (let current = error, depth = 0; current && typeof current === 'object' && depth < 4; current = (current as { cause?: unknown }).cause, depth++) {
    const { code, name } = current as { code?: unknown; name?: unknown };
    if (['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN'].includes(String(code))
      || name === 'SandboxNotFoundError') return true;
  }
  return false;
}

const workDirectory = (world: World) => path.posix.join(world.handle.root, '.karmax-injection/work-env');

/** The world's private work-environment directory, when this turn's
 * bootstrap (which also git-excludes it) has already made it (AD-12). */
export async function preparedRemoteWorkDirectory(world: World): Promise<string | undefined> {
  const runtimeWorld = world.withoutProjectEnvironment?.() ?? world;
  const prepared = await bootstraps.get(runtimeWorld)?.bootstrap.catch(() => undefined);
  return prepared?.workDirectory ? workDirectory(runtimeWorld) : undefined;
}

/** Every copy of a native history the sandbox holds, measured in place. */
export interface RemoteHistoryCopy {
  /** Relative to the agent home. */
  file: string;
  /** Codex rollout identity. */
  id?: string;
  size: number;
  sha256: string;
  /** Digest of the first bytes the host already holds of it, when this copy is at least that long. */
  prefix?: string;
}

interface RemoteBootstrap {
  runtimeBin: string;
  /** Undefined when the inventory did not run; callers then read whole files. */
  history?: RemoteHistoryCopy[];
  /** Codex also loads /etc/codex, which karmax did not write. */
  systemCodexConfig: boolean;
  /** The world's private work-environment directory exists (AD-12). */
  workDirectory: boolean;
  /** Undefined when the probe did not run; readyBrowser then probes step by step. */
  browser?: BrowserProbe;
}

interface BootstrapRequest {
  key: string;
  /** The agent home: its previous writer is stopped (Codex) and it is made private. */
  home?: string;
  quiesce?: boolean;
  inventory?: HistoryInventoryRequest;
  systemCodexConfig?: boolean;
  /** Probe the browser tools' readiness (LT-22). */
  browser?: boolean;
}

interface HistoryInventoryRequest { home: string; provider: Provider; session: string; known: Record<string, number> }

function bootstrapRequest(world: World, provider: Provider, absolute: string, session: string | undefined,
  history: Array<{ relative: string; content: Buffer }>): BootstrapRequest {
  const known: Record<string, number> = {};
  for (const file of history) known[historyKey(provider, file.relative)] = file.content.length;
  return {
    key: JSON.stringify([world.handle.root, provider, absolute, session ?? null, known]),
    home: absolute,
    ...(provider === 'codex' ? { quiesce: true, systemCodexConfig: true } : {}),
    ...(session ? { inventory: { home: absolute, provider, session, known } } : {}),
  };
}

const historyKey = (provider: Provider, relative: string) =>
  provider === 'codex' ? codexFileIdentity(relative) : relative.split(path.sep).join('/');

const codexFileIdentity = (file: string) => path.posix.basename(file.split(path.sep).join('/')).replace(/\.jsonl$/, '').match(/([0-9a-f-]{36})$/i)?.[1]
  ?? path.posix.basename(file.split(path.sep).join('/')).replace(/^rollout-/, '').replace(/\.jsonl$/, '');

const sha256 = (content: Buffer) => crypto.createHash('sha256').update(content).digest('hex');

/** The host lineage, when the sandbox holds exactly one identical copy of each
 * rollout in it and nothing else of that lineage: nothing needs publishing, and
 * the host bytes stand in for the sandbox's own. */
function syncedCodexHistory(relative: string, history: Array<{ relative: string; content: Buffer }>,
  copies?: RemoteHistoryCopy[]): Map<string, CodexHistoryFile> | undefined {
  if (!copies || !history.length) return undefined;
  const synced = new Map<string, CodexHistoryFile>();
  for (const file of history) {
    const id = codexFileIdentity(file.relative);
    const remote = copies.filter(copy => copy.id === id);
    if (remote.length !== 1 || remote[0]!.size !== file.content.length || remote[0]!.prefix !== sha256(file.content)) return undefined;
    synced.set(id, { file: `${relative}/${remote[0]!.file}`, content: file.content });
  }
  return copies.every(copy => copy.id && synced.has(copy.id)) ? synced : undefined;
}

// Exit statuses by which the bootstrap command names the step that failed.
const BOOTSTRAP_NODE = 64, BOOTSTRAP_EXPOSE = 65, BOOTSTRAP_QUIESCE = 66, BOOTSTRAP_PROTECT = 67, BOOTSTRAP_LOCKED = 68;
/** sandboxLock's status when another holder kept the lock past its wait. */
const LOCK_BUSY = 75;

/** Shell that holds an exclusive sandbox lock on descriptor 9 until the
 * enclosing (sub)shell ends: one installer at a time, including an abandoned
 * turn's still-running one. The kernel releases it with its holder, however
 * that ends. BusyBox flock has no -w, so `timeout` bounds the wait; without
 * flock the step runs unlocked, as before. */
function sandboxLock(file: string, seconds: number): string {
  const wait = Number(process.env.KARMAX_REMOTE_INSTALL_LOCK_SECONDS) || seconds;
  return [
    `exec 9>>${quote(file)} || exit 1`,
    'if command -v flock >/dev/null 2>&1; then',
    `  if command -v timeout >/dev/null 2>&1; then timeout ${wait} flock 9; else flock 9; fi`,
    `  case $? in 0) ;; 124|143) exit ${LOCK_BUSY};; *) exit 1;; esac`,
    'fi',
  ].join('\n');
}
const HISTORY_MARKER = 'KARMAX_HISTORY_INVENTORY ';
const BROWSER_MARKER = 'KARMAX_BROWSER_PROBE ';
const SYSTEM_CODEX_CONFIG = 'KARMAX_SYSTEM_CODEX_CONFIG';
const WORK_DIRECTORY_READY = 'KARMAX_WORK_DIRECTORY_READY';

async function runBootstrap(world: World, request: Omit<BootstrapRequest, 'key'>): Promise<RemoteBootstrap> {
  const issued = Date.now();
  const runtime = remoteNodeRuntime(world);
  const node = path.posix.join(runtime.bin, 'node');
  const command = [
    `( ${runtime.install} ) || { [ $? = ${LOCK_BUSY} ] && exit ${BOOTSTRAP_LOCKED}; exit ${BOOTSTRAP_NODE}; }`,
    // Login shells reset PATH in /etc/profile. Publish the whole paired toolchain
    // at the standard sandbox location, including on resumed worlds.
    `( ${runtime.expose} ) || exit ${BOOTSTRAP_EXPOSE}`,
    // A single-repo world's root is itself a checkout. Keep injected auth out of
    // `git add -A` without modifying the user's tracked .gitignore.
    "exclude=$(git rev-parse --git-path info/exclude 2>/dev/null) && mkdir -p \"$(dirname \"$exclude\")\" && { grep -qxF '.karmax-injection/' \"$exclude\" 2>/dev/null || printf '%s\\n' '.karmax-injection/' >> \"$exclude\"; } || true",
    ...(request.home && request.quiesce ? [`( ${quiesceCommand(request.home, issued)} ) || exit ${BOOTSTRAP_QUIESCE}`] : []),
    // Credentials land only inside private directories: upload creates files
    // and directories with the sandbox's default modes.
    ...(request.home ? [`( mkdir -p ${quote(request.home)} && find ${quote(request.home)} -type d -exec chmod 700 {} + && find ${quote(request.home)} -type f -exec chmod 600 {} + ) || exit ${BOOTSTRAP_PROTECT}`,
      // So do Claude's work environments. Only Claude uses them, and it makes
      // the directory itself when this could not: never fail a turn over it.
      `( mkdir -p ${quote(workDirectory(world))} && chmod 700 ${quote(workDirectory(world))} ) 2>/dev/null && printf '\\n%s\\n' ${WORK_DIRECTORY_READY}`] : []),
    ...(request.inventory ? [`${historyInventoryCommand(node, request.inventory)} || true`] : []),
    ...(request.browser ? [`${browserProbeCommand(world, node)} || true`] : []),
    ...(request.systemCodexConfig ? [`if [ -e '/etc/codex' ]; then printf '\\n%s\\n' ${SYSTEM_CODEX_CONFIG}; fi`] : []),
    'exit 0',
  ].join('\n');
  const result = await world.exec('bash', ['-lc', command], { timeoutMs: 5 * 60_000 });
  const detail = result.stderr || result.stdout;
  if (result.code === BOOTSTRAP_NODE) throw new Error(`remote world needs Node 22.12+ and automatic runtime installation failed: ${detail}`);
  if (result.code === BOOTSTRAP_LOCKED)
    throw new Error('the managed runtime is still being installed by another turn in this sandbox; its lock stayed busy');
  if (result.code === BOOTSTRAP_EXPOSE)
    throw new Error(`could not make managed Node/npm the sandbox default (requires writable /usr/local/bin or passwordless sudo): ${detail}`);
  if (result.code === BOOTSTRAP_QUIESCE) throw new CodexHistoryError(`could not stop previous writer: ${detail}`);
  if (result.code === BOOTSTRAP_PROTECT) throw new Error(`could not protect remote subscription files: ${detail}`);
  // A killed command (137, 143) or a failing login profile is not a Node problem.
  if (result.code !== 0) throw new Error(`remote runtime bootstrap failed (status ${result.code}): ${detail}`);
  const lines = result.stdout.split('\n').map((line) => line.trim());
  return { runtimeBin: runtime.bin, systemCodexConfig: lines.includes(SYSTEM_CODEX_CONFIG), workDirectory: lines.includes(WORK_DIRECTORY_READY),
    ...(request.inventory ? { history: parseHistoryInventory(result.stdout) } : {}),
    ...(request.browser ? { browser: parseBrowserProbe(result.stdout) } : {}) };
}

// Runs in the sandbox with the paired Node: find every copy of the session's
// history (and, for Codex, its lineage), and hash each where it lies.
const REMOTE_HISTORY_INVENTORY = String.raw`
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const [home, provider, session, knownJson] = process.argv.slice(1);
const known = JSON.parse(knownJson);
const found = [];
function walk(dir, depth) {
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() && depth < 8) walk(file, depth + 1);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(file);
    if (found.length > 4096) throw new Error('too many history files');
  }
}
function measure(file, key) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, whole = crypto.createHash('sha256');
    const limit = Number.isSafeInteger(known[key]) && known[key] <= size ? known[key] : -1;
    const prefix = limit >= 0 ? crypto.createHash('sha256') : undefined;
    const buffer = Buffer.alloc(1 << 20);
    let first = [], firstDone = false;
    for (let offset = 0; offset < size;) {
      const bytes = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!bytes) break;
      const chunk = buffer.subarray(0, bytes);
      if (prefix && offset < limit) prefix.update(chunk.subarray(0, Math.min(bytes, limit - offset)));
      if (!firstDone) { const end = chunk.indexOf(10); first.push(Buffer.from(end < 0 ? chunk : chunk.subarray(0, end))); firstDone = end >= 0 || offset + bytes > 2097152; }
      whole.update(chunk);
      offset += bytes;
    }
    let base;
    try { base = JSON.parse(Buffer.concat(first).toString('utf8'))?.payload?.history_base?.thread_id; } catch {}
    return { file: path.relative(home, file).split(path.sep).join('/'), size, sha256: whole.digest('hex'),
      ...(prefix ? { prefix: prefix.digest('hex') } : {}), ...(typeof base === 'string' ? { base } : {}) };
  } finally { fs.closeSync(fd); }
}
const copies = [];
if (provider === 'codex') {
  walk(path.join(home, 'sessions'), 0); walk(path.join(home, 'archived_sessions'), 0);
  const pending = [session], seen = new Set();
  while (pending.length) {
    const id = pending.pop();
    if (seen.has(id) || !/^[a-zA-Z0-9_-]{8,160}$/.test(id)) continue;
    seen.add(id);
    const mine = found.filter(file => path.basename(file).endsWith(id + '.jsonl')).map(file => ({ id, ...measure(file, id) }));
    copies.push(...mine);
    const largest = mine.sort((a, b) => b.size - a.size)[0];
    if (largest?.base) pending.push(largest.base);
  }
} else {
  walk(path.join(home, 'projects'), 0);
  for (const file of found) if (path.basename(file) === session + '.jsonl') copies.push(measure(file, path.relative(home, file).split(path.sep).join('/')));
}
process.stdout.write('\n${HISTORY_MARKER}' + JSON.stringify(copies.map(({ base, ...copy }) => copy)) + '\n');
`;

function historyInventoryCommand(node: string, request: HistoryInventoryRequest): string {
  return [node, '-e', REMOTE_HISTORY_INVENTORY, request.home, request.provider, request.session, JSON.stringify(request.known)]
    .map(quote).join(' ');
}

function parseHistoryInventory(stdout: string): RemoteHistoryCopy[] | undefined {
  const line = stdout.split('\n').reverse().find(candidate => candidate.startsWith(HISTORY_MARKER));
  if (!line) return undefined;
  let copies: unknown;
  try { copies = JSON.parse(line.slice(HISTORY_MARKER.length)); } catch { return undefined; }
  const hex = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  if (!Array.isArray(copies) || !copies.every((copy: any) => copy && typeof copy.file === 'string'
    && !copy.file.split('/').some((segment: string) => !segment || segment === '.' || segment === '..')
    && Number.isSafeInteger(copy.size) && copy.size >= 0 && hex(copy.sha256) && (copy.prefix === undefined || hex(copy.prefix))
    && (copy.id === undefined || typeof copy.id === 'string'))) return undefined;
  return copies as RemoteHistoryCopy[];
}

/** The inventory, when every entry is one the host would have looked for
 * itself: this session's transcript in this working directory's project
 * (Claude), or a rollout whose file name carries the identity it claims
 * (Codex). The sandbox's own Node prints it, and the agent can replace that,
 * so an entry must never choose a host path; any other entry means the
 * sandbox cannot be measured and whole files are read instead. */
function trustedInventory(world: World, provider: Provider, session: string | undefined,
  copies?: RemoteHistoryCopy[]): RemoteHistoryCopy[] | undefined {
  if (!copies || !session) return undefined;
  const transcript = `projects/${claudeCwdSlug(worldWorkingDirectory(world.handle))}/${session}.jsonl`;
  return copies.every((copy) => provider === 'codex'
    ? typeof copy.id === 'string' && validCodexSessionId(copy.id) && codexRolloutIdentity(copy.file) === copy.id
    : copy.id === undefined && copy.file === transcript) ? copies : undefined;
}

/** Measure the sandbox's copies of a session's history against the host's. */
async function remoteHistoryInventory(world: World, home: RemoteAgentHome, provider: Provider, session: string,
  known: Record<string, number>): Promise<RemoteHistoryCopy[] | undefined> {
  try {
    const node = home.runtimeBin ? path.posix.join(home.runtimeBin, 'node') : 'node';
    const result = await world.exec('bash', ['-c', historyInventoryCommand(node, { home: home.absolute, provider, session, known })]);
    return result.code === 0 ? trustedInventory(world, provider, session, parseHistoryInventory(result.stdout)) : undefined;
  } catch { return undefined; }
}

/** A world can rotate between several subscription accounts. Keep each native
 * home isolated by the stable control-plane config-home identity so preserving
 * refreshed auth for account A can never cause a later lease for B to run as A. */
export function remoteAgentHomeRelative(provider: Provider, localHome: string): string {
  const identity = crypto.createHash('sha256').update(path.resolve(localHome)).digest('hex').slice(0, 20);
  return `${REMOTE_ROOT}/${provider}/${identity}`;
}

/** The most one verified terminal read carries; longer reads are split. */
const HISTORY_READ_BYTES = 16 * 1024 * 1024;
/** The largest history file the host takes from a sandbox, and the most one
 * sync transfers. Native histories of long tasks reach 177 MiB on tavya.io
 * (2026-09-30), and the host already holds a whole history when it seeds one. */
const HISTORY_FILE_BYTES = 512 * 1024 * 1024;
const HISTORY_TOTAL_BYTES = 512 * 1024 * 1024;
const HISTORY_FILE_COUNT = 64;
type HistoryBudget = { bytes: number; files: number };

const VERIFIED_READ_ATTEMPTS = 3;

/** A terminal can lose a command's final output while still reporting success
 * (node-pty discards unread bytes 200 ms after its child exits: AD-30), and a
 * truncated base64 stream still decodes. History built from such a read drops
 * the newest turns or breaks a child's recorded cutoff, so the sandbox reports
 * the length and digest of exactly what it printed; an incomplete read is
 * retried, never used. */
async function verifiedRemoteOutput(world: World, command: string, maxBytes: number, action: string): Promise<Buffer> {
  const script = [
    'set -o pipefail',
    'out=$(mktemp) || exit',
    `trap 'rm -f -- "$out"' EXIT`,
    `{ ${command}\n} > "$out" || exit`,
    `cat -- "$out" && printf '\\n%s %s\\n' "$(wc -c < "$out")" "$(sha256sum < "$out" | cut -d ' ' -f 1)"`,
  ].join('\n');
  for (let attempt = 1; ; attempt++) {
    let result;
    try { result = await boundedExec(world, script, { maxBytes: maxBytes + 128, timeoutMs: 60_000 }); }
    catch (error) {
      // The terminal ended before the end-of-output marker: an incomplete read.
      if (!(error instanceof IncompleteOutputError)) throw error;
      if (attempt >= VERIFIED_READ_ATTEMPTS) throw new Error(`could not ${action}: output was incomplete after ${attempt} reads`);
      continue;
    }
    if (result.code !== 0) throw new Error(`could not ${action}: ${result.stderr || result.stdout.slice(0, 512)}`);
    const printed = Buffer.from(result.stdout);
    const trailer = /\n *(\d+) ([0-9a-f]{64})\r?\n?$/.exec(result.stdout);
    const length = Number(trailer?.[1]);
    const end = trailer ? printed.length - Buffer.byteLength(trailer[0]) : -1;
    // Anything a login shell printed before the command precedes its output.
    const output = trailer && length <= end ? printed.subarray(end - length, end) : undefined;
    if (output && crypto.createHash('sha256').update(output).digest('hex') === trailer![2]) return output;
    if (attempt >= VERIFIED_READ_ATTEMPTS) throw new Error(`could not ${action}: output was incomplete after ${attempt} reads`);
  }
}

async function readRemoteHistory(world: World, file: string, budget: HistoryBudget): Promise<Buffer> {
  if (++budget.files > HISTORY_FILE_COUNT) throw new Error('remote history file count limit exceeded');
  const absolute = quote(path.posix.join(world.handle.root, file));
  // Refuse an oversized history before any of it crosses.
  const size = Number((await verifiedRemoteOutput(world, `wc -c < ${absolute}`, 1024, 'measure remote history')).toString().trim());
  if (!Number.isSafeInteger(size) || size > HISTORY_FILE_BYTES || budget.bytes + size > HISTORY_TOTAL_BYTES)
    throw new Error('remote history byte limit exceeded');
  const chunks: Buffer[] = [];
  let read = 0;
  for (;;) {
    const chunk = await readRemoteChunk(world, file, read, HISTORY_READ_BYTES);
    chunks.push(chunk);
    read += chunk.length;
    budget.bytes += chunk.length;
    if (read > HISTORY_FILE_BYTES || budget.bytes > HISTORY_TOTAL_BYTES) throw new Error('remote history byte limit exceeded');
    if (chunk.length < HISTORY_READ_BYTES) return Buffer.concat(chunks);
  }
}

/** Export only this turn's conversation and physical Codex history dependencies.
 * Credentials are host-owned; a task world must never replace another session. */
export async function syncRemoteAgentHome(world: World, provider: Provider, remoteHome: RemoteAgentHome,
  localHome: string, session?: string): Promise<void> {
  if (!localHome || !session) return;
  try {
    if (await exportHistoryTails(world, provider, remoteHome, localHome, session, { bytes: 0, files: 0 })) return;
  } catch (error) {
    // A refused history publishes nothing either way; anything else (a lost
    // read, a shell that printed too much) is retried by whole verified reads.
    if (error instanceof CodexHistoryError) throw error;
  }
  const budget: HistoryBudget = { bytes: 0, files: 0 };
  const homePrefix = `${remoteHome.relative}/`;
  const files = [...await remoteHomeFiles(world, remoteHome.absolute)].filter(file => {
    if (!file.startsWith(homePrefix)) return false;
    const relative = file.slice(homePrefix.length);
    return !relative.split('/').some(segment => !segment || segment === '.' || segment === '..');
  });
  const pending = [session];
  const seen = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (seen.has(current)) throw new CodexHistoryError(`cyclic lineage for ${session}`);
    seen.add(current);
    const matches = files.filter(file => {
      const relative = file.slice(homePrefix.length);
      return provider === 'codex'
        ? !!codexRolloutIdentity(relative) && path.posix.basename(relative).endsWith(`${current}.jsonl`)
        : relative.startsWith('projects/') && path.posix.basename(relative) === `${current}.jsonl`;
    });
    const candidates = [];
    for (const file of matches) candidates.push({ file, content: await readRemoteHistory(world, file, budget) });
    if (!candidates.length) {
      if (current !== session) throw new CodexHistoryError(`missing ancestor ${current}`);
      continue;
    }
    if (provider === 'codex') {
      const kept = selectCodexHistoryCopy(candidates, current);
      publishLocalCodexHistory(localHome, { file: kept.file.slice(homePrefix.length), content: kept.content }, current);
      const base = codexHistoryBase(kept.content);
      if (base) pending.push(base);
    } else {
      for (const candidate of candidates) {
        const destination = path.resolve(localHome, candidate.file.slice(homePrefix.length));
        if (!destination.startsWith(path.resolve(localHome) + path.sep)) continue;
        if (fs.existsSync(destination)) {
          const local = fs.readFileSync(destination);
          if (local.subarray(0, candidate.content.length).equals(candidate.content)) continue;
          if (!candidate.content.subarray(0, local.length).equals(local))
            throw new Error(`divergent Claude history for ${current}`);
        }
        atomicPrivateWrite(destination, candidate.content);
      }
    }
  }
}

/** Export only what the sandbox appended to the host's copy (AD-12, AD-13).
 * One command measures every copy of the session's history in place; bytes
 * past a prefix the host already holds, proven by digest, are all that cross.
 * False when the sandbox could not be measured: the caller reads whole files. */
async function exportHistoryTails(world: World, provider: Provider, remoteHome: RemoteAgentHome,
  localHome: string, session: string, budget: HistoryBudget): Promise<boolean> {
  const local = new Map<string, Buffer | undefined>();
  if (provider !== 'codex')
    for (const file of hostHistoryFiles(localHome, provider, session)) local.set(file.relative.split(path.sep).join('/'), file.content);
  const hostCopy = (key: string) => {
    if (!local.has(key)) local.set(key, provider === 'codex' ? localCodexHistory(localHome, key) : undefined);
    return local.get(key);
  };
  const measure = (keys: string[]) => Object.fromEntries(keys.flatMap((key) => {
    const content = hostCopy(key);
    return content ? [[key, content.length]] : [];
  }));
  let known = measure(provider === 'codex' ? hostCodexLineage(localHome, session) : [...local.keys()]);
  let copies = await remoteHistoryInventory(world, remoteHome, provider, session, known);
  if (!copies) return false;
  // A new thread's ancestors are usually on the host already; measure them too.
  const unmeasured = provider === 'codex' ? [...new Set(copies.map((copy) => copy.id!))].filter((id) => !(id in known)) : [];
  if (Object.keys(measure(unmeasured)).length) {
    known = { ...known, ...measure(unmeasured) };
    copies = await remoteHistoryInventory(world, remoteHome, provider, session, known);
    if (!copies) return false;
  }
  const fetch = async (copy: RemoteHistoryCopy, host?: Buffer): Promise<Buffer> => {
    if (++budget.files > HISTORY_FILE_COUNT) throw new Error('remote history file count limit exceeded');
    const offset = host && copy.size > host.length && copy.prefix === sha256(host) ? host.length : 0;
    // Only the bytes the host lacks cross, so only they count against a sync.
    budget.bytes += copy.size - offset;
    if (copy.size > HISTORY_FILE_BYTES || budget.bytes > HISTORY_TOTAL_BYTES) throw new Error('remote history byte limit exceeded');
    const file = `${remoteHome.relative}/${copy.file}`;
    const tail = await readRemoteHistoryRange(world, file, offset, copy.size - offset);
    const content = offset ? Buffer.concat([host!, tail]) : tail;
    if (sha256(content) !== copy.sha256) throw new Error('could not read remote history: the sandbox copy changed while it was read');
    return content;
  };
  if (provider !== 'codex') {
    for (const copy of copies) {
      const destination = path.resolve(localHome, copy.file);
      if (!destination.startsWith(path.resolve(localHome) + path.sep)) continue;
      const host = hostCopy(copy.file);
      if (host && copy.size <= host.length && sha256(host.subarray(0, copy.size)) === copy.sha256) continue;
      if (host && !(copy.size > host.length && copy.prefix === sha256(host))) throw new Error(`divergent Claude history for ${session}`);
      atomicPrivateWrite(destination, await fetch(copy, host));
    }
    return true;
  }
  const pending = [session];
  const seen = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) throw new CodexHistoryError(`cyclic lineage for ${session}`);
    seen.add(id);
    const matches = copies.filter((copy) => copy.id === id);
    if (!matches.length) {
      if (id !== session) throw new CodexHistoryError(`missing ancestor ${id}`);
      continue;
    }
    const host = hostCopy(id);
    let content = host;
    if (matches.length !== 1 || !host || matches[0]!.size !== host.length || matches[0]!.sha256 !== sha256(host)) {
      const candidates = [];
      for (const copy of matches) candidates.push({ file: copy.file, content: await fetch(copy, host) });
      const kept = selectCodexHistoryCopy(candidates, id);
      // A new host copy is named after its identity, never after the sandbox's path.
      let name: string;
      try { name = codexRolloutFilename(codexHistoryMetadata(kept.content).timestamp, id); }
      catch { name = codexRolloutFilename(undefined, id); }
      publishLocalCodexHistory(localHome, { file: path.posix.join('sessions/forked', name), content: kept.content }, id);
      content = kept.content;
    }
    const base = codexHistoryBase(content!);
    if (base) pending.push(base);
  }
  return true;
}

async function readRemoteHistoryRange(world: World, file: string, offset: number, length: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for (let read = 0; read < length;) {
    const want = Math.min(HISTORY_READ_BYTES, length - read);
    const chunk = await readRemoteChunk(world, file, offset + read, want);
    if (chunk.length !== want) throw new Error('could not read remote history: the sandbox copy changed while it was read');
    chunks.push(chunk);
    read += want;
  }
  return Buffer.concat(chunks);
}

/** Up to `length` (at most one read's worth) bytes of a sandbox file from `offset`. */
async function readRemoteChunk(world: World, file: string, offset: number, length: number): Promise<Buffer> {
  // The capture allows a full read's worth whatever `length` is: anything a
  // login shell prints before the output must not fail a short read. `head`
  // reads the file itself: as the pipe's reader it would stop early, and the
  // writer's SIGPIPE fails the read under pipefail.
  const encoded = await verifiedRemoteOutput(world,
    `head -c ${offset + length} -- ${quote(path.posix.join(world.handle.root, file))} | tail -c +${offset + 1} | base64 -w 0`,
    Math.ceil((HISTORY_READ_BYTES + 1) / 3) * 4, 'read remote history');
  return Buffer.from(encoded.toString('latin1'), 'base64');
}

function localCodexHistory(localHome: string, id: string): Buffer | undefined {
  if (!validCodexSessionId(id)) return undefined;
  const copies = localCodexCopies(localHome, id);
  return copies.length ? selectCodexHistoryCopy(copies, id).content : undefined;
}

function hostCodexLineage(localHome: string, session: string): string[] {
  try { return (codexSessionFiles({ session, forkHome: localHome }) ?? []).map(codexFileIdentity); } catch { return []; }
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

/** Remote session export is a durability enhancement, not the provider turn's
 * terminal result. Return a diagnostic instead of throwing so a control-plane
 * timeout or a refused history (CodexHistoryError: nothing is published) during
 * cleanup cannot replace a verified successful turn (AD-11). */
export async function syncRemoteAgentHomeBestEffort(world: World, provider: Provider,
  remoteHome: RemoteAgentHome, localHome: string, session?: string): Promise<Error | undefined> {
  try {
    await syncRemoteAgentHome(world, provider, remoteHome, localHome, session);
    return undefined;
  } catch (error) {
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
    `if [ -s "$pidfile" ]; then old=$(cut -d ' ' -f 1 < "$pidfile" 2>/dev/null); cmd=$(tr '\\0' ' ' < "/proc/$old/cmdline" 2>/dev/null || true); case "$cmd" in *${opts.provider}*) kill -TERM -- "-$old" 2>/dev/null || kill -TERM "$old" 2>/dev/null || true; i=0; while kill -0 "$old" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i+1)); done; kill -KILL -- "-$old" 2>/dev/null || kill -KILL "$old" 2>/dev/null || true;; esac; rm -f "$pidfile"; fi`,
    // With the host's launch time: a bootstrap requested before it never stops it.
    `printf '%s %s\\n' "$$" ${Date.now()} > "$pidfile"`,
    trace('previous-process-stopped'),
    // The seed uploads config and credentials with the sandbox's default modes
    // into a home the bootstrap made private: close them too before the agent runs.
    `chmod -R go= -- ${quote(home)} 2>/dev/null`,
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
        const result = await boundedExec(this.world, `tail -c 8192 -- ${quote(this.stderrFile)}`,
          { maxBytes: 8192, overflow: 'tail', timeoutMs: 5000 });
        if (result.code === 0 && result.stdout) this.stderr.write(result.stdout);
      } catch { /* diagnostics must not replace the process failure */ }
    }
    this.finished = true;
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }

  private writeProtocol(chunk: string): void {
    if (this.stdout.readableLength + this.stdout.writableLength + Buffer.byteLength(chunk) > 8 * 1024 * 1024) {
      this.kill();
      void this.finish(null, { lost: new Error('agent output buffer limit exceeded') });
      return;
    }
    if (this.startup) this.received.read(chunk);
    this.stdout.write(chunk);
  }

  private onData(chunk: string): void {
    if (this.finishing || this.killed) return;
    if (this.startup) this.readBytes += Buffer.byteLength(chunk);
    if (this.protocolReady) { this.writeProtocol(chunk); return; }
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
    if (rest) this.writeProtocol(rest);
  }
}

function configFiles(root: string): Array<{ relative: string; content: Buffer }> {
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
      if (top === KARMAX_TOKEN_FILE || /^karmax-work-.*\.config\.toml$/.test(top) || top.startsWith('.karmax-history') || top.startsWith('.karmax-login') || ['projects', 'sessions', 'archived_sessions', 'logs', 'log', 'debug', 'tmp', '.tmp', 'cache', 'telemetry', 'shell_snapshots'].includes(top)
        || segments.some((segment) => ['cache', '.remote-plugin-install-staging'].includes(segment))
        || /^(?:logs?|state|goals|memories)(?:[_-].*)?\.sqlite(?:-(?:wal|shm))?$/.test(entry.name.toLowerCase())
        || ['history.jsonl', 'models_cache.json'].includes(entry.name.toLowerCase())) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) files.push({ relative: rel, content: fs.readFileSync(full) });
    }
  };
  walk(root);
  return files;
}

/** The one requested session: Codex's physical lineage or Claude's transcript copies. */
function hostHistoryFiles(root: string, provider: Provider, session?: string): Array<{ relative: string; content: Buffer }> {
  const files: Array<{ relative: string; content: Buffer }> = [];
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

/** Every file under a sandbox directory, relative to the world root. A lost
 * tail would silently drop exactly the newest paths, so the listing is verified. */
async function remoteFiles(world: World, absolute: string, action: string): Promise<string[]> {
  const listed = (await verifiedRemoteOutput(world,
    `if [ -d ${quote(absolute)} ]; then find ${quote(absolute)} -type f -print; fi`, 1024 * 1024, action)).toString('utf8');
  const root = world.handle.root.replace(/\/+$/, '');
  return listed.split('\n').map((file) => file.trim()).filter(Boolean).map((file) =>
    file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file);
}

async function remoteHomeFiles(world: World, absolute: string): Promise<Set<string>> {
  const files = await remoteFiles(world, absolute, 'inspect remote subscription home');
  if (files.length > 4096) throw new Error('remote history listing count limit exceeded');
  return new Set(files);
}

/** Repair stale aliases left by earlier seeding, including on host-only retries.
 * Rollouts are append-only: remove a shorter copy only after verifying it is an
 * exact byte prefix of the retained copy. Never guess between divergent histories.
 * Validate the whole selected lineage before removing anything; leave unrelated
 * sessions and Codex's derived SQLite indexes alone. */
export async function reconcileRemoteCodexSessionCopies(world: World, home: RemoteAgentHome,
  session: string): Promise<void> {
  const budget: HistoryBudget = { bytes: 0, files: 0 };
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
      candidates.push({ file, content: await readRemoteHistory(world, file, budget) });
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
  const budget: HistoryBudget = { bytes: 0, files: 0 };
  let files: string[] | undefined;
  const snapshot = await prepareCodexHistory(session, async (id) => {
    // A rollout the seed proved identical is read from the host (AD-13).
    const synced = home.syncedHistory?.get(id);
    if (synced) return synced;
    files ??= [...await remoteHomeFiles(world, home.absolute)]
      .filter((file) => file.startsWith(`${home.relative}/sessions/`) || file.startsWith(`${home.relative}/archived_sessions/`));
    const candidates = [];
    for (const file of files.filter((candidate) => path.posix.basename(candidate).endsWith(`${id}.jsonl`)))
      candidates.push({ file, content: await readRemoteHistory(world, file, budget) });
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
  const budget: HistoryBudget = { bytes: 0, files: 0 };
  const prefix = `${REMOTE_ROOT}/${provider}/`;
  let files: string[];
  try {
    const sourceDirectory = path.posix.join(source.handle.root, prefix);
    files = (await remoteFiles(source, sourceDirectory, 'list remote sessions')).filter((file) => file.startsWith(prefix));
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
      let content: Buffer;
      if (provider === 'codex') {
        const id = path.posix.basename(file).match(/([0-9a-f-]{36})\.jsonl$/i)?.[1]
          ?? path.posix.basename(file).replace(/^rollout-/, '').replace(/\.jsonl$/, '');
        const candidates = [];
        for (const candidate of files.filter((candidate) =>
          (candidate.startsWith(`${sourceHome}/sessions/`) || candidate.startsWith(`${sourceHome}/archived_sessions/`))
          && path.posix.basename(candidate).endsWith(`${id}.jsonl`)))
          candidates.push({ file: candidate, content: await readRemoteHistory(source, candidate, budget) });
        const kept = selectCodexHistoryCopy(candidates, id);
        file = kept.file; content = kept.content;
      } else content = await readRemoteHistory(source, file, budget);
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
  const result = await world.exec('bash', ['-lc', quiesceCommand(absolute, Date.now())]);
  if (result.code !== 0) throw new CodexHistoryError(`could not stop previous writer: ${result.stderr || result.stdout}`);
}

/** Stop the home's previous writer, if the host launched it before it asked
 * for this command (`issued`, host milliseconds, as the launcher records its
 * own launch). A provider may run a command whose stream it already dropped
 * long after: that late command must never stop a newer turn's agent. */
function quiesceCommand(absolute: string, issued: number): string {
  return `pidfile=${quote(path.posix.join(absolute, 'karmax-agent.pid'))};
if [ -s "$pidfile" ]; then
  read -r old launched < "$pidfile" || [ -n "$old" ]; case "$old" in ''|*[!0-9]*) exit 1;; esac
  case "$launched" in ''|*[!0-9]*) ;; *) [ "$launched" -ge ${issued} ] && exit 0;; esac
  cmd=$(tr '\\0' ' ' < "/proc/$old/cmdline" 2>/dev/null || true)
  case "$cmd" in *codex*)
    kill -TERM -- "-$old" 2>/dev/null || kill -TERM "$old" 2>/dev/null || true
    i=0; while kill -0 "$old" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i+1)); done
    if kill -0 "$old" 2>/dev/null; then kill -KILL -- "-$old" 2>/dev/null || kill -KILL "$old" 2>/dev/null || true; fi
    i=0; while kill -0 "$old" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i+1)); done
    if kill -0 "$old" 2>/dev/null; then echo 'previous Codex writer did not stop' >&2; exit 1; fi;;
  esac
  rm -f "$pidfile"
fi`;
}

function claudeCwdSlug(worldPath: string): string { return worldPath.replace(/[^a-zA-Z0-9]/g, '-'); }

/** Browser MCPs execute in the sandbox, while Karmax platform tools cross the
 * existing app-server stdio channel and execute on the trusted host. Remove the
 * old host-specific Karmax MCP table and preserve every other user entry. */
function remoteCodexConfig(localHome: string, browserMcp?: RemoteAgentHome['browserMcp']): string {
  let config = '';
  // Host settings are authoritative on every turn, like the skills seeded above.
  try { config = fs.readFileSync(path.join(localHome, 'config.toml'), 'utf8'); } catch { /* new home */ }
  config = removeTomlTable(removeTomlTable(removeTomlTable(config,
    'mcp_servers.karmax'), 'mcp_servers.chrome-devtools'), 'mcp_servers.playwright').trimEnd();
  for (const [name, server] of Object.entries(browserMcp ?? {})) {
    config += `\n\n[mcp_servers.${name}]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\n`;
    if (server.env && Object.keys(server.env).length) {
      config += `\n[mcp_servers.${name}.env]\n${Object.entries(server.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n')}\n`;
    }
  }
  return config;
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

/** Browser tools ready in a world: what the readiness marker records. */
interface BrowserTools { chromium: string; bin: string; cache: string }

/** What the bootstrap found of the browser tools, in one pass (LT-22). */
interface BrowserProbe {
  /** The marker, when its versions are current and every executable it names is there. */
  ready?: BrowserTools;
  /** A template's baked browser tools are present. */
  baked: boolean;
  /** Digest of the CDP launcher the world holds, if any. */
  launcher?: string;
}

const BROWSER_ROOT = `${REMOTE_ROOT}/tools/browser-${PLAYWRIGHT_VERSION}`;
const BROWSER_MARKER_FILE = `${BROWSER_ROOT}/ready.json`;
const CDP_LAUNCHER = `${REMOTE_ROOT}/chrome-cdp-launcher.mjs`;
const BROWSER_VERSIONS = { playwright: PLAYWRIGHT_VERSION, chromeMcp: CHROME_DEVTOOLS_MCP_VERSION, playwrightMcp: PLAYWRIGHT_MCP_VERSION };
const cdpLauncherSource = () => fs.readFileSync(fileURLToPath(new URL('../autonomy/chrome-cdp-launcher.mjs', import.meta.url)), 'utf8');

// Runs in the sandbox with the paired Node: the readiness marker, the
// executables it names, the baked alternative and the launcher's digest.
const REMOTE_BROWSER_PROBE = String.raw`
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const [marker, launcher, versionsJson] = process.argv.slice(1);
const versions = JSON.parse(versionsJson);
const executable = (file) => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } };
let ready;
try {
  const cached = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (Object.entries(versions).every(([key, value]) => cached[key] === value)
    && ['chromium', 'bin', 'cache'].every((key) => typeof cached[key] === 'string')
    && [cached.chromium, path.join(cached.bin, 'playwright-mcp'), path.join(cached.bin, 'chrome-devtools-mcp')].every(executable))
    ready = { chromium: cached.chromium, bin: cached.bin, cache: cached.cache };
} catch {}
const baked = !ready && executable('/opt/karmax/bin/playwright-mcp') && executable('/opt/karmax/bin/chrome-devtools-mcp')
  && fs.existsSync('/opt/karmax/smoke.mjs');
let digest;
try { digest = crypto.createHash('sha256').update(fs.readFileSync(launcher)).digest('hex'); } catch {}
process.stdout.write('\n${BROWSER_MARKER}' + JSON.stringify({ ...(ready ? { ready } : {}), baked, ...(digest ? { launcher: digest } : {}) }) + '\n');
`;

function browserProbeCommand(world: World, node: string): string {
  return [node, '-e', REMOTE_BROWSER_PROBE, path.posix.join(world.handle.root, BROWSER_MARKER_FILE),
    path.posix.join(world.handle.root, CDP_LAUNCHER), JSON.stringify(BROWSER_VERSIONS)].map(quote).join(' ');
}

function parseBrowserProbe(stdout: string): BrowserProbe | undefined {
  const line = stdout.split('\n').reverse().find((candidate) => candidate.startsWith(BROWSER_MARKER));
  let probe: any;
  try { probe = JSON.parse(line!.slice(BROWSER_MARKER.length)); } catch { return undefined; }
  const ready = probe?.ready;
  if (typeof probe?.baked !== 'boolean' || (probe.launcher !== undefined && typeof probe.launcher !== 'string')
    || (ready !== undefined && !['chromium', 'bin', 'cache'].every((key) => typeof ready?.[key] === 'string'))) return undefined;
  return { baked: probe.baked, ...(ready ? { ready: { chromium: ready.chromium, bin: ready.bin, cache: ready.cache } } : {}),
    ...(probe.launcher ? { launcher: probe.launcher } : {}) };
}

/** The browser MCP servers for this world, rewritten to sandbox-local, pinned
 * executables. Readiness is established once per turn (LT-22): by the
 * bootstrap prewarmed beside prompt preparation when there is one, including
 * a first turn's smoke test, otherwise by one probe here. */
export async function ensureRemoteBrowser(world: World, browser: BrowserKind, runtimeBin?: string): Promise<NonNullable<RemoteAgentHome['browserMcp']>> {
  const entry = bootstraps.get(world.withoutProjectEnvironment?.() ?? world);
  const bin = runtimeBin ?? (await entry?.bootstrap.catch(() => undefined))?.runtimeBin;
  // A prewarmed repair that failed is this turn's failure; only a lost
  // connection, or a bootstrap that never reached the browser, is tried again.
  let tools = await entry?.browser?.catch((error) => {
    if (browserFailures.has(error) && !lostConnection(error)) throw error;
    return undefined;
  });
  if (!tools) {
    const ready = timed('bootstrap.browser.ready', async () => readyBrowser(world, bin,
      parseBrowserProbe((await world.exec('bash', ['-c', browserProbeCommand(world, bin ? path.posix.join(bin, 'node') : 'node')])).stdout)));
    if (entry) entry.browser = ready;
    tools = await ready;
  }
  return browserServers(world, browser, tools, bin);
}

/** Provider templates are the fast path; this sandbox-local installation is the
 * compatibility path for stock/custom environments. The launch smoke test is
 * the actual guarantee: a world is never handed to an agent with a configured
 * browser MCP that cannot start its browser. The marker and the CDP launcher
 * are written only when the probe found them missing or different. */
async function readyBrowser(world: World, runtimeBin: string | undefined, probe?: BrowserProbe): Promise<BrowserTools> {
  const launcher = cdpLauncherSource();
  const launcherWrite = probe?.launcher === sha256(Buffer.from(launcher)) ? undefined : world.writeFile(CDP_LAUNCHER, launcher);
  launcherWrite?.catch(() => undefined);
  const tools = probe?.ready ?? await repairBrowser(world, runtimeBin, probe);
  if (!probe?.ready) await world.writeFile(BROWSER_MARKER_FILE, JSON.stringify({ ...tools, ...BROWSER_VERSIONS }));
  await launcherWrite;
  return tools;
}

async function repairBrowser(world: World, runtimeBin: string | undefined, probe?: BrowserProbe): Promise<BrowserTools> {
  const absolute = path.posix.join(world.handle.root, BROWSER_ROOT);
  const bin = path.posix.join(absolute, 'node_modules/.bin');
  const browserCache = path.posix.join(absolute, 'browsers');
  let chromium = '';
  let resolvedBin = bin;
  let resolvedCache = browserCache;
  const nodeCommand = runtimeBin ? path.posix.join(runtimeBin, 'node') : 'node';
  const pathEnv = runtimeBin ? `${runtimeBin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` : undefined;
  const bakedRoot = '/opt/karmax/browser';
  const bakedCache = '/opt/karmax/browsers';
  // One repair at a time per sandbox, including an abandoned turn's still-running
  // one. A step waits only for what is left of the repair's nine minutes, so a
  // late lock never runs its step into the ten-minute command timeout.
  const started = Date.now();
  const locked = () => sandboxLock(path.posix.join(absolute, '.install.lock'), Math.max(1, 540 - Math.floor((Date.now() - started) / 1000)));
  const busy = () => new Error('remote browser tools are still being installed by another turn in this sandbox; its lock stayed busy');
  const baked = probe ? { code: probe.baked ? 0 : 1 }
    : await world.exec('bash', ['-lc', 'test -x /opt/karmax/bin/playwright-mcp && test -x /opt/karmax/bin/chrome-devtools-mcp && test -f /opt/karmax/smoke.mjs']);
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
  if (!chromium) {
    const packages = [
      `playwright@${PLAYWRIGHT_VERSION}`,
      `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`,
      `chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}`,
    ];
    const install = await timed('bootstrap.browser.install', () => world.exec('bash', ['-lc', [
      `mkdir -p ${quote(absolute)} ${quote(browserCache)} || exit 1`,
      locked(),
      [...(runtimeBin ? [`export PATH=${quote(pathEnv!)}\${PATH:+:$PATH}`] : []),
        `npm install --prefix ${quote(absolute)} --no-audit --no-fund --omit=dev ${packages.map(quote).join(' ')}`,
        `PLAYWRIGHT_BROWSERS_PATH=${quote(browserCache)} ${quote(path.posix.join(bin, 'playwright'))} install chromium`,
      ].join(' && '),
    ].join('\n')], { timeoutMs: 10 * 60_000 }));
    if (install.code === LOCK_BUSY) throw busy();
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
      // Under the same lock: two install-deps would contend for dpkg's.
      const dependencyInstall = await world.exec('bash', ['-lc', [
        locked(),
        ...(runtimeBin ? [`export PATH=${quote(pathEnv!)}\${PATH:+:$PATH}`] : []),
        `installer=${quote(path.posix.join(bin, 'playwright'))}`,
        'if [ "$(id -u)" = 0 ]; then "$installer" install-deps chromium',
        'elif command -v sudo >/dev/null 2>&1; then sudo -n "$installer" install-deps chromium',
        'else exit 126',
        'fi',
      ].join('\n')], { env: { PLAYWRIGHT_BROWSERS_PATH: browserCache,
        ...(pathEnv ? { PATH: pathEnv } : {}) }, timeoutMs: 10 * 60_000 });
      if (dependencyInstall.code === LOCK_BUSY) throw busy();
      const repaired = dependencyInstall.code === 0
        ? await world.exec(nodeCommand, ['-e', "require('playwright').chromium.launch({headless:true,args:['--no-sandbox']}).then(async b=>{await b.close()}).catch(e=>{console.error(e);process.exit(1)})"], {
            cwd: absolute, env: { NODE_PATH: path.posix.join(absolute, 'node_modules'), PLAYWRIGHT_BROWSERS_PATH: browserCache,
              ...(pathEnv ? { PATH: pathEnv } : {}) }, timeoutMs: 60_000,
          })
        : dependencyInstall;
      if (repaired.code !== 0) throw new Error(`remote Chromium readiness probe failed; select a ${BRAND} browser template/image or permit Playwright OS-dependency installation: ${repaired.stderr || repaired.stdout || smoke.stderr || smoke.stdout}`);
    }
  }
  return { chromium, bin: resolvedBin, cache: resolvedCache };
}

function browserServers(world: World, browser: BrowserKind, tools: BrowserTools,
  runtimeBin?: string): NonNullable<RemoteAgentHome['browserMcp']> {
  const nodeCommand = runtimeBin ? path.posix.join(runtimeBin, 'node') : 'node';
  const pathEnv = runtimeBin ? `${runtimeBin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` : undefined;
  const env = { PLAYWRIGHT_BROWSERS_PATH: tools.cache, ...(pathEnv ? { PATH: pathEnv } : {}) };
  if (browser === 'playwright')
    return { playwright: { command: path.posix.join(tools.bin, 'playwright-mcp'), args: ['--headless', '--no-sandbox', '--isolated'], env } };
  // Run chrome-devtools-mcp through karmax's launcher so the sandbox browser
  // exposes a loopback DevTools port (wiki plans/PLAN-passwords §5B, cloud path): the
  // launcher opens Chromium with --remote-debugging-port and attaches the baked
  // chrome-devtools-mcp bin via --browserUrl. That in-world port is what the
  // gateway's remote fill (world-fill.ts, over world.exec) types into. The
  // launcher also sets vm.overcommit_memory=1 first (KARMAX_CDP_SET_OVERCOMMIT):
  // the default ~512MB E2B sandbox ships overcommit=0, under which Chrome's V8
  // renderer cannot reserve its virtual CodeRange and dies, hanging all
  // page-level CDP (see findings/e2b-headless-chrome-overcommit.md). It
  // self-falls-back to pipe mode if the browser can't open, so tools never
  // regress. readyBrowser ships the dep-free launcher into the world.
  return { 'chrome-devtools': {
    command: nodeCommand,
    args: [path.posix.join(world.handle.root, CDP_LAUNCHER)],
    env: {
      ...env,
      KARMAX_CDP_MCP_BIN: path.posix.join(tools.bin, 'chrome-devtools-mcp'),
      KARMAX_CDP_MCP_VERSION: CHROME_DEVTOOLS_MCP_VERSION,
      KARMAX_CDP_CHROME: tools.chromium,
      KARMAX_CDP_PORT: String(DEFAULT_CDP_PORT),
      KARMAX_CDP_NO_SANDBOX: '1',
      KARMAX_CDP_SET_OVERCOMMIT: '1',
      // A human approval ends the provider/MCP turn, not the browser session.
      // The task-isolated world owns this process and its private profile.
      KARMAX_CDP_KEEP_ALIVE: '1',
      KARMAX_CDP_USER_DATA_DIR: path.posix.join(world.handle.root, REMOTE_ROOT, 'browser-profile'),
      // On a desktop world the agent's browser is the one on screen, so a
      // person can sign in for it through the desktop view (then save_session
      // keeps the sign-in). E2B Desktop and Daytona Computer Use draw on :0.
      ...(world.handle.meta?.environmentFlavor === 'desktop' ? { KARMAX_CDP_HEADFUL: '1', DISPLAY: ':0' } : {}),
    },
  } };
}

/** Bring stock provider images up to the minimum runtime required by the pinned
 * Codex/Claude and browser MCP packages. The runtime is installed from npm into
 * the world injection surface, so users do not need to rebuild their selected
 * E2B template merely because its system Node is stale. Reuse the paired runtime
 * on later turns even if task commands replace system Node/npm. */
export async function ensureRemoteNode(world: World): Promise<string> {
  // This turn's bootstrap, prewarmed or seeded, already installed it.
  const prepared = await bootstraps.get(world.withoutProjectEnvironment?.() ?? world)?.bootstrap.catch(() => undefined);
  return prepared?.runtimeBin ?? (await timed('bootstrap.node', () => runBootstrap(world, {}))).runtimeBin;
}

function remoteNodeRuntime(world: World): { bin: string; install: string; expose: string } {
  const acceptable = "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)";
  // Task commands can replace system Node with an npx-cache symlink. Its
  // version still passes while npm's inferred prefix is unusable (task 201).
  // Keep the paired, pinned runtime stable across every turn.
  const root = path.posix.join(world.handle.root, `${REMOTE_ROOT}/tools/node-${REMOTE_NODE_VERSION}`);
  const bin = path.posix.join(root, 'bin');
  const node = path.posix.join(bin, 'node');
  return { bin, expose: exposeRemoteNodeCommand(bin), install: [
    `mkdir -p ${quote(bin)} || exit 1`,
    // Two npm installs into one prefix corrupt it. The bootstrap's own
    // timeout is five minutes; leave the installation one of them.
    sandboxLock(path.posix.join(root, '.install.lock'), 240),
    [installRemoteNodeCommand(root, REMOTE_NODE_VERSION, REMOTE_NPM_VERSION),
    `ln -sfn ../node_modules/node/bin/node ${quote(node)}`,
    `ln -sfn ../node_modules/npm/bin/npm-cli.js ${quote(path.posix.join(bin, 'npm'))}`,
    `ln -sfn ../node_modules/npm/bin/npx-cli.js ${quote(path.posix.join(bin, 'npx'))}`,
    `${quote(node)} -e ${quote(acceptable)}`].join(' && '),
  ].join('\n') };
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
