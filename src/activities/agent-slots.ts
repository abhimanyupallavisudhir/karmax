import os from 'node:os';

/**
 * Host-wide admission control for concurrent agent turns (SPEC §12 "RAM is
 * consumed strictly during turns"). Each agent turn spawns a real model
 * subprocess (claude/codex) that can each hold hundreds of MB; the July 5 OOM
 * was several of them resident at once with no dedicated cap. The worker's
 * `maxConcurrentActivityTaskExecutions` gates ALL activities (merges, world
 * setup, scripts) together and scales with cores — it is not an agent cap. This
 * is a dedicated, small semaphore acquired around the actual model call only.
 *
 * Scope note: this is a per-process (per-worker) gate — the right level for the
 * single-host deployment karmax targets. A multi-worker fleet would promote this
 * to a Temporal lease coordinator (same pattern as merge-queue/account); the
 * call sites already `await` an async acquire, so that swap is localized.
 */

function envInt(name: string, dflt: number): number {
  const raw = process.env[name];
  if (!raw) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

function envFloat(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** Max concurrent agent turns. Small by default (memory, not throughput, is the
 *  binding constraint on a modest host); tune with KARMAX_MAX_AGENT_SLOTS. */
const CAPACITY = envInt('KARMAX_MAX_AGENT_SLOTS', 3);

/** Admission backs off while free memory is below this many MB, so a spike in
 *  already-running turns delays admitting new ones. 0 disables the check. */
const MIN_FREE_MB = envInt('KARMAX_AGENT_MIN_FREE_MB', 512);
/** Admission also backs off while the 1-minute load average exceeds
 *  `cores × factor` — the classic "run queue longer than the CPU can serve"
 *  signal. Default 1.0 (load may not exceed the core count). 0 disables the
 *  check; loadavg reads 0 on platforms that don't report it (e.g. Windows), so
 *  the gate is naturally inert there. */
const MAX_LOAD_FACTOR = envFloat('KARMAX_AGENT_MAX_LOAD_FACTOR', 1.0);
const MEM_POLL_MS = 1000;
const MEM_WAIT_MAX_MS = 5 * 60 * 1000; // don't wedge forever if the host stays tight
const HEARTBEAT_MS = 10_000;

let inUse = 0;
const waiters: Array<() => void> = [];

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const freeMemMb = () => os.freemem() / (1024 * 1024);
const coreCount = () => os.cpus().length || 1;

/** True while free memory sits below the floor (and the check is enabled). */
const memoryTight = () => MIN_FREE_MB > 0 && freeMemMb() < MIN_FREE_MB;
/** True while the 1-minute load average exceeds `cores × factor` (check enabled). */
const loadHigh = () => MAX_LOAD_FACTOR > 0 && os.loadavg()[0]! > coreCount() * MAX_LOAD_FACTOR;

/**
 * Point-in-time host diagnostics (loadavg, free/total memory, cores). Pure
 * reporting — surfaced on `/api/diagnostics` and folded into `agentSlotStats()`.
 * It is the same signal the admission gate acts on, so a human (or the UI) can
 * see WHY new leases are being held back.
 */
export function hostStats() {
  const load = os.loadavg();
  const cores = coreCount();
  const total = os.totalmem();
  const free = os.freemem();
  return {
    loadavg: load as [number, number, number], // [1m, 5m, 15m]
    cores,
    loadPerCore: Math.round((load[0]! / cores) * 100) / 100,
    freeMemMb: Math.round(free / (1024 * 1024)),
    totalMemMb: Math.round(total / (1024 * 1024)),
    usedMemPct: Math.round((1 - free / total) * 100),
  };
}

/** Block until memory recovers AND load eases (both bounded), heartbeating while
 *  it waits so a long park doesn't trip the activity's start-to-close timeout. */
async function awaitResources(onWait?: () => void): Promise<void> {
  if (MIN_FREE_MB <= 0 && MAX_LOAD_FACTOR <= 0) return;
  const deadline = Date.now() + MEM_WAIT_MAX_MS;
  while ((memoryTight() || loadHigh()) && Date.now() < deadline) {
    onWait?.();
    await delay(MEM_POLL_MS);
  }
}

/**
 * Acquire one agent slot. Resolves once both a slot is free AND memory pressure
 * has eased. Returns a release function that MUST be called (in a finally) — it
 * hands the slot straight to the next waiter. `onWait` is invoked periodically
 * while parked (wire the activity heartbeat) so a long queue doesn't trip the
 * activity timeout.
 *
 * Concurrency invariant: `inUse` counts slots that are held or being handed off.
 * The fast path increments it; when full, the waiter parks and a later release
 * TRANSFERS its slot (inUse unchanged) rather than decrement-then-reincrement,
 * which would briefly admit over capacity.
 */
export async function acquireAgentSlot(onWait?: () => void): Promise<() => void> {
  if (inUse < CAPACITY) {
    inUse++;
  } else {
    // Park until a release hands us its slot; heartbeat while we wait.
    const hb = onWait ? setInterval(() => onWait(), HEARTBEAT_MS) : undefined;
    try {
      await new Promise<void>((resolve) => waiters.push(resolve));
    } finally {
      if (hb) clearInterval(hb);
    }
  }
  await awaitResources(onWait);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = waiters.shift();
    if (next) next(); // transfer the slot; inUse unchanged
    else inUse--;
  };
}

/** Introspection for tests / diagnostics. Includes the live host signal and
 *  whether either pressure gate is currently holding admission back. */
export function agentSlotStats() {
  return {
    capacity: CAPACITY,
    inUse,
    waiting: waiters.length,
    minFreeMb: MIN_FREE_MB,
    maxLoadFactor: MAX_LOAD_FACTOR,
    memoryTight: memoryTight(),
    loadHigh: loadHigh(),
    host: hostStats(),
  };
}
