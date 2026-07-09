import fs from 'node:fs';

/**
 * Live process accounting for the dashboard task manager (GET /api/processes).
 *
 * Two layers make "nothing goes untracked" true:
 *
 *  1. A REGISTRY of processes karmax deliberately spawned (agent subprocesses,
 *     task-drawer PTYs, the Temporal dev server, login CLIs, usage probes).
 *     Registration is about *labels* — which task/kind a pid belongs to — and
 *     kill ergonomics (a registered entry can carry its own escalating killer).
 *
 *  2. A /proc SAMPLER that walks the FULL process trees under (a) the karmax
 *     process itself and (b) every registered root. Coverage does not depend on
 *     registration: a `git` call, an `npm test` run by an agent's Bash tool, or
 *     a command typed into an embedded terminal is a descendant of one of those
 *     roots and is picked up by the tree walk, attributed to its nearest
 *     registered ancestor (or to the catch-all "other karmax children" group).
 *
 * CPU% is computed from utime+stime deltas between successive samples (the
 * first sighting of a pid reports 0). Linux-only (/proc); on other platforms
 * the sample reports `supported: false` and the UI shows a notice.
 */

export type TrackedKind = 'agent' | 'terminal' | 'temporal' | 'login' | 'probe';

export interface TrackedProcess {
  /** Root pid of the entity (its whole descendant tree is attributed to it). */
  pid: number;
  kind: TrackedKind;
  label: string;
  taskId?: string;
  startedAt: number;
  /** Infrastructure karmax cannot run without (Temporal) — kill is refused. */
  protected?: boolean;
  /** Preferred kill (e.g. custody's escalating group kill); falls back to signals. */
  kill?: (signal: NodeJS.Signals) => void | Promise<void>;
}

export interface ProcessRow {
  pid: number;
  ppid: number;
  cmd: string;
  cpuPct: number;
  rssMb: number;
  /** Seconds since the process started (from /proc starttime vs system uptime). */
  ageSec: number;
}

export interface ProcessGroup {
  /** 'self' | 'untracked' | the registered root pid as a string. */
  key: string;
  kind: TrackedKind | 'app' | 'untracked';
  label: string;
  taskId?: string;
  protected?: boolean;
  cpuPct: number;
  rssMb: number;
  procs: ProcessRow[];
}

export interface ProcessSample {
  supported: boolean;
  ts: number;
  groups: ProcessGroup[];
  totals: { procs: number; cpuPct: number; rssMb: number };
}

const registry = new Map<number, TrackedProcess>();

/** Register a spawned process; returns an unregister function (idempotent). */
export function trackProcess(p: TrackedProcess): () => void {
  if (!p.pid || p.pid <= 1) return () => {};
  registry.set(p.pid, p);
  return () => {
    if (registry.get(p.pid) === p) registry.delete(p.pid);
  };
}

/** Test/introspection hook. */
export function trackedProcesses(): TrackedProcess[] {
  return [...registry.values()];
}

// /proc/<pid>/stat times are in USER_HZ ticks; the Linux userland ABI fixes
// USER_HZ at 100 regardless of the kernel's internal CONFIG_HZ.
const CLK_TCK = 100;

interface ProcStat {
  pid: number;
  ppid: number;
  pgrp: number;
  comm: string;
  /** utime+stime in clock ticks. */
  ticks: number;
  /** Process start, in ticks since boot — with pid, a stable identity across pid reuse. */
  starttime: number;
}

function parseStat(pid: number): ProcStat | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return undefined; // raced an exit
  }
  // comm (field 2) is parenthesized and may itself contain spaces/parens —
  // split on the LAST ')'.
  const close = raw.lastIndexOf(')');
  const open = raw.indexOf('(');
  if (open < 0 || close < 0) return undefined;
  const comm = raw.slice(open + 1, close);
  const rest = raw.slice(close + 2).split(' ');
  // rest[0] = state (field 3); fields are 1-indexed in proc(5).
  const f = (n: number) => Number(rest[n - 3] ?? 0);
  return { pid, comm, ppid: f(4), pgrp: f(5), ticks: f(14) + f(15), starttime: f(22) };
}

function readProcTable(): Map<number, ProcStat> {
  const table = new Map<number, ProcStat>();
  let names: string[];
  try {
    names = fs.readdirSync('/proc');
  } catch {
    return table;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const st = parseStat(Number(name));
    if (st) table.set(st.pid, st);
  }
  return table;
}

function readCmdline(pid: number, comm: string): string {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    const joined = raw.split('\0').filter(Boolean).join(' ').trim();
    if (joined) return joined.length > 200 ? joined.slice(0, 200) + '…' : joined;
  } catch {
    /* fall through */
  }
  return `[${comm}]`;
}

function readRssMb(pid: number): number {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = /VmRSS:\s+(\d+)\s*kB/.exec(status);
    if (m) return Math.round((Number(m[1]) / 1024) * 10) / 10;
  } catch {
    /* kernel thread or raced an exit */
  }
  return 0;
}

function bootEpochMs(): number {
  try {
    const m = /btime\s+(\d+)/.exec(fs.readFileSync('/proc/stat', 'utf8'));
    if (m) return Number(m[1]) * 1000;
  } catch {
    /* ignore */
  }
  return 0;
}

// Previous CPU-tick observations, keyed pid:starttime so a recycled pid never
// inherits the dead process's counters.
const prevTicks = new Map<string, { ticks: number; at: number }>();

function cpuPctOf(st: ProcStat, now: number): number {
  const key = `${st.pid}:${st.starttime}`;
  const prev = prevTicks.get(key);
  prevTicks.set(key, { ticks: st.ticks, at: now });
  if (!prev || now <= prev.at) return 0;
  const pct = (((st.ticks - prev.ticks) / CLK_TCK) * 1000 * 100) / (now - prev.at);
  return Math.max(0, Math.round(pct * 10) / 10);
}

/**
 * Sample every process karmax is responsible for: the karmax process itself,
 * all its descendants, and the full tree under each registered root (which may
 * live outside our tree — the Temporal server runs as a systemd user unit).
 */
export function sampleProcesses(): ProcessSample {
  const ts = Date.now();
  if (process.platform !== 'linux' || !fs.existsSync('/proc')) {
    return { supported: false, ts, groups: [], totals: { procs: 0, cpuPct: 0, rssMb: 0 } };
  }
  const table = readProcTable();

  // Prune registry entries whose process is gone (entries that aren't our direct
  // children — the reused Temporal server — have no 'exit' event to clean them).
  for (const pid of [...registry.keys()]) if (!table.has(pid)) registry.delete(pid);

  const children = new Map<number, number[]>();
  for (const st of table.values()) {
    const list = children.get(st.ppid);
    if (list) list.push(st.pid);
    else children.set(st.ppid, [st.pid]);
  }

  // Scope = self tree ∪ every registered root's tree.
  const roots = [process.pid, ...registry.keys()];
  const scope = new Set<number>();
  const queue = roots.filter((p) => table.has(p));
  while (queue.length) {
    const pid = queue.pop()!;
    if (scope.has(pid)) continue;
    scope.add(pid);
    for (const c of children.get(pid) ?? []) queue.push(c);
  }

  // Attribute each in-scope pid to its nearest registered ancestor (itself
  // included); unregistered descendants of karmax fall into the catch-all.
  const ownerOf = (pid: number): string => {
    for (let cur: number | undefined = pid; cur && cur > 1; cur = table.get(cur)?.ppid) {
      if (registry.has(cur)) return String(cur);
      if (cur === process.pid) return pid === process.pid ? 'self' : 'untracked';
    }
    return 'untracked';
  };

  const boot = bootEpochMs();
  const groups = new Map<string, ProcessGroup>();
  const groupFor = (key: string): ProcessGroup => {
    let g = groups.get(key);
    if (g) return g;
    if (key === 'self') {
      g = { key, kind: 'app', label: 'karmax (gateway + worker)', protected: true, cpuPct: 0, rssMb: 0, procs: [] };
    } else if (key === 'untracked') {
      g = { key, kind: 'untracked', label: 'other karmax children', cpuPct: 0, rssMb: 0, procs: [] };
    } else {
      const t = registry.get(Number(key))!;
      g = { key, kind: t.kind, label: t.label, taskId: t.taskId, protected: t.protected, cpuPct: 0, rssMb: 0, procs: [] };
    }
    groups.set(key, g);
    return g;
  };

  const totals = { procs: 0, cpuPct: 0, rssMb: 0 };
  for (const pid of scope) {
    const st = table.get(pid)!;
    const row: ProcessRow = {
      pid,
      ppid: st.ppid,
      cmd: readCmdline(pid, st.comm),
      cpuPct: cpuPctOf(st, ts),
      rssMb: readRssMb(pid),
      ageSec: boot ? Math.max(0, Math.round((ts - (boot + (st.starttime / CLK_TCK) * 1000)) / 1000)) : 0,
    };
    const g = groupFor(ownerOf(pid));
    g.procs.push(row);
    g.cpuPct = Math.round((g.cpuPct + row.cpuPct) * 10) / 10;
    g.rssMb = Math.round((g.rssMb + row.rssMb) * 10) / 10;
    totals.procs++;
    totals.cpuPct = Math.round((totals.cpuPct + row.cpuPct) * 10) / 10;
    totals.rssMb = Math.round((totals.rssMb + row.rssMb) * 10) / 10;
  }

  // Drop stale CPU baselines so the map can't grow with pid churn.
  for (const key of [...prevTicks.keys()]) {
    const pid = Number(key.split(':')[0]);
    if (!scope.has(pid)) prevTicks.delete(key);
  }

  const busiest = (a: ProcessGroup, b: ProcessGroup) => b.cpuPct - a.cpuPct || b.rssMb - a.rssMb;
  for (const g of groups.values()) g.procs.sort((a, b) => b.cpuPct - a.cpuPct || b.rssMb - a.rssMb);
  return { supported: true, ts, groups: [...groups.values()].sort(busiest), totals };
}

/**
 * Kill a pid from the task-manager UI. Only pids inside the sampled scope are
 * killable (never an arbitrary system process), never karmax itself, and never
 * a protected root (the Temporal server — killing it wedges everything;
 * `npm run reset` is the supported way). A registered root's own killer is
 * preferred (custody's SIGTERM→SIGKILL group escalation); otherwise the signal
 * goes to the process group when the pid leads one, else to the bare pid.
 */
export async function killTracked(pid: number, signal: NodeJS.Signals = 'SIGTERM'): Promise<{ ok: boolean; error?: string }> {
  if (!Number.isInteger(pid) || pid <= 1) return { ok: false, error: 'invalid pid' };
  if (pid === process.pid) return { ok: false, error: 'refusing to kill karmax itself' };
  const entry = registry.get(pid);
  if (entry?.protected) return { ok: false, error: `${entry.label} is protected (use \`npm run reset\` to stop Temporal)` };

  // Fresh scope check — membership in the LAST sample isn't enough (the pid may
  // have exited and been recycled by an unrelated process since).
  const sample = sampleProcesses();
  if (!sample.supported) return { ok: false, error: 'process control unavailable on this platform' };
  const inScope = sample.groups.some((g) => (g.key === 'self' ? false : g.procs.some((r) => r.pid === pid)));
  if (!inScope) return { ok: false, error: 'pid is not a karmax-managed process' };

  try {
    if (entry?.kill) {
      await entry.kill(signal);
      return { ok: true };
    }
    const st = parseStat(pid);
    if (st && st.pgrp === pid) {
      // Group leader (detached agents): signal the whole group so tool
      // subprocesses don't survive their root.
      try {
        process.kill(-pid, signal);
        return { ok: true };
      } catch {
        /* fall through to the bare pid */
      }
    }
    process.kill(pid, signal);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
