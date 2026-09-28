import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  HOSTED_PLANS,
  hostedActiveAgentRuns,
  hostedMonthlyPriceCents,
  organizationEntitlements,
} from '../src/domain/entitlements.js';
import { makeCoordinatorActivities } from '../src/activities/coordinator.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { EntitlementQueueReconciler } from '../src/platform/entitlement-queue-reconciler.js';

describe('hosted plan entitlements', () => {
  it('keeps launch pricing and limits in one billing-safe catalog', () => {
    expect(HOSTED_PLANS.free).toMatchObject({
      monthlyBasePriceCents: 0, maxMembers: 1, maxActiveAgentRuns: 5,
      additionalActiveUserAgentRuns: 0, unlimitedProjects: true,
    });
    expect(HOSTED_PLANS.individual).toMatchObject({
      monthlyBasePriceCents: 900, maxMembers: 1, maxActiveAgentRuns: 10,
      additionalActiveUserAgentRuns: 0, unlimitedProjects: true,
    });
    expect(HOSTED_PLANS.team).toMatchObject({
      monthlyBasePriceCents: 1_900, includedActiveUsers: 1,
      monthlyAdditionalActiveUserPriceCents: 500, maxMembers: null,
      maxActiveAgentRuns: 20, additionalActiveUserAgentRuns: 5, unlimitedProjects: true,
    });
    expect(hostedMonthlyPriceCents('team', 0)).toBe(1_900);
    expect(hostedMonthlyPriceCents('team', 1)).toBe(1_900);
    expect(hostedMonthlyPriceCents('team', 4)).toBe(3_400);
    expect(hostedActiveAgentRuns('free', 1)).toBe(5);
    expect(hostedActiveAgentRuns('individual', 1)).toBe(10);
    expect(hostedActiveAgentRuns('team', 0)).toBe(20);
    expect(hostedActiveAgentRuns('team', 1)).toBe(20);
    expect(hostedActiveAgentRuns('team', 4)).toBe(35);
  });

  it('does not apply hosted monetization limits to private installations', async () => {
    expect(organizationEntitlements('free', false)).toMatchObject({
      deployment: 'private', plan: null, maxMembers: null, maxActiveAgentRuns: null,
      unlimitedProjects: true,
    });
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Private', ownerUserId: 'owner' }));
    for (let i = 0; i < 12; i++) (await store.setOrganizationMembership(organization.id, `user-${i}`, 'member'));
    expect((await store.listOrganizationMemberships(organization.id))).toHaveLength(13);
  });

  it('migrates existing organizations onto Free without losing their identity', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-plan-migration-'));
    const file = path.join(home, 'state.db');
    const legacy = new DatabaseSync(file);
    legacy.exec(`CREATE TABLE organizations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL, createdAt INTEGER NOT NULL
    )`);
    legacy.prepare('INSERT INTO organizations (id, name, slug, kind, createdAt) VALUES (?, ?, ?, ?, ?)')
      .run('org_existing', 'Existing', 'existing', 'team', 123);
    legacy.close();
    const migrated = (await Store.create(file, { hosted: true }));
    expect((await migrated.getOrganization('org_existing'))).toMatchObject({
      id: 'org_existing', name: 'Existing', plan: 'free', createdAt: 123,
    });
    (await migrated.close());
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('enforces one-user plans at the persistence boundary and unlocks Team members', async () => {
    const store = (await Store.create(':memory:', { hosted: true }));
    const organization = (await store.createOrganization({ name: 'Hosted', ownerUserId: 'owner' }));

    await expect((async () => (await store.setOrganizationMembership(organization.id, 'second', 'member')))()).rejects.toThrow('Free allows 1 organization user. Upgrade the plan');
    await expect((async () => (await store.createOrganizationInvitation({
      organizationId: organization.id, email: 'second@example.com', invitedBy: 'user:owner',
    })))()).rejects.toThrow('Free allows 1 organization user');

    expect((await store.setOrganizationPlan(organization.id, 'individual')).plan).toBe('individual');
    await expect((async () => (await store.setOrganizationMembership(organization.id, 'second', 'member')))()).rejects.toThrow('Individual allows 1 organization user');

    expect((await store.setOrganizationPlan(organization.id, 'team')).plan).toBe('team');
    (await store.setOrganizationMembership(organization.id, 'second', 'member'));
    (await store.setOrganizationMembership(organization.id, 'third', 'member'));
    expect((await store.listOrganizationMemberships(organization.id))).toHaveLength(3);
    expect((await store.organizationEntitlements(organization.id)).maxActiveAgentRuns).toBe(30);
  });

  it('re-checks the member limit when an already-issued invitation is accepted', async () => {
    const store = (await Store.create(':memory:', { hosted: true }));
    const organization = (await store.createOrganization({ name: 'Invites', ownerUserId: 'owner' }));
    (await store.setOrganizationPlan(organization.id, 'team'));
    const invite = (await store.createOrganizationInvitation({
      organizationId: organization.id, email: 'second@example.com', invitedBy: 'user:owner',
    }));
    (await store.setOrganizationPlan(organization.id, 'free'));
    await expect((async () => (await store.acceptOrganizationInvitation(invite.token, 'second', 'second@example.com')))()).rejects.toThrow('Free allows 1 organization user');
    expect((await store.listOrganizationMemberships(organization.id))).toHaveLength(1);
  });

  it.each(['free', 'individual'] as const)(
    'makes a Team → %s downgrade non-destructive and recovers after extra members are removed',
    async (plan) => {
      const store = (await Store.create(':memory:', { hosted: true }));
      const organization = (await store.createOrganization({ name: `Downgrade ${plan}`, ownerUserId: 'owner' }));
      (await store.setOrganizationPlan(organization.id, 'team'));
      (await store.setOrganizationMembership(organization.id, 'second', 'member'));
      (await store.setOrganizationMembership(organization.id, 'third', 'member'));

      (await store.setOrganizationPlan(organization.id, plan));
      expect((await store.listOrganizationMemberships(organization.id))).toHaveLength(3);
      expect((await store.organizationEntitlements(organization.id))).toMatchObject({
        plan,
        currentMemberCount: 3,
        maxMembers: 1,
        overMemberLimit: true,
        memberAdmissionAllowed: false,
        agentRunAdmissionAllowed: false,
      });
      await expect((async () => (await store.setOrganizationMembership(organization.id, 'fourth', 'member')))()).rejects.toThrow(`Remove 2 members or restore Team`);

      (await store.removeOrganizationMembership(organization.id, 'second'));
      expect((await store.organizationEntitlements(organization.id))).toMatchObject({
        currentMemberCount: 2, overMemberLimit: true, agentRunAdmissionAllowed: false,
      });
      (await store.removeOrganizationMembership(organization.id, 'third'));
      expect((await store.organizationEntitlements(organization.id))).toMatchObject({
        currentMemberCount: 1,
        overMemberLimit: false,
        memberAdmissionAllowed: false,
        agentRunAdmissionAllowed: true,
      });
    },
  );

  it('requires hosted remote subscription turns to pass through admission', async () => {
    const hostedStore = (await Store.create(':memory:', { hosted: true }));
    const privateStore = (await Store.create(':memory:'));
    const activity = (store: Store) => makeCoreActivities({
      store, worlds: new WorldRegistry(), adapters: new Map(), profiles: new ProfileResolver(store, 'mock'),
    });
    const input = {
      role: 'do' as const,
      task: { projectId: 'project', title: 'Remote', prompt: 'run', project: {}, workflow: 'software-dev' } as any,
      worldHandle: { kind: 'e2b', id: 'world', root: '/workspace', branch: 'task', base: 'main' } as any,
      accountCredentialKind: 'login' as const,
    };
    await expect(activity(hostedStore).agentUsesHostCapacity(input)).resolves.toBe(true);
    await expect(activity(privateStore).agentUsesHostCapacity(input)).resolves.toBe(false);
  });
});

describe('hosted agent-run admission integration', () => {
  it.each([
    ['free', 5],
    ['individual', 10],
    ['team', 20],
  ] as const)('uses the central %s plan limit of %i at model admission without a second default', async (plan, limit) => {
    const store = (await Store.create(':memory:', { hosted: true }));
    const organization = (await store.createOrganization({ name: `Usage ${plan}`, ownerUserId: 'owner' }));
    (await store.setOrganizationPlan(organization.id, plan));
    const project = (await store.createProject('Product', {}, organization.id));
    expect((await store.getOrganizationUsagePolicy(organization.id))).toMatchObject({
      effectiveMaxActiveAgentTurns: limit,
      maxActiveWorlds: limit,
    });
    expect((await store.getOrganizationUsagePolicy(organization.id)).maxActiveAgentTurns).toBeUndefined();
    for (let index = 0; index < limit; index++) {
      const task = (await store.createTask({ projectId: project.id, title: `Run ${index}`, workflow: 'just-do',
        workflowVersion: '1.0.0', params: { prompt: 'run' } }));
      expect((await store.admitAgentUsage({ id: `turn-${index}`, organizationId: organization.id,
        projectId: project.id, taskId: task.id, provider: 'openai', fundingSource: 'byok' })))
        .toEqual({ reused: false });
    }
    const overflow = (await store.createTask({ projectId: project.id, title: 'Overflow', workflow: 'just-do',
      workflowVersion: '1.0.0', params: { prompt: 'run' } }));
    await expect((async () => (await store.admitAgentUsage({ id: 'overflow', organizationId: organization.id,
      projectId: project.id, taskId: overflow.id, provider: 'openai', fundingSource: 'byok' })))()).rejects.toThrow(/active model turn limit/);
  });

  it('allows only an optional owner cap tighter than the central plan entitlement', async () => {
    const store = (await Store.create(':memory:', { hosted: true }));
    const organization = (await store.createOrganization({ name: 'Tighter cap', ownerUserId: 'owner' }));
    (await store.setOrganizationPlan(organization.id, 'team'));
    expect((await store.setOrganizationUsagePolicy(organization.id, { maxActiveAgentTurns: 3 }))).toMatchObject({
      maxActiveAgentTurns: 3, effectiveMaxActiveAgentTurns: 3, maxActiveWorlds: 3,
    });
    expect((await store.setOrganizationUsagePolicy(organization.id, { maxActiveAgentTurns: 99 }))).toMatchObject({
      maxActiveAgentTurns: 20, effectiveMaxActiveAgentTurns: 20, maxActiveWorlds: 20,
    });
    const restored = (await store.setOrganizationUsagePolicy(organization.id, { maxActiveAgentTurns: undefined }));
    expect(restored.maxActiveAgentTurns).toBeUndefined();
    expect(restored.effectiveMaxActiveAgentTurns).toBe(20);
  });

  it('does not retain a second hosted remote-world limit outside the plan', async () => {
    const store = (await Store.create(':memory:', { hosted: true }));
    const organization = (await store.createOrganization({ name: 'One capacity', ownerUserId: 'owner' }));
    expect((await store.setOrganizationUsagePolicy(organization.id, { maxActiveWorlds: 999 })).maxActiveWorlds).toBe(5);
    expect(JSON.parse((await store.kvGet(`organization-usage-policy:${organization.id}`)) ?? '{}'))
      .not.toHaveProperty('maxActiveWorlds');
    (await store.setOrganizationPlan(organization.id, 'individual'));
    expect((await store.getOrganizationUsagePolicy(organization.id)).maxActiveWorlds).toBe(10);
    (await store.setOrganizationPlan(organization.id, 'team'));
    expect((await store.getOrganizationUsagePolicy(organization.id)).maxActiveWorlds).toBe(20);
  });

  it('blocks over-member organizations at the final model boundary before any provider spend', async () => {
    const store = (await Store.create(':memory:', { hosted: true }));
    const organization = (await store.createOrganization({ name: 'Usage downgrade', ownerUserId: 'owner' }));
    (await store.setOrganizationPlan(organization.id, 'team'));
    (await store.setOrganizationMembership(organization.id, 'second', 'member'));
    const project = (await store.createProject('Product', {}, organization.id));
    const task = (await store.createTask({ projectId: project.id, title: 'Blocked', workflow: 'just-do',
      workflowVersion: '1.0.0', params: { prompt: 'run' } }));
    (await store.setOrganizationPlan(organization.id, 'free'));
    await expect((async () => (await store.admitAgentUsage({ id: 'blocked-turn', organizationId: organization.id,
      projectId: project.id, taskId: task.id, provider: 'openai', fundingSource: 'byok' })))()).rejects.toThrow(/Remove 1 member or restore Team to start another agent run/);
    expect(Number(((await store.db.prepare('SELECT COUNT(*) n FROM usage_admissions').get()) as any).n)).toBe(0);
  });

  it('reclaims stale queue and trusted-admission turns without evicting live owners', async () => {
    const store = (await Store.create(':memory:', { hosted: true }));
    const organization = (await store.createOrganization({ name: 'Recovered capacity', ownerUserId: 'owner' }));
    const project = (await store.createProject('Product', {}, organization.id));
    const stale = (await store.createTask({ projectId: project.id, title: 'Interrupted', workflow: 'software-dev',
      workflowVersion: '1.20.0', params: { prompt: 'Run' } }));
    const live = (await store.createTask({ projectId: project.id, title: 'Live', workflow: 'software-dev',
      workflowVersion: '1.20.0', params: { prompt: 'Run' } }));
    const staleTurn = `${stale.id}#0`;
    const liveTurn = `${live.id}#0`;
    (await store.admitAgentUsage({ id: staleTurn, organizationId: organization.id,
      projectId: project.id, taskId: stale.id, provider: 'openai', fundingSource: 'byok' }));

    const signals: Array<{ name: string; value: unknown }> = [];
    const queueHandle = {
      signal: vi.fn(async (name: string, value: unknown) => { signals.push({ name, value }); }),
      query: vi.fn(async () => ({ capacity: 1,
        current: [{ taskId: stale.id, turnId: staleTurn, role: 'do' }],
        queue: [{ taskId: live.id, turnId: liveTurn, role: 'do' }] })),
    };
    const taskViews = new Map([
      [stale.id, { status: 'active' }],
      [live.id, { status: 'waiting', agentTurn: { turnId: liveTurn, state: 'waiting-slot' } }],
    ]);
    const client = { workflow: { getHandle: vi.fn((id: string) => id === `agent-queue:${organization.id}`
      ? queueHandle : { query: vi.fn(async () => taskViews.get(id)) }) } } as any;
    const reconciler = new EntitlementQueueReconciler({ store, client, intervalMs: 0 });

    await reconciler.reconcileOrganization(organization.id);

    expect(signals).toContainEqual({ name: 'setAgentCapacity', value: { capacity: 5 } });
    expect(signals).toContainEqual({ name: 'releaseAgentSlot',
      value: { taskId: stale.id, turnId: staleTurn } });
    expect(signals).not.toContainEqual(expect.objectContaining({ name: 'cancelAgentSlot' }));
    expect((await store.db.prepare('SELECT state FROM usage_admissions WHERE id=?').get(staleTurn)))
      .toEqual({ state: 'released' });
  });

  it('preserves queue and usage leases when task ownership cannot be queried', async () => {
    const store = (await Store.create(':memory:', { hosted: true }));
    const organization = (await store.createOrganization({ name: 'Conservative recovery', ownerUserId: 'owner' }));
    const project = (await store.createProject('Product', {}, organization.id));
    const task = (await store.createTask({ projectId: project.id, title: 'Temporarily unreachable', workflow: 'software-dev',
      workflowVersion: '1.20.0', params: { prompt: 'Run' } }));
    const turnId = `${task.id}#0`;
    (await store.admitAgentUsage({ id: turnId, organizationId: organization.id,
      projectId: project.id, taskId: task.id, provider: 'openai', fundingSource: 'byok' }));
    const signal = vi.fn(async () => undefined);
    const queueHandle = { signal, query: vi.fn(async () => ({ capacity: 1,
      current: [{ taskId: task.id, turnId, role: 'do' }], queue: [] })) };
    const client = { workflow: { getHandle: vi.fn((id: string) => id === `agent-queue:${organization.id}`
      ? queueHandle : { query: vi.fn(async () => { throw new Error('temporarily unavailable'); }) }) } } as any;

    await new EntitlementQueueReconciler({ store, client, intervalMs: 0 })
      .reconcileOrganization(organization.id);

    expect(signal).toHaveBeenCalledTimes(1);
    expect((await store.db.prepare('SELECT state FROM usage_admissions WHERE id=?').get(turnId)))
      .toEqual({ state: 'active' });
  });

  // WF-3: a plan-blocked turn waits for this reconciler to restore capacity;
  // one wedged task workflow must not hold up every organization after it.
  it('moves on to the next organization when a task view query hangs', async () => {
    const store = (await Store.create(':memory:', { hosted: true }));
    const wedged = (await store.createOrganization({ name: 'Wedged', ownerUserId: 'owner' }));
    const next = (await store.createOrganization({ name: 'Next', ownerUserId: 'owner' }));
    const project = (await store.createProject('Product', {}, wedged.id));
    const task = (await store.createTask({ projectId: project.id, title: 'Wedged', workflow: 'software-dev',
      workflowVersion: '1.20.0', params: { prompt: 'Run' } }));
    (await store.admitAgentUsage({ id: `${task.id}#0`, organizationId: wedged.id,
      projectId: project.id, taskId: task.id, provider: 'openai', fundingSource: 'byok' }));
    const signalled: string[] = [];
    const client = { workflow: { getHandle: vi.fn((id: string) => id.startsWith('agent-queue:')
      ? { signal: vi.fn(async () => { signalled.push(id); }),
          query: vi.fn(async () => ({ capacity: 1, current: [], queue: [] })) }
      : { query: vi.fn(() => new Promise(() => {})) }) } } as any;
    const reconciler = new EntitlementQueueReconciler({ store, client, intervalMs: 0, queryTimeoutMs: 50 });
    (await reconciler.start());
    await vi.waitFor(() => expect(signalled).toContain(`agent-queue:${next.id}`), { timeout: 2_000 });
    expect((await store.db.prepare('SELECT state FROM usage_admissions WHERE id=?').get(`${task.id}#0`)))
      .toEqual({ state: 'active' });
    await reconciler.stop();
    (await store.close());
  });

  it('preserves pre-durable usage admissions whose workflow view has no turn identity', async () => {
    const store = (await Store.create(':memory:', { hosted: true }));
    const organization = (await store.createOrganization({ name: 'Historical workflow', ownerUserId: 'owner' }));
    const project = (await store.createProject('Product', {}, organization.id));
    const task = (await store.createTask({ projectId: project.id, title: 'Legacy', workflow: 'software-dev',
      workflowVersion: '1.3.0', params: { prompt: 'Run' } }));
    const turnId = `agent:${task.id}:do:1`;
    (await store.admitAgentUsage({ id: turnId, organizationId: organization.id,
      projectId: project.id, taskId: task.id, provider: 'openai', fundingSource: 'byok' }));
    const queueHandle = { signal: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ capacity: 1, current: [], queue: [] })) };
    const client = { workflow: { getHandle: vi.fn((id: string) => id === `agent-queue:${organization.id}`
      ? queueHandle : { query: vi.fn(async () => ({ status: 'active' })) }) } } as any;

    await new EntitlementQueueReconciler({ store, client, intervalMs: 0 })
      .reconcileOrganization(organization.id);

    expect((await store.db.prepare('SELECT state FROM usage_admissions WHERE id=?').get(turnId)))
      .toEqual({ state: 'active' });
  });

  it('reconciles the durable queue directly from member and billing-plan mutations', async () => {
    const store = (await Store.create(':memory:', { hosted: true }));
    const organization = (await store.createOrganization({ name: 'Reconcile', ownerUserId: 'owner' }));
    (await store.setOrganizationPlan(organization.id, 'team'));
    (await store.setOrganizationMembership(organization.id, 'second', 'member'));
    (await store.setOrganizationMembership(organization.id, 'third', 'member'));
    (await store.setOrganizationPlan(organization.id, 'free'));
    const signal = vi.fn(async () => undefined);
    const getHandle = vi.fn(() => ({ signal }));
    const reconciler = new EntitlementQueueReconciler({
      store,
      client: { workflow: { getHandle } } as any,
      intervalMs: 0,
    });
    (await reconciler.start());
    await vi.waitFor(() => expect(signal).toHaveBeenCalledWith('setAgentCapacity', { capacity: 0 }));

    signal.mockClear();
    (await store.removeOrganizationMembership(organization.id, 'second'));
    await vi.waitFor(() => expect(signal).toHaveBeenCalledWith('setAgentCapacity', { capacity: 0 }));
    signal.mockClear();
    (await store.removeOrganizationMembership(organization.id, 'third'));
    await vi.waitFor(() => expect(signal).toHaveBeenCalledWith('setAgentCapacity', { capacity: 5 }));

    signal.mockClear();
    (await store.setOrganizationPlan(organization.id, 'team'));
    await vi.waitFor(() => expect(signal).toHaveBeenCalledWith('setAgentCapacity', { capacity: 20 }));
    expect(getHandle).toHaveBeenLastCalledWith(`agent-queue:${organization.id}`);
    await reconciler.stop();
  });

  it('does not finish stopping while an in-flight queue reconciliation still owns the Temporal client', async () => {
    const store = (await Store.create(':memory:', { hosted: true }));
    const organization = (await store.createOrganization({ name: 'Orderly shutdown', ownerUserId: 'owner' }));
    let releaseSignal!: () => void;
    const signalBlocked = new Promise<void>((resolve) => { releaseSignal = resolve; });
    const signal = vi.fn(() => signalBlocked);
    const reconciler = new EntitlementQueueReconciler({
      store,
      client: { workflow: { getHandle: vi.fn(() => ({
        signal,
        query: vi.fn(async () => ({ current: [], queue: [] })),
      })) } } as any,
      intervalMs: 0,
    });
    (await reconciler.start());
    await vi.waitFor(() => expect(signal).toHaveBeenCalled());

    let stopped = false;
    const stopping = Promise.resolve(reconciler.stop()).then(() => { stopped = true; });
    await Promise.resolve();
    const returnedBeforeRelease = stopped;
    releaseSignal();
    await stopping;
    (await store.close());

    expect(returnedBeforeRelease).toBe(false);
  });

  it('queues run admission at zero capacity while over the member limit and reopens after recovery', async () => {
    const store = (await Store.create(':memory:', { hosted: true }));
    const organization = (await store.createOrganization({ name: 'Over limit', ownerUserId: 'owner' }));
    (await store.setOrganizationPlan(organization.id, 'team'));
    (await store.setOrganizationMembership(organization.id, 'second', 'member'));
    (await store.setOrganizationMembership(organization.id, 'third', 'member'));
    const project = (await store.createProject('Product', {}, organization.id));
    const task = (await store.createTask({
      projectId: project.id, title: 'Blocked', workflow: 'software-dev', workflowVersion: '1.20.0', params: { prompt: 'Run' },
    }));
    (await store.setOrganizationPlan(organization.id, 'free'));
    const executeUpdate = vi.fn(async () => ({ granted: false, position: 1, capacity: 0 }));
    const signalWithStart = vi.fn(async () => undefined);
    const activities = makeCoordinatorActivities({ store, taskQueue: 'test', client: {
      workflow: { signalWithStart, getHandle: vi.fn(() => ({ executeUpdate, signal: vi.fn(async () => undefined) })) },
    } as any });

    // The turn waits in the zero-capacity queue for the grant signal the
    // entitlement reconciler releases on recovery, instead of polling (WF-3).
    const admission = await activities.requestAgentSlot({
      taskId: task.id, turnId: `${task.id}#0`, role: 'do', projectId: project.id,
    });
    expect(admission).toMatchObject({
      granted: false, capacity: 0, queueId: `agent-queue:${organization.id}`,
      detail: 'Free allows 1 organization user, but this organization has 3. Remove 2 members or restore Team to start another agent run.',
    });
    expect(admission.blocked).toBeUndefined();
    expect(executeUpdate).toHaveBeenCalledOnce();
    expect(signalWithStart).toHaveBeenLastCalledWith('agentQueue', expect.objectContaining({
      workflowId: `agent-queue:${organization.id}`,
      args: [{ capacity: 0 }],
      signalArgs: [{ capacity: 0 }],
    }));

    (await store.removeOrganizationMembership(organization.id, 'second'));
    (await store.removeOrganizationMembership(organization.id, 'third'));
    executeUpdate.mockResolvedValueOnce({ granted: true, position: 0, capacity: 5 });
    await expect(activities.requestAgentSlot({
      taskId: task.id, turnId: `${task.id}#0`, role: 'do', projectId: project.id,
    })).resolves.toMatchObject({
      granted: true, capacity: 5, queueId: `agent-queue:${organization.id}`,
    });
    expect(executeUpdate).toHaveBeenCalledTimes(2);
  });

  it('uses a durable organization queue and refreshes its capacity from plan changes', async () => {
    const store = (await Store.create(':memory:', { hosted: true }));
    const organization = (await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' }));
    (await store.setOrganizationPlan(organization.id, 'individual'));
    const project = (await store.createProject('Product', {}, organization.id));
    const task = (await store.createTask({
      projectId: project.id, title: 'Ship', workflow: 'software-dev', workflowVersion: '1.20.0', params: { prompt: 'Ship' },
    }));
    const executeUpdate = vi.fn(async () => ({ granted: false, position: 1, capacity: 10 }));
    const signal = vi.fn(async () => undefined);
    const getHandle = vi.fn(() => ({ executeUpdate, signal }));
    const signalWithStart = vi.fn(async () => undefined);
    const activities = makeCoordinatorActivities({
      store,
      taskQueue: 'test',
      client: { workflow: { signalWithStart, getHandle } } as any,
    });

    await expect(activities.requestAgentSlot({
      taskId: task.id, turnId: `${task.id}#0`, role: 'do', projectId: project.id,
    })).resolves.toMatchObject({
      granted: false, capacity: 10,
      detail: 'Waiting for Individual plan capacity (10 active agent runs)',
    });
    expect(signalWithStart).toHaveBeenLastCalledWith('agentQueue', expect.objectContaining({
      workflowId: `agent-queue:${organization.id}`,
      args: [{ capacity: 10 }],
      signal: 'setAgentCapacity',
      signalArgs: [{ capacity: 10 }],
    }));

    (await store.setOrganizationPlan(organization.id, 'team'));
    executeUpdate.mockResolvedValueOnce({ granted: true, position: 0, capacity: 20 });
    await expect(activities.requestAgentSlot({
      taskId: task.id, turnId: `${task.id}#1`, role: 'confirm', projectId: project.id,
    })).resolves.toMatchObject({ granted: true, capacity: 20 });
    expect(signalWithStart).toHaveBeenLastCalledWith('agentQueue', expect.objectContaining({
      workflowId: `agent-queue:${organization.id}`,
      args: [{ capacity: 20 }],
      signalArgs: [{ capacity: 20 }],
    }));

    await activities.releaseAgentSlot(task.id, `${task.id}#1`);
    expect(getHandle).toHaveBeenLastCalledWith(`agent-queue:${organization.id}`);
    expect(signal).toHaveBeenLastCalledWith('releaseAgentSlot', { taskId: task.id, turnId: `${task.id}#1` });
  });

  it('releases and cancels through the durable queue identity after task deletion', async () => {
    const store = (await Store.create(':memory:', { hosted: true }));
    const organization = (await store.createOrganization({ name: 'Cleanup', ownerUserId: 'owner' }));
    (await store.setOrganizationPlan(organization.id, 'individual'));
    const project = (await store.createProject('Cleanup project', {}, organization.id));
    const held = (await store.createTask({
      projectId: project.id, title: 'Held', workflow: 'software-dev', workflowVersion: '1.20.0', params: { prompt: 'Held' },
    }));
    const waiting = (await store.createTask({
      projectId: project.id, title: 'Waiting', workflow: 'software-dev', workflowVersion: '1.20.0', params: { prompt: 'Waiting' },
    }));
    const signal = vi.fn(async () => undefined);
    const executeUpdate = vi.fn()
      .mockResolvedValueOnce({ granted: true, position: 0, capacity: 10 })
      .mockResolvedValueOnce({ granted: false, position: 1, capacity: 10 });
    const getHandle = vi.fn(() => ({ executeUpdate, signal }));
    const activities = makeCoordinatorActivities({ store, taskQueue: 'test', client: {
      workflow: { signalWithStart: vi.fn(async () => undefined), getHandle },
    } as any });
    const heldAdmission = await activities.requestAgentSlot({
      taskId: held.id, turnId: `${held.id}#0`, role: 'do', projectId: project.id,
    });
    const waitingAdmission = await activities.requestAgentSlot({
      taskId: waiting.id, turnId: `${waiting.id}#0`, role: 'do', projectId: project.id,
    });

    (await store.deleteTask(held.id));
    (await store.deleteTask(waiting.id));
    await activities.releaseAgentSlot(held.id, `${held.id}#0`, heldAdmission.queueId);
    await activities.cancelAgentSlot(waiting.id, `${waiting.id}#0`, waitingAdmission.queueId);

    expect(getHandle).toHaveBeenNthCalledWith(3, `agent-queue:${organization.id}`);
    expect(getHandle).toHaveBeenNthCalledWith(4, `agent-queue:${organization.id}`);
    expect(signal).toHaveBeenCalledWith('releaseAgentSlot', { taskId: held.id, turnId: `${held.id}#0` });
    expect(signal).toHaveBeenCalledWith('cancelAgentSlot', { taskId: waiting.id, turnId: `${waiting.id}#0` });
  });

  it('keeps the configurable host queue for private installations', async () => {
    const store = (await Store.create(':memory:'));
    (await store.setSettings('global', 'agent-queue', { capacity: 7 }));
    const executeUpdate = vi.fn(async () => ({ granted: true, position: 0, capacity: 7 }));
    const signalWithStart = vi.fn(async () => undefined);
    const activities = makeCoordinatorActivities({ store, taskQueue: 'test', client: {
      workflow: { signalWithStart, getHandle: vi.fn(() => ({ executeUpdate })) },
    } as any });

    await activities.requestAgentSlot({ taskId: 'private-task', turnId: 'private-task#0', role: 'do' });
    expect(signalWithStart).toHaveBeenCalledWith('agentQueue', expect.objectContaining({
      workflowId: 'agent-queue', args: [{ capacity: 7 }],
    }));
  });
});
