import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../src/store/db.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { TriggerScheduler } from '../src/platform/trigger-scheduler.js';
import { forcesRepeatable } from '../src/domain/triggers.js';
import type { TaskRecord, TaskTrigger } from '../src/domain/types.js';
import type { ProjectEvent, TriggerContext } from '../src/domain/project-events.js';
import { storeBackends } from './helpers/store-backends.js';

class FakeClock {
  time = 1_000_000;
  private seq = 0;
  private timers: { id: number; at: number; fn: () => void }[] = [];
  now = () => this.time;
  set = (fn: () => void, ms: number) => { const id = ++this.seq; this.timers.push({ id, at: this.time + ms, fn }); return id; };
  clear = (h: unknown) => { this.timers = this.timers.filter((t) => t.id !== h); };
  advance(ms: number) { this.time += ms; }
}

interface Fire { taskId: string; mode: 'self' | 'clone'; trigger?: TriggerContext }

describe.each(storeBackends)('project event dispatch ($name)', ({ open }) => {
  let store: Store;
  let bus: KarmaxBus;
  let clock: FakeClock;
  let projectId: string;
  let otherProjectId: string;
  let fires: Fire[];
  let failNext: number;
  let schedulers: TriggerScheduler[];

  beforeEach(async () => {
    store = await open();
    bus = new KarmaxBus();
    clock = new FakeClock();
    projectId = (await store.createProject('P')).id;
    otherProjectId = (await store.createProject('Q')).id;
    fires = [];
    failNext = 0;
    schedulers = [];
  });
  afterEach(async () => {
    for (const scheduler of schedulers) await scheduler.stop();
  });

  const armedTask = async (triggers: TaskTrigger[], options: { repeatable?: boolean; project?: string } = {}): Promise<TaskRecord> => {
    const repeatable = options.repeatable ?? (forcesRepeatable(triggers) || undefined);
    const t = await store.createTask({ projectId: options.project ?? projectId, title: 'series', workflow: 'software-dev', workflowVersion: '1.27.0',
      params: { prompt: 'p', triggers, ...(repeatable ? { repeatable: true } : {}) } });
    await store.updateTaskParams(t.id, { ...t.params, triggerState: 'armed' });
    return (await store.getTask(t.id))!;
  };

  /** A fire that, like the API, records a run for a series. */
  const fire = async (taskId: string, mode: 'self' | 'clone', trigger?: TriggerContext) => {
    if (failNext > 0) { failNext--; throw new Error('engine unavailable'); }
    fires.push({ taskId, mode, trigger });
    if (mode === 'clone') {
      const series = (await store.getTask(taskId))!;
      const run = await store.createTask({ projectId: series.projectId, title: 'run', workflow: 'software-dev', workflowVersion: '1.27.0',
        params: { prompt: 'p', runOf: taskId, ...(trigger ? { trigger } : {}) } });
      return { startedTaskId: run.id };
    }
    const task = (await store.getTask(taskId))!;
    await store.updateTaskParams(taskId, { ...task.params, triggerState: 'fired', ...(trigger ? { trigger } : {}) });
    return { startedTaskId: taskId };
  };

  const scheduler = async () => {
    const s = new TriggerScheduler({ store, bus, fire, now: clock.now, setTimer: clock.set, clearTimer: clock.clear, reconcileMs: 0, inboxSweepMs: 0 });
    schedulers.push(s);
    await s.start();
    return s;
  };

  let seq = 0;
  const record = async (over: Partial<Omit<ProjectEvent, 'id' | 'receivedAt'>> = {}) => (await store.recordProjectEvent({
    organizationId: 'org_personal', projectId, source: 'github', type: 'github.issues.labeled', key: `delivery-${++seq}`,
    occurredAt: clock.time, receivedAt: clock.time, origin: 'external', hops: 0,
    payload: { label: { name: 'planned' }, issue: { number: seq, title: `Issue ${seq}` } }, ...over,
  })).event;

  const deliver = async (s: TriggerScheduler, ev: ProjectEvent) => { s.projectEventRecorded(ev); await s.drain(); };

  const planned: TaskTrigger = { kind: 'event', type: 'github.issues.labeled', where: { 'label.name': 'planned' }, recurring: true };

  it('starts one run per event, handing the run the event, and collapses redeliveries', async () => {
    const series = await armedTask([planned]);
    const s = await scheduler();
    const first = await record({ key: 'same' });
    await deliver(s, first);
    const again = await store.recordProjectEvent({ organizationId: 'org_personal', projectId, source: 'github', type: 'github.issues.labeled',
      key: 'same', occurredAt: 0, receivedAt: clock.time, origin: 'external', hops: 0, payload: { different: true } });
    expect(again.created).toBe(false);
    expect(again.event.id).toBe(first.id);
    await deliver(s, again.event);
    await deliver(s, await record());
    expect(fires.map((f) => [f.taskId, f.mode])).toEqual([[series.id, 'clone'], [series.id, 'clone']]);
    expect(fires[0]!.trigger).toMatchObject({ eventId: first.id, type: 'github.issues.labeled', source: 'github', payload: first.payload });
    const claims = await store.listProjectEventClaims(first.id);
    expect(claims).toMatchObject([{ taskId: series.id, state: 'started' }]);
    expect(claims[0]!.runId).toBeTruthy();
    expect((await store.undispatchedProjectEvents()).length).toBe(0);
  });

  it('ignores non-matching filters, other projects and echoes of tavya itself', async () => {
    await armedTask([planned]);
    await armedTask([planned], { project: otherProjectId });
    const s = await scheduler();
    await deliver(s, await record({ payload: { label: { name: 'bug' } } }));
    await deliver(s, await record({ origin: 'self' }));
    await deliver(s, await record({ type: 'github.issues.opened' }));
    expect(fires).toEqual([]);
    const echo = await armedTask([{ ...planned, includeSelf: true }]);
    await s.arm(echo);
    await deliver(s, await record({ origin: 'self' }));
    expect(fires.map((f) => f.taskId)).toEqual([echo.id]);
  });

  it('starts a one-off task itself once, and skips later events for it', async () => {
    const task = await armedTask([{ kind: 'event', type: 'github.issues.labeled' }]);
    const s = await scheduler();
    await deliver(s, await record());
    await deliver(s, await record());
    expect(fires).toHaveLength(1);
    expect(fires[0]).toMatchObject({ taskId: task.id, mode: 'self' });
    expect(s.size).toBe(0);
  });

  it('skips while a run for the same key is active, or queues it until that run ends', async () => {
    const skip = await armedTask([{ ...planned, concurrency: { key: '{{label.name}}' } }]);
    const queue = await armedTask([{ ...planned, concurrency: { key: '{{label.name}}', mode: 'queue' } }]);
    const s = await scheduler();
    await deliver(s, await record());
    const second = await record();
    await deliver(s, second);
    expect(fires.filter((f) => f.taskId === skip.id)).toHaveLength(1);
    expect(fires.filter((f) => f.taskId === queue.id)).toHaveLength(1);
    expect(await store.getProjectEventClaim(second.id, skip.id)).toMatchObject({ state: 'skipped' });
    expect(await store.getProjectEventClaim(second.id, queue.id)).toMatchObject({ state: 'deferred' });
    // The queued run waits while the first is unfinished…
    await s.sweepProjectEvents();
    expect(fires.filter((f) => f.taskId === queue.id)).toHaveLength(1);
    // …and starts once it is done.
    const firstQueueRun = (await store.getProjectEventClaim((await store.listProjectEvents(projectId)).at(-1)!.id, queue.id))!.runId!;
    await store.saveView(firstQueueRun, { status: 'done' } as any);
    await s.sweepProjectEvents();
    expect(fires.filter((f) => f.taskId === queue.id)).toHaveLength(2);
    expect(await store.getProjectEventClaim(second.id, queue.id)).toMatchObject({ state: 'started' });
  });

  it('holds runs past the hourly limit until the hour has passed', async () => {
    const series = await armedTask([{ ...planned, maxPerHour: 2 }]);
    const s = await scheduler();
    for (let i = 0; i < 3; i++) await deliver(s, await record());
    expect(fires).toHaveLength(2);
    const third = (await store.listProjectEvents(projectId))[0]!;
    expect(await store.getProjectEventClaim(third.id, series.id)).toMatchObject({ state: 'deferred' });
    clock.advance(3600_000);
    await s.sweepProjectEvents();
    expect(fires).toHaveLength(3);
  });

  it('stops event loops after a bounded number of hops', async () => {
    const series = await armedTask([{ kind: 'event', type: 'loop.tick', recurring: true }]);
    const s = await scheduler();
    const looping = await record({ type: 'loop.tick', source: `task:${series.id}`, origin: 'task', hops: 9 });
    await deliver(s, looping);
    expect(fires).toEqual([]);
    expect(await store.getProjectEventClaim(looping.id, series.id)).toMatchObject({ state: 'skipped' });
  });

  it('waits for dependency prerequisites before starting an event run', async () => {
    const dep = await store.createTask({ projectId, title: 'dep', workflow: 'software-dev', workflowVersion: '1.27.0', params: { prompt: 'd' } });
    const series = await armedTask([{ kind: 'dependency', tasks: [dep.id] }, planned]);
    const s = await scheduler();
    const ev = await record();
    await deliver(s, ev);
    expect(fires).toEqual([]);
    expect(await store.getProjectEventClaim(ev.id, series.id)).toMatchObject({ state: 'deferred' });
    await store.saveView(dep.id, { status: 'done' } as any);
    bus.emit({ type: 'view.updated', taskId: dep.id, ts: 0, payload: { status: 'done' } });
    await s.drain();
    await s.sweepProjectEvents();
    expect(fires.filter((f) => f.trigger?.eventId === ev.id)).toHaveLength(1);
  });

  it('retries a failed start, and adopts a run a crashed process already started', async () => {
    const series = await armedTask([planned]);
    const s = await scheduler();
    failNext = 1;
    const ev = await record();
    await deliver(s, ev);
    expect(await store.getProjectEventClaim(ev.id, series.id)).toMatchObject({ state: 'deferred' });
    await s.sweepProjectEvents();
    expect(fires).toHaveLength(0); // backs off
    clock.advance(60_000);
    await s.sweepProjectEvents();
    expect(fires).toHaveLength(1);

    // A process claimed an event and started its run, then died before recording it.
    const orphan = await record();
    await store.claimProjectEvent({ eventId: orphan.id, taskId: series.id, state: 'pending', receivedAt: orphan.receivedAt, updatedAt: clock.time });
    await store.markProjectEventDispatched(orphan.id);
    const run = await store.createTask({ projectId, title: 'run', workflow: 'software-dev', workflowVersion: '1.27.0',
      params: { prompt: 'p', runOf: series.id, trigger: { eventId: orphan.id } } });
    clock.advance(11 * 60_000);
    await s.sweepProjectEvents();
    expect(await store.getProjectEventClaim(orphan.id, series.id)).toMatchObject({ state: 'started', runId: run.id });
    expect(fires).toHaveLength(1);
  });

  it('delivers events recorded while it was not running, once, even with two dispatchers', async () => {
    const series = await armedTask([planned]);
    const early = await record();
    const a = new TriggerScheduler({ store, bus, fire, now: clock.now, setTimer: clock.set, clearTimer: clock.clear, reconcileMs: 0, inboxSweepMs: 0 });
    a.projectEventRecorded(early); // before start: must not be marked dispatched
    expect((await store.undispatchedProjectEvents()).map((e) => e.id)).toEqual([early.id]);
    schedulers.push(a);
    const b = new TriggerScheduler({ store, bus, fire, now: clock.now, setTimer: clock.set, clearTimer: clock.clear, reconcileMs: 0, inboxSweepMs: 0 });
    schedulers.push(b);
    await Promise.all([a.start(), b.start()]);
    const later = await record();
    a.projectEventRecorded(later);
    b.projectEventRecorded(later);
    await Promise.all([a.drain(), b.drain()]);
    expect(fires.filter((f) => f.taskId === series.id).map((f) => f.trigger?.eventId).sort()).toEqual([early.id, later.id].sort());
  });

  it('forgets claims for a task that is no longer waiting', async () => {
    const series = await armedTask([{ ...planned, maxPerHour: 1 }]);
    const s = await scheduler();
    await deliver(s, await record());
    const held = await record();
    await deliver(s, held);
    expect(await store.getProjectEventClaim(held.id, series.id)).toMatchObject({ state: 'deferred' });
    s.disarm(series.id);
    await store.updateTaskParams(series.id, { ...(await store.getTask(series.id))!.params, triggerState: undefined, draft: true });
    await s.sweepProjectEvents();
    expect(await store.getProjectEventClaim(held.id, series.id)).toMatchObject({ state: 'skipped' });
  });
});
