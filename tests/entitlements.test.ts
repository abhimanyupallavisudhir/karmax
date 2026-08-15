import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  HOSTED_PLANS,
  hostedMonthlyPriceCents,
  organizationEntitlements,
} from '../src/domain/entitlements.js';
import { makeCoordinatorActivities } from '../src/activities/coordinator.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';

describe('hosted plan entitlements', () => {
  it('keeps launch pricing and limits in one billing-safe catalog', () => {
    expect(HOSTED_PLANS.free).toMatchObject({
      monthlyBasePriceCents: 0, maxMembers: 1, maxActiveAgentRuns: 1, unlimitedProjects: true,
    });
    expect(HOSTED_PLANS.individual).toMatchObject({
      monthlyBasePriceCents: 900, maxMembers: 1, maxActiveAgentRuns: 5, unlimitedProjects: true,
    });
    expect(HOSTED_PLANS.team).toMatchObject({
      monthlyBasePriceCents: 1_900, includedActiveUsers: 1,
      monthlyAdditionalActiveUserPriceCents: 500, maxMembers: null,
      maxActiveAgentRuns: 10, unlimitedProjects: true,
    });
    expect(hostedMonthlyPriceCents('team', 0)).toBe(1_900);
    expect(hostedMonthlyPriceCents('team', 1)).toBe(1_900);
    expect(hostedMonthlyPriceCents('team', 4)).toBe(3_400);
  });

  it('does not apply hosted monetization limits to private installations', () => {
    expect(organizationEntitlements('free', false)).toMatchObject({
      deployment: 'private', plan: null, maxMembers: null, maxActiveAgentRuns: null,
      unlimitedProjects: true,
    });
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Private', ownerUserId: 'owner' });
    for (let i = 0; i < 12; i++) store.setOrganizationMembership(organization.id, `user-${i}`, 'member');
    expect(store.listOrganizationMemberships(organization.id)).toHaveLength(13);
  });

  it('migrates existing organizations onto Free without losing their identity', () => {
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
    const migrated = new Store(file, { hosted: true });
    expect(migrated.getOrganization('org_existing')).toMatchObject({
      id: 'org_existing', name: 'Existing', plan: 'free', createdAt: 123,
    });
    migrated.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('enforces one-user plans at the persistence boundary and unlocks Team members', () => {
    const store = new Store(':memory:', { hosted: true });
    const organization = store.createOrganization({ name: 'Hosted', ownerUserId: 'owner' });

    expect(() => store.setOrganizationMembership(organization.id, 'second', 'member'))
      .toThrow('Free allows 1 organization user. Upgrade the plan');
    expect(() => store.createOrganizationInvitation({
      organizationId: organization.id, email: 'second@example.com', invitedBy: 'user:owner',
    })).toThrow('Free allows 1 organization user');

    expect(store.setOrganizationPlan(organization.id, 'individual').plan).toBe('individual');
    expect(() => store.setOrganizationMembership(organization.id, 'second', 'member'))
      .toThrow('Individual allows 1 organization user');

    expect(store.setOrganizationPlan(organization.id, 'team').plan).toBe('team');
    store.setOrganizationMembership(organization.id, 'second', 'member');
    store.setOrganizationMembership(organization.id, 'third', 'member');
    expect(store.listOrganizationMemberships(organization.id)).toHaveLength(3);
    expect(store.organizationEntitlements(organization.id).maxActiveAgentRuns).toBe(10);
  });

  it('re-checks the member limit when an already-issued invitation is accepted', () => {
    const store = new Store(':memory:', { hosted: true });
    const organization = store.createOrganization({ name: 'Invites', ownerUserId: 'owner' });
    store.setOrganizationPlan(organization.id, 'team');
    const invite = store.createOrganizationInvitation({
      organizationId: organization.id, email: 'second@example.com', invitedBy: 'user:owner',
    });
    store.setOrganizationPlan(organization.id, 'free');
    expect(() => store.acceptOrganizationInvitation(invite.token, 'second', 'second@example.com'))
      .toThrow('Free allows 1 organization user');
    expect(store.listOrganizationMemberships(organization.id)).toHaveLength(1);
  });

  it('requires hosted remote subscription turns to pass through admission', async () => {
    const hostedStore = new Store(':memory:', { hosted: true });
    const privateStore = new Store(':memory:');
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
  it('uses a durable organization queue and refreshes its capacity from plan changes', async () => {
    const store = new Store(':memory:', { hosted: true });
    const organization = store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    store.setOrganizationPlan(organization.id, 'individual');
    const project = store.createProject('Product', {}, organization.id);
    const task = store.createTask({
      projectId: project.id, title: 'Ship', workflow: 'software-dev', workflowVersion: '1.20.0', params: { prompt: 'Ship' },
    });
    const executeUpdate = vi.fn(async () => ({ granted: false, position: 1, capacity: 5 }));
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
      granted: false, capacity: 5,
      detail: 'Waiting for Individual plan capacity (5 active agent runs)',
    });
    expect(signalWithStart).toHaveBeenLastCalledWith('agentQueue', expect.objectContaining({
      workflowId: `agent-queue:${organization.id}`,
      args: [{ capacity: 5 }],
      signal: 'setAgentCapacity',
      signalArgs: [{ capacity: 5 }],
    }));

    store.setOrganizationPlan(organization.id, 'team');
    executeUpdate.mockResolvedValueOnce({ granted: true, position: 0, capacity: 10 });
    await expect(activities.requestAgentSlot({
      taskId: task.id, turnId: `${task.id}#1`, role: 'confirm', projectId: project.id,
    })).resolves.toMatchObject({ granted: true, capacity: 10 });
    expect(signalWithStart).toHaveBeenLastCalledWith('agentQueue', expect.objectContaining({
      workflowId: `agent-queue:${organization.id}`,
      args: [{ capacity: 10 }],
      signalArgs: [{ capacity: 10 }],
    }));

    await activities.releaseAgentSlot(task.id, `${task.id}#1`);
    expect(getHandle).toHaveBeenLastCalledWith(`agent-queue:${organization.id}`);
    expect(signal).toHaveBeenLastCalledWith('releaseAgentSlot', { taskId: task.id, turnId: `${task.id}#1` });
  });

  it('keeps the configurable host queue for private installations', async () => {
    const store = new Store(':memory:');
    store.setSettings('global', 'agent-queue', { capacity: 7 });
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
