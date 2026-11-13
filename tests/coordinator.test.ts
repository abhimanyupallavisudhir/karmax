import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { assemblePrompt } from '../src/agent/prompt.js';
import type { AgentProfile, TaskInput } from '../src/domain/types.js';
import { coordinatorSetting, normalizeCoordinatorSetting, coordinatorCheckIn, coordinatorRetryMinutes, wakeIntervalText,
  DEFAULT_COORDINATOR_WAKE_HOURS } from '../src/domain/coordinator.js';
import { storeBackends } from './helpers/store-backends.js';

/**
 * A permanent co-ordinator (wiki features/coordinator): a task that runs its
 * project like an autonomous firm's CEO, never finishes, is woken again within
 * its interval whenever it stops, and whose failure is a critical ask. The
 * workflow half is in tests/pipeline-coordinator.test.ts.
 */
describe('the co-ordinator setting', () => {
  it('takes true or { wakeHours } in hours, decimals included, 24 by default', () => {
    expect(normalizeCoordinatorSetting(true)).toEqual({ wakeHours: 24 });
    expect(normalizeCoordinatorSetting({})).toEqual({ wakeHours: DEFAULT_COORDINATOR_WAKE_HOURS });
    expect(normalizeCoordinatorSetting({ wakeHours: 1.5 })).toEqual({ wakeHours: 1.5 });
    expect(normalizeCoordinatorSetting({ wakeHours: '0.25' })).toEqual({ wakeHours: 0.25 });
    expect(normalizeCoordinatorSetting(undefined)).toBeNull();
    expect(normalizeCoordinatorSetting(false)).toBeNull();
  });

  it('refuses an interval that is not a number of hours from a minute to a year', () => {
    for (const wakeHours of [0, -1, 0.001, 9000, 'soon', Number.NaN, Infinity])
      expect(() => normalizeCoordinatorSetting({ wakeHours })).toThrow(/wakeHours/);
    expect(() => normalizeCoordinatorSetting('yes')).toThrow(/coordinator must be/);
  });

  it('reads stored params leniently: a bad stored interval falls back to the default', () => {
    expect(coordinatorSetting({ coordinator: { wakeHours: 6 } })).toEqual({ wakeHours: 6 });
    expect(coordinatorSetting({ coordinator: { wakeHours: 'x' } })).toEqual({ wakeHours: 24 });
    expect(coordinatorSetting({})).toBeUndefined();
    expect(coordinatorSetting(undefined)).toBeUndefined();
  });

  it('says its interval in words', () => {
    expect(wakeIntervalText(24)).toBe('24 hours');
    expect(wakeIntervalText(1)).toBe('1 hour');
    expect(wakeIntervalText(0.5)).toBe('30 minutes');
    expect(coordinatorCheckIn({ wakeHours: 2.5 })).toContain('it has been 2.5 hours since you stopped');
  });
});

describe('the co-ordinator retry backoff', () => {
  it('starts at 15 minutes and doubles with each failure in a row, up to a week', () => {
    expect([1, 2, 3, 4, 5].map(coordinatorRetryMinutes)).toEqual([15, 30, 60, 120, 240]);
    expect(coordinatorRetryMinutes(0)).toBe(15);
    expect(coordinatorRetryMinutes(11)).toBe(7 * 24 * 60);
    expect(coordinatorRetryMinutes(2_000)).toBe(7 * 24 * 60);
  });
});

describe('the co-ordinator brief', () => {
  const profile: AgentProfile = { id: 'profile_do', role: 'do', name: 'Do', provider: 'mock' };
  const world = { id: 'world', kind: 'memory' as const, root: '/world', workdir: '/world', branch: 'task', base: 'main', target: 'main' };
  const task = (extra: Partial<TaskInput>): TaskInput => ({
    taskId: 'task', projectId: 'project', title: 'Run the firm', prompt: 'Grow the product', project: {}, ...extra });

  it('tells its Do agent it runs the project like a CEO, rests, and is woken within its interval', () => {
    const prompt = assemblePrompt({ profile, role: 'do', task: task({ coordinator: { wakeHours: 6 } }), world });
    expect(prompt).toContain('# Your role: permanent co-ordinator');
    expect(prompt).toContain('CEO');
    expect(prompt).toContain('create_task');
    expect(prompt).toContain('wakes you again within 6 hours to check in');
    expect(prompt).toContain('This task never finishes');
    expect(prompt).toContain('open_pr() one for every branch with new work; neither ends this task.');
  });

  it('tells it to run forever, so never to ship a change that only works once its own work is merged, deployed or restarted', () => {
    const prompt = assemblePrompt({ profile, role: 'do', task: task({ coordinator: { wakeHours: 6 } }), world });
    expect(prompt).toContain('Your purpose is to run for as long as the project exists, without stopping');
    expect(prompt).toContain('So don\'t make changes yourself.');
    expect(prompt).toContain('merged, deployed or this task restarted');
    expect(prompt).toContain('put every such change in a task you create, and steer it from here');
  });

  it('is told to no other task, and to none of its other agents', () => {
    expect(assemblePrompt({ profile, role: 'do', task: task({}), world })).not.toContain('permanent co-ordinator');
    expect(assemblePrompt({ profile: { ...profile, role: 'responder' }, role: 'responder', task: task({ coordinator: { wakeHours: 6 } }), world }))
      .not.toContain('# Your role: permanent co-ordinator');
  });
});

const PUBLISHED = { lifecycleEvent: false };

describe.each(storeBackends)('a co-ordinator failing ($name)', ({ open }) => {
  async function fixture(params: Record<string, unknown>) {
    const store = (await open());
    const organization = (await store.createOrganization({ name: 'Firm', ownerUserId: 'owner' }));
    const project = (await store.createProject('Firm', {}, organization.id));
    const task = (await store.createTask({ projectId: project.id, title: 'Run the firm', workflow: 'software-dev',
      workflowVersion: '1.30.0', params: { prompt: 'run it', ...params }, createdBy: { kind: 'user', userId: 'owner' } }));
    const publish = async (patch: Record<string, unknown>) => {
      const next = { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'do', status: 'active',
        messages: [], actions: [], state: {}, updatedAt: Date.now(), ...patch } as any;
      (await store.saveView(task.id, next, undefined, undefined, undefined, PUBLISHED));
      (await store.appendEvent({ taskId: task.id, type: 'view.updated', ts: Date.now(), payload: {
        stage: next.stage, status: next.status, waitingFor: next.waitingFor?.kind ?? null } }));
    };
    const inbox = async () => (await store.listInbox('owner', organization.id));
    return { store, task, publish, inbox };
  }

  it('asks its creator at critical urgency when its run fails', async () => {
    const f = (await fixture({ coordinator: { wakeHours: 24 } }));
    (await f.publish({ stage: 'failed', status: 'failed', error: 'workflow failed: boom' }));
    const items = (await f.inbox());
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ taskId: f.task.id, kind: 'escalated', urgency: 'critical', actionable: true });
  });

  it('asks at critical urgency when it is stuck on a stage it could not get past', async () => {
    const f = (await fixture({ coordinator: { wakeHours: 24 } }));
    (await f.publish({ stage: 'do', status: 'blocked', waitingFor: { kind: 'human', reason: 'error', audience: ['@creator'] } }));
    expect((await f.inbox())[0]).toMatchObject({ kind: 'escalated', urgency: 'critical' });
  });

  it('leaves an ordinary task\'s failure as quiet news', async () => {
    const f = (await fixture({}));
    (await f.publish({ stage: 'failed', status: 'failed' }));
    expect((await f.inbox()).filter((item) => item.actionable)).toEqual([]);
  });

  it('lists failed co-ordinators with when they failed and their failures in a row, for the revival sweep', async () => {
    const f = (await fixture({ coordinator: { wakeHours: 2 } }));
    expect((await f.store.failedCoordinators())).toEqual([]);
    const before = Date.now();
    (await f.publish({ stage: 'failed', status: 'failed', state: { coordinatorFailures: 3 } }));
    const failed = (await f.store.failedCoordinators());
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ id: f.task.id, failures: 3 });
    expect(failed[0]!.failedAt).toBeGreaterThanOrEqual(before);
  });
});

describe('making a permanent co-ordinator', () => {
  async function fixture(config: Record<string, unknown> = {}) {
    const { Store } = await import('../src/store/db.js');
    const { AuthorizationService, projectScope } = await import('../src/platform/authorization.js');
    const { KarmaxApi } = await import('../src/platform/api.js');
    const { TokenAuthority } = await import('../src/platform/tokens.js');
    const store = await Store.create(':memory:');
    await store.claimPersonalOrganization('owner');
    const project = await store.createProject('Firm', config as any);
    const authorization = await AuthorizationService.create(store);
    await authorization.grant('system:test', { principalId: 'user:owner', scopeKey: projectScope(project.id), profileId: 'maintainer' });
    const tokens = new TokenAuthority(store);
    const owner = (await tokens.mintPrincipal('user:owner', await authorization.capabilities('user:owner', project.id, 'org_personal'),
      project.id, undefined, 'org_personal')).token;
    const started: any[] = [];
    const updates: any[] = [];
    const client = { workflow: {
      getHandle: () => ({ query: async () => [], signal: async () => undefined,
        executeUpdate: async (_name: string, opts: { args: unknown[] }) => { updates.push(opts.args[0]); return { applied: Object.keys(opts.args[0] as object) }; } }),
      start: async (_type: string, opts: { args: unknown[] }) => { started.push(opts.args[0]); return { firstExecutionRunId: `run-${started.length}` }; },
    } } as any;
    const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, authorization });
    return { store, project, api, owner, started, updates };
  }

  it('starts its run knowing it is one, its work always landing branch by branch', async () => {
    const f = await fixture({ multiPr: false });
    const task = await f.api.createTask(f.owner, { projectId: f.project.id, prompt: 'Run the firm',
      params: { coordinator: { wakeHours: '1.5' }, multiPr: false } });
    expect(task.params.coordinator).toEqual({ wakeHours: 1.5 });
    // Its params say what it does, whatever was sent.
    expect(task.params.multiPr).toBe(true);
    expect(f.started).toHaveLength(1);
    expect(f.started[0].coordinator).toEqual({ wakeHours: 1.5 });
    expect(f.started[0].project.multiPr).toBe(true);
    // An ordinary task is none of that.
    await f.api.createTask(f.owner, { projectId: f.project.id, prompt: 'Fix a bug', params: { multiPr: false } });
    expect(f.started[1].coordinator).toBeUndefined();
    expect(f.started[1].project.multiPr).toBeFalsy();
  });

  it('refuses an interval out of range, a repeatable co-ordinator and another workflow', async () => {
    const f = await fixture();
    await expect(f.api.createTask(f.owner, { projectId: f.project.id, prompt: 'Run', draft: true,
      params: { coordinator: { wakeHours: 0 } } })).rejects.toThrow(/wakeHours/);
    await expect(f.api.createTask(f.owner, { projectId: f.project.id, prompt: 'Run', draft: true,
      params: { coordinator: { wakeHours: 24 }, repeatable: true } })).rejects.toThrow(/repeatable/);
    await expect(f.api.createTask(f.owner, { projectId: f.project.id, prompt: 'Run', draft: true, workflow: 'merge-only',
      params: { coordinator: { wakeHours: 24 } } })).rejects.toThrow(/Software dev/);
    // Unticked, the setting is simply absent.
    const plain = await f.api.createTask(f.owner, { projectId: f.project.id, prompt: 'Run', draft: true, params: { coordinator: false } });
    expect(plain.params.coordinator).toBeUndefined();
  });

  async function failedCoordinator(f: Awaited<ReturnType<typeof fixture>>, failures: number) {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const task = await f.api.createTask(f.owner, { projectId: f.project.id, prompt: 'Run the firm', draft: true,
      params: { coordinator: { wakeHours: 2 } } });
    const worldPath = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-world-'));
    await f.store.saveView(task.id, { taskId: task.id, title: task.title, workflow: 'software-dev', stage: 'failed', status: 'failed',
      error: 'workflow failed: boom', worldPath, branch: `tavya/${task.id}`, base: 'main', messages: [], actions: [],
      state: { failedFrom: 'do', coordinatorFailures: failures }, updatedAt: 7 } as any);
    return { task, worldPath, failedAt: Date.now() };
  }

  it('restarts a co-ordinator whose run failed after its backoff, and only then', async () => {
    const f = await fixture();
    const { task, worldPath, failedAt } = await failedCoordinator(f, 1);
    expect(await f.api.reviveFailedCoordinators(failedAt + 14 * 60_000)).toEqual([]);
    expect(f.started).toHaveLength(0);
    expect(await f.api.reviveFailedCoordinators(failedAt + 15 * 60_000 + 1_000)).toEqual([task.id]);
    expect(f.started).toHaveLength(1);
    expect(f.started[0].coordinator).toEqual({ wakeHours: 2, failures: 1 });
    expect(f.started[0].recovery.world.root).toBe(worldPath);
    expect((await f.store.eventsOfType(task.id, 'coordinator.revived'))).toHaveLength(1);
  });

  it('waits longer the more times in a row it has failed', async () => {
    const f = await fixture();
    const { task, failedAt } = await failedCoordinator(f, 3);
    expect(await f.api.reviveFailedCoordinators(failedAt + 59 * 60_000)).toEqual([]);
    expect(await f.api.reviveFailedCoordinators(failedAt + 60 * 60_000 + 1_000)).toEqual([task.id]);
    expect(f.started[0].coordinator.failures).toBe(3);
  });

  it('backs off when it cannot even be restarted', async () => {
    const fs = await import('node:fs');
    const f = await fixture();
    const { task, worldPath, failedAt } = await failedCoordinator(f, 1);
    fs.rmSync(worldPath, { recursive: true });
    expect(await f.api.reviveFailedCoordinators(failedAt + 16 * 60_000)).toEqual([]);
    expect((await f.store.eventsOfType(task.id, 'coordinator.revival-failed'))).toHaveLength(1);
    // Its failure count stands at 1 and one attempt failed: 30 minutes from that attempt.
    await f.api.reviveFailedCoordinators(failedAt + 40 * 60_000);
    expect((await f.store.eventsOfType(task.id, 'coordinator.revival-failed'))).toHaveLength(1);
    await f.api.reviveFailedCoordinators(failedAt + 47 * 60_000);
    expect((await f.store.eventsOfType(task.id, 'coordinator.revival-failed'))).toHaveLength(2);
  });

  it('changes a running co-ordinator\'s interval through its workflow and its params', async () => {
    const f = await fixture();
    const task = await f.api.createTask(f.owner, { projectId: f.project.id, prompt: 'Run the firm', params: { coordinator: { wakeHours: 24 } } });
    const result = await f.api.updateParams(f.owner, task.id, { coordinator: { wakeHours: '0.5' } });
    expect(result.applied).toContain('coordinator');
    expect(f.updates).toEqual([{ coordinator: { wakeHours: 0.5 } }]);
    expect((await f.store.getTask(task.id))!.params.coordinator).toEqual({ wakeHours: 0.5 });
  });

  it('refuses a bad interval, stopping being one, and an ordinary task', async () => {
    const f = await fixture();
    const task = await f.api.createTask(f.owner, { projectId: f.project.id, prompt: 'Run the firm', params: { coordinator: { wakeHours: 24 } } });
    await expect(f.api.updateParams(f.owner, task.id, { coordinator: { wakeHours: 0 } })).rejects.toThrow(/wakeHours/);
    await expect(f.api.updateParams(f.owner, task.id, { coordinator: false })).rejects.toThrow(/stays one/);
    const plain = await f.api.createTask(f.owner, { projectId: f.project.id, prompt: 'Fix a bug' });
    await expect(f.api.updateParams(f.owner, plain.id, { coordinator: { wakeHours: 2 } })).rejects.toThrow(/queued as a permanent co-ordinator/);
    expect(f.updates).toEqual([]);
    expect((await f.store.getTask(task.id))!.params.coordinator).toEqual({ wakeHours: 24 });
  });

  it('changes a failed co-ordinator\'s interval without its finished workflow', async () => {
    const f = await fixture();
    const { task } = await failedCoordinator(f, 1);
    await f.api.updateParams(f.owner, task.id, { coordinator: { wakeHours: 6 } });
    expect(f.updates).toEqual([]);
    expect((await f.store.getTask(task.id))!.params.coordinator).toEqual({ wakeHours: 6 });
  });
});
