// A new organization's free trial (wiki features/managed-compute § Trial): $5
// of credit for tavya's computers, usable for its first 14 days, drawn before
// any other credit, once per person.
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { COMPUTE_TRIAL } from '../src/domain/entitlements.js';
import { ComputeCreditExhausted, assertComputeCredit, computeCredit, holdManagedCompute, startComputeTrial,
  topUpBalance } from '../src/world/managed-compute.js';
import { computeNoticeEmail } from '../src/world/compute-notices.js';
import { publicLaunchInfo } from '../src/launch/legal.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const DAY = 24 * 60 * 60_000;
/** Mid-month, so the 14 days stay in October. */
const T = Date.UTC(2026, 9, 10, 12);

async function fixture(options: { hosted?: boolean } = {}) {
  const store = await Store.create(':memory:', { hosted: options.hosted ?? true });
  cleanups.push(() => store.close());
  const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
  /** Managed machine time as the provider feed books it, in provider cost (tavya charges 2×). */
  let n = 0;
  const book = (costMicros: number, endedAt: number, minutes = 10) => store.recordUsage({ id: `usage:e2b:${n++}`,
    organizationId: organization.id, provider: 'e2b', kind: 'world.active', quantity: minutes * 60, unit: 'second', costMicros,
    startedAt: endedAt - minutes * 60_000, endedAt, fundingSource: 'managed' });
  return { store, organization, book };
}

describe('free trial', () => {
  it('gives a new organization $5 for 14 days, once per person', async () => {
    const f = await fixture();
    expect(COMPUTE_TRIAL).toEqual({ creditMicros: 5_000_000, days: 14 });
    expect(await startComputeTrial(f.store, f.organization.id, 'owner', T)).toBe(true);
    expect(await f.store.computeTrial(f.organization.id)).toEqual({ userId: 'owner', creditMicros: 5_000_000, startsAt: T, endsAt: T + 14 * DAY });
    const credit = await computeCredit(f.store, f.organization.id, T + DAY);
    expect(credit).toMatchObject({ creditMicros: 0, availableMicros: 5_000_000,
      trial: { creditMicros: 5_000_000, usedMicros: 0, leftMicros: 5_000_000, monthMicros: 5_000_000, endsAt: T + 14 * DAY } });

    // The same person's next organization has none, even once the first is deleted.
    const second = await f.store.createOrganization({ name: 'Second', ownerUserId: 'owner' });
    expect(await startComputeTrial(f.store, second.id, 'owner', T)).toBe(false);
    await f.store.deleteOrganization(f.organization.id);
    const third = await f.store.createOrganization({ name: 'Third', ownerUserId: 'owner' });
    expect(await startComputeTrial(f.store, third.id, 'owner', T)).toBe(false);
    expect(await f.store.computeTrial(second.id)).toBeUndefined();
    expect((await computeCredit(f.store, second.id, T + DAY)).availableMicros).toBe(0);
    // Someone else's is their own.
    expect(await startComputeTrial(f.store, second.id, 'someone-else', T)).toBe(true);
  });

  it('is only for hosted installations', async () => {
    const f = await fixture({ hosted: false });
    expect(await startComputeTrial(f.store, f.organization.id, 'owner', T)).toBe(false);
    expect((await computeCredit(f.store, f.organization.id, T)).availableMicros).toBeNull();
  });

  it('is drawn by managed work until it is used up, then work waits for a plan', async () => {
    const f = await fixture();
    await startComputeTrial(f.store, f.organization.id, 'owner', T);
    await f.book(1_000_000, T + DAY); // $2 at tavya's prices
    expect((await computeCredit(f.store, f.organization.id, T + DAY + 60_000))).toMatchObject({ usedMicros: 2_000_000, availableMicros: 3_000_000,
      trial: { usedMicros: 2_000_000, leftMicros: 3_000_000 } });
    await assertComputeCredit(f.store, f.organization.id, 'e2b', T + DAY + 60_000);
    await f.book(1_600_000, T + 2 * DAY); // $3.20 more: past the trial
    const spent = await computeCredit(f.store, f.organization.id, T + 2 * DAY + 60_000);
    expect(spent).toMatchObject({ trial: { usedMicros: 5_000_000, leftMicros: 0 } });
    expect(spent.availableMicros).toBeLessThanOrEqual(0);
    const refused = await assertComputeCredit(f.store, f.organization.id, 'e2b', T + 2 * DAY + 60_000).catch((error) => error);
    expect(refused).toBeInstanceOf(ComputeCreditExhausted);
    expect(refused.message).toBe('Out of compute: your $5.00 free trial is used up. Choose a plan in Plan & billing, '
      + 'or connect your own E2B account in Settings → Computers.');
  });

  it('ends after 14 days whatever is left, and says so', async () => {
    const f = await fixture();
    await startComputeTrial(f.store, f.organization.id, 'owner', T);
    await f.book(500_000, T + DAY); // $1
    const after = T + 14 * DAY + 60_000;
    const credit = await computeCredit(f.store, f.organization.id, after);
    // What it drew still counts against its use; what was left is gone.
    expect(credit).toMatchObject({ usedMicros: 1_000_000, availableMicros: 0, trial: { usedMicros: 1_000_000, leftMicros: 0, monthMicros: 1_000_000 } });
    const refused = await assertComputeCredit(f.store, f.organization.id, 'e2b', after).catch((error) => error);
    expect(refused.message).toMatch(/^Out of compute: your \$5\.00 free trial ended on 2026-10-24\. Choose a plan in Plan & billing/);
  });

  it('is drawn before a paid plan\'s own credit', async () => {
    const f = await fixture();
    await startComputeTrial(f.store, f.organization.id, 'owner', T);
    await f.store.setOrganizationPlan(f.organization.id, 'individual'); // $5 a month
    await f.book(1_500_000, T + DAY); // $3, all from the trial
    expect((await computeCredit(f.store, f.organization.id, T + DAY + 60_000)).availableMicros).toBe(7_000_000);
    // Once it ends, the month's $5 is still whole.
    expect((await computeCredit(f.store, f.organization.id, T + 15 * DAY)).availableMicros).toBe(5_000_000);
  });

  it('spans a month\'s end: each month counts only what it drew', async () => {
    const f = await fixture();
    const start = Date.UTC(2026, 9, 25, 12);
    await startComputeTrial(f.store, f.organization.id, 'owner', start);
    await f.book(1_000_000, Date.UTC(2026, 9, 27)); // October: $2
    const november = Date.UTC(2026, 10, 2);
    expect(await computeCredit(f.store, f.organization.id, november)).toMatchObject({ usedMicros: 0, availableMicros: 3_000_000,
      trial: { usedMicros: 2_000_000, leftMicros: 3_000_000, monthMicros: 3_000_000 } });
    await f.book(1_000_000, Date.UTC(2026, 10, 3)); // November: $2
    expect(await computeCredit(f.store, f.organization.id, Date.UTC(2026, 10, 3, 1))).toMatchObject({ usedMicros: 2_000_000,
      availableMicros: 1_000_000, trial: { usedMicros: 4_000_000, leftMicros: 1_000_000, monthMicros: 3_000_000 } });
  });

  it('leaves top-ups to what the trial did not cover', async () => {
    const f = await fixture();
    await startComputeTrial(f.store, f.organization.id, 'owner', Date.UTC(2026, 9, 25));
    await f.store.createComputeTopUp({ id: 'topup_1', organizationId: f.organization.id, creditMicros: 10_000_000, amountCents: 1_000,
      subscriptionId: 'sub_1', requestedAt: Date.UTC(2026, 9, 20) });
    await f.store.updateComputeTopUp('topup_1', { state: 'paid', settledAt: Date.UTC(2026, 9, 20) });
    await f.book(3_000_000, Date.UTC(2026, 9, 28)); // October: $6, $5 from the trial, $1 from the top-up
    expect(await topUpBalance(f.store, f.organization.id, 0, Date.UTC(2026, 10, 2))).toBe(9_000_000);
  });

  it('holds managed work against it like any credit', async () => {
    const f = await fixture();
    await startComputeTrial(f.store, f.organization.id, 'owner', T);
    const project = await f.store.createProject('Cloud', { worldProvider: 'e2b' }, f.organization.id);
    const task = await f.store.createTask({ projectId: project.id, title: 'Run', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'Run' } as any });
    const endsAt = await holdManagedCompute(f.store, { id: 'turn:1', organizationId: f.organization.id, taskId: task.id, provider: 'e2b',
      purpose: 'turn', shape: { cpu: 2, memoryMb: 2048, diskGb: 20 } }, T + DAY);
    expect(endsAt).toBe(T + DAY + 15 * 60_000);
    expect((await computeCredit(f.store, f.organization.id, T + DAY)).heldMicros).toBeGreaterThan(0);
  });

  it('is named on the pricing page and in notices that do not promise a renewal', () => {
    expect(publicLaunchInfo({}).trial).toEqual({ creditMicros: 5_000_000, days: 14 });
    const message = computeNoticeEmail('Acme', 'tavya', { stage: 'spent', usedMicros: 5_000_000, creditMicros: 5_000_000,
      renewsAt: Date.UTC(2026, 10, 1), trial: true });
    expect(message.subject).toBe('Acme\'s free tavya trial is over');
    expect(message.text).toContain('choose a plan in Plan & billing');
    expect(message.text).not.toMatch(/renews/);
  });
});
