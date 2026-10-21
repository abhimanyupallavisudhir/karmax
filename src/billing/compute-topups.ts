import crypto from 'node:crypto';
import type { ComputeTopUp, Store } from '../store/db.js';
import { ABSENT_WRITE_SETTLE_MS, type SubscriptionBillingService } from './subscriptions.js';
import { BillingRequestRejected } from './paddle.js';
import { COMPUTE_TERMS } from '../domain/entitlements.js';
import { COMPUTE_LOW_MICROS, computeCredit, computeMonth } from '../world/managed-compute.js';

/** Auto top-up (wiki features/managed-compute § Auto top-up): an organization
 * that opts in buys more compute credit by itself when it runs low, one
 * `amountCents` top-up at a time, charged at once to its subscription's saved
 * payment method, up to the monthly cap its owner set. Top-up credit lasts
 * until used. Off by default; offered only once the billing terms that
 * describe it are approved (`offered`). */
export const COMPUTE_TOP_UP = {
  amountCents: COMPUTE_TERMS.topUpCents,
  /** A dollar paid buys a dollar of compute at tavya's prices, as packs do. */
  creditMicros: COMPUTE_TERMS.topUpCents * 10_000,
  defaultCapCents: 5_000,
  /** A declined card stops top-ups this long, and the owners are told. */
  declinedPauseMs: 24 * 60 * 60_000,
  /** A short hold (compute-short) this recent counts as work needing more. */
  shortWithinMs: 15 * 60_000,
};

export interface AutoTopUpSettings {
  enabled: boolean;
  /** Most a calendar month's top-ups may come to, in cents. */
  capCents: number;
  /** No top-ups until then: the last one was declined. */
  pausedUntil?: number;
  lastError?: string;
  updatedBy?: string;
  updatedAt?: number;
}

export interface AutoTopUpStatus extends AutoTopUpSettings {
  /** Whether this installation offers auto top-up to this organization now. */
  offered: boolean;
  /** Why not, when it is not. */
  reason?: string;
  amountCents: number;
  /** This month's top-ups that count toward the cap (paid or under way). */
  spentCents: number;
}

const key = (organizationId: string) => `compute-auto-topup:${organizationId}`;
const SETTLING: Array<ComputeTopUp['state']> = ['charging', 'uncertain', 'pending'];

export class ComputeTopUps {
  constructor(private store: Store, private billing: SubscriptionBillingService, private options: {
    /** Whether the approved billing terms include auto top-up. */
    offered: () => Promise<boolean>;
    /** Tell the organization's owners (an email) that a top-up was declined. */
    tell?: (organizationId: string, message: { subject: string; text: string }) => Promise<void>;
  }) {}

  async settings(organizationId: string): Promise<AutoTopUpSettings> {
    try {
      const value = JSON.parse((await this.store.kvGet(key(organizationId))) ?? 'null');
      if (value) return { enabled: value.enabled === true, capCents: Number(value.capCents) || COMPUTE_TOP_UP.defaultCapCents,
        ...(value.pausedUntil ? { pausedUntil: Number(value.pausedUntil) } : {}), ...(value.lastError ? { lastError: String(value.lastError) } : {}),
        ...(value.updatedBy ? { updatedBy: String(value.updatedBy) } : {}), ...(value.updatedAt ? { updatedAt: Number(value.updatedAt) } : {}) };
    } catch { /* unreadable: off */ }
    return { enabled: false, capCents: COMPUTE_TOP_UP.defaultCapCents };
  }

  async status(organizationId: string, now = Date.now()): Promise<AutoTopUpStatus> {
    const settings = await this.settings(organizationId);
    const target = await this.billing.computeTopUpTarget(organizationId);
    const offered = await this.options.offered();
    const reason = !offered ? 'auto top-up is not offered yet' : 'reason' in target ? target.reason : undefined;
    return { ...settings, offered: !reason, ...(reason ? { reason } : {}), amountCents: COMPUTE_TOP_UP.amountCents,
      spentCents: await this.spentCents(organizationId, now) };
  }

  /** An owner turns auto top-up on or off and sets its monthly cap. Turning it
   * on again lifts a pause after a declined card. */
  async configure(organizationId: string, input: { enabled?: unknown; capCents?: unknown }, by: string, now = Date.now()): Promise<AutoTopUpStatus> {
    const current = await this.settings(organizationId);
    const enabled = input.enabled === undefined ? current.enabled : input.enabled;
    if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false');
    const capCents = input.capCents === undefined ? current.capCents : input.capCents;
    if (typeof capCents !== 'number' || !Number.isSafeInteger(capCents) || capCents < COMPUTE_TOP_UP.amountCents || capCents > 1_000_000)
      throw new Error(`the monthly cap must be whole cents from ${COMPUTE_TOP_UP.amountCents} to 1000000`);
    if (enabled) {
      const status = await this.status(organizationId, now);
      if (!status.offered) throw new Error(status.reason ?? 'auto top-up is not available');
    }
    const keepPause = enabled && current.enabled;
    const next: AutoTopUpSettings = { enabled, capCents, updatedBy: by, updatedAt: now,
      ...(keepPause && current.pausedUntil ? { pausedUntil: current.pausedUntil } : {}),
      ...(keepPause && current.lastError ? { lastError: current.lastError } : {}) };
    (await this.store.kvSet(key(organizationId), JSON.stringify(next)));
    return this.status(organizationId, now);
  }

  /** Top-ups of this calendar month that count toward the cap. */
  private async spentCents(organizationId: string, now: number): Promise<number> {
    return (await this.store.computeTopUps(organizationId, computeMonth(now).from))
      .filter((topUp) => topUp.state !== 'failed').reduce((total, topUp) => total + topUp.amountCents, 0);
  }

  /** Every minute (src/main.ts): settle top-ups under way, then buy one for
   * each organization that opted in and is running low. */
  async run(now = Date.now()): Promise<number> {
    if (!this.store.hosted) return 0;
    for (const topUp of await this.store.computeTopUps()) await this.settle(topUp, now).catch((error) =>
      console.warn(`compute top-up ${topUp.id}: ${error instanceof Error ? error.message : String(error)}`));
    let bought = 0;
    for (const { key: entry } of await this.store.kvEntries('compute-auto-topup:')) {
      const organizationId = entry.slice('compute-auto-topup:'.length);
      if (await this.maybeTopUp(organizationId, now).catch((error) => {
        console.warn(`compute auto top-up for ${organizationId}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      })) bought++;
    }
    return bought;
  }

  /** Buy one top-up if the organization opted in, may be charged, needs the
   * credit (work running or waiting for it, and less than COMPUTE_LOW_MICROS
   * or what that work needs left) and has room under its cap. */
  async maybeTopUp(organizationId: string, now = Date.now()): Promise<boolean> {
    const settings = await this.settings(organizationId);
    if (!settings.enabled || (settings.pausedUntil ?? 0) > now || !(await this.options.offered())) return false;
    const credit = await computeCredit(this.store, organizationId, now);
    if (credit.availableMicros == null) return false;
    let short: { at?: number; neededMicros?: number } | undefined;
    try { short = JSON.parse((await this.store.kvGet(`compute-short:${organizationId}`)) ?? 'null') ?? undefined; } catch { short = undefined; }
    const recentShort = short && now - Number(short.at) < COMPUTE_TOP_UP.shortWithinMs ? short : undefined;
    if (!recentShort && credit.heldMicros <= 0) return false;
    if (credit.availableMicros >= Math.max(COMPUTE_LOW_MICROS, Number(recentShort?.neededMicros) || 0)) return false;
    const target = await this.billing.computeTopUpTarget(organizationId);
    if ('reason' in target) return false;
    const topUp = await this.store.transaction(async () => {
      (await this.store.lock(`usage:${organizationId}`));
      const recent = await this.store.computeTopUps(organizationId, computeMonth(now).from - 31 * 24 * 60 * 60_000);
      if (recent.some((row) => SETTLING.includes(row.state))) return undefined;
      const spent = recent.filter((row) => row.requestedAt >= computeMonth(now).from && row.state !== 'failed')
        .reduce((total, row) => total + row.amountCents, 0);
      if (spent + COMPUTE_TOP_UP.amountCents > settings.capCents) return undefined;
      const row = { id: `topup_${crypto.randomUUID()}`, organizationId, creditMicros: COMPUTE_TOP_UP.creditMicros,
        amountCents: COMPUTE_TOP_UP.amountCents, subscriptionId: target.subscriptionId, requestedAt: now };
      (await this.store.createComputeTopUp(row));
      return row;
    });
    if (!topUp) return false;
    try {
      await target.provider.chargeComputeTopUp!({ subscriptionId: target.subscriptionId, topUpId: topUp.id, amountCents: topUp.amountCents });
      (await this.store.updateComputeTopUp(topUp.id, { state: 'pending' }));
    } catch (error) {
      if (error instanceof BillingRequestRejected) {
        (await this.store.updateComputeTopUp(topUp.id, { state: 'failed', error: error.message, settledAt: Date.now() }));
        await this.declined(organizationId, error.message, now);
        return false;
      }
      // The answer was lost: the provider's records settle it, never a second charge.
      (await this.store.updateComputeTopUp(topUp.id, { state: 'uncertain', error: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    await this.settle({ ...topUp, state: 'pending' }, Date.now());
    return true;
  }

  /** Read where a top-up stands from the provider; credit it once paid. */
  private async settle(topUp: ComputeTopUp, now: number): Promise<void> {
    if (!SETTLING.includes(topUp.state) || !topUp.subscriptionId) return;
    // A row left `charging` by a process that died mid-call is uncertain once
    // that call could no longer be running.
    if (topUp.state === 'charging' && now - topUp.requestedAt < 2 * 60_000) return;
    const target = await this.billing.computeTopUpTarget(topUp.organizationId);
    const provider = 'provider' in target ? target.provider : undefined;
    if (!provider?.findComputeTopUp) return;
    const found = await provider.findComputeTopUp({ subscriptionId: topUp.subscriptionId, topUpId: topUp.id, since: topUp.requestedAt });
    if (!found) return;
    if ('absent' in found) {
      // Only a charge that should long have shown up counts as never made.
      if (topUp.state !== 'pending' && now - topUp.requestedAt >= ABSENT_WRITE_SETTLE_MS)
        (await this.store.updateComputeTopUp(topUp.id, { state: 'failed', error: 'no charge was made', settledAt: now }));
      return;
    }
    if (found.state === 'paid') {
      (await this.store.updateComputeTopUp(topUp.id, { state: 'paid', transactionId: found.transactionId, settledAt: now }));
      (await this.store.kvDelete(`compute-short:${topUp.organizationId}`));
      return;
    }
    if (found.state === 'failed') {
      (await this.store.updateComputeTopUp(topUp.id, { state: 'failed', transactionId: found.transactionId, error: 'the charge was canceled', settledAt: now }));
      return;
    }
    if (found.state === 'declined' && topUp.error !== 'declined') {
      (await this.store.updateComputeTopUp(topUp.id, { state: 'pending', transactionId: found.transactionId, error: 'declined' }));
      await this.declined(topUp.organizationId, 'the payment was declined', now);
      return;
    }
    if (topUp.state !== 'pending' || found.transactionId !== topUp.transactionId)
      (await this.store.updateComputeTopUp(topUp.id, { state: 'pending', transactionId: found.transactionId, ...(topUp.error ? { error: topUp.error } : {}) }));
  }

  /** A declined top-up pauses auto top-up for a day and tells the owners. */
  private async declined(organizationId: string, reason: string, now: number): Promise<void> {
    const settings = await this.settings(organizationId);
    (await this.store.kvSet(key(organizationId), JSON.stringify({ ...settings, pausedUntil: now + COMPUTE_TOP_UP.declinedPauseMs, lastError: reason })));
    const organization = await this.store.getOrganization(organizationId);
    await this.options.tell?.(organizationId, {
      subject: `Compute top-up for ${organization?.name ?? organizationId} was declined`,
      text: `Auto top-up tried to add $${(COMPUTE_TOP_UP.amountCents / 100).toFixed(2)} of compute and the payment did not go through (${reason}). `
        + 'It tries again in a day; update the payment method in Plan & billing → Billing, or add a compute pack. '
        + 'Tasks on managed computers wait for compute meanwhile.',
    }).catch(() => undefined);
  }
}
