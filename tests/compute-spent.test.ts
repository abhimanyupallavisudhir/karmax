// Spent compute credit and parked disks (wiki features/managed-compute § Spent
// credit): owners are told, then after a grace the organization's parked
// managed VMs are hibernated so their disks stop costing what no credit covers.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { COMPUTE_HIBERNATED_NOTICE, WorldLifecycleManager } from '../src/world/runners.js';
import { COMPUTE_SPENT, hibernateAt, notifyComputeCredit, parkedManagedDisks } from '../src/world/compute-notices.js';
import type { WorldHandle } from '../src/world/types.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const T = Date.UTC(2026, 9, 15, 12);
const HOUR = 60 * 60_000, DAY = 24 * HOUR;

async function fixture(diskGb = 200) {
  const store = await Store.create(':memory:', { hosted: true });
  cleanups.push(() => store.close());
  const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
  await store.setOrganizationPlan(organization.id, 'individual');
  const project = await store.createProject('Cloud', { worldProvider: 'aws' }, organization.id);
  const task = await store.createTask({ projectId: project.id, title: 'Parked', workflow: 'just-do', workflowVersion: '1.0.0',
    params: { prompt: 'x' } as any });
  const handle = await store.registerWorld({ kind: 'aws', id: task.id, root: '/home/user', branch: 'main', base: 'main',
    meta: { funding: 'managed', machine: { cpu: 2, memoryMb: 4096, diskGb } } } as any, project.id) as WorldHandle;
  await store.setWorldState(handle, 'parked');
  const checkpoint = { id: 'checkpoint-1', worldId: handle.id, generation: 1, projectId: project.id,
    runnerPoolId: 'local', environmentDigest: 'test', repos: [], createdAt: Date.now() };
  await store.saveWorldCheckpoint(checkpoint);
  const worlds = new WorldRegistry();
  const destroy = vi.fn(async () => {});
  worlds.register({ kind: 'aws', parkable: true, destroy, probe: async () => undefined } as any);
  const addNotice = vi.fn(async () => {});
  const lifecycle = new WorldLifecycleManager(store, worlds, { checkpoint: vi.fn(async () => checkpoint), addNotice } as any);
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const deps = { store, email: { configured: async () => true, send: async (message: any) => { sent.push(message); } },
    userEmail: async (userId: string) => `${userId}@example.test`, publicUrl: 'https://tavya.test', siteName: async () => 'tavya',
    hibernate: (candidates: any) => lifecycle.hibernateForCompute(candidates) };
  const spend = () => store.recordUsage({ id: 'usage:aws:spent', organizationId: organization.id, provider: 'aws', kind: 'world.active',
    quantity: 3600, unit: 'second', costMicros: 2_600_000, startedAt: T - 2 * HOUR, endedAt: T - HOUR, fundingSource: 'managed' });
  return { store, organization, task, handle, destroy, addNotice, sent, deps, spend };
}

describe('spent compute credit', () => {
  it('tells the owners, reminds them a day ahead, hibernates parked disks after three days, and withdraws it all once there is credit', async () => {
    const f = await fixture();
    expect(await parkedManagedDisks(f.store, f.organization.id)).toEqual([expect.objectContaining({ provider: 'aws', diskGb: 200,
      diskMicrosPerHour: Math.ceil(200 * 0.0952 / 730 * 1e6) })]);
    await f.spend();
    // Spent must last ten minutes (an auto top-up may be on its way) before anyone is told.
    expect(await notifyComputeCredit(f.deps, T)).toBe(0);
    expect(await notifyComputeCredit(f.deps, T + 10 * 60_000)).toBe(1);
    const [spent] = await f.store.listInbox('owner', f.organization.id);
    expect(spent!.subject).toMatchObject({ kind: 'compute', stage: 'spent', usedMicros: 5_200_000, creditMicros: 5_000_000,
      hibernateAt: T + 3 * DAY, computers: 1 });
    expect(f.sent[0]!.subject).toBe('Acme has used this month\'s tavya compute');
    expect(f.sent[0]!.text).toMatch(/Its 1 parked computer keeps its disk until 2026-10-18 12:00 UTC, then it is hibernated/);
    expect(f.sent[0]!.text).toMatch(/files Git ignores \(installed dependencies, build output, caches\) are deleted/);
    expect(await notifyComputeCredit(f.deps, T + DAY)).toBe(0);
    expect(await notifyComputeCredit(f.deps, T + 2 * DAY)).toBe(1);
    expect(f.sent[1]!.subject).toBe('Acme\'s parked tavya computers are hibernated on 2026-10-18 12:00 UTC');
    expect(f.destroy).not.toHaveBeenCalled();
    expect(await notifyComputeCredit(f.deps, T + 3 * DAY)).toBe(1);
    expect(f.destroy).toHaveBeenCalledTimes(1);
    expect(await f.store.worldState(f.handle.id)).toBe('hibernated');
    expect((await f.store.eventsOfType(f.task.id, 'world.hibernated')).at(-1)?.payload).toMatchObject({ reason: 'compute-spent', checkpointId: 'checkpoint-1' });
    expect(f.addNotice).toHaveBeenCalledWith(f.task.id, COMPUTE_HIBERNATED_NOTICE);
    expect(f.sent[2]!.subject).toBe('Acme\'s parked tavya computers were hibernated');
    expect(f.sent[2]!.text).toMatch(/its 1 parked computer was hibernated: saved, and its machine and disk deleted/);
    const inbox = await f.store.listInbox('owner', f.organization.id);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.subject).toMatchObject({ stage: 'hibernated', computers: 1 });
    expect(inbox[0]!.urgency).toBe('critical');
    // A pack: nothing is spent any more, and the notices are withdrawn.
    await f.store.setComputePackGift(f.organization.id, 1, 'operator');
    await notifyComputeCredit(f.deps, T + 3 * DAY + 10 * 60_000);
    expect(await f.store.listInbox('owner', f.organization.id)).toHaveLength(0);
    expect(await f.store.kvGet(`compute-spent:${f.organization.id}`)).toBeUndefined();
  });

  it('hibernates a huge disk sooner: once it would have cost $10 past the credit', async () => {
    const f = await fixture(16_384);
    const perHour = Math.ceil(16_384 * 0.0952 / 730 * 1e6);
    // $4.27 an hour at tavya's prices: $10 is 2.3 hours.
    expect(hibernateAt(T, perHour) - T).toBeCloseTo(10_000_000 / (2 * perHour) * HOUR, -3);
    // But never sooner than an hour after the credit ran out.
    expect(hibernateAt(T, 1e9) - T).toBe(COMPUTE_SPENT.minGraceMs);
    await f.spend();
    await notifyComputeCredit(f.deps, T);
    await notifyComputeCredit(f.deps, T + 10 * 60_000);
    expect((await f.store.listInbox('owner', f.organization.id))[0]!.subject).toMatchObject({ hibernateAt: hibernateAt(T, perHour) });
    // No reminder for a grace shorter than a day; hibernated when it ends.
    expect(await notifyComputeCredit(f.deps, T + 2 * HOUR)).toBe(0);
    expect(await notifyComputeCredit(f.deps, T + 2.4 * HOUR)).toBe(1);
    expect(await f.store.worldState(f.handle.id)).toBe('hibernated');
  });

  it('waits for an auto top-up being charged, and leaves an organization with credit alone', async () => {
    const f = await fixture();
    await f.spend();
    await f.store.createComputeTopUp({ id: 'topup_a', organizationId: f.organization.id, creditMicros: 10_000_000, amountCents: 1_000,
      subscriptionId: 'sub_1', requestedAt: T });
    await notifyComputeCredit(f.deps, T);
    expect(await notifyComputeCredit(f.deps, T + 20 * 60_000)).toBe(0);
    await f.store.updateComputeTopUp('topup_a', { state: 'paid', settledAt: T + 21 * 60_000 });
    expect(await notifyComputeCredit(f.deps, T + 30 * 60_000)).toBe(0);
    expect(await f.store.kvGet(`compute-spent:${f.organization.id}`)).toBeUndefined();
    expect(await f.store.worldState(f.handle.id)).toBe('parked');
  });
});
