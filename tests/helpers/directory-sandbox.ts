/** A remote (E2B/Daytona-shaped) world backed by a local directory, with a
 * fake Codex CLI on its agent PTY. Real karmax code runs everything else, so
 * tests and benchmarks/remote-bootstrap.ts see the actual start-up sequence
 * without a sandbox, a model or provider credit. Optional latency models a
 * provider round trip and bandwidth; the meter counts both. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openLocalPty, runLocalCommand } from '../../src/world/local-execution.js';
import type { ExecResult, World, WorldPty, WorldPtySpec } from '../../src/world/types.js';

export interface SandboxLatency {
  roundTripMs: number; bytesPerMs: number; cliStartMs: number; accountReadMs: number;
  /** A baked Chromium's launch smoke test (stageBakedBrowser). */
  smokeMs?: number;
}
export const NO_LATENCY: SandboxLatency = { roundTripMs: 0, bytesPerMs: Infinity, cliStartMs: 0, accountReadMs: 0 };

export interface SandboxMeter {
  /** Provider requests: execs, terminals, file reads and writes. */
  roundTrips: number;
  execs: string[];
  uploaded: number;
  downloaded: number;
  /** Files written through the file API, relative to the world root. */
  writes: string[];
  /** Native CLI processes launched through the agent launcher, and their scripts. */
  cliStarts: string[];
  launches: string[];
  /** When the fake app-server received `turn/start` (performance.now()), and
   * how many round trips and commands preceded it. */
  modelStartedAt?: number;
  roundTripsAtModelStart?: number;
  execsAtModelStart?: number;
  requests: any[];
  /** App-server protocol order: `request <method>` / `answer <method>`. */
  events: string[];
}

export const newMeter = (): SandboxMeter => ({ roundTrips: 0, execs: [], writes: [], uploaded: 0, downloaded: 0, cliStarts: [], launches: [], requests: [], events: [] });

const READY = '\u001eKARMAX_AGENT_READY\u001e';
const delay = (ms: number) => ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/** The directory itself, or a link to it whose path is safe to substitute into
 * shell text unquoted: a root with spaces or quotes is still a valid sandbox. */
function inertPath(root: string): string {
  if (/^[\w./-]+$/.test(root)) return root;
  const alias = path.join(os.tmpdir(), `karmax-sandbox-alias-${crypto.randomBytes(6).toString('hex')}`);
  fs.symlinkSync(root, alias);
  process.once('exit', () => fs.rmSync(alias, { force: true }));
  return alias;
}

/** System paths karmax names inside a sandbox, and where the directory keeps them. */
const SYSTEM_PATHS = [['/usr/local/bin', '.usr-local-bin'], ['/etc/codex', '.etc-codex'], ['/opt/karmax', '.opt-karmax']] as const;
/** What a sandbox Node process reads through the preload: never a path this
 * machine's own Node may load itself from (a karmax template keeps it under
 * /opt/karmax/node-*). */
const PRELOADED_PATHS = ['/etc/codex', '/opt/karmax/bin', '/opt/karmax/browser', '/opt/karmax/browsers', '/opt/karmax/smoke.mjs'];

/** `/usr/local/bin` (where karmax exposes its managed Node), `/etc/codex`
 * (Codex's system config layer) and `/opt/karmax` (a template's baked tools)
 * are redirected into the directory, so no test or benchmark can replace the
 * machine's own Node or depend on its config. Shell text and arguments are
 * rewritten; a Node process in the sandbox sees them through a preload.
 * A login `profile` runs (as ~/.bash_profile) before every sandbox command,
 * like a template's /etc/profile; `intercept` may answer a command instead. */
export function directorySandbox(root: string, meter: SandboxMeter, options: {
  latency?: SandboxLatency; growth?: number; profile?: string;
  intercept?: (command: string, args: string[]) => ExecResult | undefined | Promise<ExecResult | undefined>;
} = {}): World {
  const latency = options.latency ?? NO_LATENCY;
  fs.mkdirSync(path.join(root, '.usr-local-bin'), { recursive: true });
  // The paths substituted into shell text need no quoting in any context,
  // including a script nested inside another's quotes (`sudo -n sh -c '…'`).
  const inert = inertPath(root);
  const redirect = (value: string) => SYSTEM_PATHS.reduce((text, [system, local]) => text.replaceAll(system, path.join(inert, local)), value);
  const preload = path.join(root, '.sandbox-paths.cjs');
  fs.writeFileSync(preload, `const fs = require('node:fs');
const map = ${JSON.stringify(PRELOADED_PATHS.map((system) => [system, redirect(system)]))};
const redirect = (value) => typeof value !== 'string' ? value
  : map.reduce((text, [system, local]) => text === system || text.startsWith(system + '/') ? local + text.slice(system.length) : text, value);
for (const name of ['accessSync', 'existsSync', 'statSync', 'readFileSync', 'openSync', 'readdirSync']) {
  const original = fs[name];
  fs[name] = function (file, ...rest) { return original.call(this, redirect(file), ...rest); };
}
`);
  const home = path.join(root, '.home');
  if (options.profile !== undefined) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, '.bash_profile'), options.profile);
  }
  const sandboxEnv = (env: Record<string, string | undefined> = {}) => ({
    ...Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value === undefined ? value : redirect(value)])),
    NODE_OPTIONS: `--require="${preload}"`, ...(options.profile !== undefined ? { HOME: home } : {}),
  });
  const trip = async (bytes = 0) => { meter.roundTrips++; await delay(latency.roundTripMs + bytes / latency.bytesPerMs); };
  const file = (relative: string) => path.join(root, relative);
  const write = async (relative: string, content: Buffer) => {
    meter.writes.push(relative); meter.uploaded += content.length; await trip(content.length);
    fs.mkdirSync(path.dirname(file(relative)), { recursive: true });
    fs.writeFileSync(file(relative), content);
  };
  const world: World = {
    handle: { version: 2, kind: 'e2b', provider: 'e2b', sealedProviderRef: 'sandbox', id: 'sandbox', root, branch: 'task', base: 'main' },
    async exec(command, args, execOptions = {}) {
      meter.execs.push([command, ...args].join(' '));
      await trip();
      // An intercept may answer, or delay the real command and let it run.
      const intercepted = await options.intercept?.(command, args);
      if (intercepted) return intercepted;
      // A shell's script follows its -c flag; every other argument is a plain path or value.
      const result = await runLocalCommand(redirect(command), args.map((arg) => redirect(arg)), {
        cwd: execOptions.cwd ?? root, env: { ...process.env, ...sandboxEnv(execOptions.env) } as NodeJS.ProcessEnv,
        timeoutMs: execOptions.timeoutMs, input: execOptions.input });
      const bytes = Buffer.byteLength(result.stdout);
      meter.downloaded += bytes; await delay(bytes / latency.bytesPerMs);
      return result;
    },
    async readFile(relative) { await trip(); return fs.readFileSync(file(relative), 'utf8'); },
    async readFileBuffer(relative) {
      const content = fs.readFileSync(file(relative)); meter.downloaded += content.length; await trip(content.length); return content;
    },
    async writeFile(relative, content) { await write(relative, Buffer.from(content)); },
    async writeFileBuffer(relative, content) { await write(relative, content); },
    async listFiles() { throw new Error('whole-world listing is not part of agent start-up'); },
    async startProcess() { throw new Error('unused'); },
    async openPty(spec: WorldPtySpec = {}) {
      await trip();
      const launcher = spec.command?.match(/^exec sh '((?:[^']|'\\'')+)'$/)?.[1]?.replaceAll(`'\\''`, "'");
      if (launcher) {
        const script = fs.readFileSync(launcher, 'utf8');
        fs.rmSync(launcher, { force: true });
        return fakeCodex(script, String(spec.env?.CODEX_HOME), meter, latency, options.growth ?? 4096);
      }
      return meteredPty(await openLocalPty(root, { ...spec, env: { ...spec.env, ...sandboxEnv(spec.env) } as Record<string, string> }),
        meter, latency, redirect);
    },
    async destroy() {},
  };
  return world;
}

/** Output reaches the host at the modelled bandwidth, in order, before exit. */
function meteredPty(pty: WorldPty, meter: SandboxMeter, latency: SandboxLatency, redirect: (value: string) => string): WorldPty {
  let delivered: Promise<void> = Promise.resolve();
  const outputs = new Set<(chunk: string) => void>();
  const exits = new Set<(code: number | null) => void>();
  pty.onData((chunk) => {
    const bytes = Buffer.byteLength(chunk);
    meter.downloaded += bytes;
    delivered = delivered.then(() => delay(bytes / latency.bytesPerMs)).then(() => { for (const listener of outputs) listener(chunk); });
  });
  pty.onExit((code) => { delivered = delivered.then(() => { for (const listener of exits) listener(code); }); });
  return {
    onData(listener) { outputs.add(listener); return () => outputs.delete(listener); },
    onExit(listener) { exits.add(listener); return () => exits.delete(listener); },
    async write(data) {
      // boundedExec ships its script base64-encoded; redirect inside it too.
      const script = data.replace(/(<<'(KARMAX_EXEC_[0-9a-f]+)_END'\n)([\s\S]*?)(\n\2_END\n)/, (_, open, marker, body, close) => {
        const decoded = Buffer.from(body.replaceAll('\n', ''), 'base64').toString();
        meter.execs.push(decoded);
        return open + Buffer.from(redirect(decoded)).toString('base64').match(/.{1,1024}/g)!.join('\n') + close;
      });
      meter.uploaded += Buffer.byteLength(script);
      return pty.write(script);
    },
    resize: (cols, rows) => pty.resize(cols, rows),
    close: () => pty.close(),
  };
}

export function sandboxRollout(home: string, id: string): string | undefined {
  for (const directory of ['sessions', 'archived_sessions']) {
    const found = fs.existsSync(path.join(home, directory))
      ? fs.readdirSync(path.join(home, directory), { recursive: true }).map(String).find((name) => name.endsWith(`${id}.jsonl`)) : undefined;
    if (found) return path.join(home, directory, found);
  }
  return undefined;
}

/** Codex 0.156's app-server protocol as karmax drives it, and `codex mcp list`.
 * Each turn appends `growth` bytes of tool output to the thread's rollout. */
function fakeCodex(script: string, home: string, meter: SandboxMeter, latency: SandboxLatency, growth: number): WorldPty {
  const outputs = new Set<(chunk: string) => void>();
  const exits = new Set<(code: number | null) => void>();
  const send = (value: unknown) => { const line = JSON.stringify(value) + '\n'; for (const listener of outputs) listener(line); };
  const exit = (code: number) => { for (const listener of exits) listener(code); };
  const listing = /mcp\W+list/.test(script);
  // Servers the launch flags enable are the ones that start (and list tools).
  const enabled = [...script.matchAll(/mcp_servers\.([A-Za-z0-9_-]+)\.enabled=true/g)].map((match) => match[1]!);
  meter.cliStarts.push(listing ? 'mcp list' : 'app-server');
  meter.launches.push(script);
  setTimeout(() => {
    for (const listener of outputs) listener(`${READY}\n`);
    if (listing) { for (const listener of outputs) listener('[]\n'); setTimeout(() => exit(0), 5); }
  }, latency.cliStartMs);
  let input = '';
  let thread = '';
  const handle = async (request: any) => {
    meter.requests.push(request);
    meter.events.push(`request ${request.method}`);
    const reply = (result: unknown) => { meter.events.push(`answer ${request.method}`); send({ id: request.id, result }); };
    if (request.method === 'initialize') reply({});
    else if (request.method === 'account/rateLimits/read') { await delay(latency.accountReadMs); reply({ rateLimits: {} }); }
    else if (request.method === 'mcpServerStatus/list') {
      await delay(latency.roundTripMs);
      reply({ data: enabled.map((name) => ({ name, tools: { ping: {} } })), nextCursor: null });
    }
    else if (request.method === 'thread/start') {
      thread = crypto.randomUUID();
      const file = path.join(home, 'sessions/2026/09/28', `rollout-2026-09-28T00-00-00-${thread}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ ordinal: 0, type: 'session_meta', payload: { id: thread,
        timestamp: '2026-09-28T00:00:00Z', history_mode: 'paginated', dynamic_tools: request.params.dynamicTools } }) + '\n');
      reply({ thread: { id: thread } });
    } else if (request.method === 'thread/resume') {
      thread = request.params.threadId;
      if (!sandboxRollout(home, thread)) { send({ id: request.id, error: { code: -32600, message: `no rollout found for thread id ${thread}` } }); return; }
      reply({ thread: { id: thread } });
    } else if (request.method === 'turn/start') {
      meter.modelStartedAt = performance.now();
      meter.roundTripsAtModelStart = meter.roundTrips;
      meter.execsAtModelStart = meter.execs.length;
      const file = sandboxRollout(home, thread)!;
      const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
      let ordinal = JSON.parse(lines.at(-1)!).ordinal + 1;
      const records: string[] = [];
      for (let bytes = 0; bytes < growth; bytes += 4096)
        records.push(JSON.stringify({ ordinal: ordinal++, type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(4000) } }));
      fs.appendFileSync(file, records.join('\n') + '\n');
      reply({ turn: { id: `turn-${ordinal}` } });
      send({ method: 'turn/started', params: { turn: { id: `turn-${ordinal}` } } });
      send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'done' } } });
      send({ method: 'turn/completed', params: { turn: { id: `turn-${ordinal}`, status: 'completed' } } });
    }
  };
  return {
    onData(listener) { outputs.add(listener); return () => outputs.delete(listener); },
    onExit(listener) { exits.add(listener); return () => exits.delete(listener); },
    async write(chunk) {
      if (listing || chunk === '\x04') return;
      input += chunk;
      for (let newline = input.indexOf('\n'); newline >= 0; newline = input.indexOf('\n')) {
        const line = input.slice(0, newline); input = input.slice(newline + 1);
        if (line.trim()) void handle(JSON.parse(line));
      }
    },
    async resize() {},
    async close() { exit(0); },
  };
}

/** Stage the paired managed runtime from this machine's Node, so a sandbox
 * start never downloads Node from npm. */
export function stageRemoteRuntime(root: string, version = '22.16.0'): void {
  const modules = path.join(root, `.karmax-injection/agent/tools/node-${version}/node_modules`);
  const npm = npmDirectory();
  fs.mkdirSync(path.join(modules, 'node/bin'), { recursive: true });
  fs.symlinkSync(process.execPath, path.join(modules, 'node/bin/node'));
  fs.symlinkSync(npm, path.join(modules, 'npm'));
  const bin = path.join(modules, '../bin');
  fs.mkdirSync(bin);
  fs.symlinkSync('../node_modules/node/bin/node', path.join(bin, 'node'));
  fs.symlinkSync('../node_modules/npm/bin/npm-cli.js', path.join(bin, 'npm'));
  fs.symlinkSync('../node_modules/npm/bin/npx-cli.js', path.join(bin, 'npx'));
}

/** A provider template's baked browser tools at /opt/karmax: MCP executables,
 * a Chromium, the Playwright package that locates it and the launch smoke
 * test, which takes `smokeMs` like a real headless Chromium start. */
export function stageBakedBrowser(root: string, smokeMs = 0): void {
  const baked = path.join(root, '.opt-karmax');
  const executable = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { mode: 0o755 });
  };
  for (const name of ['playwright-mcp', 'chrome-devtools-mcp']) executable(path.join(baked, 'bin', name), '#!/bin/sh\nexit 0\n');
  executable(path.join(baked, 'browsers/chromium/chrome'), '#!/bin/sh\nexit 0\n');
  executable(path.join(baked, 'browser/node_modules/playwright/index.js'),
    "module.exports = { chromium: { executablePath: () => '/opt/karmax/browsers/chromium/chrome' } };\n");
  executable(path.join(baked, 'smoke.mjs'), `await new Promise((resolve) => setTimeout(resolve, ${smokeMs}));\n`);
}

/** A provider template's paired runtime at /opt/karmax/node-<version>. Its
 * version check logs when it starts and ends, so a test can see whether two
 * bootstraps linked it at the same time. */
export function stageBakedRuntime(root: string, version = '22.16.0', checkMs = 0): string {
  const baked = path.join(root, `.opt-karmax/node-${version}`);
  const log = path.join(root, 'baked-runtime.log');
  fs.mkdirSync(path.join(baked, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(baked, 'node_modules/node/bin'), { recursive: true });
  fs.symlinkSync(process.execPath, path.join(baked, 'node_modules/node/bin/node'));
  fs.symlinkSync(npmDirectory(), path.join(baked, 'node_modules/npm'));
  fs.writeFileSync(path.join(baked, 'bin/node'), `#!/bin/sh\necho start >> '${log}'\nsleep ${checkMs / 1000}\necho end >> '${log}'\nexit 0\n`, { mode: 0o755 });
  return log;
}

function npmDirectory(): string {
  const node = fs.realpathSync(process.execPath);
  const npm = [path.join(path.dirname(node), '../lib/node_modules/npm'), path.join(path.dirname(node), '../../npm')]
    .find((candidate) => fs.existsSync(path.join(candidate, 'bin/npx-cli.js')));
  if (!npm) throw new Error('the directory sandbox needs the npm that ships with this Node');
  return npm;
}

/** A ChatGPT login whose ID token stays fresh for an hour: no host refresh. */
export function freshCodexHome(home: string): void {
  const jwt = (seconds: number) => `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds })).toString('base64url')}.signature`;
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt',
    tokens: { id_token: jwt(3600), access_token: jwt(10 * 24 * 3600), refresh_token: 'host-authority' } }));
}
