import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from '../config/paths.js';

/**
 * Process-tree custody for spawned agent subprocesses (the other half of the
 * July-5 OOM fix; the graceful abort half already landed in the adapters).
 *
 * The graceful path — an AbortController wired into the SDK/CLI on a *catchable*
 * signal — only runs when karmax gets to run a handler. The July-5 kill was
 * systemd-oomd (SIGKILL): no handler runs, the spawned `claude`/`codex` (and
 * their descendant tool processes) reparent to init and keep eating RAM with
 * nothing left alive that knows about them.
 *
 * This module is the custody that survives SIGKILL:
 *  - every directly-spawned agent is recorded as a pidfile under
 *    `KARMAX_HOME/state/agents/<pid>.json` at spawn, removed at turn end;
 *  - adapters stamp a unique id into KARMAX_CUSTODY_CHAIN. Every ordinary
 *    descendant inherits it, even when a tool creates a new process group or
 *    session (Chrome, shell commands, nested karmax, test Temporal servers);
 *  - adapters also spawn the child *detached* (its own process group), retained
 *    as a compatibility/fallback boundary for old records and scrubbed envs;
 *  - at BOOT, `reapOrphans()` sweeps leftover pidfiles: any still-live marked
 *    scope that a prior incarnation left behind is hard-killed. This is the only
 *    custody that works after a SIGKILL/crash — graceful teardown never ran.
 *
 * PID-reuse guard: a stale pidfile's number may have been recycled by an
 * unrelated process after a reboot. On Linux we verify `/proc/<pid>/cmdline`
 * still matches the recorded command before killing; where we can't verify
 * (no procfs), we clear the pidfile without killing. Better to leak a truly
 * dead record than to kill an innocent bystander.
 *
 * Live-owner guard (2026-07-12 incident): "anything recorded here is an orphan"
 * is only true when this boot is the sole karmax app. With the world-rooted boot
 * guard disabled (karmax#3), a task's agent can boot a dogfooding karmax from
 * its worktree world against the same KARMAX_HOME — and that boot's sweep would
 * SIGKILL the very agent running the task (plus every other live turn) because
 * their pidfiles look like leftovers. An agent record whose `owner` process is
 * still alive is NOT an orphan; the sweep must leave it (and its pidfile — the
 * custody record must survive for when the owner does die) untouched.
 */

export interface AgentRecord {
  /** Root pid == process-group id (spawned detached). */
  pid: number;
  /** Command basename we spawned (e.g. "codex"), for the PID-reuse cmdline check. */
  cmd: string;
  provider?: string;
  taskId?: string;
  role?: string;
  /** The karmax process that spawned it (debugging / incarnation attribution). */
  owner: number;
  /** Unique inherited marker used to find descendants across process groups. */
  custodyId?: string;
  startedAt: number;
}

export const CUSTODY_ENV = 'KARMAX_CUSTODY_CHAIN';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function agentsDir(): string {
  return path.join(paths().state, 'agents');
}
function fileFor(pid: number): string {
  return path.join(agentsDir(), `${pid}.json`);
}

/**
 * Add a fresh custody id to an agent's environment without discarding an outer
 * agent's marker. The chain matters for dogfooding: an agent may start karmax,
 * which may start another agent. Ending either turn should reap its own subtree,
 * while ending the outer turn must also reap everything nested below it.
 */
export function createCustodyEnv<T extends Record<string, string | undefined>>(
  env: T,
): { env: T; custodyId: string } {
  const custodyId = crypto.randomUUID();
  const inherited = (env[CUSTODY_ENV] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    custodyId,
    env: { ...env, [CUSTODY_ENV]: [...inherited, custodyId].join(',') } as T,
  };
}

/** Record a freshly-spawned agent so it can be reaped after a hard kill. */
export function registerAgent(rec: AgentRecord): void {
  try {
    fs.mkdirSync(agentsDir(), { recursive: true });
    fs.writeFileSync(fileFor(rec.pid), JSON.stringify(rec));
  } catch {
    /* custody is best-effort; never fail a turn over a pidfile */
  }
}

/** Drop an agent's pidfile once its turn has ended normally. */
export function unregisterAgent(pid: number | undefined): void {
  if (!pid) return;
  try {
    fs.rmSync(fileFor(pid), { force: true });
  } catch {
    /* ignore */
  }
}

function recordFor(pid: number | undefined): AgentRecord | undefined {
  if (!pid) return undefined;
  try {
    return JSON.parse(fs.readFileSync(fileFor(pid), 'utf8')) as AgentRecord;
  } catch {
    return undefined;
  }
}

/** Is `pid` a live process? `EPERM` means it exists but we can't signal it. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

/** On Linux, does `/proc/<pid>` still belong to the command we spawned? Returns
 *  false when we can't read procfs (non-Linux) — the safe default is "don't kill". */
function cmdlineMatches(pid: number, cmd: string): boolean {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return raw.split('\0').join(' ').includes(cmd);
  } catch {
    return false;
  }
}

/** Exact custody ids inherited by a process. Linux procfs is the recovery
 * source after parents have died and descendants have been reparented. */
function processCustodyIds(pid: number): string[] {
  if (process.platform !== 'linux') return [];
  try {
    const raw = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
    const prefix = `${CUSTODY_ENV}=`;
    const entry = raw.split('\0').find((value) => value.startsWith(prefix));
    return entry
      ? entry.slice(prefix.length).split(',').map((value) => value.trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

/** Find every live process carrying `custodyId`, regardless of its parent,
 * process group, or session. Exported for diagnostics and focused tests. */
export function custodyProcesses(custodyId: string | undefined): number[] {
  if (!custodyId || process.platform !== 'linux') return [];
  let entries: string[];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return [];
  }
  return entries
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number)
    .filter((pid) => processCustodyIds(pid).includes(custodyId))
    .sort((a, b) => a - b);
}

/** Signal marked processes one by one, rechecking the marker immediately before
 * each signal as a PID-reuse guard. */
function signalCustody(custodyId: string | undefined, signal: NodeJS.Signals): number {
  if (!custodyId) return 0;
  let signalled = 0;
  for (const pid of custodyProcesses(custodyId)) {
    if (!processCustodyIds(pid).includes(custodyId)) continue;
    try {
      process.kill(pid, signal);
      signalled++;
    } catch {
      /* raced process exit */
    }
  }
  return signalled;
}

/** Is the karmax process that spawned this agent still alive? A live owner means
 *  the record is NOT an orphan — another running app instance is mid-turn on it.
 *  PID-reuse guard: the owner's pid may have been recycled after a reboot, so on
 *  Linux require its cmdline to still look like a Node process (karmax always
 *  runs under node/tsx). Where we can't verify (no procfs), a live pid counts as
 *  a live owner — better to leak a true orphan for one boot than to SIGKILL an
 *  in-flight agent turn. */
function ownerAlive(owner: number | undefined): boolean {
  if (!owner || owner <= 1 || !alive(owner)) return false;
  try {
    return fs.readFileSync(`/proc/${owner}/cmdline`, 'utf8').includes('node');
  } catch {
    return true;
  }
}

/**
 * Signal a whole process group, falling back to the bare pid if the target was
 * never a group leader. Negative pid = the group (SPEC: detached spawn makes the
 * root its own group leader, so the group id equals the root pid).
 */
export function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid || pid <= 1) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

function signalAgentTree(pid: number, custodyId: string | undefined, signal: NodeJS.Signals): number {
  const marked = signalCustody(custodyId, signal);
  // Keep the original group kill as a fallback for legacy records and for a
  // descendant that deliberately scrubbed its environment.
  killProcessGroup(pid, signal);
  return marked;
}

function agentTreeAlive(pid: number, custodyId: string | undefined): boolean {
  return alive(pid) || custodyProcesses(custodyId).length > 0;
}

/**
 * Terminate a live agent's whole marked scope: SIGTERM, then SIGKILL after a
 * grace window if it hasn't exited. Removes its pidfile. Used by the graceful
 * abort path (mid-turn cancel) for a firm, escalating kill of the tool subtree.
 */
export async function killAgent(
  pid: number | undefined,
  graceMs = 2500,
  custodyId = recordFor(pid)?.custodyId,
): Promise<void> {
  if (!pid) return;
  signalAgentTree(pid, custodyId, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (agentTreeAlive(pid, custodyId) && Date.now() < deadline) await delay(100);
  if (agentTreeAlive(pid, custodyId)) signalAgentTree(pid, custodyId, 'SIGKILL');
  unregisterAgent(pid);
}

/**
 * The agent root can exit normally while background tools remain. Settle the
 * inherited custody scope before dropping its durable record; otherwise a
 * successful turn can leak exactly the same nested apps/browsers as a crash.
 */
export async function releaseAgent(
  pid: number | undefined,
  custodyId = recordFor(pid)?.custodyId,
  graceMs = 1000,
): Promise<void> {
  if (!pid) return;
  if (!custodyId && !alive(pid)) {
    unregisterAgent(pid);
    return;
  }
  await killAgent(pid, graceMs, custodyId);
}

/**
 * Boot/periodic sweep: hard-kill any agent process scopes a previous karmax
 * incarnation left running (systemd-oomd / crash / force-kill), then clear the
 * pidfiles. Only records whose OWNER process is dead are orphans — an agent
 * whose spawning karmax instance is still alive belongs to a concurrently
 * running app (karmax#3 dogfooding boot) and is skipped, pidfile intact.
 * Returns how many scopes were reaped, stale files cleared, and live-owned
 * records skipped.
 */
export function reapOrphans(): { reaped: number; cleared: number; skipped: number } {
  let reaped = 0;
  let cleared = 0;
  let skipped = 0;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(agentsDir());
  } catch {
    return { reaped: 0, cleared: 0, skipped: 0 }; // no dir yet → nothing to reap
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(agentsDir(), name);
    let rec: AgentRecord | undefined;
    try {
      rec = JSON.parse(fs.readFileSync(file, 'utf8')) as AgentRecord;
    } catch {
      /* corrupt/partial pidfile — just clear it below */
    }
    if (rec && ownerAlive(rec.owner)) {
      // Not an orphan: the instance that spawned it is still running its turn.
      skipped++;
      continue;
    }
    const pid = rec?.pid ?? Number(name.slice(0, -5));
    let killed = false;
    if (rec?.custodyId && signalCustody(rec.custodyId, 'SIGKILL') > 0) {
      // Descendants may have left the root's group/session or the root may
      // already be gone. The inherited marker still identifies the whole scope.
      killed = true;
    }
    if (Number.isFinite(pid) && pid > 1 && alive(pid) && rec && cmdlineMatches(pid, rec.cmd)) {
      // Compatibility/fallback for old records and descendants that scrubbed
      // their environment. The live root + command check guards PID reuse.
      killProcessGroup(pid, 'SIGKILL');
      killed = true;
    }
    if (killed) reaped++;
    try {
      fs.rmSync(file, { force: true });
      cleared++;
    } catch {
      /* ignore */
    }
  }
  return { reaped, cleared, skipped };
}
