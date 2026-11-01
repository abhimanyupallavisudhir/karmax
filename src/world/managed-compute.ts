import { ProviderCapacityFull } from '../agent/limits.js';
import { BRAND } from '../domain/brand.js';
import { COMPUTE_TERMS, computeChargeMicros } from '../domain/entitlements.js';
import { providerDefaults, type AccountPool } from '../domain/computer-limits.js';
import { flyComputeDollarsPerSecond, flyGuest, flyVolumeDollarsPerSecond } from './fly.js';
import { costMicrosPerSecond } from './runners.js';
import type { Store } from '../store/db.js';
import { providerName } from './connections.js';
import { accountRoom } from './account-room.js';

/** Managed compute: tasks of an organization without its own provider account
 * run on the installation's (src/world/connections.ts MANAGED_COMPUTE), and
 * what they use is charged to the organization's monthly compute credit at
 * tavya's prices (COMPUTE_PRICE_MULTIPLIER × the provider's own). Wiki
 * features/managed-compute. */

/** This month's compute is spent (or the plan has none). Like a provider limit
 * that is full, only time or a person frees it (a pack, a plan, the next
 * month), so the task waits for it as for a machine ('world-capacity'),
 * parking its world, and carries on by itself once there is credit again. */
export class ComputeCreditExhausted extends ProviderCapacityFull {
  constructor(message: string) {
    super(message);
    this.name = 'ComputeCreditExhausted';
  }
}

/** The installation's account runs as many machines as it may at once. */
export class ManagedComputeBusy extends ProviderCapacityFull {
  constructor(message: string) {
    super(message);
    this.name = 'ManagedComputeBusy';
  }
}

export interface ComputeCredit {
  /** The calendar month (UTC) the credit is for: [from, to). */
  from: number;
  to: number;
  /** Monthly credit in USD micros at tavya's prices; null when unmetered
   * (a private installation). */
  creditMicros: number | null;
  /** Top-up credit left from earlier months and bought this month: it lasts
   * until used, and is used after the month's own credit. */
  topUpMicros: number;
  /** Charged so far this month, at tavya's prices. */
  usedMicros: number;
  /** Held for work running now and not yet booked (compute holds). */
  heldMicros: number;
  /** What new work may still use: credit + top-ups − used − held. */
  availableMicros: number | null;
  /** What the provider charged for it (the operator's cost). */
  costMicros: number;
  /** Machine time this month, in seconds. */
  seconds: number;
  byProvider: Array<{ provider: string; usedMicros: number; seconds: number }>;
}

export function computeMonth(now: number): { from: number; to: number } {
  const date = new Date(now);
  return { from: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1), to: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) };
}

const monthKey = (at: number) => new Date(at).toISOString().slice(0, 7);
const monthStart = (key: string) => Date.parse(`${key}-01T00:00:00Z`);

/** An organization's managed compute this month against its credit. Usage
 * arrives as providers report it (E2B when a sandbox pauses, at most an hour
 * on Hobby; VMs each sweep); until then the holds of the work that ran
 * stand in for it. */
export async function computeCredit(store: Store, organizationId: string, now = Date.now()): Promise<ComputeCredit> {
  const month = computeMonth(now);
  const costs = await store.managedComputeCosts(month.from, month.to, organizationId);
  const entitlements = await store.organizationEntitlements(organizationId);
  const costMicros = costs.reduce((total, row) => total + row.costMicros, 0);
  const creditMicros = entitlements.computeCreditMicros;
  const topUpMicros = creditMicros == null ? 0 : (await topUpBalance(store, organizationId, creditMicros, now));
  const heldMicros = creditMicros == null ? 0 : computeChargeMicros(await store.computeHeldCostMicros(organizationId, now));
  const usedMicros = computeChargeMicros(costMicros);
  return { ...month, creditMicros, topUpMicros, usedMicros, heldMicros,
    availableMicros: creditMicros == null ? null : creditMicros + topUpMicros - usedMicros - heldMicros, costMicros,
    seconds: costs.reduce((total, row) => total + row.seconds, 0),
    byProvider: costs.map((row) => ({ provider: row.provider, usedMicros: computeChargeMicros(row.costMicros), seconds: row.seconds }))
      .sort((a, b) => b.usedMicros - a.usedMicros) };
}

/** How long after a month ends its usage is taken as complete, so what it
 * drew from the top-up balance is written down for good. */
const MONTH_SETTLE_MS = 6 * 60 * 60_000;

/** Top-up credit left at `now`. A month uses its own credit first; what it
 * used beyond that it drew from the top-ups paid before it ended. A closed
 * month's draw is recorded (closeComputeMonths); an open one's is worked out
 * the same way, from the credit recorded for it while it ran. */
export async function topUpBalance(store: Store, organizationId: string, allowanceMicros: number, now = Date.now(),
  close = false): Promise<number> {
  const paid = (await store.computeTopUps(organizationId)).filter((topUp) => topUp.state === 'paid' && topUp.settledAt! <= now);
  if (!paid.length) return 0;
  const months = new Map((await store.computeCreditMonths(organizationId)).map((row) => [row.month, row]));
  const current = monthKey(now);
  let drawn = 0;
  for (let key = monthKey(Math.min(...paid.map((topUp) => topUp.settledAt!))); key < current;) {
    const next = computeMonth(monthStart(key)).to;
    const row = months.get(key);
    let draw = row?.drawnMicros;
    if (draw === undefined) {
      const balance = paid.filter((topUp) => topUp.settledAt! < next).reduce((total, topUp) => total + topUp.creditMicros, 0) - drawn;
      const used = computeChargeMicros((await store.managedComputeCosts(monthStart(key), next, organizationId))
        .reduce((total, cost) => total + cost.costMicros, 0));
      draw = Math.max(0, Math.min(balance, used - (row?.allowanceMicros ?? allowanceMicros)));
      if (close && now >= next + MONTH_SETTLE_MS)
        (await store.setComputeCreditMonth(organizationId, key, { allowanceMicros: row?.allowanceMicros ?? allowanceMicros, drawnMicros: draw }));
    }
    drawn += draw;
    key = monthKey(next);
  }
  return paid.reduce((total, topUp) => total + topUp.creditMicros, 0) - drawn;
}

/** Hourly, for organizations with top-ups: record the running month's credit
 * and close the months that have settled. */
export async function closeComputeMonths(store: Store, now = Date.now()): Promise<void> {
  for (const organizationId of await store.organizationsWithComputeTopUps()) {
    const allowance = (await store.organizationEntitlements(organizationId)).computeCreditMicros;
    if (allowance == null) continue;
    (await store.setComputeCreditMonth(organizationId, monthKey(now), { allowanceMicros: allowance }));
    (await topUpBalance(store, organizationId, allowance, now, true));
  }
}

const dollars = (micros: number) => `$${(micros / 1e6).toFixed(2)}`;

function exhausted(credit: ComputeCredit, provider: string): ComputeCreditExhausted {
  const own = `connect your own ${providerName(provider)} account in Settings → Computers`;
  if (!credit.creditMicros && !credit.topUpMicros) return new ComputeCreditExhausted(
    `Out of compute: ${BRAND}'s computers come with a paid plan. Choose one in Plan & billing, or ${own}.`);
  const renews = new Date(credit.to).toISOString().slice(0, 10);
  const spent = credit.heldMicros > 0 && credit.usedMicros < credit.creditMicros! + credit.topUpMicros
    ? `this month's ${dollars(credit.creditMicros! + credit.topUpMicros)} of compute is used up or held by work running now`
    : `this month's ${dollars(credit.creditMicros! + credit.topUpMicros)} of compute is used up`;
  return new ComputeCreditExhausted(`Out of compute: ${spent}. `
    + `Add a compute pack or turn on auto top-up in Plan & billing, or ${own}. It renews on ${renews}.`);
}

/** Why managed work on `provider` cannot go on: the credit as it stands. */
export async function outOfCompute(store: Store, organizationId: string, provider: string, now = Date.now()): Promise<ComputeCreditExhausted> {
  return exhausted(await computeCredit(store, organizationId, now), provider);
}

/** Refuse new managed-compute work once this month's credit is spent; with
 * a `machine`, unless the first minutes a hold would need fit
 * (`COMPUTE_HOLD.minStartMs` of it). */
export async function assertComputeCredit(store: Store, organizationId: string, provider: string, now = Date.now(),
  machine?: { shape?: { cpu?: number; memoryMb?: number; diskGb?: number }; taskId?: string }): Promise<void> {
  if (!store.hosted) return;
  const credit = await computeCredit(store, organizationId, now);
  if (credit.availableMicros == null) return;
  let needed = 1;
  if (machine) {
    const rate = await machineRate(store, { organizationId, provider, ...machine }, now);
    needed = Math.max(1, computeChargeMicros((rate.activeMicrosPerHour + rate.diskMicrosPerHour) * COMPUTE_HOLD.minStartMs / 3_600_000));
  }
  if (credit.availableMicros >= needed) return;
  (await store.kvSet(`compute-short:${organizationId}`, JSON.stringify({ at: now, neededMicros: needed })));
  throw exhausted(credit, provider);
}

/** Compute holds (wiki features/managed-compute § Holds): work on a managed
 * computer reserves the cost of its next `windowMs` before it runs and
 * renews it `renewBeforeMs` before the hold ends; it starts only if
 * `minStartMs` of it fits. A hold that cannot be renewed ends the work there:
 * a turn is stopped and its computer parked, a wait on jobs returns. */
export const COMPUTE_HOLD = { windowMs: COMPUTE_TERMS.holdMinutes * 60_000, renewBeforeMs: 5 * 60_000,
  minStartMs: COMPUTE_TERMS.minStartMinutes * 60_000 };

/** Below this much credit left, auto top-up buys more. */
export const COMPUTE_LOW_MICROS = 2_000_000;

export interface MachineRate { activeMicrosPerHour: number; diskMicrosPerHour: number }

/** Providers' list prices (USD an hour), used until a machine's own usage is
 * booked: rounded up from the drivers' fallback prices, so a first hold is
 * never smaller than what the machine costs. */
export function listRate(provider: string, shape: { cpu: number; memoryMb: number; diskGb: number }): MachineRate {
  const memoryGb = shape.memoryMb / 1024;
  const perGbMonth = (price: number) => shape.diskGb * price / 730;
  let active = 0, disk = 0;
  switch (provider) {
    case 'aws': {
      const perCpu = memoryGb / shape.cpu > 8 ? 0.06615 : memoryGb / shape.cpu > 4 ? 0.0504 : 0.044625;
      active = shape.cpu * perCpu + 0.005; disk = perGbMonth(0.0952); break;
    }
    case 'gcp': active = shape.cpu * 0.025 + memoryGb * 0.0034 + 0.005; disk = perGbMonth(0.12); break;
    case 'hetzner': active = shape.cpu * 0.02 + 0.001; disk = perGbMonth(0.05); break;
    case 'fly': active = flyComputeDollarsPerSecond(flyGuest(shape)) * 3600; disk = flyVolumeDollarsPerSecond(shape.diskGb) * 3600; break;
    default: active = costMicrosPerSecond(provider, shape.cpu, shape.memoryMb, 0) * 3600 / 1e6;
  }
  return { activeMicrosPerHour: Math.ceil(active * 1e6), diskMicrosPerHour: Math.ceil(disk * 1e6) };
}

/** What a task's machine costs an hour: what the provider last booked for
 * it, when that was this size, else the list price. */
export async function machineRate(store: Store, input: { organizationId: string; taskId?: string; provider: string;
  shape?: { cpu?: number; memoryMb?: number; diskGb?: number } }, now = Date.now()): Promise<MachineRate> {
  const defaults = providerDefaults(input.provider) ?? { cpu: 2, memoryMb: 2048, diskGb: 20 };
  const shape = { cpu: input.shape?.cpu ?? defaults.cpu, memoryMb: input.shape?.memoryMb ?? defaults.memoryMb, diskGb: input.shape?.diskGb ?? defaults.diskGb };
  const rate = listRate(input.provider, shape);
  if (!input.taskId) return rate;
  const latest = await store.latestManagedUsage(input.organizationId, input.taskId, input.provider, now - 7 * 24 * 60 * 60_000);
  const same = (metadata: Record<string, unknown>, keys: Array<'cpu' | 'memoryMb' | 'diskGb'>) =>
    keys.every((key) => metadata[key] === undefined || Number(metadata[key]) === shape[key]);
  if (latest.active && same(latest.active.metadata, ['cpu', 'memoryMb']))
    rate.activeMicrosPerHour = Math.ceil(latest.active.costMicros / latest.active.seconds * 3600);
  if (latest.disk && same(latest.disk.metadata, ['diskGb']))
    rate.diskMicrosPerHour = Math.ceil(latest.disk.costMicros / latest.disk.seconds * 3600);
  return rate;
}

export interface ComputeHoldRequest {
  id: string; organizationId: string; taskId?: string; worldId?: string; provider: string;
  purpose: 'turn' | 'jobs' | 'machine';
  shape?: { cpu?: number; memoryMb?: number; diskGb?: number };
}

/** Reserve (or renew) a hold for work on a managed computer. Returns when it
 * ends (Infinity when unmetered). A new hold is refused with
 * ComputeCreditExhausted unless `COMPUTE_HOLD.minStartMs` fits; a renewal
 * takes whatever fits, and returns the end it already had when nothing does.
 * Either way a short hold asks auto top-up for more (kv compute-short). */
export async function holdManagedCompute(store: Store, request: ComputeHoldRequest, now = Date.now()): Promise<number> {
  if (!store.hosted) return Infinity;
  const entitlements = await store.organizationEntitlements(request.organizationId);
  if (entitlements.computeCreditMicros == null) return Infinity;
  const existing = await store.computeHold(request.id);
  const rate = await machineRate(store, request, now);
  const creditMicros = entitlements.computeCreditMicros + (await topUpBalance(store, request.organizationId, entitlements.computeCreditMicros, now));
  const held = await store.holdCompute({ ...request, ...rate, until: now + COMPUTE_HOLD.windowMs,
    minUntil: existing && !existing.closedAt ? 0 : now + COMPUTE_HOLD.minStartMs }, creditMicros, now);
  const endsAt = held?.endsAt ?? (existing && !existing.closedAt ? existing.endsAt : undefined);
  if (endsAt === undefined || endsAt < now + COMPUTE_HOLD.windowMs)
    (await store.kvSet(`compute-short:${request.organizationId}`, JSON.stringify({ at: now,
      neededMicros: computeChargeMicros((rate.activeMicrosPerHour + rate.diskMicrosPerHour) * COMPUTE_HOLD.windowMs / 3_600_000) })));
  if (endsAt !== undefined) return endsAt;
  throw exhausted(await computeCredit(store, request.organizationId, now), request.provider);
}

/** A managed account's budget and fair share, as its connection states them. */
export interface ManagedBudget { pool?: AccountPool; share?: number }

/** Why the installation's `provider` account has no room now (account-room.ts). */
export interface ManagedNoRoom { reason: string; message: string }

/** Whether the installation's `provider` account has room for one more
 * machine for `organizationId`: its budget, its queue and the fair share
 * (account-room.ts). A refused task with a `taskId` joins the queue. */
export async function managedRoom(store: Store, provider: string, budget: ManagedBudget, organizationId: string,
  request: { cpu?: number; diskGb?: number; taskId?: string; worldId?: string; peek?: boolean } = {}, now = Date.now()): Promise<ManagedNoRoom | undefined> {
  return accountRoom(store, { provider, managed: true, pool: budget.pool, share: budget.share }, { organizationId, ...request }, now);
}

/** Refuse a new machine on the installation's account without room for it:
 * the task waits for one instead of the provider refusing it. */
export async function assertManagedRoom(store: Store, provider: string, budget: ManagedBudget, organizationId: string,
  request: { cpu?: number; diskGb?: number; taskId?: string; worldId?: string } = {}, now = Date.now()): Promise<void> {
  const refusal = await managedRoom(store, provider, budget, organizationId, request, now);
  if (refusal) throw new ManagedComputeBusy(refusal.message);
}
