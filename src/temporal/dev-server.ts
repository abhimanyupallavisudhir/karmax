import { spawn, ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { findFreePorts, waitForPort } from '../util/ports.js';

const TEMPORAL_BIN = process.env.TEMPORAL_CLI ?? path.join(os.homedir(), '.temporalio', 'bin', 'temporal');

export interface DevServer {
  address: string; // host:grpcPort
  uiUrl: string;
  namespace: string;
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

/**
 * Boot a Temporal dev server (SQLite-backed) on dynamically chosen ports.
 * SPEC §1: Temporal is the durable-execution spine. We never hardcode its ports.
 */
export async function startDevServer(opts: DevServerOptions = {}): Promise<DevServer> {
  if (!fs.existsSync(TEMPORAL_BIN)) {
    throw new Error(
      `Temporal CLI not found at ${TEMPORAL_BIN}. Install it (https://temporal.io/setup/install-temporal-cli) or set TEMPORAL_CLI.`,
    );
  }
  const namespace = opts.namespace ?? 'default';
  const ports = await findFreePorts(3);
  const grpcPort = ports[0]!;
  const uiPort = ports[1]!;
  const metricsPort = ports[2]!;

  const args = [
    'server',
    'start-dev',
    '--ip',
    '127.0.0.1',
    '--port',
    String(grpcPort),
    '--metrics-port',
    String(metricsPort),
    '--log-level',
    opts.logLevel ?? 'error',
    '--namespace',
    namespace,
  ];
  if (opts.headless) args.push('--headless');
  else args.push('--ui-port', String(uiPort));
  if (opts.dbFilename) {
    fs.mkdirSync(path.dirname(opts.dbFilename), { recursive: true });
    args.push('--db-filename', opts.dbFilename);
  }

  const child: ChildProcess = spawn(TEMPORAL_BIN, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  let stderrTail = '';
  child.stderr?.on('data', (b) => {
    stderrTail = (stderrTail + b.toString()).slice(-2000);
  });

  const exited = new Promise<never>((_, reject) => {
    child.once('exit', (code) =>
      reject(new Error(`temporal dev server exited (code ${code}). stderr:\n${stderrTail}`)),
    );
  });

  try {
    await Promise.race([
      waitForPort(grpcPort, { timeoutMs: 30_000 }),
      exited,
    ]);
  } catch (err) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    throw err;
  }

  const address = `127.0.0.1:${grpcPort}`;
  const uiUrl = opts.headless ? '' : `http://127.0.0.1:${uiPort}`;

  return {
    address,
    uiUrl,
    namespace,
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
