import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { paths } from '../config/paths.js';
import { acquireFileLock } from './file-lock.js';
import { BRAND } from '../domain/brand.js';

/**
 * Duplicate app-instance detection (karmax#4). The July-5 OOM had 14 concurrent
 * `src/main.ts` app instances running against the same KARMAX_HOME — each boots
 * its own worker (and its own fan-out of agent turns), multiplying RAM pressure
 * with no benefit: one app already serves the whole todo list. Nothing enforced
 * "one app per home", so nothing warned.
 *
 * On Linux admission uses a kernel flock held by the app's file descriptor.
 * It survives neither process death nor a container replacement, unlike a PID
 * number persisted in a Docker volume. PID files remain diagnostic metadata and
 * support upgrades from installations that predate the kernel lock.
 * Two workers polling the same Temporal queue can load
 * different workflow/activity code, steal each other's activities, duplicate
 * agent fan-out, and make a task appear permanently stuck. Graceful restart
 * releases its registration before spawning the successor, so exclusivity does
 * not interfere with the supported fast-restart path.
 */

/** Default liveness probe: signal 0 tests existence without delivering a signal.
 *  EPERM means the pid exists but is owned by another user — still "alive". */
function isAliveDefault(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

const instancesDir = () => path.join(paths().state, 'instances');
const pidFile = (dir: string, pid: number) => path.join(dir, `${pid}.pid`);

interface ProcessIdentity {
  pidStart?: string;
  bootId?: string;
  argv?: string[];
  cwd?: string;
}

function processIdentity(pid: number): ProcessIdentity {
  const read = (file: string) => { try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; } };
  const stat = read(`/proc/${pid}/stat`);
  let cwd: string | undefined;
  try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch { /* unavailable off Linux or without permission */ }
  return {
    // comm may contain spaces and parentheses. The suffix starts at field 3;
    // starttime is field 22, not a wall-clock time that NTP can change.
    pidStart: stat?.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19],
    bootId: read('/proc/sys/kernel/random/boot_id')?.trim(),
    argv: read(`/proc/${pid}/cmdline`)?.split('\0').filter(Boolean),
    cwd,
  };
}

function sameProcess(record: ProcessIdentity, current: ProcessIdentity): boolean {
  if (record.bootId && current.bootId && record.bootId !== current.bootId) return false;
  if (record.pidStart && current.pidStart) return record.pidStart === current.pidStart;
  // Legacy records contain only argv. Preserve a live old app during an upgrade,
  // but do not mistake tsx/esbuild or another recycled PID for its entrypoint.
  const entrypoint = record.argv?.[0];
  if (typeof entrypoint === 'string' && current.argv && current.cwd && path.isAbsolute(entrypoint))
    return current.argv.some((arg) => path.resolve(current.cwd!, arg) === entrypoint);
  // If identity cannot be read (e.g. EPERM/non-Linux), keep the live-PID guard.
  return true;
}

function lockInstance(dir: string): (() => void) | undefined {
  if (process.platform !== 'linux') return undefined;
  // Never unlink this file: all contenders must lock the same inode. flock(1)
  // receives the parent's open file description as fd 3, so the lock remains
  // held by this process after the short-lived helper exits.
  const fd = fs.openSync(path.join(dir, 'app.lock'), 'a', 0o600);
  const result = spawnSync('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '73', '3'], {
    stdio: ['ignore', 'pipe', 'pipe', fd], encoding: 'utf8', timeout: 5_000,
  });
  if (result.status !== 0) {
    fs.closeSync(fd);
    if (result.status === 73) throw new Error(duplicateInstanceMessage(paths().home, []));
    throw new Error(`could not acquire the ${BRAND} instance lock (Linux requires util-linux/flock): ${result.error?.message ?? result.stderr.trim()}`);
  }
  return () => fs.closeSync(fd);
}

/**
 * Is `dir` located inside `parent`? Symlinks and relative segments are resolved
 * (a world checkout may be reached through either its real or linked path), and
 * a missing path falls back to plain resolution so the check still works for a
 * directory that was deleted out from under a running process.
 */
export function isInsideDir(dir: string, parent: string): boolean {
  const real = (q: string) => {
    try {
      return fs.realpathSync(q);
    } catch {
      return path.resolve(q);
    }
  };
  const rel = path.relative(real(parent), real(dir));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Scan `dir` for live OTHER app instances, pruning stale pidfiles as it goes.
 * Once the exclusive kernel lock is held, prior lock-aware records are stale
 * even if a replacement container reused their PIDs. Legacy records still need
 * a liveness/identity check so upgrading cannot admit a second old worker.
 */
export function scanInstances(dir: string, selfPid: number, isAlive: (pid: number) => boolean = isAliveDefault,
  readIdentity: (pid: number) => ProcessIdentity = processIdentity, hasProcessLock = false): number[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // dir absent ⇒ no prior instances
  }
  const others: number[] = [];
  for (const name of names) {
    const m = /^(\d+)\.pid$/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === selfPid) continue;
    let record: ProcessIdentity & { processLock?: boolean } = {};
    try { record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) ?? {}; } catch { /* retain the live-PID guard */ }
    if (!(hasProcessLock && record.processLock === true) && isAlive(pid) && sameProcess(record, readIdentity(pid))) others.push(pid);
    else {
      try {
        fs.rmSync(path.join(dir, name)); // stale holder — clean up
      } catch {
        /* raced another instance's prune */
      }
    }
  }
  return others.sort((a, b) => a - b);
}

export interface InstanceRegistration {
  /** Live OTHER app instances sharing this KARMAX_HOME (empty when we're alone). */
  others: number[];
  /** Remove this instance's pidfile. Idempotent; wire into shutdown. */
  release: () => void;
}

export function duplicateInstanceMessage(home: string, others: number[]): string {
  const owner = others.length ? `pid${others.length === 1 ? '' : 's'} ${others.join(', ')}` : 'exclusive process lock is held';
  return `another ${BRAND} app instance is already running against ${home} (${owner}). `
    + 'Stop that instance before starting another; concurrent workers can steal activities and corrupt workflow coherence.';
}

/**
 * Register this process as a live app instance and report any others already
 * running against the same KARMAX_HOME. Admission fails closed if the Linux
 * process lock cannot be acquired; silently bypassing it permits two workers.
 */
export function registerAppInstance(): InstanceRegistration {
  const dir = instancesDir();
  fs.mkdirSync(dir, { recursive: true });
  const unlock = lockInstance(dir);
  const others = scanInstances(dir, process.pid, isAliveDefault, processIdentity, !!unlock);
  const self = pidFile(dir, process.pid);
  const identity = processIdentity(process.pid);
  const contents = JSON.stringify({ pid: process.pid, home: paths().home, argv: process.argv.slice(1, 3),
    pidStart: identity.pidStart, bootId: identity.bootId, processLock: !!unlock });
  try {
    if (!others.length) fs.writeFileSync(self, contents);
  } catch {
    /* best effort — detection still worked */
  }
  let released = false;
  return {
    others,
    release: () => {
      if (released) return;
      released = true;
      try {
        if (!others.length && fs.readFileSync(self, 'utf8') === contents) fs.rmSync(self);
      } catch {
        /* already gone */
      }
      unlock?.();
    },
  };
}

/** Exclusive same-home ownership shared by combined and supervised workers.
 * Keep this descriptor until execution has drained; never unlink its lock file. */
export async function claimWorkerOwnership(home: string): Promise<() => void> {
  const release = await acquireFileLock(path.join(paths(home).state, 'instances', 'worker.lock'), { waitMs: 0 });
  if (!release) throw new Error('another execution worker is still running for this home');
  return release;
}

/** Admit a supervised execution child only under the registered primary for
 * this home. This is a local process-coordination guard, not a security boundary
 * against another program running as the same OS user. Install the independent
 * parent-lifetime guardian before calling it, and keep the returned worker lock
 * until all activity services have drained.
 */
export async function admitWorkerProcess(home: string): Promise<() => void> {
  if (process.platform !== 'linux' || !process.connected || !process.send)
    throw new Error('worker admission requires Linux and supervisor IPC');
  const parent = process.ppid;
  const dir = path.join(paths(home).state, 'instances');
  const verifyParent = () => {
    if (!process.connected || process.ppid !== parent) throw new Error('worker supervisor is gone');
    let record: ProcessIdentity & { pid?: number; home?: string; processLock?: boolean };
    try { record = JSON.parse(fs.readFileSync(pidFile(dir, parent), 'utf8')); }
    catch { throw new Error('worker supervisor is not registered for this home'); }
    const current = processIdentity(parent);
    if (!record || record.pid !== parent || record.processLock !== true
      || typeof record.home !== 'string' || fs.realpathSync(record.home) !== fs.realpathSync(home)
      || !record.pidStart || !record.bootId || record.pidStart !== current.pidStart || record.bootId !== current.bootId)
      throw new Error('worker supervisor registration does not match its live identity');
  };
  verifyParent();
  // A stale registration must never license bypassing the primary lock. This
  // probe is nonblocking and releases immediately if no primary holds it.
  const primary = await acquireFileLock(path.join(dir, 'app.lock'), { waitMs: 0 });
  if (primary) {
    primary();
    throw new Error('worker supervisor does not hold the application lock');
  }
  const release = await claimWorkerOwnership(home);
  try { verifyParent(); }
  catch (error) { release(); throw error; }
  return release;
}
