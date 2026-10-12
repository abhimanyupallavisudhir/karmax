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

  const told: Array<{ runId: string; trigger: TriggerContext; text?: string }> = [];
  let tellFailures = 0;
  const tell = async (runId: string, trigger: TriggerContext, text?: string) => {
    if (tellFailures > 0) { tellFailures--; throw new Error('task unreachable'); }
    told.push({ runId, trigger, ...(text ? { text } : {}) });
  };
  const scheduler = async () => {
    const s = new TriggerScheduler({ store, bus, fire, tell, now: clock.now, setTimer: clock.set, clearTimer: clock.clear, reconcileMs: 0, inboxSweepMs: 0 });
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

  it('tells the unfinished run of a key about a further event instead of starting another', async () => {
    told.length = 0;
    const series = await armedTask([{ ...planned, concurrency: { key: '{{label.name}}', mode: 'tell' } }]);
    const s = await scheduler();
    const first = await record();
    await deliver(s, first);
    const runId = (await store.getProjectEventClaim(first.id, series.id))!.runId!;
    const second = await record();
    await deliver(s, second);
    expect(fires).toHaveLength(1);
    expect(told).toMatchObject([{ runId, trigger: { eventId: second.id } }]);
    expect(await store.getProjectEventClaim(second.id, series.id)).toMatchObject({ state: 'told', runId });
    // Once that run has finished, the next event is new work.
    await store.saveView(runId, { status: 'done' } as any);
    await deliver(s, await record());
    expect(fires).toHaveLength(2);
    expect(told).toHaveLength(1);
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

  describe('follows', () => {
    const plainTask = async () => store.createTask({ projectId, title: 'worker', workflow: 'software-dev', workflowVersion: '1.29.0', params: { prompt: 'p' } });
    const follow = (taskId: string, over: Record<string, unknown>) => store.addTaskFollow({ id: `fol_${++seq}`, taskId, projectId, createdAt: clock.time, ...over });

    it('delivers a matching event to a following task once, and a wait (once) ends at the first match', async () => {
      told.length = 0;
      const task = await plainTask();
      const wait = await follow(task.id, { type: 'deploy.*', where: { env: 'prod' }, once: true });
      const s = await scheduler();
      await deliver(s, await record({ type: 'deploy.finished', source: 'webhook:hk_1', payload: { env: 'staging' } }));
      expect(told).toEqual([]);
      const prod = await record({ type: 'deploy.finished', source: 'webhook:hk_1', payload: { env: 'prod' } });
      await deliver(s, prod);
      await deliver(s, prod); // a redelivery
      expect(told).toMatchObject([{ runId: task.id, trigger: { eventId: prod.id, type: 'deploy.finished' } }]);
      expect(told[0]!.text).toMatch(/^The event you were waiting for arrived: `deploy.finished`/);
      expect(await store.getProjectEventClaim(prod.id, task.id)).toMatchObject({ state: 'told', runId: task.id });
      expect(await store.getTaskFollow(wait.id)).toBeUndefined();
      await deliver(s, await record({ type: 'deploy.finished', source: 'webhook:hk_1', payload: { env: 'prod' } }));
      expect(told).toHaveLength(1);
      expect(fires).toEqual([]);
    });

    it('a run hears what is said about its subject, and its series starts no second run for it', async () => {
      told.length = 0;
      const issue = 'https://github.com/o/r/issues/7';
      const series = await armedTask([{ kind: 'event', type: 'github.*', recurring: true }]);
      const s = new TriggerScheduler({ store, bus, tell, now: clock.now, setTimer: clock.set, clearTimer: clock.clear, reconcileMs: 0, inboxSweepMs: 0,
        // Like the API: a run follows the subject of the event that started it.
        fire: async (taskId, mode, trigger) => {
          const started = await fire(taskId, mode, trigger);
          if (trigger?.subject) await follow(started.startedTaskId, { subject: trigger.subject });
          return started;
        } });
      schedulers.push(s);
      await s.start();
      const labeled = await record({ subject: issue });
      await deliver(s, labeled);
      const runId = (await store.getProjectEventClaim(labeled.id, series.id))!.runId!;
      expect(told).toEqual([]); // the event that started it is not repeated to it

      const comment = await record({ type: 'github.issue_comment.created', subject: issue, payload: { comment: { body: 'also the footer' } } });
      await deliver(s, comment);
      expect(fires).toHaveLength(1);
      expect(told).toMatchObject([{ runId, trigger: { eventId: comment.id } }]);
      expect(told[0]!.text).toMatch(/^An event you follow arrived \(fol_\d+\): `github.issue_comment.created`/);
      expect(await store.getProjectEventClaim(comment.id, series.id)).toMatchObject({ state: 'skipped', reason: `its run ${runId} follows this` });
      // The App's own comment is not news to the run; another issue is another run.
      await deliver(s, await record({ type: 'github.issue_comment.created', subject: issue, origin: 'self' }));
      await deliver(s, await record({ subject: 'https://github.com/o/r/issues/8' }));
      expect(told).toHaveLength(1);
      expect(fires).toHaveLength(2);
      // A finished run hears nothing more; the next event on its issue is new work.
      await store.saveView(runId, { status: 'done' } as any);
      await deliver(s, await record({ type: 'github.issue_comment.created', subject: issue }));
      expect(told).toHaveLength(1);
      expect(fires).toHaveLength(3);
    });

    it('never tells a task its own emits, and retries a delivery that failed', async () => {
      told.length = 0;
      const series = await armedTask([{ kind: 'event', type: 'nothing.here', recurring: true }]);
      const run = await store.createTask({ projectId, title: 'run', workflow: 'software-dev', workflowVersion: '1.29.0', params: { prompt: 'p', runOf: series.id } });
      await follow(run.id, { type: 'feed.*' });
      const s = await scheduler();
      await deliver(s, await record({ type: 'feed.item', source: `task:${series.id}`, origin: 'task' }));
      expect(told).toEqual([]);
      tellFailures = 1;
      const item = await record({ type: 'feed.item', source: 'task:task_other', origin: 'task' });
      await deliver(s, item);
      expect(await store.getProjectEventClaim(item.id, run.id)).toMatchObject({ state: 'deferred' });
      clock.advance(60_000);
      await s.sweepProjectEvents();
      expect(told).toMatchObject([{ runId: run.id, trigger: { eventId: item.id } }]);
      expect(await store.getProjectEventClaim(item.id, run.id)).toMatchObject({ state: 'told' });
      // A task that stopped following is not retried.
      tellFailures = 1;
      const later = await record({ type: 'feed.item', source: 'task:task_other', origin: 'task' });
      await deliver(s, later);
      await store.saveView(run.id, { status: 'done' } as any);
      clock.advance(60_000);
      await s.sweepProjectEvents();
      expect(await store.getProjectEventClaim(later.id, run.id)).toMatchObject({ state: 'skipped' });
    });
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
