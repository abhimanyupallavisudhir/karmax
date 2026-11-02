import crypto from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { Store } from '../src/store/db.js';
import { managedStorageLocationId } from '../src/store/storage-locations.js';
import { organizationInsights } from '../src/platform/insights.js';
import { recordStorageDay, storageDayKey, turnUsd } from '../src/platform/insights-usage.js';
import { capacityKey, observedKey } from '../src/scheduling/state.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
// Noon UTC, 2026-11-10: the month's credit has ten days of use behind it.
const NOW = Date.UTC(2026, 10, 10, 12);
const GIB = 1024 ** 3;

// Production runs PostgreSQL: the same suite runs there when
// KARMAX_TEST_POSTGRES_URL points at a disposable database.
const postgresUrl = process.env.KARMAX_TEST_POSTGRES_URL;
const admin = postgresUrl ? new Pool({ connectionString: postgresUrl }) : undefined;
const BACKENDS = ['sqlite', ...(postgresUrl ? ['postgres'] : [])];
let backend = 'sqlite';
afterAll(async () => { await admin?.end(); });

async function seed(options: { hosted?: boolean } = {}) {
  if (backend === 'postgres') await admin!.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const store = await Store.create(backend === 'postgres' ? postgresUrl! : ':memory:', { hosted: options.hosted ?? true });
  const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'user_1' } as any);
  const other = await store.createOrganization({ name: 'Other', ownerUserId: 'user_1' } as any);
  const web = await store.createProject('Web', {}, organization.id);
  const api = await store.createProject('Backend', {}, organization.id);
  const foreign = await store.createProject('Foreign', {}, other.id);
  const task = async (projectId: string, title: string) => store.createTask({ projectId, title, workflow: 'software-dev',
    workflowVersion: '1.0.0', params: { prompt: title } as any });
  const machine = (input: { organizationId?: string; projectId: string; taskId: string; provider: string; funding: 'managed' | 'byok';
    start: number; end: number; costMicros: number; cpu?: number; memoryMb?: number; disk?: number }) =>
    store.recordUsage({ id: crypto.randomUUID(), organizationId: input.organizationId ?? organization.id, projectId: input.projectId,
      taskId: input.taskId, provider: input.provider, kind: input.disk ? 'world.disk' : 'world.active',
      quantity: (input.end - input.start) / 1000, unit: 'second', costMicros: input.costMicros, fundingSource: input.funding,
      startedAt: input.start, endedAt: input.end,
      metadata: input.disk ? { diskGb: input.disk } : { cpu: input.cpu ?? 2, memoryMb: input.memoryMb ?? 4096 } } as any);
  return { store, organization, other, web, api, foreign, task, machine };
}

describe.each(BACKENDS)('%s', (name) => {
beforeEach(() => { backend = name; });

describe('insights: compute', () => {
  it('breaks machine cost down by provider, funding, project, task and size, at list and as charged', async () => {
    const f = await seed();
    try {
      const login = await f.task(f.web.id, 'Login page');
      const etl = await f.task(f.api.id, 'Nightly ETL');
      // Own Hetzner: an hour across local midnight (UTC) splits half and half.
      const midnight = Date.UTC(2026, 10, 9);
      await f.machine({ projectId: f.web.id, taskId: login.id, provider: 'hetzner', funding: 'byok',
        start: midnight - HOUR / 2, end: midnight + HOUR / 2, costMicros: 40_000 });
      // Its disk: 100 GB for 2 hours.
      await f.machine({ projectId: f.web.id, taskId: login.id, provider: 'hetzner', funding: 'byok',
        start: midnight, end: midnight + 2 * HOUR, costMicros: 10_000, disk: 100 });
      // Managed Google Cloud: charged at twice list.
      await f.machine({ projectId: f.api.id, taskId: etl.id, provider: 'gcp', funding: 'managed',
        start: NOW - 3 * HOUR, end: NOW - HOUR, costMicros: 300_000, cpu: 4, memoryMb: 16_384 });
      // The previous week, and another organization: neither is in this week's totals.
      await f.machine({ projectId: f.api.id, taskId: etl.id, provider: 'gcp', funding: 'managed',
        start: NOW - 10 * DAY, end: NOW - 10 * DAY + HOUR, costMicros: 50_000 });
      await f.machine({ organizationId: f.other.id, projectId: f.foreign.id, taskId: 'elsewhere', provider: 'gcp', funding: 'managed',
        start: NOW - HOUR, end: NOW, costMicros: 999_000 });

      const { compute } = await organizationInsights(f.store, f.organization.id, { days: 7, now: NOW, includeSpend: true });
      expect(compute.money).toBe(true);
      expect(compute.multiplier).toBe(2);
      expect(compute.totals).toMatchObject({ listMicros: 350_000, chargedMicros: 600_000, activeSeconds: 3 * 3600, diskGbHours: 200 });
      expect(compute.totals.managed).toMatchObject({ listMicros: 300_000, chargedMicros: 600_000, activeSeconds: 7200 });
      expect(compute.totals.own).toMatchObject({ listMicros: 50_000, chargedMicros: 0, activeSeconds: 3600 });
      expect(compute.previous).toMatchObject({ listMicros: 50_000, chargedMicros: 100_000 });
      // Days: the 8th, 9th and 10th of November are the last three.
      expect(compute.daily.at(-3)).toMatchObject({ listMicros: 20_000, byProvider: { hetzner: 20_000 } });
      expect(compute.daily.at(-2)).toMatchObject({ listMicros: 30_000, byFunding: { own: 30_000, managed: 0 } });
      expect(compute.daily.at(-1)).toMatchObject({ listMicros: 300_000, chargedMicros: 600_000, bySize: { '4 CPU · 16 GB': 300_000 } });
      expect(compute.providers.map((row) => [row.key, row.funding, row.listMicros, row.chargedMicros]))
        .toEqual([['gcp', 'managed', 300_000, 600_000], ['hetzner', 'own', 50_000, 0]]);
      expect(compute.projects.map((row) => [row.label, row.listMicros])).toEqual([['Backend', 300_000], ['Web', 50_000]]);
      expect(compute.tasks.map((row) => [row.label, row.projectId])).toEqual([['Nightly ETL', f.api.id], ['Login page', f.web.id]]);
      // A disk is billed to the size of the machine it belongs to.
      expect(compute.sizes.map((row) => [row.key, row.listMicros])).toEqual([['4 CPU · 16 GB', 300_000], ['2 CPU · 4 GB', 50_000]]);
    } finally { await f.store.close(); }
  });

  it('shows machine time but no amounts to members who may not see money', async () => {
    const f = await seed();
    try {
      const work = await f.task(f.web.id, 'Work');
      await f.machine({ projectId: f.web.id, taskId: work.id, provider: 'e2b', funding: 'managed', start: NOW - HOUR, end: NOW, costMicros: 120_000 });
      const { compute } = await organizationInsights(f.store, f.organization.id, { days: 7, now: NOW, computeCredit: true });
      expect(compute.money).toBe(false);
      expect(compute.totals).toMatchObject({ listMicros: 0, chargedMicros: 0, activeSeconds: 3600 });
      expect(compute.daily.at(-1)!.byProvider).toEqual({ e2b: 0 });
      expect(compute.credit).toBeUndefined();
    } finally { await f.store.close(); }
  });

  it('plots the month\'s credit (plan, packs, gifts) against cumulative charges', async () => {
    const f = await seed();
    try {
      await f.store.setOrganizationPlan(f.organization.id, 'team');
      await f.store.setOrganizationComputePacks(f.organization.id, 1);
      await f.store.setComputePackGift(f.organization.id, 2, 'user_operator');
      const work = await f.task(f.web.id, 'Work');
      // $1 at list on Nov 2, $0.50 on Nov 10; October's use is another month's credit.
      await f.machine({ projectId: f.web.id, taskId: work.id, provider: 'hetzner', funding: 'managed',
        start: Date.UTC(2026, 10, 2, 10), end: Date.UTC(2026, 10, 2, 11), costMicros: 1_000_000 });
      await f.machine({ projectId: f.web.id, taskId: work.id, provider: 'hetzner', funding: 'managed',
        start: NOW - 2 * HOUR, end: NOW - HOUR, costMicros: 500_000 });
      await f.machine({ projectId: f.web.id, taskId: work.id, provider: 'hetzner', funding: 'managed',
        start: Date.UTC(2026, 9, 30), end: Date.UTC(2026, 9, 30, 1), costMicros: 9_000_000 });
      // Own machines never draw on the credit.
      await f.machine({ projectId: f.web.id, taskId: work.id, provider: 'e2b', funding: 'byok', start: NOW - HOUR, end: NOW, costMicros: 700_000 });

      const { compute } = await organizationInsights(f.store, f.organization.id, { days: 7, now: NOW, includeSpend: true, computeCredit: true });
      const credit = compute.credit!;
      expect(credit).toMatchObject({ month: '2026-11', daysInMonth: 30, includedMicros: 10_000_000, packMicros: 10_000_000,
        giftMicros: 20_000_000, creditMicros: 40_000_000, usedMicros: 3_000_000 });
      expect(credit.cumulative).toHaveLength(10);
      expect(credit.cumulative[0]).toBe(0);
      expect(credit.cumulative[1]).toBe(2_000_000);
      expect(credit.cumulative.at(-1)).toBe(3_000_000);
    } finally { await f.store.close(); }
  });

  it('counts where provider Any routed computers and which accounts were full', async () => {
    const f = await seed();
    try {
      const work = await f.task(f.web.id, 'Work');
      const routed = (ts: number, payload: Record<string, unknown>) => f.store.appendEvent({ taskId: work.id, type: 'world.routed', ts, payload });
      await routed(NOW - HOUR, { provider: 'hetzner', funding: 'managed', reason: 'cheapest that fits',
        candidates: [{ provider: 'hetzner', funding: 'managed', outcome: 'chosen' }, { provider: 'aws', funding: 'managed', outcome: 'untried' }] });
      await routed(NOW - 2 * HOUR, { provider: 'aws', funding: 'managed', reason: 'cheapest that fits; Hetzner was full',
        candidates: [{ provider: 'hetzner', funding: 'managed', outcome: 'full' }, { provider: 'aws', funding: 'managed', outcome: 'chosen' }] });
      await routed(NOW - 3 * HOUR, { provider: 'e2b', funding: 'own', reason: 'your own account', candidates: [] });
      await routed(NOW - 4 * HOUR, { reason: 'every computer is full',
        candidates: [{ provider: 'hetzner', outcome: 'full' }, { provider: 'aws', outcome: 'full' }] });
      await routed(NOW - 30 * DAY, { provider: 'gcp', funding: 'managed', reason: 'old', candidates: [] });

      const { compute } = await organizationInsights(f.store, f.organization.id, { days: 7, now: NOW });
      expect(compute.routing).toEqual({
        total: 3, fellOver: 1, unplaced: 1,
        providers: [
          { provider: 'hetzner', funding: 'managed', count: 1, reasons: [{ reason: 'cheapest that fits', count: 1 }] },
          { provider: 'aws', funding: 'managed', count: 1, reasons: [{ reason: 'cheapest that fits', count: 1 }] },
          { provider: 'e2b', funding: 'own', count: 1, reasons: [{ reason: 'your own account', count: 1 }] },
        ],
        full: [{ provider: 'hetzner', count: 2 }, { provider: 'aws', count: 1 }],
      });
    } finally { await f.store.close(); }
  });

  it('gives operators each managed account\'s peak use per day against its budget', async () => {
    const f = await seed();
    try {
      const ours = await f.task(f.web.id, 'Ours');
      // Two organizations share the account: 4 + 2 CPUs overlap on the 10th.
      await f.machine({ projectId: f.web.id, taskId: ours.id, provider: 'gcp', funding: 'managed', start: NOW - 3 * HOUR, end: NOW - HOUR, costMicros: 1, cpu: 4 });
      await f.machine({ organizationId: f.other.id, projectId: f.foreign.id, taskId: 'theirs', provider: 'gcp', funding: 'managed',
        start: NOW - 2 * HOUR, end: NOW, costMicros: 1, cpu: 2 });
      // One machine running from the 8th through the 9th: the 9th has no start but is busy all day.
      await f.machine({ projectId: f.web.id, taskId: ours.id, provider: 'gcp', funding: 'managed',
        start: Date.UTC(2026, 10, 8, 20), end: Date.UTC(2026, 10, 10, 1), costMicros: 1, cpu: 8 });
      // Hourly bookings back to back are one machine, not two.
      await f.machine({ projectId: f.web.id, taskId: ours.id, provider: 'hetzner', funding: 'managed', start: NOW - 6 * HOUR, end: NOW - 5 * HOUR, costMicros: 1 });
      await f.machine({ projectId: f.web.id, taskId: ours.id, provider: 'hetzner', funding: 'managed', start: NOW - 5 * HOUR, end: NOW - 4 * HOUR, costMicros: 1 });
      const budgets = [{ provider: 'gcp', pool: { cpu: 24, machines: 24 } }, { provider: 'hetzner', pool: { cpu: 10 } }, { provider: 'fly' }];

      const member = await organizationInsights(f.store, f.organization.id, { days: 7, now: NOW, managedBudgets: budgets });
      expect(member.compute.budgets).toBeUndefined();
      const { compute } = await organizationInsights(f.store, f.organization.id, { days: 7, now: NOW, includeSpend: true, managedBudgets: budgets });
      const gcp = compute.budgets!.find((budget) => budget.provider === 'gcp')!;
      expect(gcp.pool).toEqual({ cpu: 24, machines: 24 });
      expect(gcp.peakCpu.slice(-3)).toEqual([8, 8, 8]);
      expect(gcp.peakMachines.slice(-3)).toEqual([1, 1, 2]);
      const hetzner = compute.budgets!.find((budget) => budget.provider === 'hetzner')!;
      expect(hetzner.peakMachines.at(-1)).toBe(1);
      // An account with no budget and no use is left out.
      expect(compute.budgets!.map((budget) => budget.provider)).toEqual(['gcp', 'hetzner']);
    } finally { await f.store.close(); }
  });
});

describe('insights: storage', () => {
  async function storageFixture() {
    const f = await seed();
    await f.store.setOrganizationPlan(f.organization.id, 'individual');
    await f.store.setOrganizationStoragePacks(f.organization.id, 1);
    const location = managedStorageLocationId(f.organization.id);
    await f.store.saveStorageLocation({ id: location, organizationId: f.organization.id, name: 'Managed storage',
      kind: 'managed', config: {}, isDefault: true, status: 'ready', createdAt: NOW - 30 * DAY, updatedAt: NOW - 30 * DAY } as any);
    const work = await f.task(f.web.id, 'Work');
    // A task workspace saved 3 days ago (1 GiB) and a review file today (10 MiB).
    await f.store.db.prepare(`INSERT INTO world_checkpoints (id, projectId, worldId, generation, manifest, createdAt) VALUES (?, ?, ?, 1, ?, ?)`)
      .run('cp_1', f.web.id, work.id, JSON.stringify({ id: 'cp_1', filesystemDelta: { bytes: GIB } }), NOW - 3 * DAY);
    await f.store.savePromotedArtifact({ id: 'art_1', organizationId: f.organization.id, projectId: f.api.id, taskId: work.id,
      objectKey: 'k', sha256: 's', bytes: 10 * 1024 ** 2, mediaType: 'image/png', name: 'chart.png', createdAt: NOW - HOUR });
    await f.store.recordUsage({ organizationId: f.organization.id, projectId: f.web.id, taskId: work.id, provider: 'e2b',
      kind: 'checkpoint.storage', quantity: GIB, unit: 'byte', costMicros: 0, fundingSource: 'managed',
      startedAt: NOW - 3 * DAY, endedAt: NOW - 3 * DAY } as any);
    return { ...f, work };
  }

  it('shows what managed storage holds by kind and project against the plan\'s quota and packs', async () => {
    const f = await storageFixture();
    try {
      const { storage } = await organizationInsights(f.store, f.organization.id, { days: 7, now: NOW });
      expect(storage.bytes).toBe(GIB + 10 * 1024 ** 2);
      expect(storage.byKind).toEqual({ resources: 0, workspaces: GIB, reviewFiles: 10 * 1024 ** 2, other: 0 });
      // Individual: 50 GiB, plus one 100 GiB pack at $4 a month.
      expect(storage.quotaBytes).toBe(150 * GIB);
      expect(storage.packs).toEqual({ paid: 1, gifted: 0, packBytes: 100 * GIB, monthlyCents: 400 });
      expect(storage.projects.map((project) => [project.name, project.bytes])).toEqual([['Web', GIB], ['Backend', 10 * 1024 ** 2]]);
      // Before any snapshot, earlier days are estimated from what is stored now.
      expect(storage.daily.at(-5)).toMatchObject({ bytes: 0, estimated: true });
      expect(storage.daily.at(-4)).toMatchObject({ bytes: GIB, estimated: true });
      // usage_events.quantity is REAL: PostgreSQL keeps it to single precision.
      expect(storage.daily.at(-4)!.added / GIB).toBeCloseTo(1, 6);
      expect(storage.daily.at(-3)).toMatchObject({ bytes: GIB, estimated: true, added: 0 });
      expect(storage.daily.at(-1)).toMatchObject({ bytes: GIB + 10 * 1024 ** 2 });
      expect(storage.daily.at(-1)!.estimated).toBeUndefined();
    } finally { await f.store.close(); }
  });

  it('counts chunked workspaces\' shared chunks as workspaces, split by what each project uploaded', async () => {
    const f = await storageFixture();
    try {
      const location = managedStorageLocationId(f.organization.id);
      await f.store.db.prepare(`INSERT INTO resource_snapshot_chunks (organizationId, chunkId, storageLocationId, refs, bytes) VALUES (?, ?, ?, 1, ?)`)
        .run(f.organization.id, 'chunk-1', location, 4 * GIB);
      // Web's tasks uploaded 1 GiB of checkpoints (the fixture), Backend's 3 GiB.
      const other = await f.task(f.api.id, 'Backend work');
      await f.store.recordUsage({ organizationId: f.organization.id, projectId: f.api.id, taskId: other.id, provider: 'e2b',
        kind: 'checkpoint.storage', quantity: 3 * GIB, unit: 'byte', costMicros: 0, fundingSource: 'managed',
        startedAt: NOW - DAY, endedAt: NOW - DAY } as any);
      const { storage } = await organizationInsights(f.store, f.organization.id, { days: 7, now: NOW });
      expect(storage.byKind).toEqual({ resources: 0, workspaces: 5 * GIB, reviewFiles: 10 * 1024 ** 2, other: 0 });
      const project = (id: string) => storage.projects.find((p) => p.id === id)!;
      expect(project(f.web.id).byKind.workspaces / GIB).toBeCloseTo(2, 5);
      expect(project(f.api.id).byKind.workspaces / GIB).toBeCloseTo(3, 5);
    } finally { await f.store.close(); }
  });

  it('remembers each day\'s storage, so deleted data still shows on the days it was kept', async () => {
    const f = await storageFixture();
    try {
      await recordStorageDay(f.store, f.organization.id, NOW - 2 * DAY);
      await f.store.db.prepare('DELETE FROM world_checkpoints WHERE id=?').run('cp_1');
      // A stale snapshot past the 120 days kept is pruned.
      await f.store.kvSet(storageDayKey(f.organization.id, '2026-01-01'), '{}');
      await recordStorageDay(f.store, f.organization.id, NOW - DAY);
      expect(await f.store.kvGet(storageDayKey(f.organization.id, '2026-01-01'))).toBeUndefined();

      const { storage } = await organizationInsights(f.store, f.organization.id, { days: 7, now: NOW });
      // (The review file is already there when the 8th is recorded: it was saved before the test's clock.)
      expect(storage.daily.at(-3)).toMatchObject({ bytes: GIB + 10 * 1024 ** 2, byKind: { workspaces: GIB }, byProject: { [f.web.id]: GIB } });
      expect(storage.daily.at(-3)!.estimated).toBeUndefined();
      expect(storage.daily.at(-2)).toMatchObject({ bytes: 10 * 1024 ** 2, byKind: { workspaces: 0 } });
      expect(storage.daily.at(-1)).toMatchObject({ bytes: 10 * 1024 ** 2 });
    } finally { await f.store.close(); }
  });
});

describe('insights: model logins', () => {
  it('shows which login served which share and each subscription\'s 5-hour and weekly windows', async () => {
    const f = await seed();
    try {
      const work = await f.task(f.web.id, 'Work');
      const max1 = 'login:anthropic:max-1', max2 = 'login:anthropic:max-2';
      let n = 0;
      const turn = (at: number, account: string | undefined, outputTokens: number) => f.store.recordUsage({ id: `t${++n}`,
        organizationId: f.organization.id, projectId: f.web.id, taskId: work.id, provider: 'anthropic', kind: 'agent.tokens',
        quantity: outputTokens, unit: 'token', costMicros: 0, fundingSource: 'byok', startedAt: at, endedAt: at,
        metadata: { model: 'claude-opus-4-1', inputTokens: 0, outputTokens, ...(account ? { account } : {}) } } as any);
      const usd = turnUsd({ model: 'claude-opus-4-1', inputTokens: 0, outputTokens: 1_000_000 });
      expect(usd).toBeGreaterThan(0);
      // max-1: three turns in one 5-hour window, then a fresh window 6 hours later.
      await turn(NOW - 10 * HOUR, max1, 1_000_000);
      await turn(NOW - 9 * HOUR, max1, 1_000_000);
      await turn(NOW - 8 * HOUR, max1, 1_000_000);
      await turn(NOW - 2 * HOUR, max1, 1_000_000);
      // max-2 took the rest; an API key turn has no windows.
      await turn(NOW - 3 * HOUR, max2, 1_000_000);
      await turn(NOW - HOUR, undefined, 1_000_000);
      await f.store.kvSet(capacityKey(max1), JSON.stringify({ session: { usd: usd * 4, samples: 3 }, week: { usd: usd * 40, samples: 1 } }));
      await f.store.kvSet(observedKey(max1), JSON.stringify({ week: { utilization: 0.31, resetsAt: NOW + 2 * DAY, at: NOW - HOUR, spentAt: 0 } }));

      const hidden = await organizationInsights(f.store, f.organization.id, { days: 7, now: NOW });
      expect(hidden.logins).toBeUndefined();
      const { logins } = await organizationInsights(f.store, f.organization.id, { days: 7, now: NOW, includeLogins: true });
      // A turn that did not record its login is kept apart: shares are among the logins known.
      expect(logins!.map((login) => [login.id, login.turns, login.unrecorded])).toEqual([[max1, 4, undefined], [max2, 1, undefined],
        ['unrecorded:anthropic', 1, true]]);
      expect(logins![0]!.share).toBeCloseTo(4 / 5);
      expect(logins![2]!.share).toBe(0);
      expect(logins![0]!.capacity).toMatchObject({ learned: true });
      expect(logins![0]!.observed).toEqual({ week: { utilization: 0.31, resetsAt: NOW + 2 * DAY, at: NOW - HOUR } });
      expect(logins![2]!.hourly).toBeUndefined();
      const { session, week, from } = logins![0]!.hourly!;
      const at = (ts: number) => Math.floor((ts - from) / HOUR);
      // Three of four windows' worth by the third turn; the window closes 5 hours after it opened.
      expect(session[at(NOW - 8 * HOUR)]).toBeCloseTo(0.75);
      expect(session[at(NOW - 4 * HOUR)]).toBe(0);
      expect(session[at(NOW - 2 * HOUR)]).toBeCloseTo(0.25);
      // The week (reset two days from now) counts every turn since it began.
      expect(week[at(NOW - 2 * HOUR)]).toBeCloseTo(0.1);
      // Logins default to the scheduler's prior capacity until readings teach it.
      expect(logins![1]!.capacity).toEqual({ session: 150, week: 900, learned: false });
    } finally { await f.store.close(); }
  });
});
});
