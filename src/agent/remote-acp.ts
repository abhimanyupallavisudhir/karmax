import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PassThrough, Writable, type Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { Provider } from '../domain/types.js';
import type { World } from '../world/types.js';
import { mapBatches } from '../util/async-batch.js';
import { timed } from '../timing/index.js';
import { karmaxHome } from '../config/paths.js';
import { atomicPrivateWrite } from './codex-history-files.js';
import type { ControlFrame } from './control-bridge.js';
import { acpSessionDigestFile, installMemoryGuard, isControlPlaneAuth, prepareRemoteAcpHome, remoteAcpHomeRelative,
  remoteAuthProjection, validAcpSessionId, type RemoteAcpHome } from './remote-process.js';

/**
 * ACP harnesses (OpenCode) in a cloud sandbox (E2B, Daytona) — SPEC §7.3, wiki
 * `features/remote-acp-agents`.
 *
 * Claude and Codex reach a sandbox through `remote-process.ts`: the CLI runs
 * there on the world's PTY, and every platform tool travels over the agent's
 * own protocol (SDK MCP over stream-json; Codex `dynamicTools`). An ACP agent
 * has no such channel: the only tools it accepts are MCP servers it spawns
 * itself. So the PTY carries a second stream:
 *
 *   · `acp-relay.mjs` runs the harness on pipes inside the sandbox and owns the
 *     turn's control socket there; its frames (`\x1eKXC {...}` lines) ride the
 *     same PTY as ACP, interleaved only at line boundaries.
 *   · `control-mcp.mjs`, the same dependency-free stdio MCP child local turns
 *     use, connects to that socket. The activity answers each frame with the
 *     handlers and token checks of `control-bridge.ts`.
 *
 * Nothing in the sandbox can reach the control plane or hold any authority
 * the agent does not already have; the bridge dies with the PTY.
 *
 * Session history: OpenCode keeps sessions in SQLite under its data home,
 * which lives in the world's `.karmax-injection/` (never checkpointed). After
 * every turn the session is exported (`opencode export`) to the host
 * (`$KARMAX_HOME/agent-sessions/<provider>/<id>.json`); a sandbox that lacks
 * it (a restored or new world, a fork into another world) imports it before
 * the harness starts, keeping its id (`opencode import`), so a retried turn,
 * a resumed task and a fork all continue the same native session.
 */

/** ACP harnesses with a remote implementation. Kimi Code and Grok Build would
 * need only their package, home layout and session export here; neither is
 * admitted (`AGENT_PROVIDERS`), so neither is wired. */
export function remoteAcpSupported(provider: Provider): boolean {
  return provider === 'opencode';
}

const REMOTE_TOOLS = '.karmax-injection/agent/acp';
const relaySource = () => fs.readFileSync(fileURLToPath(new URL('./acp-relay.mjs', import.meta.url)));
const controlSource = () => fs.readFileSync(fileURLToPath(new URL('./control-mcp.mjs', import.meta.url)));
/** The largest session export the host takes from a sandbox. */
const EXPORT_BYTES = 256 * 1024 * 1024;

const sha256 = (content: Buffer) => crypto.createHash('sha256').update(content).digest('hex');
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** Where the host keeps a session's latest export. */
export function hostAcpSessionFile(provider: Provider, session: string): string {
  if (!validAcpSessionId(session)) throw new Error('invalid ACP session id');
  return path.join(karmaxHome(), 'agent-sessions', provider, `${session}.json`);
}

export function readHostAcpSession(provider: Provider, session: string): Buffer | undefined {
  try { return fs.readFileSync(hostAcpSessionFile(provider, session)); } catch { return undefined; }
}

/** An export the sandbox produced, accepted only as the session it claims to
 * be: `opencode export` prints `{ info: { id }, messages: [...] }`. */
export function validAcpExport(content: Buffer, session: string): boolean {
  try {
    const parsed = JSON.parse(content.toString('utf8'));
    return parsed?.info?.id === session && Array.isArray(parsed.messages);
  } catch { return false; }
}

/** The files of an OpenCode login home the sandbox receives: the credential
 * (refresh tokens withheld) and user configuration. Sessions, logs and caches
 * stay where they are; installed plugin modules are rebuilt by OpenCode. */
function openCodeConfigFiles(localHome: string): Array<{ relative: string; content: Buffer }> {
  const files: Array<{ relative: string; content: Buffer }> = [];
  const auth = path.join(localHome, 'data', 'opencode', 'auth.json');
  if (fs.existsSync(auth)) files.push({ relative: 'data/opencode/auth.json', content: fs.readFileSync(auth) });
  const walk = (dir: string, relative: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || ['node_modules', '.git', 'cache'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile() && fs.statSync(full).size <= 1024 * 1024) files.push({ relative: rel, content: fs.readFileSync(full) });
    }
  };
  walk(path.join(localHome, 'config', 'opencode'), 'config/opencode');
  return files;
}

export interface RemoteAcpTurn {
  home: RemoteAcpHome;
  /** Absolute sandbox paths. */
  relay: { script: string; socket: string };
  control: { command: string; args: string[] };
  /** The system prompt, as a file OpenCode reads (`{file:…}` in its config):
   * an environment variable is capped at 128 KiB by Linux, and a prompt is
   * routinely larger. */
  promptFile: string;
  /** Imports the session before the harness starts, when the sandbox lacks it. */
  prelude?: string;
  /** Removes the turn's private files. */
  cleanup(): Promise<void>;
}

/** Seed one ACP turn's sandbox: runtime and home (bootstrap), login files,
 * the relay and control child, the system prompt and, when the sandbox lacks
 * it, the session the turn resumes or forks. */
export async function prepareRemoteAcpTurn(world: World, opts: { provider: Provider; localHome?: string; session?: string;
  systemPrompt: string; onStartupStep?: (step: string) => Promise<void> | void }): Promise<RemoteAcpTurn> {
  if (!world.writeFileBuffer) throw new Error('remote world cannot receive agent files');
  const write = world.writeFileBuffer.bind(world);
  await opts.onStartupStep?.('prepare-runtime');
  const relative = remoteAcpHomeRelative(opts.provider, opts.localHome);
  const home = await prepareRemoteAcpHome(world, opts.provider, relative, opts.session);
  await opts.onStartupStep?.('prepare-config');
  const turnRelative = `${relative}/karmax-turn/${crypto.randomUUID()}`;
  const promptFile = path.posix.join(world.handle.root, turnRelative, 'system-prompt.md');
  const relayRelative = `${REMOTE_TOOLS}/acp-relay.mjs`;
  const controlRelative = `${REMOTE_TOOLS}/control-mcp.mjs`;
  const uploads: Array<{ relative: string; content: Buffer }> = [
    { relative: relayRelative, content: relaySource() },
    { relative: controlRelative, content: controlSource() },
    { relative: `${turnRelative}/system-prompt.md`, content: Buffer.from(opts.systemPrompt) },
    ...(opts.localHome ? openCodeConfigFiles(opts.localHome) : []).map((file) => ({
      relative: `${relative}/${file.relative}`,
      content: isControlPlaneAuth(opts.provider, file.relative) ? remoteAuthProjection(opts.provider, file.relative, file.content) : file.content,
    })),
  ];
  // A session the sandbox does not hold as the host last stored it.
  let prelude: string | undefined;
  if (opts.session && validAcpSessionId(opts.session)) {
    const stored = readHostAcpSession(opts.provider, opts.session);
    if (stored && validAcpExport(stored, opts.session) && sha256(stored) !== home.sessionDigest) {
      const importFile = path.posix.join(home.absolute, 'karmax-import', `${opts.session}.json`);
      uploads.push({ relative: `${relative}/karmax-import/${opts.session}.json`, content: stored });
      // A sandbox that still holds the session (newer than the host's copy,
      // after an interrupted turn) keeps it: an import never replaces it.
      prelude = `if ! "$bin" export ${quote(opts.session)} >/dev/null 2>&1; then "$bin" import ${quote(importFile)} >/dev/null || echo 'karmax: could not import the session' >&2; fi; rm -f -- ${quote(importFile)}`;
    }
  }
  await Promise.all([
    timed('bootstrap.seed-files', () => mapBatches(uploads, (file) => write(file.relative, file.content))),
    installMemoryGuard(world).catch(() => undefined),
  ]);
  const node = path.posix.join(home.runtimeBin, 'node');
  return {
    home,
    relay: {
      script: path.posix.join(world.handle.root, relayRelative),
      // Short and outside the world: a unix socket path is capped near 108 bytes.
      socket: `/tmp/kx-ctl-${crypto.randomBytes(8).toString('hex')}.sock`,
    },
    control: { command: node, args: [path.posix.join(world.handle.root, controlRelative)] },
    promptFile,
    ...(prelude ? { prelude } : {}),
    async cleanup() {
      await world.exec('rm', ['-rf', '--', path.posix.join(world.handle.root, turnRelative)]).catch(() => undefined);
    },
  };
}

/** Export a session from the sandbox and keep it on the host. Runs after the
 * harness has stopped. Never throws: like `syncRemoteAgentHomeBestEffort`, a
 * lost export must not replace a verified turn result (AD-11); it is reported. */
export async function exportRemoteAcpSession(world: World, provider: Provider, home: RemoteAcpHome, session: string,
  opts: { cwd: string; env: Record<string, string> }): Promise<Error | undefined> {
  try {
    if (!validAcpSessionId(session)) throw new Error('invalid ACP session id');
    const relative = `${home.relative}/karmax-export/${session}.json`;
    const absolute = path.posix.join(world.handle.root, relative);
    const script = [
      'set -e',
      `bin=$(cat ${quote(path.posix.join(home.absolute, 'karmax-agent-bin'))})`,
      `mkdir -p ${quote(path.posix.dirname(absolute))}`,
      `"$bin" export ${quote(session)} > ${quote(`${absolute}.tmp`)} 2>/dev/null`,
      `mv -f ${quote(`${absolute}.tmp`)} ${quote(absolute)}`,
      `wc -c < ${quote(absolute)}`,
    ].join('\n');
    const exported = await world.exec('bash', ['-c', script], { cwd: opts.cwd, env: opts.env, timeoutMs: 120_000 });
    if (exported.code !== 0) throw new Error(`could not export the ${provider} session: ${(exported.stderr || exported.stdout).slice(-400)}`);
    const size = Number(exported.stdout.trim().split('\n').pop());
    if (!Number.isSafeInteger(size) || size > EXPORT_BYTES) throw new Error(`the ${provider} session export is too large`);
    const content = await world.readFileBuffer(relative);
    if (content.length !== size || !validAcpExport(content, session))
      throw new Error(`the ${provider} session export is not session ${session}`);
    atomicPrivateWrite(hostAcpSessionFile(provider, session), content);
    // Only now does the sandbox claim to hold what the host holds.
    const digest = acpSessionDigestFile(home.absolute, session);
    await world.exec('bash', ['-c', `mkdir -p ${quote(path.posix.dirname(digest))} && printf '%s' ${quote(sha256(content))} > ${quote(digest)} && rm -f -- ${quote(absolute)}`]);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/** The PTY carries two streams (see the header): ACP lines, and control
 * frames that start with 0x1E. Both directions are line-buffered so a frame
 * never splits an ACP message. */
export function multiplexAcpChannel(process: { stdin: Writable; stdout: Readable }, onControl: (frame: ControlFrame) => void) {
  const FRAME = '\x1eKXC ';
  const stdout = new PassThrough();
  let pending = '';
  process.stdout.on('data', (chunk: Buffer | string) => {
    pending += chunk.toString();
    let index: number;
    while ((index = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, index + 1);
      pending = pending.slice(index + 1);
      if (line.startsWith(FRAME)) {
        let frame: ControlFrame | undefined;
        try { frame = JSON.parse(line.slice(FRAME.length)); } catch { /* a malformed frame is dropped */ }
        if (frame) onControl(frame);
      } else stdout.write(line);
    }
  });
  process.stdout.on('end', () => { if (pending && !pending.startsWith(FRAME)) stdout.write(pending); pending = ''; stdout.end(); });
  process.stdout.on('error', (error) => stdout.destroy(error));
  let unsent = '';
  const stdin = new Writable({
    write(chunk, _encoding, done) {
      unsent += Buffer.from(chunk).toString();
      const end = unsent.lastIndexOf('\n');
      if (end < 0) { done(); return; }
      const lines = unsent.slice(0, end + 1);
      unsent = unsent.slice(end + 1);
      process.stdin.write(lines, (error) => done(error ?? undefined));
    },
    final(done) {
      const rest = unsent;
      unsent = '';
      if (rest) process.stdin.write(rest);
      process.stdin.end(() => done());
    },
  });
  stdin.on('error', () => {});
  return {
    stdin,
    stdout,
    /** Written between whole ACP lines: anything partial waits in `unsent`. */
    sendControl(frame: ControlFrame) {
      try { process.stdin.write(`${FRAME}${JSON.stringify(frame)}\n`); } catch { /* the PTY closed */ }
    },
  };
}
