import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths } from '../config/paths.js';

/**
 * Worker-side live-resource checks for concurrent agent turns (SPEC §12 "RAM is
 * consumed strictly during turns"). Current executions get their configured,
 * ordered capacity lease from the agent-queue workflow; memory/load can only be
 * observed here, immediately before the model subprocess starts.
 *
 * The file-slot path is retained for replay compatibility with historical task
 * workflows that have no stable agent-turn id/coordinator enrollment. Those
 * slots are atomic lease files under the shared KARMAX_HOME. Every holder is
 * tied to its worker pid + Linux process-start identity, so another worker can
 * reclaim the lease after a crash without mistaking a reused pid for the old
 * owner. On platforms without procfs, signal-0 liveness is the conservative
 * fallback. Waiter files make diagnostics global too; they are admission hints,
 * not correctness locks. The numbered slot files are the only authority.
 */

function envInt(name: string, dflt: number): number {
  const raw = process.env[name];
  if (!raw) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

function envNonNegativeInt(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}

function envFloat(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

// Read configuration at admission time. Besides making diagnostics reflect a
// deliberate runtime env change, this prevents a utility import during startup
// from permanently freezing legacy admission settings before configuration is
// loaded. Stable turn IDs use the durable agent-queue coordinator; this file
// remains the replay-compatible fallback for historical executions.
const capacity = () => envInt('KARMAX_MAX_AGENT_SLOTS', 3);
const minFreeMb = () => envNonNegativeInt('KARMAX_AGENT_MIN_FREE_MB', 512);
const maxLoadFactor = () => envFloat('KARMAX_AGENT_MAX_LOAD_FACTOR', 1.0);
const MEM_POLL_MS = 1000;
const SLOT_POLL_MS = 100;
const MEM_WAIT_MAX_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 10_000;
const PARTIAL_FILE_GRACE_MS = 5_000;

interface LeaseRecord {
  token: string;
  owner: number;
  ownerStart?: string;
  createdAt: number;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const freeMemMb = () => os.freemem() / (1024 * 1024);
const coreCount = () => os.cpus().length || 1;
const leaseRoot = () => path.join(paths().state, 'agent-slots');
const slotsDir = () => path.join(leaseRoot(), 'held');
const waitersDir = () => path.join(leaseRoot(), 'waiting');

function ensureLeaseDirs(): void {
  fs.mkdirSync(slotsDir(), { recursive: true });
  fs.mkdirSync(waitersDir(), { recursive: true });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** Linux field 22 is the process start tick. It disambiguates pid reuse. */
function processStart(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return afterComm[19]; // array begins at field 3; index 19 is field 22
  } catch {
    return undefined;
  }
}

const SELF_START = processStart(process.pid);

function ownerAlive(rec: LeaseRecord): boolean {
  if (!rec.owner || !alive(rec.owner)) return false;
  if (!rec.ownerStart) return true;
  const now = processStart(rec.owner);
  return now === undefined || now === rec.ownerStart;
}

function readRecord(file: string): LeaseRecord | undefined {
  try {
    const rec = JSON.parse(fs.readFileSync(file, 'utf8')) as LeaseRecord;
    return rec?.token && Number.isFinite(rec.owner) ? rec : undefined;
  } catch {
    return undefined;
  }
}

/** Return live records and prune files whose owning worker is gone. A just-created
 * empty/partial file is conservatively counted for a few seconds so a scanner
 * cannot unlink it between another process's O_EXCL open and write. */
function liveRecords(dir: string): Array<{ file: string; rec?: LeaseRecord }> {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: Array<{ file: string; rec?: LeaseRecord }> = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    const rec = readRecord(file);
    if (rec && ownerAlive(rec)) {
      out.push({ file, rec });
      continue;
    }
    if (!rec) {
      try {
        if (Date.now() - fs.statSync(file).mtimeMs < PARTIAL_FILE_GRACE_MS) {
          out.push({ file });
          continue;
        }
      } catch {
        continue;
      }
    }
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* raced another scanner */
    }
  }
  return out;
}

function writeExclusive(file: string, rec: LeaseRecord): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(rec));
    return true;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e;
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function removeOwned(file: string, token: string): void {
  try {
    if (readRecord(file)?.token === token) fs.rmSync(file, { force: true });
  } catch {
    /* already gone */
  }
}

export function admissionDecision(
  host: { freeMemMb: number; loadavg1: number; cores: number },
  thresholds: { minFreeMb: number; maxLoadFactor: number },
): { memoryTight: boolean; loadHigh: boolean; backpressure: boolean } {
  const memoryTight = thresholds.minFreeMb > 0 && host.freeMemMb < thresholds.minFreeMb;
  const loadHigh = thresholds.maxLoadFactor > 0 && host.loadavg1 > host.cores * thresholds.maxLoadFactor;
  return { memoryTight, loadHigh, backpressure: memoryTight || loadHigh };
}

const pressure = () =>
  admissionDecision(
    { freeMemMb: freeMemMb(), loadavg1: os.loadavg()[0]!, cores: coreCount() },
    { minFreeMb: minFreeMb(), maxLoadFactor: maxLoadFactor() },
  );
const memoryTight = () => pressure().memoryTight;
const loadHigh = () => pressure().loadHigh;

export function hostMemoryTight(): boolean {
  if (minFreeMb() > 0) return memoryTight();
  const total = os.totalmem() / (1024 * 1024);
  return freeMemMb() < total * 0.05;
}

export function hostStats() {
  const load = os.loadavg();
  const cores = coreCount();
  const total = os.totalmem();
  const free = os.freemem();
  return {
    loadavg: load as [number, number, number],
    cores,
    loadPerCore: Math.round((load[0]! / cores) * 100) / 100,
    freeMemMb: Math.round(free / (1024 * 1024)),
    totalMemMb: Math.round(total / (1024 * 1024)),
    usedMemPct: Math.round((1 - free / total) * 100),
  };
}

export async function awaitAgentResources(
  onWait?: () => void,
  signal?: AbortSignal,
  onPressure?: (state: { memoryTight: boolean; loadHigh: boolean }) => void | Promise<void>,
): Promise<void> {
  if (minFreeMb() <= 0 && maxLoadFactor() <= 0) return;
  const deadline = Date.now() + MEM_WAIT_MAX_MS;
  for (;;) {
    const state = pressure();
    if (!state.backpressure || Date.now() >= deadline) break;
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('agent slot wait cancelled');
    await onPressure?.(state);
    onWait?.();
    await delay(MEM_POLL_MS);
  }
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('agent slot wait cancelled');
}

function tryAcquire(rec: LeaseRecord): string | undefined {
  ensureLeaseDirs();
  liveRecords(slotsDir());
  for (let i = 0; i < capacity(); i++) {
    const file = path.join(slotsDir(), `${i}.json`);
    if (writeExclusive(file, rec)) return file;
  }
  return undefined;
}

export async function acquireAgentSlot(onWait?: () => void, signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('agent slot wait cancelled');
  ensureLeaseDirs();
  const rec: LeaseRecord = { token: crypto.randomUUID(), owner: process.pid, ownerStart: SELF_START, createdAt: Date.now() };
  const waiterFile = path.join(waitersDir(), `${rec.createdAt}-${process.pid}-${rec.token}.json`);
  let slotFile = tryAcquire(rec);
  if (!slotFile) writeExclusive(waiterFile, rec);
  let lastHeartbeat = Date.now();
  try {
    while (!slotFile) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('agent slot wait cancelled');
      if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
        onWait?.();
        lastHeartbeat = Date.now();
      }
      await delay(SLOT_POLL_MS);
      slotFile = tryAcquire(rec);
    }
  } finally {
    removeOwned(waiterFile, rec.token);
  }

  try {
    await awaitAgentResources(onWait, signal);
  } catch (e) {
    removeOwned(slotFile, rec.token);
    throw e;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    removeOwned(slotFile!, rec.token);
  };
}

export function agentSlotStats() {
  ensureLeaseDirs();
  return {
    capacity: capacity(),
    inUse: liveRecords(slotsDir()).length,
    waiting: liveRecords(waitersDir()).length,
    minFreeMb: minFreeMb(),
    maxLoadFactor: maxLoadFactor(),
    memoryTight: memoryTight(),
    loadHigh: loadHigh(),
    host: hostStats(),
  };
}
