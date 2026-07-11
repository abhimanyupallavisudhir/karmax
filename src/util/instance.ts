import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config/paths.js';

/**
 * Duplicate app-instance detection (karmax#4). The July-5 OOM had 14 concurrent
 * `src/main.ts` app instances running against the same KARMAX_HOME — each boots
 * its own worker (and its own fan-out of agent turns), multiplying RAM pressure
 * with no benefit: one app already serves the whole todo list. Nothing enforced
 * "one app per home", so nothing warned.
 *
 * This is advisory, not a hard lock: karmax deliberately supports a fast restart
 * (Ctrl-C then re-run) and the shared Temporal server is reused across boots — a
 * hard singleton lock would fight that. So we keep a directory of live-instance
 * pidfiles under the state dir and log a LOUD warning when another live app is
 * already registered against the same home; the operator decides.
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
 * Pure over its injected `isAlive` (tests pass a fake) — no process signals or
 * clock reads of its own beyond the probe.
 */
export function scanInstances(dir: string, selfPid: number, isAlive: (pid: number) => boolean = isAliveDefault): number[] {
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
    if (isAlive(pid)) others.push(pid);
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

/**
 * Register this process as a live app instance and report any others already
 * running against the same KARMAX_HOME. Best-effort: a filesystem hiccup never
 * blocks boot.
 */
export function registerAppInstance(): InstanceRegistration {
  const dir = instancesDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return { others: [], release: () => {} };
  }
  const others = scanInstances(dir, process.pid);
  const self = pidFile(dir, process.pid);
  try {
    fs.writeFileSync(self, JSON.stringify({ pid: process.pid, home: paths().home, argv: process.argv.slice(1, 3) }));
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
        fs.rmSync(self);
      } catch {
        /* already gone */
      }
    },
  };
}
