import { ProviderCapacityFull } from '../agent/limits.js';
import { BRAND } from '../domain/brand.js';
import { computeChargeMicros } from '../domain/entitlements.js';
import type { Store } from '../store/db.js';
import { providerName } from './connections.js';

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
  /** Charged so far this month, at tavya's prices. */
  usedMicros: number;
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

/** An organization's managed compute this month against its credit. Usage
 * arrives as providers report it (E2B when a sandbox pauses, at most an hour
 * on Hobby; Fly and Hetzner each sweep), so a running machine's last stretch
 * shows a little late. */
export async function computeCredit(store: Store, organizationId: string, now = Date.now()): Promise<ComputeCredit> {
  const month = computeMonth(now);
  const costs = await store.managedComputeCosts(month.from, month.to, organizationId);
  const entitlements = await store.organizationEntitlements(organizationId);
  const costMicros = costs.reduce((total, row) => total + row.costMicros, 0);
  return { ...month, creditMicros: entitlements.computeCreditMicros, usedMicros: computeChargeMicros(costMicros), costMicros,
    seconds: costs.reduce((total, row) => total + row.seconds, 0),
    byProvider: costs.map((row) => ({ provider: row.provider, usedMicros: computeChargeMicros(row.costMicros), seconds: row.seconds }))
      .sort((a, b) => b.usedMicros - a.usedMicros) };
}

const dollars = (micros: number) => `$${(micros / 1e6).toFixed(2)}`;

/** Refuse new managed-compute work once this month's credit is spent. */
export async function assertComputeCredit(store: Store, organizationId: string, provider: string, now = Date.now()): Promise<void> {
  if (!store.hosted) return;
  const credit = await computeCredit(store, organizationId, now);
  if (credit.creditMicros == null || credit.usedMicros < credit.creditMicros) return;
  const own = `connect your own ${providerName(provider)} account in Settings → Computers`;
  if (!credit.creditMicros) throw new ComputeCreditExhausted(
    `Out of compute: ${BRAND}'s computers come with a paid plan. Choose one in Plan & billing, or ${own}.`);
  const renews = new Date(credit.to).toISOString().slice(0, 10);
  throw new ComputeCreditExhausted(`Out of compute: this month's ${dollars(credit.creditMicros)} of compute is used up. `
    + `Add a compute pack in Plan & billing, or ${own}. It renews on ${renews}.`);
}

/** Refuse a new machine on the installation's account while it runs as many
 * as it may (its concurrency limit): the task waits for one instead of the
 * provider refusing it. Not a queue: whichever waiting task tries first after
 * one stops gets it. */
export async function assertManagedRoom(store: Store, provider: string, maxRunning: number | undefined): Promise<void> {
  if (!maxRunning) return;
  const running = await store.runningManagedWorlds(provider);
  if (running >= maxRunning) throw new ManagedComputeBusy(
    `All ${maxRunning} of ${BRAND}'s ${providerName(provider)} computers are in use; waiting for one to free up.`);
}
