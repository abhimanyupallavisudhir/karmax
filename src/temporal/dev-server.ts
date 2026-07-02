import { spawn, ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Connection } from '@temporalio/client';
import { findFreePorts, waitForPort } from '../util/ports.js';
import { withTimeout } from '../util/timeout.js';

const TEMPORAL_BIN = process.env.TEMPORAL_CLI ?? path.join(os.homedir(), '.temporalio', 'bin', 'temporal');

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
 *   - reuse a recorded server that answers a persistence-backed health check;
 *   - kill + replace one that's dead, or alive-but-wedged (releasing its DB lock
 *     before the replacement opens the file);
 *   - otherwise spawn a fresh one, detached so it outlives this process.
 * Teardown of the shared server is explicit (`npm run reset` / the recovery
 * script), not per-reload — `stop()` intentionally leaves it running.
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
        return { ...existing, namespace: existing.namespace ?? namespace, reused: true, async stop() {} };
      }
      // Alive but not answering RPCs — wedged/half-started. Kill it so its lock on
      // the SQLite file is released before we start a replacement.
      await killPid(existing.pid);
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

async function spawnPersistent(opts: DevServerOptions, namespace: string, rec: string): Promise<DevServer> {
  const [grpcPort, uiPort, metricsPort] = await findFreePorts(3);
  const args = buildArgs({ grpcPort: grpcPort!, uiPort: uiPort!, metricsPort: metricsPort! }, namespace, opts);
  const logPath = logFilePath(opts.dbFilename!);
  const out = fs.openSync(logPath, 'a');
  // detached + unref: the server must outlive this (reload-prone) process so the
  // next boot can reuse it. stdio → a log file (not a pipe) so it's not tied to
  // our lifetime, and so Temporal's logs survive for later diagnosis.
  const child = spawn(TEMPORAL_BIN, args, { stdio: ['ignore', out, out], detached: true });
  try {
    await awaitStartup(child, grpcPort!, () => `log:\n${tail(logPath)}`);
  } finally {
    try {
      fs.closeSync(out);
    } catch {
      /* ignore */
    }
  }
  child.unref();

  const address = `127.0.0.1:${grpcPort}`;
  const uiUrl = opts.headless ? '' : `http://127.0.0.1:${uiPort}`;
  const record: ServerRecord = { pid: child.pid!, address, uiUrl, namespace };
  try {
    fs.writeFileSync(rec, JSON.stringify(record));
  } catch {
    /* best effort */
  }

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
