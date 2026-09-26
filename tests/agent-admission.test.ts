import { describe, expect, it, vi } from 'vitest';
import { Context } from '@temporalio/activity';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';

describe('agent turn admission', () => {
  it.each(['failure', 'cancel', 'cancel-metered', 'timeout', 'post-turn'])('retains managed cost and retries safely after %s', async mode => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'fake-managed-key');
    vi.stubEnv('KARMAX_MANAGED_MODEL_REQUEST_CEILINGS', JSON.stringify({ 'anthropic/test-model': 100_000 }));
    vi.stubEnv('KARMAX_MANAGED_MODEL_PRICING', mode === 'cancel-metered' ? JSON.stringify({ 'anthropic/test-model': { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 1_000_000 } }) : '');
    const store = await Store.create(':memory:', { hosted: true });
    const org = await store.createOrganization({ name: 'Failure billing', ownerUserId: 'owner' });
    const project = await store.createProject('Failure billing', {}, org.id);
    const task = await store.createTask({ projectId: project.id, title: 'Work', workflow: 'just-do',
      workflowVersion: '1.0.0', params: { prompt: 'work' } as any });
    await store.setOrganizationUsagePolicy(org.id, { managedSpendCapMicros: 1_000_000, managedModelProviders: ['anthropic'] });
    const worlds = new WorldRegistry();
    const world = await worlds.create('memory', { taskId: task.id, base: 'main' });
    let attempt = 1;
    let abort = new AbortController();
    vi.spyOn(Context, 'current').mockImplementation(() => ({
      info: { attempt, activityId: 'turn', workflowExecution: { runId: 'run' } },
      cancellationSignal: abort.signal, heartbeat: () => {},
    }) as any);
    let costAtProviderStart = 0;
    const runTurn = vi.fn(async () => {
      costAtProviderStart = (await store.usageSummary(org.id)).estimatedCostMicros;
      if (mode === 'failure') throw new Error('provider disconnected');
      if (mode.startsWith('cancel') || mode === 'timeout') abort.abort(new Error(mode));
      return { termination: { kind: 'success', status: 'end_turn' }, output: 'durable output',
        ...(mode === 'cancel-metered' ? { usage: { inputTokens: 75, outputTokens: 25 } } : {}) };
    });
    const core = makeCoreActivities({ store, worlds,
      adapters: new Map([['claude', { provider: 'claude', runTurn }]]) as any,
      profiles: new ProfileResolver(store, 'claude') });
    const append = store.appendEvent.bind(store);
    vi.spyOn(store, 'appendEvent').mockImplementation(async event => {
      if (mode === 'post-turn' && event.type === 'turn.result' && attempt === 1) throw new Error('result publication failed');
      return append(event);
    });
    const args = { taskId: task.id, role: mode === 'post-turn' ? 'confirm' : 'do', agentTurnId: `${task.id}#0`,
      agentSlotGranted: true, agentAdmissionManaged: true, worldHandle: world.handle, messages: [],
      task: { taskId: task.id, projectId: project.id, title: task.title, prompt: 'work', project: {}, workflow: 'just-do',
        agents: { do: { provider: 'claude', model: 'test-model' }, confirm: { provider: 'claude', model: 'test-model' } } } } as any;
    try {
      if (mode === 'post-turn') await expect(core.runAgentTurn(args)).rejects.toMatchObject({ type: 'agent-infra', nonRetryable: false });
      else await expect(core.runAgentTurn(args)).rejects.toThrow();
      expect(costAtProviderStart).toBe(100_000);
      expect(await store.usageSummary(org.id)).toMatchObject({
        costMicros: mode === 'cancel-metered' ? 100 : 100_000,
        incurredCostMicros: mode === 'cancel-metered' ? 100 : 0, activeReservationsMicros: 0 });
      attempt = 2;
      abort = new AbortController();
      if (mode === 'post-turn') {
        await expect(core.runAgentTurn(args)).resolves.toMatchObject({ output: 'durable output' });
        expect(runTurn).toHaveBeenCalledTimes(1);
        expect(JSON.parse((await store.kvGet(`confirm-transcript:${task.id}`))!)).toHaveLength(1);
        expect(await store.usageSummary(org.id)).toMatchObject({ estimatedCostMicros: 100_000 });
      } else {
        await expect(core.runAgentTurn(args)).rejects.toThrow();
        expect(await store.usageSummary(org.id)).toMatchObject({ costMicros: mode === 'cancel-metered' ? 200 : 200_000, activeReservationsMicros: 0 });
      }
    } finally {
      vi.restoreAllMocks(); vi.unstubAllEnvs();
      await world.destroy(); await store.close();
    }
  });

  it('replaces a lost attempt without releasing its cost or rerunning a completed admission', async () => {
    const store = await Store.create(':memory:');
    const project = await store.createProject('Lost attempt');
    const task = await store.createTask({ projectId: project.id, title: 'Retry', workflow: 'just-do', workflowVersion: '1.0.0', params: {} as any });
    await store.setOrganizationUsagePolicy(project.organizationId!, { maxActiveAgentTurns: 1 });
    const admission = { id: 'turn', organizationId: project.organizationId!, projectId: project.id,
      taskId: task.id, provider: 'anthropic', fundingSource: 'customer' as const };
    try {
      await store.admitAgentUsage(admission);
      await store.finishUsageAdmission('turn', undefined, Date.now(), [{ id: 'usage:cost:turn',
        organizationId: project.organizationId!, projectId: project.id, taskId: task.id, provider: 'anthropic',
        kind: 'agent.cost', quantity: 0, unit: 'request', costMicros: 100, costClassification: 'estimated',
        startedAt: Date.now(), endedAt: Date.now() }]);
      await expect(store.admitAgentUsage({ ...admission, id: 'turn:attempt:2', retryOf: 'turn' } as any)).resolves.toEqual({ reused: false });
      expect(await store.usageSummary(project.organizationId!)).toMatchObject({ estimatedCostMicros: 100 });
      expect(await store.activeAgentUsageAdmissions(project.organizationId!)).toEqual([{ id: 'turn:attempt:2', taskId: task.id }]);
      await store.finishUsageAdmission('turn:attempt:2', true);
      await expect(store.admitAgentUsage({ ...admission, id: 'turn:attempt:3', retryOf: 'turn:attempt:2' } as any))
        .rejects.toThrow('already completed');
    } finally { await store.close(); }
  });

  it('classifies failures while preparing a turn before provider admission', async () => {
    const store = await Store.create(':memory:');
    const worlds = new WorldRegistry();
    const profiles = new ProfileResolver(store, 'mock');
    vi.spyOn(profiles, 'resolve').mockRejectedValue(new Error('invalid turn profile'));
    const core = makeCoreActivities({ store, worlds, adapters: new Map(), profiles });
    try {
      await expect(core.runAgentTurn({ taskId: 'task', role: 'do', messages: [],
        worldHandle: { kind: 'memory', id: 'task' },
        task: { projectId: 'project', title: 'Work', prompt: 'work', project: {} } } as any))
        .rejects.toMatchObject({ type: 'agent-error', nonRetryable: true });
    } finally { vi.restoreAllMocks(); await store.close(); }
  });

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
        branch: 'karmax/reconnect-task', base: 'main' },
      messages: [{ id: 'm0', role: 'user', text: 'continue', ts: 0 }],
      task: { projectId: 'project', title: 'Reconnect', prompt: 'continue', project: {},
        workflow: 'software-dev' },
    } as any).then(() => undefined, (caught) => caught);

    expect(error).toMatchObject({ type: 'agent-infra', nonRetryable: false });
    (await store.close());
  });
});
