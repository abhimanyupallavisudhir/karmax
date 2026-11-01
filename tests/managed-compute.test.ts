// Managed compute (wiki features/managed-compute): organizations without their
// own provider account run on the installation's, within a monthly compute
// credit their plan, packs and gifts give them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { MANAGED_COMPUTE, WorldProviderConnectionService, connectionScope, fundingRef } from '../src/world/connections.js';
import { COMPUTE_PACK, COMPUTE_PRICE_MULTIPLIER, HOSTED_PLANS, computeChargeMicros, hostedComputeCreditMicros,
  hostedMonthlyPriceCents, organizationEntitlements } from '../src/domain/entitlements.js';
import { ComputeCreditExhausted, ManagedComputeBusy, assertComputeCredit, computeCredit } from '../src/world/managed-compute.js';
import { RunnerPoolService, WorldLifecycleManager } from '../src/world/runners.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ProviderCapacityFull } from '../src/agent/limits.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); });
// Mid-month: usage booked minutes ago, or checked minutes ahead, must fall in
// the month whose credit is asked for, which it does not near a month's end.
beforeEach(() => { vi.useFakeTimers({ now: Date.UTC(2026, 9, 15, 12), toFake: ['Date'] }); });
const probes = { check: async () => {}, limits: async () => ({}) };

async function fixture(options: { hosted?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-managed-compute-'));
  const store = await Store.create(':memory:', { hosted: options.hosted ?? true });
  cleanups.push(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const broker = new CredentialBroker(new Vault(dir));
  const connections = new WorldProviderConnectionService(store, broker, probes);
  const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
  const project = await store.createProject('Cloud', { worldProvider: 'e2b' }, organization.id);
  const task = async (title = 'Run') => store.createTask({ projectId: project.id, title, workflow: 'just-do', workflowVersion: '1.0.0',
    params: { prompt: title } as any });
  /** Managed compute rows as the provider feed books them. */
  const usage = async (id: string, costMicros: number, at = Date.now() - 60_000, fundingSource: 'managed' | 'byok' = 'managed') =>
    store.recordUsage({ id: `usage:e2b:${id}`, organizationId: organization.id, provider: 'e2b', kind: 'world.active',
      quantity: 600, unit: 'second', costMicros, startedAt: at - 600_000, endedAt: at, fundingSource });
  return { store, broker, connections, organization, project, task, usage };
}

describe('compute credit in the plan catalog', () => {
  it('gives paid plans monthly credit, adds packs and gifts, and prices packs', () => {
    expect(HOSTED_PLANS.free.computeCreditMicros).toBe(0);
    expect(HOSTED_PLANS.individual.computeCreditMicros).toBe(5_000_000);
    expect(COMPUTE_PACK).toEqual({ creditMicros: 10_000_000, monthlyPriceCents: 1_000 });
    // Team: $10 + $3 for each active user after the first.
    expect(hostedComputeCreditMicros('team', 3)).toBe(16_000_000);
    expect(hostedComputeCreditMicros('individual', 1, 2, 1)).toBe(35_000_000);
    // Packs in force count on any plan, paid or gifted.
    expect(hostedComputeCreditMicros('free', 1, 4, 1)).toBe(50_000_000);
    expect(hostedMonthlyPriceCents('individual', 1, 1, 2)).toBe(900 + 400 + 2_000);
    expect(hostedMonthlyPriceCents('free', 1, 1, 2)).toBe(400 + 2_000);
    expect(organizationEntitlements('team', true, 2, { computePacks: 1, giftedComputePacks: 2 })).toMatchObject({
      computeCreditMicros: 13_000_000 + 3 * COMPUTE_PACK.creditMicros, includedComputeCreditMicros: 13_000_000,
      computePacks: 1, giftedComputePacks: 2, computePackCreditMicros: 10_000_000 });
    expect(organizationEntitlements('team', false, 2)).toMatchObject({ computeCreditMicros: null });
    expect(computeChargeMicros(1_234)).toBe(1_234 * COMPUTE_PRICE_MULTIPLIER);
  });
});

describe('managed compute accounts', () => {
  it('runs an organization without its own account on the installation\'s, and its own account always first', async () => {
    const f = await fixture();
    await expect(f.connections.resolve(f.organization.id, 'e2b')).rejects.toThrow(/not connected/);
    expect(await f.connections.funding(f.organization.id, 'e2b')).toBeUndefined();

    await f.connections.save({ organizationId: MANAGED_COMPUTE, provider: 'e2b', apiKey: 'operator-key', config: {} });
    const managed = await f.connections.resolve(f.organization.id, 'e2b');
    expect(managed).toMatchObject({ apiKey: 'operator-key', managed: true, organizationId: f.organization.id });
    expect(await f.connections.funding(f.organization.id, 'e2b')).toBe('managed');
    expect(fundingRef(managed)).toEqual({ funding: 'managed' });

    // The organization's list offers it, without the installation's secrets or capacity.
    const listed = await f.connections.list(f.organization.id);
    expect(listed).toEqual([expect.objectContaining({ provider: 'e2b', managed: true, credentialConfigured: true, config: {} })]);
    expect(JSON.stringify(listed)).not.toMatch(/operator-key|maxRunning|world-provider:installation/);

    // Its own account wins from then on; a world made on managed compute stays there.
    await f.connections.save({ organizationId: f.organization.id, provider: 'e2b', apiKey: 'own-key' });
    expect(await f.connections.resolve(f.organization.id, 'e2b')).toMatchObject({ apiKey: 'own-key' });
    expect((await f.connections.resolve(f.organization.id, 'e2b')).managed).toBeUndefined();
    expect(await f.connections.funding(f.organization.id, 'e2b')).toBe('own');
    const scope = connectionScope({ organizationId: f.organization.id, funding: 'managed' });
    expect(scope).toBe(MANAGED_COMPUTE);
    expect(await f.connections.resolve(scope, 'e2b')).toMatchObject({ apiKey: 'operator-key', managed: true });
    expect((await f.connections.list(f.organization.id)).map((value) => value.managed ?? false)).toEqual([false]);
  });

  // Moving an organization from its own account to managed compute
  // (nisada-personal, 2026-11-01): disabling its own connection sends every
  // new computer to managed compute, while computers already made on its own
  // account keep that account until they end, so none is stranded on a key
  // that cannot see it (deleting the connection is refused while they exist).
  it('sends new computers to managed compute once an organization disables its own account, and keeps its existing ones on it', async () => {
    const f = await fixture();
    await f.connections.save({ organizationId: MANAGED_COMPUTE, provider: 'hetzner', apiKey: 'managed-project', config: {} });
    await f.connections.save({ organizationId: f.organization.id, provider: 'hetzner', apiKey: 'own-project' });
    await f.connections.save({ organizationId: f.organization.id, provider: 'hetzner', enabled: false });

    expect(await f.connections.funding(f.organization.id, 'hetzner')).toBe('managed');
    expect(await f.connections.resolve(f.organization.id, 'hetzner', { new: true }))
      .toMatchObject({ apiKey: 'managed-project', managed: true, organizationId: f.organization.id });
    expect(await f.connections.available(f.organization.id, 'hetzner')).toBe(true);
    // "Any" can choose managed Hetzner; Settings still shows the organization's own, off.
    expect((await f.connections.reachable(f.organization.id)).map((value) => [value.provider, value.managed ?? false]))
      .toEqual([['hetzner', true]]);
    expect((await f.connections.list(f.organization.id))[0]).toMatchObject({ provider: 'hetzner', enabled: false });
    expect((await f.connections.list(f.organization.id))[0]!.managed).toBeUndefined();

    // A computer made on its own account (no `funding` in its reference) still reaches it.
    const existing = await f.connections.resolve(connectionScope({ organizationId: f.organization.id }), 'hetzner');
    expect(existing).toMatchObject({ apiKey: 'own-project' });
    expect(existing.managed).toBeUndefined();
  });

  it('keeps the installation\'s key in the installation\'s vault scope and offers nothing once disabled', async () => {
    const f = await fixture();
    const saved = await f.connections.save({ organizationId: MANAGED_COMPUTE, provider: 'hetzner', apiKey: 'hcloud',
      config: { limits: { pool: { cpu: 12 } }, share: 40, region: 'fsn1' } });
    expect(saved.config).toMatchObject({ limits: { pool: { cpu: 12 } }, share: 40, region: 'fsn1' });
    expect(saved.limits.pool).toEqual({ cpu: 12 });
    expect((await f.connections.list(f.organization.id))[0]).toMatchObject({ provider: 'hetzner', config: { region: 'fsn1' } });
    // Organizations see what one machine may be, never the installation's budget or share.
    expect(JSON.stringify(await f.connections.list(f.organization.id))).not.toMatch(/"pool"|"share"/);
    await f.connections.save({ organizationId: MANAGED_COMPUTE, provider: 'hetzner', enabled: false });
    expect(await f.connections.list(f.organization.id)).toEqual([]);
    await expect(f.connections.resolve(f.organization.id, 'hetzner')).rejects.toThrow(/not connected/);
  });

  it('gives managed computers the installation account\'s limits', async () => {
    const f = await fixture();
    await f.connections.save({ organizationId: MANAGED_COMPUTE, provider: 'e2b', apiKey: 'operator-key', config: { limits: { diskGb: 25 } } });
    expect((await f.connections.limits(f.organization.id, 'e2b')).diskGb).toBe(25);
  });
});

describe('compute credit', () => {
  it('charges managed machine time at tavya\'s prices this month and ignores the organization\'s own account', async () => {
    const f = await fixture();
    await f.store.setOrganizationPlan(f.organization.id, 'individual');
    await f.usage('a', 1_000_000);
    await f.usage('b', 500_000, Date.now() - 60_000, 'byok');
    await f.usage('old', 9_000_000, Date.UTC(2020, 0, 5));
    const credit = await computeCredit(f.store, f.organization.id);
    expect(credit).toMatchObject({ creditMicros: 5_000_000, costMicros: 1_000_000, usedMicros: 2_000_000, seconds: 600,
      byProvider: [{ provider: 'e2b', usedMicros: 2_000_000, seconds: 600 }] });
    await expect(assertComputeCredit(f.store, f.organization.id, 'e2b')).resolves.toBeUndefined();

    await f.usage('c', 1_500_000);
    const spent = await assertComputeCredit(f.store, f.organization.id, 'e2b').catch((error) => error);
    expect(spent).toBeInstanceOf(ComputeCreditExhausted);
    expect(spent).toBeInstanceOf(ProviderCapacityFull);
    expect(spent.message).toMatch(/^Out of compute: this month's \$5\.00 of compute is used up\. Add a compute pack or turn on auto top-up in Plan & billing, or connect your own E2B account/);

    // A gifted pack makes room again.
    await f.store.setComputePackGift(f.organization.id, 1, 'operator');
    await expect(assertComputeCredit(f.store, f.organization.id, 'e2b')).resolves.toBeUndefined();
  });

  it('says that Free has no managed compute, and leaves private installations unmetered', async () => {
    const f = await fixture();
    await expect(assertComputeCredit(f.store, f.organization.id, 'e2b')).rejects.toThrow(/^Out of compute: tavya's computers come with a paid plan/);
    const p = await fixture({ hosted: false });
    await p.usage('a', 50_000_000);
    await expect(assertComputeCredit(p.store, p.organization.id, 'e2b')).resolves.toBeUndefined();
  });
});

describe('managed compute admission', () => {
  it('admits new work within the credit, waits once it is spent, and still wakes a world to save its work', async () => {
    const f = await fixture();
    await f.connections.save({ organizationId: MANAGED_COMPUTE, provider: 'e2b', apiKey: 'operator-key' });
    await f.store.setOrganizationPlan(f.organization.id, 'individual');
    const runners = new RunnerPoolService(f.store, f.connections);
    const one = await f.task('One');
    const lease = await runners.acquire({ project: f.project, taskId: one.id, worldId: one.id, provider: 'e2b', work: true });
    expect(lease.runnerPoolId).toBe(`${f.organization.id}:tavya-e2b`);
    expect(await f.store.getRunnerPool(lease.runnerPoolId)).toMatchObject({ mode: 'managed' });
    await runners.release(lease.leaseId, 'e2b');

    await f.usage('spent', 2_600_000);
    const two = await f.task('Two');
    await expect(runners.acquire({ project: f.project, taskId: two.id, worldId: two.id, provider: 'e2b', work: true }))
      .rejects.toBeInstanceOf(ComputeCreditExhausted);
    expect((await f.store.listWorldLeases(lease.runnerPoolId)).filter((value) => value.state !== 'released')).toEqual([]);
    const wake = await runners.acquire({ project: f.project, taskId: two.id, worldId: two.id, provider: 'e2b' });
    expect(wake.runnerPoolId).toBe(lease.runnerPoolId);
  });

  it('runs no more of the installation\'s machines at once than its account allows, across organizations', async () => {
    const f = await fixture();
    await f.connections.save({ organizationId: MANAGED_COMPUTE, provider: 'e2b', apiKey: 'operator-key', config: { limits: { pool: { machines: 1 } } } });
    const other = await f.store.createOrganization({ name: 'Other', ownerUserId: 'other' });
    const otherProject = await f.store.createProject('Theirs', { worldProvider: 'e2b' }, other.id);
    for (const id of [f.organization.id, other.id]) await f.store.setOrganizationPlan(id, 'team');
    const runners = new RunnerPoolService(f.store, f.connections);
    const mine = await f.task('Mine');
    const held = await runners.acquire({ project: f.project, taskId: mine.id, worldId: mine.id, provider: 'e2b', work: true });
    const theirs = await f.store.createTask({ projectId: otherProject.id, title: 'Theirs', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'x' } as any });
    const busy = await runners.acquire({ project: otherProject, taskId: theirs.id, worldId: theirs.id, provider: 'e2b', work: true }).catch((error) => error);
    expect(busy).toBeInstanceOf(ManagedComputeBusy);
    expect(busy.message).toBe('All 1 of tavya\'s E2B computers are in use; waiting for one to free up.');
    // An organization's own account is not limited by the installation's.
    await f.connections.save({ organizationId: other.id, provider: 'e2b', apiKey: 'their-key' });
    await expect(runners.acquire({ project: otherProject, taskId: theirs.id, worldId: theirs.id, provider: 'e2b', work: true })).resolves.toBeDefined();
    await runners.release(held.leaseId, 'e2b');
  });

  // The account's budget (wiki features/managed-compute § Budget): CPUs and
  // machines at once, read from the provider or entered, and a fair share.
  describe('the account\'s budget', () => {
    async function two(config: Record<string, unknown>) {
      const f = await fixture();
      await f.connections.save({ organizationId: MANAGED_COMPUTE, provider: 'e2b', apiKey: 'operator-key', config });
      const other = await f.store.createOrganization({ name: 'Other', ownerUserId: 'other' });
      const otherProject = await f.store.createProject('Theirs', { worldProvider: 'e2b' }, other.id);
      for (const id of [f.organization.id, other.id]) await f.store.setOrganizationPlan(id, 'team');
      const runners = new RunnerPoolService(f.store, f.connections);
      const resources = (cpu: number) => ({ cpu, memoryMb: 2048, gpu: 0 });
      // A new task of ours or theirs asks for a machine (or `taskId`, one that asked before, again).
      const ours = async (cpu = 2, taskId?: string) => {
        const id = taskId ?? (await f.task()).id;
        return runners.acquire({ project: f.project, taskId: id, worldId: id, provider: 'e2b', work: true, resources: resources(cpu) });
      };
      const theirTask = async () => (await f.store.createTask({ projectId: otherProject.id, title: 'Theirs', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'x' } as any })).id;
      const theirs = async (cpu = 2, taskId?: string) => {
        const id = taskId ?? await theirTask();
        return runners.acquire({ project: otherProject, taskId: id, worldId: id, provider: 'e2b', work: true, resources: resources(cpu) });
      };
      return { ...f, runners, ours, theirs, theirTask };
    }

    it('admits machines while their CPUs fit the account\'s, whatever their number', async () => {
      const f = await two({ limits: { pool: { cpu: 4 } } });
      await f.ours();
      await f.theirs();
      const refused = await f.ours().catch((error) => error);
      expect(refused).toBeInstanceOf(ManagedComputeBusy);
      expect(refused.message).toBe('tavya\'s E2B computers are using 4 of their 4 CPUs; waiting for room.');
    });

    // The queue (wiki features/managed-compute § Queue): room that frees goes to
    // who waited first when it fits them, not to whoever asks next.
    it('gives freed room to the task that waited first, not to a newer one', async () => {
      const f = await two({ limits: { pool: { cpu: 8 } } });
      const held = [await f.ours(), await f.ours(), await f.ours(), await f.ours()];
      // Full: the other organization's task waits in line.
      const waiting = await f.theirTask();
      expect(await f.theirs(2, waiting).catch((error) => error)).toBeInstanceOf(ManagedComputeBusy);
      await f.runners.release(held.pop()!.leaseId, 'e2b');
      const ours = await f.ours().catch((error) => error);
      expect(ours).toBeInstanceOf(ManagedComputeBusy);
      expect(ours.message).toBe('A task is waiting ahead of this one for tavya\'s E2B computers; waiting its turn.');
      // The one that waited first gets the room when it asks again.
      await expect(f.theirs(2, waiting)).resolves.toBeDefined();
    });

    it('lets one organization use all of it alone, and holds it to its share once another waits for more than is free', async () => {
      const f = await two({ limits: { pool: { cpu: 8 } } });
      await f.ours(); await f.ours(); await f.ours();
      // They need 4 CPUs and only 2 are free: they wait. Their place does not
      // hold back a 2-CPU machine that fits the room now, but our share does:
      // we hold 6 of 8 while they wait.
      expect(await f.theirs(4).catch((error) => error)).toBeInstanceOf(ManagedComputeBusy);
      const ours = await f.ours().catch((error) => error);
      expect(ours).toBeInstanceOf(ManagedComputeBusy);
      expect(ours.message).toBe('This organization already uses its share of tavya\'s E2B computers (6 of 8 CPUs) while other organizations wait for one; waiting for one of its machines to finish.');
      // A share of 100% gives no way, and an organization holding nothing always gets its first machine.
      const g = await two({ limits: { pool: { cpu: 4 } }, share: 100 });
      await g.ours();
      expect(await g.theirs().catch(() => 'refused')).not.toBe('refused');
      expect(await g.theirs().catch((error) => error)).toBeInstanceOf(ManagedComputeBusy);
      await expect(g.ours()).rejects.toBeInstanceOf(ManagedComputeBusy);
    });

    // Owner, 2026-10-30: no limits besides the providers'. The machines at once
    // entered before (tavya's own caution) are not a budget; each provider's
    // own refusal makes a task wait or move instead.
    it('ignores machines at once saved before the budget, and drops it at the next save', async () => {
      const f = await two({});
      const row = (await f.store.getWorldProviderConnection(MANAGED_COMPUTE, 'e2b'))!;
      await f.store.upsertWorldProviderConnection({ ...row, config: { ...row.config, maxRunning: 1 } as any });
      expect((await f.connections.managedConnections())[0]!.limits.pool).toBeUndefined();
      await f.ours();
      await expect(f.theirs()).resolves.toBeDefined();
      await f.connections.save({ organizationId: MANAGED_COMPUTE, provider: 'e2b', config: { region: 'us' } });
      expect((await f.store.getWorldProviderConnection(MANAGED_COMPUTE, 'e2b'))!.config).not.toHaveProperty('maxRunning');
    });

    it('takes a budget the provider tells, and an entered one over it', async () => {
      const f = await fixture();
      const measured = new WorldProviderConnectionService(f.store, f.broker,
        { check: async () => {}, limits: async () => ({ cpu: 32, pool: { cpu: 24, machines: 24 } }) });
      await measured.save({ organizationId: MANAGED_COMPUTE, provider: 'gcp', apiKey: JSON.stringify({ type: 'service_account', project_id: 'p',
        client_email: 'a@p.iam.gserviceaccount.com', private_key: (await import('node:crypto')).generateKeyPairSync('rsa', { modulusLength: 2048 })
          .privateKey.export({ type: 'pkcs8', format: 'pem' }) }) });
      await measured.test(MANAGED_COMPUTE, 'gcp');
      const account = async () => (await measured.managedConnections()).find((value) => value.provider === 'gcp')!;
      // One machine is never more than the whole budget.
      expect((await account()).limits).toMatchObject({ cpu: 24, pool: { cpu: 24, machines: 24 } });
      await measured.save({ organizationId: MANAGED_COMPUTE, provider: 'gcp', config: { limits: { pool: { cpu: 12 } } } });
      expect((await account()).limits).toMatchObject({ cpu: 12, pool: { cpu: 12, machines: 24 }, source: { cpu: 'configured' } });
    });
  });

  it('bills a lease-priced managed provider (Daytona) as managed', async () => {
    const f = await fixture();
    await f.connections.save({ organizationId: MANAGED_COMPUTE, provider: 'daytona', apiKey: 'operator-key' });
    await f.store.setOrganizationPlan(f.organization.id, 'individual');
    const runners = new RunnerPoolService(f.store, f.connections);
    const one = await f.task();
    const lease = await runners.acquire({ project: f.project, taskId: one.id, worldId: one.id, provider: 'daytona', work: true });
    await f.store.db.prepare('UPDATE world_leases SET acquiredAt=? WHERE id=?').run(Date.now() - 3_600_000, lease.leaseId);
    await runners.release(lease.leaseId, 'daytona');
    const summary = await f.store.usageSummary(f.organization.id);
    expect(Object.keys(summary.byFundingSource)).toEqual(['managed']);
    expect((await computeCredit(f.store, f.organization.id)).usedMicros).toBe(computeChargeMicros(summary.costMicros));
  });
});

describe('managed compute usage', () => {
  it('books the installation account\'s feed to each organization as managed', async () => {
    const f = await fixture();
    await f.connections.save({ organizationId: MANAGED_COMPUTE, provider: 'e2b', apiKey: 'operator-key' });
    const one = await f.task();
    const listUsageEvents = vi.fn(async (scope: string) => ({ events: scope === MANAGED_COMPUTE ? [{ id: 'execution-1', sandboxId: 'sandbox-1',
      taskId: one.id, organizationId: f.organization.id, startedAt: Date.UTC(2026, 9, 1, 10), endedAt: Date.UTC(2026, 9, 1, 11),
      activeMs: 3_600_000, cpu: 2, memoryMb: 2048 }] : [] }));
    const worlds = new WorldRegistry();
    worlds.register({ kind: 'e2b', parkable: true, listUsageEvents } as any);
    await new WorldLifecycleManager(f.store, worlds, {} as any).sweep(Date.UTC(2026, 9, 1, 12));
    expect(listUsageEvents).toHaveBeenCalledWith(MANAGED_COMPUTE, undefined, undefined);
    const summary = await f.store.usageSummary(f.organization.id);
    // An hour of 2 vCPU / 2 GiB at E2B's list price.
    expect(summary).toMatchObject({ costMicros: 133_200, byFundingSource: { managed: 133_200 } });
    expect((await computeCredit(f.store, f.organization.id, Date.UTC(2026, 9, 15))).usedMicros).toBe(266_400);
  });

  it('books an organization\'s own machines as its own when it connected the installation\'s very account', async () => {
    // Production, 2026-10-30: an organization whose own E2B key is the same
    // E2B account as the installation's had its own sandboxes, read through
    // the installation's feed, charged to its compute credit.
    const f = await fixture();
    await f.connections.save({ organizationId: MANAGED_COMPUTE, provider: 'e2b', apiKey: 'shared-account' });
    await f.connections.save({ organizationId: f.organization.id, provider: 'e2b', apiKey: 'shared-account' });
    const [own, managed, earlier] = [await f.task('Own'), await f.task('Managed'), await f.task('Earlier')];
    // A world made on managed compute before the organization connected its key keeps it.
    for (const [task, meta] of [[own, {}], [managed, { funding: 'managed' }], [earlier, {}]] as const)
      await f.store.registerWorld({ id: task.id, kind: 'e2b', root: '/home/user', meta } as any, f.project.id);
    const hour = (n: number) => Date.UTC(2026, 9, 1, n);
    const event = (id: string, taskId: string, at: number) => ({ id, sandboxId: `sandbox-${id}`, taskId, organizationId: f.organization.id,
      startedAt: at, endedAt: at + 3_600_000, activeMs: 3_600_000, cpu: 2, memoryMb: 2048 });
    // An earlier release booked this one as managed.
    await f.store.recordUsage({ id: 'usage:e2b:earlier', organizationId: f.organization.id, projectId: f.project.id, taskId: earlier.id,
      worldId: earlier.id, provider: 'e2b', kind: 'world.active', quantity: 3600, unit: 'second', costMicros: 133_200,
      startedAt: hour(8), endedAt: hour(9), fundingSource: 'managed' });
    // One account: both keys read the same feed.
    const events = [event('own', own.id, hour(10)), event('managed', managed.id, hour(10)), event('earlier', earlier.id, hour(8))];
    const worlds = new WorldRegistry();
    worlds.register({ kind: 'e2b', parkable: true, listUsageEvents: async () => ({ events }) } as any);
    await new WorldLifecycleManager(f.store, worlds, {} as any).sweep(hour(12));
    expect(await f.store.usageSummary(f.organization.id)).toMatchObject({ costMicros: 3 * 133_200,
      byFundingSource: { managed: 133_200, byok: 2 * 133_200 } });
    expect((await computeCredit(f.store, f.organization.id, Date.UTC(2026, 9, 15))).usedMicros).toBe(266_400);
  });
});

describe('out-of-compute notices', () => {
  it('tells the owners once a month while the credit is spent, and withdraws it when there is credit again', async () => {
    const { notifyComputeCredit } = await import('../src/world/compute-notices.js');
    const f = await fixture();
    await f.store.setOrganizationPlan(f.organization.id, 'individual');
    const sent: Array<{ to: string; subject: string; text: string }> = [];
    const deps = { store: f.store, email: { configured: async () => true, send: async (message: any) => { sent.push(message); } },
      userEmail: async (userId: string) => `${userId}@example.test`, publicUrl: 'https://tavya.test', siteName: async () => 'tavya' };
    expect(await notifyComputeCredit(deps)).toBe(0);
    await f.usage('spent', 2_500_000);
    // Told once it has stayed spent ten minutes (an auto top-up may be on its way).
    expect(await notifyComputeCredit(deps)).toBe(0);
    expect(await notifyComputeCredit(deps, Date.now() + 10 * 60_000)).toBe(1);
    expect(await notifyComputeCredit(deps, Date.now() + 20 * 60_000)).toBe(0);
    const inbox = await f.store.listInbox('owner', f.organization.id);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.subject).toMatchObject({ kind: 'compute', usedMicros: 5_000_000, creditMicros: 5_000_000 });
    expect(sent).toEqual([expect.objectContaining({ to: 'owner@example.test', subject: 'Acme has used this month\'s tavya compute' })]);
    expect(sent[0]!.text).toMatch(/\$5\.00 of its \$5\.00[\s\S]*add a compute pack, turn on auto top-up[\s\S]*https:\/\/tavya\.test\/settings/);
    await f.store.setComputePackGift(f.organization.id, 1, 'operator');
    await notifyComputeCredit(deps, Date.now() + 30 * 60_000);
    expect(await f.store.listInbox('owner', f.organization.id)).toHaveLength(0);
  });
});
