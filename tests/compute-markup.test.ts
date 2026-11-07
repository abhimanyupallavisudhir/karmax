// An organization's own compute markup (wiki features/managed-compute § Markup):
// the operator sets what tavya charges one organization over the provider's
// price, like a gift. It applies from when it is set: use before then keeps
// the price it ran at, so nothing booked is repriced.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { Store } from '../src/store/db.js';
import { COMPUTE_PRICE_MULTIPLIER, computeMultiplierAt, usageChargeMicros } from '../src/domain/entitlements.js';
import { computeCredit, holdManagedCompute } from '../src/world/managed-compute.js';
import { hibernateAt } from '../src/world/compute-notices.js';
import { organizationInsights } from '../src/platform/insights.js';
import { FakeSubscriptionProvider, SubscriptionBillingService } from '../src/billing/subscriptions.js';
import { routeCapability } from '../src/gateway/server.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

// Production runs PostgreSQL: the store's part runs there too when
// KARMAX_TEST_POSTGRES_URL points at a disposable database.
const postgresUrl = process.env.KARMAX_TEST_POSTGRES_URL;
const admin = postgresUrl ? new Pool({ connectionString: postgresUrl }) : undefined;
const BACKENDS = ['sqlite', ...(postgresUrl ? ['postgres'] : [])];
let backend = 'sqlite';
afterAll(async () => { await admin?.end(); });

const HOUR = 3_600_000;
const T = Date.UTC(2026, 9, 15, 12);

async function fixture(hosted = true) {
  if (backend === 'postgres') await admin!.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const store = await Store.create(backend === 'postgres' ? postgresUrl! : ':memory:', { hosted });
  cleanups.push(() => store.close());
  const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
  await store.setOrganizationPlan(organization.id, 'team');
  const project = await store.createProject('Cloud', { worldProvider: 'aws' }, organization.id);
  const book = (id: string, costMicros: number, startedAt: number, endedAt: number, kind: 'world.active' | 'agent.cost' = 'world.active',
    organizationId = organization.id) =>
    store.recordUsage({ id: `usage:${id}`, organizationId, projectId: project.id, provider: kind === 'agent.cost' ? 'openrouter' : 'aws', kind,
      quantity: (endedAt - startedAt) / 1000, unit: kind === 'agent.cost' ? 'request' : 'second', costMicros, startedAt, endedAt,
      fundingSource: 'managed', metadata: { cpu: 2, memoryMb: 4096 } });
  return { store, organization, project, book };
}

describe('pricing a slice of usage', () => {
  it('charges each part of a row at the price in effect then, and the default before any change', () => {
    const changes = [{ from: 100, markupPercent: 50 }, { from: 200, markupPercent: null }, { from: 300, markupPercent: 0 }];
    expect(computeMultiplierAt([], 0)).toBe(COMPUTE_PRICE_MULTIPLIER);
    expect([99, 100, 199, 200, 300].map((at) => computeMultiplierAt(changes, at))).toEqual([2, 1.5, 1.5, 2, 1]);
    // 0..400 costs 400: 100 at 2×, 100 at 1.5×, 100 at 2×, 100 at 1×.
    expect(usageChargeMicros(changes, { costMicros: 400, startedAt: 0, endedAt: 400 })).toBe(200 + 150 + 200 + 100);
    // Only the part inside [150, 350).
    expect(usageChargeMicros(changes, { costMicros: 400, startedAt: 0, endedAt: 400 }, 150, 350)).toBe(75 + 200 + 50);
    // An instant (a model's spend) at its moment, and only inside the window.
    expect(usageChargeMicros(changes, { costMicros: 10, startedAt: 150, endedAt: 150 })).toBe(15);
    expect(usageChargeMicros(changes, { costMicros: 10, startedAt: 150, endedAt: 150 }, 160)).toBe(0);
  });
});

describe.each(BACKENDS)('an organization\'s compute markup (%s)', (name) => {
  beforeEach(() => { backend = name; });
  it('charges use from when it was set at the new price, and never reprices what ran before', async () => {
    const f = await fixture();
    expect(await f.store.computePrice(f.organization.id, T)).toEqual({ markupPercent: null, multiplier: 2, defaultMarkupPercent: 100 });
    await f.book('before', 1_000_000, T - 2 * HOUR, T - HOUR);
    await f.store.setComputeMarkup(f.organization.id, 50, 'user:operator', T - HOUR / 2);
    // An hour across the change: half at 2×, half at 1.5×.
    await f.book('across', 1_000_000, T - HOUR, T);
    // The included model's spend after it: 1.5×.
    await f.book('model', 100_000, T - HOUR / 4, T - HOUR / 4, 'agent.cost');
    expect(await f.store.computePrice(f.organization.id, T)).toEqual({ markupPercent: 50, multiplier: 1.5, defaultMarkupPercent: 100,
      grantedBy: 'user:operator', grantedAt: T - HOUR / 2 });
    const credit = await computeCredit(f.store, f.organization.id, T);
    expect(credit).toMatchObject({ costMicros: 2_100_000, usedMicros: 2_000_000 + 1_750_000 + 150_000 });
    expect(credit.byProvider).toEqual([{ provider: 'aws', usedMicros: 3_750_000, seconds: 7200 },
      { provider: 'openrouter', usedMicros: 150_000, seconds: 0 }]);

    // Back to the default from now on: what ran at 1.5× stays so.
    await f.store.setComputeMarkup(f.organization.id, null, 'user:operator', T);
    expect((await f.store.computePrice(f.organization.id, T)).multiplier).toBe(2);
    expect((await computeCredit(f.store, f.organization.id, T)).usedMicros).toBe(3_900_000);
    // The same price again changes nothing; nor does it reprice the past.
    await f.store.setComputeMarkup(f.organization.id, null, 'user:operator', T + HOUR);
    expect(await f.store.computePriceChanges(f.organization.id)).toEqual([{ from: T - HOUR / 2, markupPercent: 50 },
      { from: T, markupPercent: null }]);
    // Another organization keeps the default.
    const other = await f.store.createOrganization({ name: 'Other', ownerUserId: 'owner' });
    expect(await f.store.computePriceMultiplier(other.id, T)).toBe(2);
  });

  it('refuses a markup that is not a whole percent from 0 to 1000', async () => {
    const f = await fixture();
    for (const markup of [-1, 1001, 12.5, Number.NaN])
      await expect(f.store.setComputeMarkup(f.organization.id, markup, 'user:operator')).rejects.toThrow(/whole percent from 0 to 1000/);
    await expect(f.store.setComputeMarkup('org_missing', 10, 'user:operator')).rejects.toThrow(/no organization/);
    expect(await f.store.computePriceChanges(f.organization.id)).toEqual([]);
  });

  it('reserves running work at the organization\'s price now', async () => {
    const f = await fixture();
    const task = await f.store.createTask({ projectId: f.project.id, title: 'Run', workflow: 'just-do', workflowVersion: '1.0.0',
      params: { prompt: 'Run' } as any });
    // 64 vCPU / 128 GB on AWS: $2.861 an hour at list, so 15 minutes held is $0.71525 at cost.
    const shape = { cpu: 64, memoryMb: 131_072, diskGb: 0 };
    await f.store.setComputeMarkup(f.organization.id, 0, 'user:operator', T - HOUR);
    await holdManagedCompute(f.store, { id: 'hold', organizationId: f.organization.id, taskId: task.id, provider: 'aws', purpose: 'turn', shape }, T);
    expect((await computeCredit(f.store, f.organization.id, T)).heldMicros).toBe(715_250);
    await f.store.setComputeMarkup(f.organization.id, 300, 'user:operator', T);
    expect((await computeCredit(f.store, f.organization.id, T)).heldMicros).toBe(4 * 715_250);
    // A spent organization's parked disks: the overrun cap is at its price.
    expect(hibernateAt(0, 1_000_000, 1) - hibernateAt(0, 1_000_000, 4)).toBeGreaterThan(0);
  });

  it('shows Insights\' charges and multiplier at the organization\'s price', async () => {
    const f = await fixture();
    const now = Date.UTC(2026, 10, 10, 12);
    await f.book('earlier', 300_000, now - 3 * HOUR, now - 2 * HOUR);
    await f.store.setComputeMarkup(f.organization.id, 20, 'user:operator', now - 2 * HOUR);
    await f.book('later', 300_000, now - 2 * HOUR, now - HOUR);
    const { compute } = await organizationInsights(f.store, f.organization.id, { days: 7, now, includeSpend: true, computeCredit: true });
    expect(compute.multiplier).toBe(1.2);
    expect(compute.totals.managed).toMatchObject({ listMicros: 600_000, chargedMicros: 600_000 + 360_000 });
    expect(compute.daily.at(-1)).toMatchObject({ chargedMicros: 960_000 });
    expect(compute.credit?.cumulative.at(-1)).toBe(960_000);
  });

  it('is set through billing with an idempotency key, on hosted installations only, and shown in its status', async () => {
    const f = await fixture();
    const billing = new SubscriptionBillingService(f.store, new FakeSubscriptionProvider(), true);
    await expect(billing.setComputeMarkup(f.organization.id, 30, 'user:operator', '')).rejects.toThrow(/idempotency/i);
    await expect(billing.setComputeMarkup(f.organization.id, '30', 'user:operator', 'markup-key-0')).rejects.toThrow(/whole percent/);
    const result = await billing.setComputeMarkup(f.organization.id, 30, 'user:operator', 'markup-key-1');
    expect(result.computePrice).toMatchObject({ markupPercent: 30, multiplier: 1.3, defaultMarkupPercent: 100, grantedBy: 'user:operator' });
    // A retry with the same key changes nothing more.
    await billing.setComputeMarkup(f.organization.id, 30, 'user:operator', 'markup-key-1');
    expect(await f.store.computePriceChanges(f.organization.id)).toHaveLength(1);
    expect((await billing.setComputeMarkup(f.organization.id, null, 'user:operator', 'markup-key-2')).computePrice?.markupPercent).toBeNull();
    expect(routeCapability('POST', `/api/organizations/${f.organization.id}/subscription/compute-markup`)).toBe('subscription:gift');

    if (backend === 'postgres') return;
    const self = await fixture(false);
    await expect(new SubscriptionBillingService(self.store, new FakeSubscriptionProvider(), false)
      .setComputeMarkup(self.organization.id, 30, 'user:operator', 'markup-key-3')).rejects.toThrow(/hosted/);
  });

  it('is exported with the organization and deleted with it', async () => {
    const f = await fixture();
    await f.store.setComputeMarkup(f.organization.id, 40, 'user:operator', T);
    expect(await f.store.exportOrganization(f.organization.id)).toMatchObject({ tables: {
      compute_price_changes: [expect.objectContaining({ markupPercent: 40, grantedBy: 'user:operator' })] } });
    await f.store.deleteOrganization(f.organization.id);
    expect(await f.store.computePriceChanges(f.organization.id)).toEqual([]);
  });
});
