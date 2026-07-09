import { spawn, ChildProcess, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Connection } from '@temporalio/client';
import { findFreePortFrom, findFreePorts, isPortFree, waitForPort } from '../util/ports.js';
import { withTimeout } from '../util/timeout.js';
import { trackProcess } from '../util/processes.js';

const execFileP = promisify(execFileCb);

const TEMPORAL_BIN = process.env.TEMPORAL_CLI ?? path.join(os.homedir(), '.temporalio', 'bin', 'temporal');

// Conventional Temporal ports. The persistent server claims each by walking
// upward from its default (findFreePortFrom) so its address — and the UI URL —
// stay stable across restarts. Ephemeral (test) servers keep OS-random ports
// so parallel test workers don't race for the same base. Temporal's own
// internal services (history/matching/worker) take arbitrary high ports we
// never touch, so these three don't collide with them.
const DEFAULT_GRPC_PORT = 7233;
const DEFAULT_UI_PORT = 8233;
const DEFAULT_METRICS_PORT = 9233;

export interface DevServer {
  address: string; // host:grpcPort
  uiUrl: string;
  namespace: string;
  /** Whether this handle owns a freshly-spawned server vs. reuses an existing one. */
  reused: boolean;
  stop(): Promise<void>;
}

export interface DevServerOptions {
  /** Persistent SQLite db. Omit for ephemeral in-memory (tests). */
  dbFilename?: string;
  namespace?: string;
  /** Disable the Web UI (tests). */
  headless?: boolean;
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'never';
}

/** What we persist so a later boot/reload can find and reuse the running server. */
interface ServerRecord {
  pid: number;
  address: string;
  uiUrl: string;
  namespace: string;
  /** Transient systemd user unit hosting the server, when systemd-run was usable. */
  unit?: string;
}

/** The three ports a persistent server binds. grpc is the one clients/workers pin. */
interface PortTriple {
  grpcPort: number;
  uiPort: number;
  metricsPort: number;
}

const HEALTH_TIMEOUT_MS = 6000;

const recordFile = (dbFilename: string) => path.join(path.dirname(dbFilename), 'dev-server.json');
const logFilePath = (dbFilename: string) => path.join(path.dirname(dbFilename), 'dev-server.log');

function readRecord(file: string): ServerRecord | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ServerRecord;
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch {
    return false;
  }
}

/**
 * A recorded server may be *alive but wedged* (accepts TCP but can't serve RPCs).
 * A TCP probe isn't enough — we hit a persistence-backed RPC (describeNamespace)
 * so a jammed SQLite backend reads as unhealthy and gets replaced, not reused.
 */
async function serverHealthy(address: string, namespace: string): Promise<boolean> {
  let conn: Connection | undefined;
  try {
    conn = await withTimeout(Connection.connect({ address, connectTimeout: HEALTH_TIMEOUT_MS }), HEALTH_TIMEOUT_MS);
    await withTimeout(conn.workflowService.describeNamespace({ namespace }), HEALTH_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  } finally {
    if (conn) await conn.close().catch(() => {});
  }
}

async function killPid(pid: number, timeoutMs = 5000): Promise<void> {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
}

async function unitMainPid(unit: string): Promise<number | undefined> {
  try {
    const { stdout } = await execFileP('systemctl', ['--user', 'show', '--property=MainPID', '--value', unit]);
    const pid = Number(stdout.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Try to launch the server as a transient systemd *user* service instead of a
 * plain detached child. `detached: true` gives the child its own session (no
 * SIGHUP on terminal close) but NOT its own cgroup — it stays in the systemd
 * scope of the terminal tab that first booted karmax, and closing that tab
 * stops the scope, SIGTERM-ing every process left in it, shared dev server
 * included (observed 2026-07-07: the server died the second an old terminal
 * tab was closed, and the app spun on gRPC retries for good). A transient unit
 * gets its own cgroup under the user manager, so only karmax (or
 * `npm run reset`) decides when it dies.
 *
 * Returns undefined when systemd-run isn't usable (no systemd, no user
 * manager, non-Linux) — the caller falls back to the detached spawn.
 */
async function spawnViaSystemdRun(args: string[], logPath: string): Promise<{ pid: number; unit: string } | undefined> {
  const unit = `karmax-temporal-${crypto.randomBytes(4).toString('hex')}`;
  try {
    await execFileP('systemd-run', [
      '--user',
      '--collect', // GC the unit even if it fails — a dead unit must never block a respawn
      '--quiet',
      `--unit=${unit}`,
      '--service-type=exec',
      `--property=StandardOutput=append:${logPath}`,
      `--property=StandardError=append:${logPath}`,
      '--',
      TEMPORAL_BIN,
      ...args,
    ]);
  } catch {
    return undefined;
  }
  // MainPID can lag the start by a beat; poll briefly.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const pid = await unitMainPid(unit);
    if (pid) return { pid, unit };
    await new Promise((r) => setTimeout(r, 100));
  }
  await execFileP('systemctl', ['--user', 'stop', unit]).catch(() => {});
  return undefined;
}

/** Whether transient user units can be spawned at all (cached — probed once). */
let systemdProbe: Promise<boolean> | undefined;
function systemdUsable(): Promise<boolean> {
  systemdProbe ??= execFileP('systemd-run', ['--user', '--collect', '--quiet', '--wait', '/bin/true']).then(
    () => true,
    () => false,
  );
  return systemdProbe;
}

/** O_EXCL lock file with stale takeover — guards cross-instance respawns. */
function tryLock(file: string, staleMs = 120_000): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return true;
    } catch {
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > staleMs) {
          fs.rmSync(file);
          continue; // stale holder — retake
        }
      } catch {
        /* raced away — treat as held */
      }
      return false;
    }
  }
  return false;
}

function tail(file: string, bytes = 2000): string {
  try {
    return fs.readFileSync(file, 'utf8').slice(-bytes);
  } catch {
    return '';
  }
}

function buildArgs(
  ports: { grpcPort: number; uiPort: number; metricsPort: number },
  namespace: string,
  opts: DevServerOptions,
): string[] {
  const args = [
    'server',
    'start-dev',
    '--ip',
    '127.0.0.1',
    '--port',
    String(ports.grpcPort),
    '--metrics-port',
    String(ports.metricsPort),
    '--log-level',
    opts.logLevel ?? 'error',
    '--namespace',
    namespace,
  ];
  if (opts.headless) args.push('--headless');
  else args.push('--ui-port', String(ports.uiPort));
  if (opts.dbFilename) args.push('--db-filename', opts.dbFilename);
  return args;
}

/** Race a freshly-spawned child's port coming up against it dying on startup. */
async function awaitStartup(child: ChildProcess, grpcPort: number, onFail: () => string): Promise<void> {
  let onExit: (code: number | null) => void = () => {};
  const exited = new Promise<never>((_, reject) => {
    onExit = (code) => reject(new Error(`temporal dev server exited (code ${code}). ${onFail()}`));
    child.once('exit', onExit);
  });
  try {
    await Promise.race([waitForPort(grpcPort, { timeoutMs: 30_000 }), exited]);
  } catch (err) {
    try {
      if (child.pid) process.kill(child.pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    // Drop the startup-only exit listener so a *later* crash of a detached server
    // doesn't reject an already-settled promise (→ unhandledRejection).
    child.off('exit', onExit);
    exited.catch(() => {});
  }
}

/**
 * Boot (or reuse) a Temporal dev server (SQLite-backed) on dynamically chosen
 * ports. SPEC §1: Temporal is the durable-execution spine; we never hardcode its
 * ports.
 *
 * **Persistent mode (a `dbFilename` is set → the real app).** The dev server is a
 * single, long-lived process that survives app restarts and `tsx watch` reloads
 * and is *reused* across them. This is deliberate: spawning a fresh server on
 * every reload while the old one still holds the same SQLite file is exactly what
 * wedges Temporal — two servers writing one DB surface as
 * `SQL logic error: cannot start a transaction within a transaction`, and each
 * reload piles on another. So we keep at most one server per DB file:
 *   - reuse a recorded server that answers a persistence-backed health check
 *     (a healthy but unit-less one — a pre-unit record — is first adopted into
 *     a systemd unit by replacing it at the same address);
 *   - kill + replace one that's dead, or alive-but-wedged (releasing its DB lock
 *     before the replacement opens the file);
 *   - otherwise spawn a fresh one — as a transient systemd user unit when
 *     possible (own cgroup: survives the terminal that booted karmax closing),
 *     else a plain detached child — so it outlives this process.
 * Teardown of the shared server is explicit (`npm run reset` / the recovery
 * script), not per-reload — `stop()` intentionally leaves it running. If it
 * dies mid-run, `watchDevServer` respawns it at the same address.
 *
 * **Ephemeral mode (no `dbFilename` → tests).** Unchanged: a throwaway child that
 * `stop()` actually kills, so each test file gets an isolated server.
 */
export async function startDevServer(opts: DevServerOptions = {}): Promise<DevServer> {
  if (!fs.existsSync(TEMPORAL_BIN)) {
    throw new Error(
      `Temporal CLI not found at ${TEMPORAL_BIN}. Install it (https://temporal.io/setup/install-temporal-cli) or set TEMPORAL_CLI.`,
    );
  }
  const namespace = opts.namespace ?? 'default';

  if (opts.dbFilename) {
    fs.mkdirSync(path.dirname(opts.dbFilename), { recursive: true });
    const rec = recordFile(opts.dbFilename);
    const existing = readRecord(rec);
    if (existing && pidAlive(existing.pid)) {
      if (await serverHealthy(existing.address, existing.namespace ?? namespace)) {
        if (existing.unit || !(await systemdUsable())) {
          trackTemporal(existing.pid, existing.address);
          return { ...existing, namespace: existing.namespace ?? namespace, reused: true, async stop() {} };
        }
        // Healthy but not unit-managed (pre-unit record): still living in the
        // terminal scope that first booted it, so closing that tab would kill it.
        // Adopt it into a unit by replacing it at the same address — boot is the
        // safe moment (our workers aren't polling yet; other instances' pollers
        // ride through a same-address respawn).
        await killPid(existing.pid);
        try {
          fs.rmSync(rec);
        } catch {
          /* ignore */
        }
        const grpcPort = Number(existing.address.split(':')[1]);
        const uiPort = existing.uiUrl ? Number(new URL(existing.uiUrl).port) : undefined;
        return spawnPersistent(opts, namespace, rec, { grpcPort, uiPort });
      }
      // Alive but not answering RPCs — wedged/half-started. Kill it so its lock on
      // the SQLite file is released before we start a replacement. When the record
      // names a unit, verify the pid still belongs to it — a dead server's pid can
      // be recycled by an unrelated process we must not SIGKILL.
      if (!existing.unit || (await unitMainPid(existing.unit)) === existing.pid) await killPid(existing.pid);
    }
    try {
      fs.rmSync(rec);
    } catch {
      /* ignore */
    }
    return spawnPersistent(opts, namespace, rec);
  }

  return spawnEphemeral(opts, namespace);
}

/**
 * Pick the server's ports. A pinned grpc port is used as-is — that's the
 * respawn-at-the-same-address path, and the caller has already verified it is
 * free (workers/clients retry that exact address, so any other port is
 * useless). ui just *prefers* its old spot; metrics walks from its default.
 */
async function choosePorts(pin?: Partial<PortTriple>): Promise<PortTriple> {
  const grpcPort = pin?.grpcPort ?? (await findFreePortFrom(DEFAULT_GRPC_PORT));
  const uiPort =
    pin?.uiPort && (await isPortFree(pin.uiPort)) ? pin.uiPort : await findFreePortFrom(DEFAULT_UI_PORT, { avoid: [grpcPort] });
  const metricsPort = await findFreePortFrom(DEFAULT_METRICS_PORT, { avoid: [grpcPort, uiPort] });
  return { grpcPort, uiPort, metricsPort };
}

/** Surface the (possibly adopted) server in the dashboard task manager. Marked
 *  protected — killing it from the UI would wedge every workflow; `npm run
 *  reset` is the supported teardown. Re-registering the same pid is idempotent
 *  (the registry is keyed by pid) and dead pids are pruned on each sample. */
function trackTemporal(pid: number, address: string): void {
  trackProcess({ pid, kind: 'temporal', label: `Temporal dev server (${address})`, startedAt: Date.now(), protected: true });
}

async function spawnPersistent(
  opts: DevServerOptions,
  namespace: string,
  rec: string,
  pin?: Partial<PortTriple>,
): Promise<DevServer> {
  const ports = await choosePorts(pin);
  const args = buildArgs(ports, namespace, opts);
  const logPath = logFilePath(opts.dbFilename!);
  const address = `127.0.0.1:${ports.grpcPort}`;
  const uiUrl = opts.headless ? '' : `http://127.0.0.1:${ports.uiPort}`;

  // Prefer a transient systemd user unit — its own cgroup, so closing the
  // terminal that booted karmax can't reap it (see spawnViaSystemdRun).
  let pid: number;
  let unit: string | undefined;
  const viaUnit = await spawnViaSystemdRun(args, logPath);
  if (viaUnit) {
    ({ pid, unit } = viaUnit);
    // Race the port coming up against the unit dying on startup.
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        await waitForPort(ports.grpcPort, { timeoutMs: 1000 });
        break;
      } catch {
        const died = !pidAlive(pid);
        if (died || Date.now() > deadline) {
          await execFileP('systemctl', ['--user', 'stop', unit]).catch(() => {});
          throw new Error(
            `temporal dev server (unit ${unit}) ${died ? 'died on startup' : `never served ${address}`}. log:\n${tail(logPath)}`,
          );
        }
      }
    }
  } else {
    const out = fs.openSync(logPath, 'a');
    // detached + unref: the server must outlive this (reload-prone) process so the
    // next boot can reuse it. stdio → a log file (not a pipe) so it's not tied to
    // our lifetime, and so Temporal's logs survive for later diagnosis.
    const child = spawn(TEMPORAL_BIN, args, { stdio: ['ignore', out, out], detached: true });
    try {
      await awaitStartup(child, ports.grpcPort, () => `log:\n${tail(logPath)}`);
    } finally {
      try {
        fs.closeSync(out);
      } catch {
        /* ignore */
      }
    }
    child.unref();
    pid = child.pid!;
  }

  const record: ServerRecord = { pid, address, uiUrl, namespace, ...(unit ? { unit } : {}) };
  try {
    fs.writeFileSync(rec, JSON.stringify(record));
  } catch {
    /* best effort */
  }
  trackTemporal(pid, address);

  return {
    address,
    uiUrl,
    namespace,
    reused: false,
    // Leave the shared server running for the next restart/reload; explicit
    // teardown is `npm run reset` / the recovery script.
    async stop() {},
  };
}

async function spawnEphemeral(opts: DevServerOptions, namespace: string): Promise<DevServer> {
  const [grpcPort, uiPort, metricsPort] = await findFreePorts(3);
  const args = buildArgs({ grpcPort: grpcPort!, uiPort: uiPort!, metricsPort: metricsPort! }, namespace, opts);
  const child: ChildProcess = spawn(TEMPORAL_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: false });
  let stderrTail = '';
  child.stderr?.on('data', (b) => {
    stderrTail = (stderrTail + b.toString()).slice(-2000);
  });
  await awaitStartup(child, grpcPort!, () => `stderr:\n${stderrTail}`);

  const address = `127.0.0.1:${grpcPort}`;
  const uiUrl = opts.headless ? '' : `http://127.0.0.1:${uiPort}`;
  return {
    address,
    uiUrl,
    namespace,
    reused: false,
    async stop() {
      if (child.exitCode !== null) return;
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        // Hard-kill quickly so a stopping server doesn't overlap the next test
        // file's fresh one (the dev DB is throwaway — nothing to flush).
        setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
        }, 1200).unref();
      });
    },
  };
}

const WATCH_INTERVAL_MS = 15_000;
const WATCH_FAILS_BEFORE_RESPAWN = 2; // one blip is a blip; two in a row (~30s) is an outage
const RESPAWN_ATTEMPTS = 3;

export interface DevServerWatch {
  stop(): void;
}

export interface WatchHooks {
  log?: (msg: string) => void;
  /** The server is gone AND could not be respawned at its address. Default: log + exit(1). */
  onFatal?: (msg: string) => void;
}

/**
 * Watch the shared persistent server and respawn it AT THE SAME gRPC ADDRESS if
 * it dies mid-run (its terminal scope stopped, someone pkill'd it, it crashed).
 * Same address is the whole trick: the worker's pollers and every open Client
 * retry their recorded address forever, so a replacement that binds the same
 * port is picked up automatically — no reconnect plumbing anywhere else.
 * (2026-07-07: the server died mid-run and the app spun on `Connection refused`
 * retries for 20+ minutes, looking alive while serving nothing.)
 *
 * If the address can't be re-bound, `onFatal` fires (default: loud error +
 * exit 1) — without Temporal every gateway call hangs, so an honest death
 * beats a zombie.
 *
 * Cross-instance safety: respawning is serialized through a lock file next to
 * the record so two karmax processes sharing one server don't both spawn one
 * (two servers on one SQLite file is the classic wedge).
 */
export function watchDevServer(
  server: DevServer,
  opts: DevServerOptions & { dbFilename: string },
  hooks: WatchHooks = {},
): DevServerWatch {
  const log = hooks.log ?? ((m: string) => console.warn(m));
  const onFatal =
    hooks.onFatal ??
    ((m: string) => {
      console.error(m);
      process.exit(1);
    });
  const rec = recordFile(opts.dbFilename);
  const lock = `${rec}.lock`;
  const grpcPort = Number(server.address.split(':')[1]);
  const uiPort = server.uiUrl ? Number(new URL(server.uiUrl).port) : undefined;

  let stopped = false;
  let fails = 0;
  let timer: NodeJS.Timeout | undefined;

  const respawn = async (): Promise<void> => {
    if (!tryLock(lock)) {
      log(`  ⚠ Temporal at ${server.address} unreachable; another karmax instance is already respawning it`);
      return;
    }
    try {
      // Re-check under the lock: another instance may have just fixed it.
      if (await serverHealthy(server.address, server.namespace)) {
        fails = 0;
        return;
      }
      const existing = readRecord(rec);
      if (existing && pidAlive(existing.pid)) {
        // Alive-but-wedged: release its SQLite lock (unit check as in startDevServer).
        if (!existing.unit || (await unitMainPid(existing.unit)) === existing.pid) await killPid(existing.pid);
      }
      let lastErr: unknown;
      for (let i = 1; i <= RESPAWN_ATTEMPTS && !stopped; i++) {
        try {
          if (!(await isPortFree(grpcPort))) throw new Error(`port ${grpcPort} is taken by another process`);
          await spawnPersistent(opts, server.namespace, rec, { grpcPort, uiPort });
          log(`  ✓ Temporal dev server died and was respawned at ${server.address}; workers reconnect on their own`);
          fails = 0;
          return;
        } catch (err) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      if (!stopped)
        onFatal(
          `  ✗ Temporal dev server at ${server.address} died and could not be respawned there ` +
            `(${lastErr instanceof Error ? lastErr.message : String(lastErr)}). karmax cannot serve anything ` +
            `without it — restart karmax (workflow state is safe in ${opts.dbFilename}).`,
        );
    } finally {
      try {
        fs.rmSync(lock);
      } catch {
        /* ignore */
      }
    }
  };

  const schedule = () => {
    timer = setTimeout(tick, WATCH_INTERVAL_MS);
    timer.unref(); // the watcher must never be what keeps the process alive
  };
  const tick = async () => {
    if (stopped) return;
    const healthy = await serverHealthy(server.address, server.namespace);
    if (stopped) return;
    if (healthy) {
      fails = 0;
    } else {
      fails++;
      if (fails >= WATCH_FAILS_BEFORE_RESPAWN) {
        log(`  ⚠ Temporal dev server at ${server.address} is unreachable — respawning…`);
        await respawn();
      }
    }
    if (!stopped) schedule();
  };
  schedule();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
