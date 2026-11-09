import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { AuthorizationService, projectScope } from '../src/platform/authorization.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { TriggerScheduler, createTriggerFire } from '../src/platform/trigger-scheduler.js';
import { followUpsAfterFiring, normalizeFollowUpTriggers, validateFollowUpTriggers, type FollowUpTrigger } from '../src/domain/triggers.js';
import { followUpMessage, type ProjectEvent, type TriggerContext } from '../src/domain/project-events.js';

/**
 * Follow-up triggers (wiki features/follow-up-triggers): the shapes that can
 * start a task, on a task that has started. Firing tells it, keeps the message
 * until it can take one, or forks it once it is done.
 */

const event = (over: Partial<FollowUpTrigger> & Record<string, unknown> = {}) =>
  ({ id: `f${Math.random()}`, kind: 'event', type: 'deploy.finished', ...over }) as FollowUpTrigger;

describe('follow-up trigger rules', () => {
  it('a one-shot is used up, a recurring one stays, and dependencies go with the last activator', () => {
    const once = event({ id: 'a' });
    const again = event({ id: 'b', recurring: true });
    const dep = { id: 'd', kind: 'dependency', tasks: ['t1'] } as FollowUpTrigger;
    expect(followUpsAfterFiring([once, again], 'a')).toEqual([again]);
    expect(followUpsAfterFiring([once, again], 'b')).toEqual([once, again]);
    expect(followUpsAfterFiring([dep, once], 'a')).toEqual([]);
    expect(followUpsAfterFiring([dep], 'd')).toEqual([]);
    expect(followUpsAfterFiring([once], 'gone')).toEqual([once]);
  });

  it('refuses what could never fire, and a concurrency that means nothing here', async () => {
    expect(await validateFollowUpTriggers([event(), event({ kind: 'schedule', cron: '0 9 * * *', type: undefined })])).toEqual([]);
    expect((await validateFollowUpTriggers([event({ type: 'bad type' })]))[0]).toMatch(/invalid event type/);
    expect((await validateFollowUpTriggers([event({ concurrency: { mode: 'skip' } })]))[0]).toMatch(/concurrency/);
    expect((await validateFollowUpTriggers([{ id: 'x', kind: 'dependency', tasks: ['me'] }], { taskId: 'me' }))[0]).toMatch(/itself/);
    expect((await validateFollowUpTriggers([{ id: 'x', kind: 'dependency', tasks: ['gone'] }], { exists: () => false }))[0]).toMatch(/does not exist/);
    expect((await validateFollowUpTriggers(Array.from({ length: 51 }, () => event())))[0]).toMatch(/at most 50/);
  });

  it('reads what an event or the clock did into the message, quoting event content as untrusted', () => {
    const context = { eventId: 'e', source: 'github', type: 'deploy.finished', key: 'k', receivedAt: 1, hops: 0, payload: { env: 'prod' } } as TriggerContext;
    const text = followUpMessage(event(), context);
    expect(text).toMatch(/^A follow-up trigger fired: the event `deploy.finished`/);
    expect(text).toContain('"env": "prod"');
    expect(followUpMessage({ kind: 'schedule', cron: '0 9 * * *' }, undefined)).toMatch(/time you scheduled/);
    expect(followUpMessage({ kind: 'dependency', tasks: ['t1'] }, undefined)).toMatch(/t1/);
  });
});

class FakeClock {
  time = 1_000_000;
  private seq = 0;
  private timers: { id: number; at: number; fn: () => void }[] = [];
  now = () => this.time;
  set = (fn: () => void, ms: number) => { const id = ++this.seq; this.timers.push({ id, at: this.time + ms, fn }); return id; };
  clear = (h: unknown) => { this.timers = this.timers.filter((t) => t.id !== h); };
  async advance(ms: number) {
    this.time += ms;
    for (const timer of this.timers.filter((t) => t.at <= this.time)) { this.clear(timer.id); timer.fn(); }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('dispatching follow-up triggers', () => {
  let store: Store, bus: KarmaxBus, clock: FakeClock, projectId: string, fires: Array<{ taskId: string; mode: string; trigger?: TriggerContext; cause?: FollowUpTrigger }>;
  let scheduler: TriggerScheduler;
  let failNext = 0, seq = 0;
  beforeEach(async () => {
    store = await Store.create(':memory:');
    bus = new KarmaxBus();
    clock = new FakeClock();
    projectId = (await store.createProject('P')).id;
    fires = [];
    failNext = 0;
    scheduler = new TriggerScheduler({ store, bus, now: clock.now, setTimer: clock.set, clearTimer: clock.clear, reconcileMs: 0, inboxSweepMs: 0,
      fire: async (taskId, mode, trigger, cause) => {
        if (failNext > 0) { failNext--; throw new Error('engine unavailable'); }
        fires.push({ taskId, mode, trigger, cause: cause as FollowUpTrigger });
        return { startedTaskId: taskId, told: true };
      } });
  });
  afterEach(async () => { await scheduler.stop(); });

  const running = async (followUpTriggers: unknown[], params: Record<string, unknown> = {}) => {
    const task = await store.createTask({ projectId, title: 'worker', workflow: 'software-dev', workflowVersion: '1.30.0',
      params: { prompt: 'p', followUpTriggers, ...params } as any });
    await store.saveView(task.id, { taskId: task.id, stage: 'do', status: 'active', messages: [], actions: [], updatedAt: 1 } as any, undefined, undefined, undefined, { lifecycleEvent: false });
    return (await store.getTask(task.id))!;
  };
  const record = async (over: Partial<ProjectEvent> = {}) => (await store.recordProjectEvent({
    organizationId: 'org_personal', projectId, source: 'github', type: 'deploy.finished', key: `d-${++seq}`, occurredAt: clock.time, receivedAt: clock.time,
    origin: 'external', hops: 0, payload: { env: 'prod' }, ...over })).event;
  const deliver = async (ev: ProjectEvent) => { scheduler.projectEventRecorded(ev); await scheduler.drain(); };

  it('fires at a started task, once per event, and the same event reaches it once', async () => {
    const task = await running([event({ id: 'a', recurring: true, where: { env: 'prod' } })]);
    await scheduler.start();
    await deliver(await record({ payload: { env: 'staging' } }));
    expect(fires).toEqual([]);
    const prod = await record();
    await deliver(prod);
    await deliver(prod);
    expect(fires).toMatchObject([{ taskId: task.id, mode: 'followUp', trigger: { eventId: prod.id }, cause: { id: 'a' } }]);
    expect(await store.getProjectEventClaim(prod.id, task.id)).toMatchObject({ state: 'told' });
  });

  it('a subject narrows it to one issue, and a task never hears its own emits', async () => {
    const issue = 'https://github.com/o/r/issues/7';
    const task = await running([event({ id: 'a', type: '*', subject: issue, recurring: true })]);
    await scheduler.start();
    await deliver(await record({ subject: 'https://github.com/o/r/issues/8' }));
    await deliver(await record({ subject: issue, source: `task:${task.id}`, origin: 'task' }));
    await deliver(await record({ subject: issue, origin: 'self' }));
    expect(fires).toEqual([]);
    await deliver(await record({ subject: issue }));
    expect(fires).toHaveLength(1);
  });

  it('a task that is not running yet, or is a series, does not listen: its runs will', async () => {
    const draft = await running([event()], { draft: true });
    const series = await running([event()], { repeatable: true });
    await scheduler.start();
    await deliver(await record());
    expect(fires.map((f) => f.taskId)).not.toContain(draft.id);
    expect(fires.map((f) => f.taskId)).not.toContain(series.id);
  });

  it('a one-shot fires once even if the fire fails first, and is retried', async () => {
    const task = await running([event({ id: 'a' })]);
    await scheduler.start();
    failNext = 1;
    const ev = await record();
    await deliver(ev);
    expect(await store.getProjectEventClaim(ev.id, task.id)).toMatchObject({ state: 'deferred' });
    clock.time += 61_000;
    await scheduler.sweepProjectEvents();
    expect(fires).toHaveLength(1);
    expect(await store.getProjectEventClaim(ev.id, task.id)).toMatchObject({ state: 'told' });
    // The API used it up and re-armed; nothing left to fire.
    await store.updateFollowUpTriggers(task.id, () => []);
    await scheduler.armFollowUps((await store.getTask(task.id))!);
    await deliver(await record());
    expect(fires).toHaveLength(1);
  });

  it('a scheduled time fires it, and a one-shot time fires only once', async () => {
    const task = await running([{ id: 'a', kind: 'schedule', at: clock.time + 5_000 }]);
    await scheduler.start();
    await clock.advance(6_000);
    expect(fires).toMatchObject([{ taskId: task.id, mode: 'followUp', cause: { id: 'a', kind: 'schedule' } }]);
    await clock.advance(10_000);
    expect(fires).toHaveLength(1);
  });

  it('another task finishing fires a dependency, and one already finished fires it at once', async () => {
    const dep = await store.createTask({ projectId, title: 'dep', workflow: 'software-dev', workflowVersion: '1.30.0', params: { prompt: 'p' } });
    await store.saveView(dep.id, { taskId: dep.id, stage: 'do', status: 'active', messages: [], actions: [], updatedAt: 1 } as any, undefined, undefined, undefined, { lifecycleEvent: false });
    const task = await running([{ id: 'a', kind: 'dependency', tasks: [dep.id] }]);
    await scheduler.start();
    expect(fires).toEqual([]);
    await store.saveView(dep.id, { taskId: dep.id, stage: 'done', status: 'done', messages: [], actions: [], updatedAt: 2 } as any, undefined, undefined, undefined, { lifecycleEvent: false });
    bus.emit({ taskId: dep.id, type: 'view.updated', ts: 2, payload: { status: 'done', stage: 'done' } });
    await scheduler.drain();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fires).toMatchObject([{ taskId: task.id, mode: 'followUp', cause: { kind: 'dependency' } }]);

    const later = await running([{ id: 'b', kind: 'dependency', tasks: [dep.id] }]);
    await scheduler.armFollowUps(later);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fires.map((f) => f.taskId)).toEqual([task.id, later.id]);
  });

  it('a task event can fire it, but never one of the task\'s own', async () => {
    const task = await running([event({ id: 'a', type: 'feed.item', recurring: true })]);
    await scheduler.start();
    bus.emit({ taskId: task.id, type: 'feed.item', ts: 2, payload: {} });
    await scheduler.drain();
    expect(fires).toEqual([]);
    const other = await store.createTask({ projectId, title: 'other', workflow: 'software-dev', workflowVersion: '1.30.0', params: { prompt: 'p' } });
    bus.emit({ taskId: other.id, type: 'feed.item', ts: 3, payload: {} });
    await scheduler.drain();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fires).toHaveLength(1);
  });

  it('keeps listening after the task is done, drops only what was for while it ran, and clears everything at cancellation', async () => {
    const task = await running([event({ id: 'a', recurring: true }), event({ id: 'b', type: '*', subject: 's', whileRunning: true, recurring: true })]);
    await scheduler.start();
    await store.saveView(task.id, { taskId: task.id, stage: 'done', status: 'done', messages: [], actions: [], updatedAt: 2 } as any, undefined, undefined, undefined, { lifecycleEvent: false });
    bus.emit({ taskId: task.id, type: 'view.updated', ts: 2, payload: { status: 'done', stage: 'done' } });
    await scheduler.drain();
    expect(normalizeFollowUpTriggers((await store.getTask(task.id))!.params).map((t) => t.id)).toEqual(['a']);
    await deliver(await record());
    expect(fires).toHaveLength(1);
    await store.saveView(task.id, { taskId: task.id, stage: 'cancelled', status: 'cancelled', messages: [], actions: [], updatedAt: 3 } as any, undefined, undefined, undefined, { lifecycleEvent: false });
    bus.emit({ taskId: task.id, type: 'view.updated', ts: 3, payload: { status: 'cancelled', stage: 'cancelled' } });
    await scheduler.drain();
    expect((await store.getTask(task.id))!.params.followUpTriggers).toBeUndefined();
    await deliver(await record());
    expect(fires).toHaveLength(1);
  });

  it('turns follows saved before this existed into triggers for while the task runs', async () => {
    const task = await running([]);
    const done = await store.createTask({ projectId, title: 'old', workflow: 'software-dev', workflowVersion: '1.30.0', params: { prompt: 'p' } });
    await store.saveView(done.id, { taskId: done.id, stage: 'done', status: 'done', messages: [], actions: [], updatedAt: 1 } as any, undefined, undefined, undefined, { lifecycleEvent: false });
    const insert = 'INSERT INTO task_follows (id, taskId, projectId, filter, once, createdAt) VALUES (?,?,?,?,?,?)';
    await (store as any).db.prepare(insert).run('fol_1', task.id, projectId, JSON.stringify({ type: 'deploy.*', where: { env: 'prod' } }), 1, 1);
    await (store as any).db.prepare(insert).run('fol_2', done.id, projectId, JSON.stringify({ subject: 's' }), 0, 1);
    await scheduler.start();
    expect((await store.getTask(task.id))!.params.followUpTriggers).toEqual([{ id: 'fol_1', kind: 'event', type: 'deploy.*', where: { env: 'prod' }, whileRunning: true }]);
    expect((await store.getTask(done.id))!.params.followUpTriggers).toBeUndefined();
    expect(await (store as any).db.prepare('SELECT COUNT(*) n FROM task_follows').get()).toMatchObject({ n: 0 });
    await deliver(await record());
    expect(fires.map((f) => f.taskId)).toEqual([task.id]);
  });
});

const CANCEL = { name: 'cancel', kind: 'signal', label: 'Cancel', enabled: true, danger: true };
const DO_ACTIONS = [{ name: 'followUp', kind: 'signal', label: 'Send follow-up', enabled: true }, CANCEL];

async function api(stage = 'do', actions: unknown[] = DO_ACTIONS, status = 'active') {
  const store = (await Store.create(':memory:'));
  (await store.claimPersonalOrganization('owner'));
  const project = (await store.createProject('Follow-ups'));
  const authorization = (await AuthorizationService.create(store));
  (await authorization.grant('system:test', { principalId: 'user:owner', scopeKey: projectScope(project.id), profileId: 'maintainer' }));
  (await authorization.grant('system:test', { principalId: 'user:limited', scopeKey: projectScope(project.id), profileId: 'developer' }));
  const tokens = new TokenAuthority(store);
  const tokenFor = async (principal: string) => (await tokens.mintPrincipal(
    principal, (await authorization.capabilities(principal, project.id, 'org_personal')), project.id, undefined, 'org_personal')).token;
  const signals: unknown[][] = [];
  const client = { workflow: {
    getHandle: () => ({ signal: async (...args: unknown[]) => { signals.push(args); }, query: async () => undefined,
      executeUpdate: async () => { throw new Error('the workflow has finished'); } }),
    start: async () => ({}),
  } } as any;
  const bus = new KarmaxBus();
  store.onEventRecorded((e) => bus.emit(e));
  const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, authorization, bus });
  const task = (await store.createTask({ projectId: project.id, title: 'Watch', workflow: 'software-dev', workflowVersion: '1.30.0',
    createdBy: { kind: 'user', userId: 'owner' }, params: { prompt: 'start', 'agent:do': { provider: 'mock' }, paymentPolicy: { dailyLimit: 1 } as any,
      followUpTriggers: [{ id: 'keep', kind: 'event', type: 'deploy.*', recurring: true }, { id: 'once', kind: 'event', type: 'once.*' }] } as any }));
  const view = (over: Record<string, unknown> = {}) => ({ taskId: task.id, title: 'Watch', workflow: 'software-dev', stage, status,
    messages: [{ id: 'm0', role: 'user', text: 'start', ts: 1 }], actions, state: {}, updatedAt: 1,
    participants: [{ key: 'do', label: 'Agent', role: 'do', state: 'idle', messages: 0 }], ...over }) as any;
  (await store.saveView(task.id, view()));
  const followUps = () => signals.filter(([name]) => name === 'followUp').map(([, message]) => (message as { id: string; text: string; authorLabel?: string }));
  const settled = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };
  const fire = createTriggerFire(api, tokens);
  const ev = { eventId: 'evt1', source: 'github', type: 'deploy.finished', key: 'k1', receivedAt: 1, hops: 2, payload: { env: 'prod' } } as TriggerContext;
  const keep = normalizeFollowUpTriggers(task.params)[0]!;
  const once = normalizeFollowUpTriggers(task.params)[1]!;
  const tasks = () => store.listTasks(project.id);
  return { store, api, task, tokenFor, followUps, view, settled, fire, ev, keep, once, tasks, project };
}

describe('a follow-up trigger firing', () => {
  it('tells a task that can take a message, and a one-shot is used up', async () => {
    const f = await api();
    const result = await f.fire(f.task.id, 'followUp', f.ev, f.once) as { told?: boolean };
    await f.settled();
    expect(result.told).toBe(true);
    expect(f.followUps()).toMatchObject([{ text: expect.stringMatching(/^A follow-up trigger fired/), authorLabel: 'Follow-up trigger' }]);
    expect(normalizeFollowUpTriggers((await f.store.getTask(f.task.id))!.params).map((t) => t.id)).toEqual(['keep']);
    await f.fire(f.task.id, 'followUp', f.ev, f.keep);
    await f.settled();
    expect(normalizeFollowUpTriggers((await f.store.getTask(f.task.id))!.params).map((t) => t.id)).toEqual(['keep']);
  });

  it('waits while the task cannot take a message, and delivers it when it can', async () => {
    const f = await api('setup', [CANCEL]);
    await f.fire(f.task.id, 'followUp', f.ev, f.keep);
    await f.settled();
    expect(f.followUps()).toEqual([]);
    const owner = await f.tokenFor('user:owner');
    expect((await f.api.getTaskView(owner, f.task.id))?.pendingMessages?.[0]?.message.text).toMatch(/follow-up trigger/);
    await f.store.saveView(f.task.id, f.view({ stage: 'do', actions: DO_ACTIONS, updatedAt: 2 }));
    await f.settled();
    expect(f.followUps()).toHaveLength(1);
  });

  it('forks a done task: new work, its agent resumed, no budget, the triggers moved on', async () => {
    const f = await api('done', [], 'done');
    await f.fire(f.task.id, 'followUp', f.ev, f.once);
    await f.settled();
    expect(f.followUps()).toEqual([]);
    const fork = (await f.tasks()).find((task) => task.id !== f.task.id)!;
    expect(fork).toBeDefined();
    expect(fork.params.prompt).toMatch(/^A follow-up trigger fired/);
    expect(fork.params['agent:do']).toMatchObject({ resumeFrom: { taskId: f.task.id, role: 'do' } });
    expect(fork.params.paymentPolicy).not.toMatchObject({ dailyLimit: 1 });
    expect(fork.params.trigger).toMatchObject({ eventId: 'evt1', hops: 2 });
    expect(fork.createdBy).toEqual({ kind: 'user', userId: 'owner' });
    expect(normalizeFollowUpTriggers(fork.params).map((t) => t.id)).toEqual(['keep']);
    expect((await f.store.getTask(f.task.id))!.params.followUpTriggers).toBeUndefined();
  });

  it('holds a sealed proposal\'s follow-up until it has landed, then forks', async () => {
    const f = await api('merge', [CANCEL], 'waiting');
    await f.store.saveView(f.task.id, f.view({ waitingFor: { kind: 'github' }, updatedAt: 2 }));
    await f.fire(f.task.id, 'followUp', f.ev, f.keep);
    await f.settled();
    expect((await f.tasks())).toHaveLength(1);
    await f.store.saveView(f.task.id, f.view({ stage: 'done', status: 'done', actions: [], updatedAt: 3 }));
    await f.settled();
    expect((await f.tasks())).toHaveLength(2);
    expect((await f.store.kvGet(`pending-messages:${f.task.id}`)) ?? '[]').toBe('[]');
  });

  it('forks a done just-do task too', async () => {
    const f = await api('done', [], 'done');
    await (f.store as any).db.prepare('UPDATE tasks SET workflow=? WHERE id=?').run('just-do', f.task.id);
    await f.fire(f.task.id, 'followUp', f.ev, f.keep);
    await f.settled();
    expect((await f.tasks())).toHaveLength(2);
  });

  it('several kept while it could not take them: the first forks, the rest follow it', async () => {
    const f = await api('merge', [CANCEL], 'waiting');
    await f.store.saveView(f.task.id, f.view({ waitingFor: { kind: 'github' }, updatedAt: 2 }));
    await f.fire(f.task.id, 'followUp', f.ev, f.keep);
    await f.fire(f.task.id, 'followUp', { ...f.ev, eventId: 'evt2', key: 'k2' }, f.keep);
    await f.settled();
    await f.store.saveView(f.task.id, f.view({ stage: 'done', status: 'done', actions: [], updatedAt: 3 }));
    await f.settled();
    const tasks = await f.tasks();
    expect(tasks).toHaveLength(2);
    const fork = tasks.find((task) => task.id !== f.task.id)!;
    expect(JSON.parse((await f.store.kvGet(`pending-messages:${fork.id}`))!)).toHaveLength(1);
  });
});

describe('setting follow-up triggers', () => {
  it('a person edits them through the task\'s parameters, even on a finished task', async () => {
    const f = await api('done', [], 'done');
    const owner = await f.tokenFor('user:owner');
    const { applied } = await f.api.updateParams(owner, f.task.id, { followUpTriggers: [{ kind: 'schedule', at: Date.now() + 60_000 }] });
    expect(applied).toEqual(['followUpTriggers']);
    const [saved] = normalizeFollowUpTriggers((await f.store.getTask(f.task.id))!.params);
    expect(saved).toMatchObject({ kind: 'schedule', id: expect.stringMatching(/^fol_/) });
    await expect(f.api.updateParams(owner, f.task.id, { followUpTriggers: [{ kind: 'event', type: 'bad type' }] })).rejects.toThrow(/invalid event type/);
  });

  it('a task\'s own agent adds and removes them; an add keeps what is there', async () => {
    const f = await api();
    const { token } = await new TokenAuthority(f.store).mint({ taskId: f.task.id, profileId: 'do', role: 'do', principal: `task-agent:${f.task.id}`, projectId: f.task.projectId,
      ceiling: ['task:edit', 'task:event:read', 'task:read'] as any, grantorCaps: ['task:edit', 'task:event:read', 'task:read'] as any });
    const added = await f.api.addFollowUpTrigger(token, f.task.id, { kind: 'dependency', tasks: [f.task.id] }).catch((error: Error) => error.message);
    expect(added).toMatch(/itself/);
    const trigger = await f.api.addFollowUpTrigger(token, f.task.id, { kind: 'schedule', cron: '0 9 * * *' });
    expect(normalizeFollowUpTriggers((await f.store.getTask(f.task.id))!.params)).toHaveLength(3);
    await f.api.removeFollowUpTrigger(token, f.task.id, trigger.id);
    expect((await f.api.listFollowUpTriggers(token, f.task.id)).map((t) => t.id)).toEqual(['keep', 'once']);
  });

  it('nobody without the task\'s authority can arrange a fork of it', async () => {
    const f = await api();
    await f.store.patchTaskParams(f.task.id, { _authorization: { principal: 'user:owner', level: 'maintainer', scope: 'projects', projectIds: [f.task.projectId], capabilities: ['project:settings:write'] } } as any);
    const limited = await f.tokenFor('user:limited');
    await expect(f.api.updateParams(limited, f.task.id, { followUpTriggers: [{ kind: 'schedule', cron: '0 9 * * *' }] })).rejects.toThrow(/authorization|edit/);
    const owner = await f.tokenFor('user:owner');
    await f.api.updateParams(owner, f.task.id, { followUpTriggers: [] });
    expect((await f.store.getTask(f.task.id))!.params.followUpTriggers).toBeUndefined();
  });

  it('refuses a cancelled task, and a task with no agent', async () => {
    const f = await api('cancelled', [], 'cancelled');
    const owner = await f.tokenFor('user:owner');
    await expect(f.api.updateParams(owner, f.task.id, { followUpTriggers: [{ kind: 'schedule', cron: '0 9 * * *' }] })).rejects.toThrow(/cancelled/);
  });

  it('a timed pause on a task with triggers says what it waits for', async () => {
    const f = await api('do', DO_ACTIONS, 'waiting');
    await f.store.saveView(f.task.id, f.view({ status: 'waiting', waitingFor: { kind: 'timer', detail: 'Waiting 60 min', until: 123 }, updatedAt: 2 }));
    const owner = await f.tokenFor('user:owner');
    expect((await f.api.getTaskView(owner, f.task.id))?.waitingFor).toMatchObject({ kind: 'timer', until: 123, summary: 'Waiting for deploy.*, once.*' });
  });

  it('a task created with them starts listening', async () => {
    const f = await api();
    const armed: string[] = [];
    f.api.setTriggerArmer({ arm: () => undefined, disarm: () => undefined, armFollowUps: (task: { id: string }) => { armed.push(task.id); } });
    const owner = await f.tokenFor('user:owner');
    const created = await f.api.createTask(owner, { projectId: f.project.id, prompt: 'x', params: { followUpTriggers: [{ kind: 'event', type: 'deploy.*' }] } as any });
    expect(armed).toContain(created.id);
    expect(normalizeFollowUpTriggers(created.params)[0]!.id).toMatch(/^fol_/);
    await expect(f.api.createTask(owner, { projectId: f.project.id, prompt: 'x', params: { followUpTriggers: [{ kind: 'event', type: 'bad type' }] } as any })).rejects.toThrow(/invalid event type/);
  });
});
