import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from '../config/paths.js';
import { processStartTick } from '../util/processes.js';

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
 * unrelated process after a reboot. Identity is established by the process START
 * TICK (`/proc/<pid>/stat` field 22) recorded at spawn — the same primitive
 * `src/activities/agent-slots.ts` uses for lease owners — and only then by
 * `/proc/<pid>/cmdline`. The cmdline check alone is NOT sufficient: for the
 * Claude Agent-SDK rail the spawned command is the node executable, so
 * `rec.cmd === 'node'` and a recycled pid belonging to ANY node process on the
 * box would pass it and be SIGKILLed with its whole process group — precisely
 * the 2026-07-12 cross-instance-kill incident class. Where we can't verify (no
 * procfs, or a record written before start ticks were stamped), we clear the
 * pidfile WITHOUT killing. Better to leak a truly dead record for one boot than
 * to kill an innocent bystander; the custodyId sweep below still reaps every
 * marked descendant exactly, so nothing verifiable is lost.
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
  /** The process start time for `pid` (`/proc/<pid>/stat` field 22 on Linux,
   *  `ps` lstart elsewhere), stamped by `registerAgent`. Wall-clock `startedAt`
   *  cannot disambiguate pid reuse; this can. Absent on records written before
   *  this existed. */
  pidStart?: string;
  /** The same start tick for `owner`, so a recycled owner pid cannot make a
   *  genuine orphan permanently unreapable. */
  ownerStart?: string;
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

/**
 * Record a freshly-spawned agent so it can be reaped after a hard kill. The
 * start ticks are stamped HERE rather than by each adapter so every call site
 * (and every future one) gets the PID-reuse guard for free.
 */
export function registerAgent(rec: AgentRecord): void {
  try {
    fs.mkdirSync(agentsDir(), { recursive: true });
    const pidStart = rec.pidStart ?? processStart(rec.pid);
    const ownerStart = rec.ownerStart ?? processStart(rec.owner);
    fs.writeFileSync(
      fileFor(rec.pid),
      JSON.stringify({
        ...rec,
        ...(pidStart ? { pidStart } : {}),
        ...(ownerStart ? { ownerStart } : {}),
      }),
    );
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

/** Custody ids of the task's agents that are running now. A record whose pid
 *  was recycled does not count: only a verified start tick proves it. */
export function taskCustodyIds(taskId: string): string[] {
  let files: string[];
  try {
    files = fs.readdirSync(agentsDir()).filter((file) => file.endsWith('.json'));
  } catch {
    return [];
  }
  return files
    .map((file) => recordFor(Number(file.slice(0, -5))))
    .filter((rec): rec is AgentRecord => !!rec?.custodyId && rec.taskId === taskId && alive(rec.pid) && startMatches(rec.pid, rec.pidStart))
    .map((rec) => rec.custodyId!);
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
 *  false when we can't read procfs (non-Linux) — the safe default is "don't kill".
 *
 *  NOTE: this is a WEAK check and must never be the only one guarding a SIGKILL.
 *  `rec.cmd` is a basename, and for the Claude Agent-SDK rail the command we
 *  spawn is the node executable, so it is literally "node" — matched by every
 *  node process on the host. `startMatches()` is the authoritative guard. */
function cmdlineMatches(pid: number, cmd: string): boolean {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return raw.split('\0').join(' ').includes(cmd);
  } catch {
    return false;
  }
}

/** The process's start time: `/proc` field 22 on Linux, `ps` elsewhere. Two
 *  processes with the same pid at different times cannot share it, so it is the
 *  only reliable identity check available after the parent has died. */
const processStart = processStartTick;

/**
 * Is `pid` still the very process the record was written for?
 *
 * `recorded === undefined` (a pre-start-tick record, or no procfs or `ps`) is
 * treated as NOT verified. That is the conservative direction on purpose: an
 * unverifiable record can only cost us a leaked, already-dead pidfile for one
 * boot, whereas guessing "yes" reintroduces exactly the incident this guards —
 * SIGKILLing a whole process group belonging to some unrelated recycled pid.
 * The custodyId sweep is unaffected: it matches an exact inherited marker in
 * `/proc/<pid>/environ`, so genuine descendants are still reaped precisely.
 */
function startMatches(pid: number, recorded: string | undefined): boolean {
  if (!recorded) return false;
  const now = processStart(pid);
  return now !== undefined && now === recorded;
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
 *
 *  PID-reuse guard, mirrored from the kill path: when the record carries an
 *  `ownerStart`, the live pid must ALSO have that exact start tick, otherwise the
 *  owner is a recycled stranger and the record is a genuine orphan (previously a
 *  recycled owner pid running any node process made an orphan permanently
 *  unreapable). Without a recorded tick we fall back to the old cmdline heuristic
 *  and, failing that, treat a live pid as a live owner — the conservative
 *  direction HERE is the opposite of the kill path's: leaking a true orphan for
 *  one boot beats SIGKILLing another instance's in-flight agent turn. */
function ownerAlive(rec: Pick<AgentRecord, 'owner' | 'ownerStart'>): boolean {
  const owner = rec.owner;
  if (!owner || owner <= 1 || !alive(owner)) return false;
  const recorded = rec.ownerStart;
  if (recorded) {
    const now = processStart(owner);
    // `undefined` = procfs unreadable ⇒ unverifiable ⇒ assume the owner is live.
    return now === undefined || now === recorded;
  }
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

function signalAgentTree(pid: number, custodyId: string | undefined, signal: NodeJS.Signals, pidStart?: string): number {
  const marked = signalCustody(custodyId, signal);
  // Keep the original group kill as a fallback for legacy records and for a
  // descendant that deliberately scrubbed its environment.
  if (startMatches(pid, pidStart)) killProcessGroup(pid, signal);
  return marked;
}

function agentTreeAlive(pid: number, custodyId: string | undefined, pidStart?: string): boolean {
  return (startMatches(pid, pidStart) && alive(pid)) || custodyProcesses(custodyId).length > 0;
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
  const pidStart = recordFor(pid)?.pidStart;
  signalAgentTree(pid, custodyId, 'SIGTERM', pidStart);
  const deadline = Date.now() + graceMs;
  while (agentTreeAlive(pid, custodyId, pidStart) && Date.now() < deadline) await delay(100);
  if (agentTreeAlive(pid, custodyId, pidStart)) signalAgentTree(pid, custodyId, 'SIGKILL', pidStart);
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
    if (rec && ownerAlive(rec)) {
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
    if (
      Number.isFinite(pid) && pid > 1 && rec && alive(pid)
      // Authoritative PID-reuse guard: the pid must be the SAME process incarnation
      // we recorded. Without this, `cmd === 'node'` (every Claude Agent-SDK record)
      // let any recycled node pid's whole process group be SIGKILLed.
      && startMatches(pid, rec.pidStart)
      && cmdlineMatches(pid, rec.cmd)
    ) {
      // Compatibility/fallback for descendants that scrubbed their environment.
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
