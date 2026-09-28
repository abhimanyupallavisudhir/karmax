import { describe, expect, it, vi } from 'vitest';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';

describe('agent turn admission', () => {
  it('does not release another admission when a colliding turn is rejected', async () => {
    const store = (await Store.create(':memory:'));
    const project = (await store.createProject('Collision'));
    const task = (await store.createTask({ projectId: project.id, title: 'Collision', workflow: 'just-do',
      workflowVersion: '1.0.0', params: { prompt: 'work' } as any }));
    const worlds = new WorldRegistry();
    const world = await worlds.create('memory', { taskId: task.id, base: 'main' });
    const id = `${task.id}#0`;
    (await store.admitAgentUsage({ id, organizationId: project.organizationId!, projectId: project.id,
      taskId: task.id, provider: 'anthropic', model: 'original-model', fundingSource: 'customer' }));
    const core = makeCoreActivities({ store, worlds, adapters: new Map() as any,
      profiles: new ProfileResolver(store, 'claude') });
    try {
      await expect(core.runAgentTurn({ taskId: task.id, role: 'do', agentTurnId: id,
        agentSlotGranted: true, agentAdmissionManaged: true, worldHandle: world.handle,
        messages: [{ id: 'm0', role: 'user', text: 'work', ts: 0 }],
        task: { taskId: task.id, projectId: project.id, title: task.title, prompt: 'work', project: {},
          workflow: 'just-do', agents: { do: { provider: 'claude', model: 'replacement-model' } } },
      } as any)).rejects.toThrow('different attributed work');
      expect((await store.db.prepare('SELECT state FROM usage_admissions WHERE id=?').get(id)))
        .toMatchObject({ state: 'active' });
    } finally { await world.destroy(); (await store.close()); }
  });

  it('actualizes a managed reservation from configured provider token pricing', async () => {
    const previousCeilings = process.env.KARMAX_MANAGED_MODEL_REQUEST_CEILINGS;
    const previousPricing = process.env.KARMAX_MANAGED_MODEL_PRICING;
    const previousApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'installation-managed-test-key';
    process.env.KARMAX_MANAGED_MODEL_REQUEST_CEILINGS = JSON.stringify({ 'anthropic/test-model': 500_000 });
    process.env.KARMAX_MANAGED_MODEL_PRICING = JSON.stringify({ 'anthropic/test-model': {
      inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000,
      cacheReadMicrosPerMillionTokens: 500_000,
    } });
    const store = (await Store.create(':memory:', { hosted: true }));
    const organization = (await store.createOrganization({ name: 'Managed usage', ownerUserId: 'owner' }));
    const project = (await store.createProject('Usage', {}, organization.id));
    const task = (await store.createTask({ projectId: project.id, title: 'Use managed model', workflow: 'just-do',
      workflowVersion: '1.0.0', params: { prompt: 'work' } as any }));
    (await store.setOrganizationUsagePolicy(organization.id, { managedSpendCapMicros: 1_000_000,
      managedModelProviders: ['anthropic'] }));
    const worlds = new WorldRegistry();
    const world = await worlds.create('memory', { taskId: task.id, base: 'main' });
    const adapters = new Map([['claude', { provider: 'claude', async runTurn() {
      return { termination: { kind: 'success', status: 'end_turn' }, output: 'done',
        usage: { inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 200,
          inputTokensIncludeCacheRead: false, totalTokens: 1_700 } };
    } }]]) as any;
    const core = makeCoreActivities({ store, worlds, adapters, profiles: new ProfileResolver(store, 'claude') });
    try {
      await core.runAgentTurn({ taskId: task.id, role: 'do', agentTurnId: `${task.id}#0`,
        agentSlotGranted: true, agentAdmissionManaged: true, worldHandle: world.handle,
        messages: [{ id: 'm0', role: 'user', text: 'work', ts: 0 }],
        task: { taskId: task.id, projectId: project.id, title: task.title, prompt: 'work', project: {}, workflow: 'just-do',
          agents: { do: { provider: 'claude', model: 'test-model' } } },
      } as any);
      expect((await store.usageSummary(organization.id))).toMatchObject({ costMicros: 2_100,
        incurredCostMicros: 2_100, estimatedCostMicros: 0, activeReservationsMicros: 0,
        byFundingSource: { managed: 2_100 }, requests: { managed: 1 }, active: { agentTurns: 0 } });
      expect((await store.db.prepare("SELECT costMicros, costClassification FROM usage_events WHERE kind='agent.request'").get()))
        .toMatchObject({ costMicros: 0, costClassification: 'none' });
      const cost = (await store.db.prepare("SELECT costMicros, costClassification, metadata FROM usage_events WHERE kind='agent.cost'").get()) as any;
      expect(cost).toMatchObject({ costMicros: 2_100, costClassification: 'incurred' });
      expect(JSON.parse(cost.metadata)).toMatchObject({ costBasis: 'configured-provider-token-pricing' });
    } finally {
      await world.destroy();
      if (previousCeilings === undefined) delete process.env.KARMAX_MANAGED_MODEL_REQUEST_CEILINGS;
      else process.env.KARMAX_MANAGED_MODEL_REQUEST_CEILINGS = previousCeilings;
      if (previousPricing === undefined) delete process.env.KARMAX_MANAGED_MODEL_PRICING;
      else process.env.KARMAX_MANAGED_MODEL_PRICING = previousPricing;
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousApiKey;
    }
  });

  it('labels an unpriceable successful managed request as an estimate, never incurred provider cost', async () => {
    const previousCeilings = process.env.KARMAX_MANAGED_MODEL_REQUEST_CEILINGS;
    const previousPricing = process.env.KARMAX_MANAGED_MODEL_PRICING;
    const previousApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'installation-managed-test-key';
    process.env.KARMAX_MANAGED_MODEL_REQUEST_CEILINGS = JSON.stringify({ 'anthropic/unpriced': 400_000 });
    delete process.env.KARMAX_MANAGED_MODEL_PRICING;
    const store = (await Store.create(':memory:', { hosted: true }));
    const organization = (await store.createOrganization({ name: 'Estimated usage', ownerUserId: 'owner' }));
    const project = (await store.createProject('Usage', {}, organization.id));
    const task = (await store.createTask({ projectId: project.id, title: 'Estimate', workflow: 'just-do',
      workflowVersion: '1.0.0', params: { prompt: 'work' } as any }));
    (await store.setOrganizationUsagePolicy(organization.id, { managedSpendCapMicros: 400_000,
      managedModelProviders: ['anthropic'] }));
    const worlds = new WorldRegistry();
    const world = await worlds.create('memory', { taskId: task.id, base: 'main' });
    const adapters = new Map([['claude', { provider: 'claude', async runTurn() {
      return { termination: { kind: 'success', status: 'end_turn' }, output: 'done' };
    } }]]) as any;
    const core = makeCoreActivities({ store, worlds, adapters, profiles: new ProfileResolver(store, 'claude') });
    try {
      await core.runAgentTurn({ taskId: task.id, role: 'do', agentTurnId: `${task.id}#0`,
        agentSlotGranted: true, agentAdmissionManaged: true, worldHandle: world.handle,
        messages: [{ id: 'm0', role: 'user', text: 'work', ts: 0 }],
        task: { taskId: task.id, projectId: project.id, title: task.title, prompt: 'work', project: {}, workflow: 'just-do',
          agents: { do: { provider: 'claude', model: 'unpriced' } } },
      } as any);
      expect((await store.usageSummary(organization.id))).toMatchObject({ costMicros: 400_000,
        incurredCostMicros: 0, estimatedCostMicros: 400_000, activeReservationsMicros: 0 });
      expect((await store.db.prepare("SELECT costClassification FROM usage_events WHERE kind='agent.cost'").get()))
        .toMatchObject({ costClassification: 'estimated' });
    } finally {
      await world.destroy();
      if (previousCeilings === undefined) delete process.env.KARMAX_MANAGED_MODEL_REQUEST_CEILINGS;
      else process.env.KARMAX_MANAGED_MODEL_REQUEST_CEILINGS = previousCeilings;
      if (previousPricing === undefined) delete process.env.KARMAX_MANAGED_MODEL_PRICING;
      else process.env.KARMAX_MANAGED_MODEL_PRICING = previousPricing;
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousApiKey;
    }
  });

  it('attributes provider-reported model usage at the trusted turn boundary', async () => {
    const store = (await Store.create(':memory:'));
    const project = (await store.createProject('Usage', {}));
    const task = (await store.createTask({ projectId: project.id, title: 'Use model', workflow: 'just-do',
      workflowVersion: '1.0.0', params: { prompt: 'work' } as any }));
    const worlds = new WorldRegistry();
    const world = await worlds.create('memory', { taskId: task.id, base: 'main' });
    const adapters = new Map([['claude', { provider: 'claude', async runTurn() {
      return { termination: { kind: 'success', status: 'end_turn' }, output: 'done',
        usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 3 } };
    } }]]) as any;
    const core = makeCoreActivities({ store, worlds, adapters, profiles: new ProfileResolver(store, 'claude') });

    await core.runAgentTurn({ taskId: task.id, role: 'do', agentTurnId: `${task.id}#0`,
      agentSlotGranted: true, agentAdmissionManaged: true, worldHandle: world.handle,
      messages: [{ id: 'm0', role: 'user', text: 'work', ts: 0 }],
      task: { taskId: task.id, projectId: project.id, title: task.title, prompt: 'work', project: {}, workflow: 'just-do',
        agents: { do: { provider: 'claude' } } },
    } as any);

    expect((await store.usageSummary('org_personal'))).toMatchObject({
      events: 2, quantities: { request: 1, token: 25 }, byFundingSource: { customer: 0 },
      byProvider: { anthropic: 0 }, requests: { total: 1, customer: 1 }, active: { agentTurns: 0 },
    });
    const event = (await store.db.prepare("SELECT projectId, taskId, worldId, fundingSource, metadata FROM usage_events WHERE kind='agent.tokens'").get()) as any;
    expect(event).toMatchObject({ projectId: project.id, taskId: task.id, worldId: task.id, fundingSource: 'customer' });
    expect(JSON.parse(event.metadata)).toMatchObject({ inputTokens: 20, outputTokens: 5, cacheReadTokens: 3 });
    await world.destroy();
  });

  it('uses a blocking update and classifies coordinator failures as retryable infrastructure', async () => {
    const store = (await Store.create(':memory:'));
    const worlds = new WorldRegistry();
    const world = await worlds.create('memory', { taskId: 'admission-task', base: 'main' });
    const coordinator = {
      signal: vi.fn(async () => undefined),
      executeUpdate: vi.fn(async () => {
        throw new Error('Failed to query Workflow → 8 RESOURCE_EXHAUSTED: consistent query buffer is full');
      }),
      query: vi.fn(),
    };
    const client = {
      workflow: {
        signalWithStart: vi.fn(async () => undefined),
        getHandle: vi.fn(() => coordinator),
      },
    } as any;
    const core = makeCoreActivities({
      store,
      worlds,
      adapters: new Map(),
      profiles: new ProfileResolver(store, 'mock'),
      client,
      taskQueue: 'test',
    });

    const error = await core.runAgentTurn({
      taskId: 'admission-task',
      role: 'do',
      agentTurnId: 'admission-task#0',
      worldHandle: world.handle,
      messages: [{ id: 'm0', role: 'user', text: 'publish', ts: 0 }],
      task: {
        projectId: 'project',
        title: 'Admission',
        prompt: 'publish',
        project: {},
        workflow: 'software-dev',
      },
    } as any).then(() => undefined, (caught) => caught);

    expect(coordinator.executeUpdate).toHaveBeenCalledWith('waitAgentSlot', {
      args: [{
        taskId: 'admission-task',
        turnId: 'admission-task#0',
        role: 'do',
        provider: 'mock',
        title: 'Admission',
        projectId: 'project',
      }],
    });
    expect(coordinator.query).not.toHaveBeenCalled();
    expect(error).toMatchObject({
      type: 'agent-infra',
      nonRetryable: false,
    });
    expect(error.message).toContain('agent-slot admission failed');
    await world.destroy();
  });

  it('classifies a remote sandbox reconnect timeout as retryable infrastructure', async () => {
    const store = (await Store.create(':memory:'));
    const worlds = new WorldRegistry();
    worlds.register({
      kind: 'fake-remote', capabilities: { remote: true },
      async create() { throw new Error('unused'); },
      async open() {
        throw Object.assign(new Error('E2B reconnect failed'), { code: 'ETIMEDOUT' });
      },
      async destroy() {},
    } as any);
    const core = makeCoreActivities({
      store, worlds, adapters: new Map(), profiles: new ProfileResolver(store, 'mock'),
    });

    const error = await core.runAgentTurn({
      taskId: 'reconnect-task', role: 'do',
      worldHandle: { kind: 'fake-remote', id: 'reconnect-task', root: '/workspace',
        branch: 'tavya/reconnect-task', base: 'main' },
      messages: [{ id: 'm0', role: 'user', text: 'continue', ts: 0 }],
      task: { projectId: 'project', title: 'Reconnect', prompt: 'continue', project: {},
        workflow: 'software-dev' },
    } as any).then(() => undefined, (caught) => caught);

    expect(error).toMatchObject({ type: 'agent-infra', nonRetryable: false });
    (await store.close());
  });
});
