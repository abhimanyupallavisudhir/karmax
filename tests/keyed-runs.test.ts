import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../src/store/db.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { TriggerScheduler, type GateRequest, type GateVerdict } from '../src/platform/trigger-scheduler.js';
import type { TaskRecord, TaskTrigger, TaskView } from '../src/domain/types.js';
import type { EventTrigger } from '../src/domain/triggers.js';
import type { ProjectEvent, TriggerContext } from '../src/domain/project-events.js';
import { storeBackends } from './helpers/store-backends.js';

/**
 * Counted events and one task per key (wiki features/events-and-automations
 * § Keys): a repeat of an event's key is counted on the event; a trigger whose
 * concurrency mode is `continue` keeps one task per key for good.
 */

class FakeClock {
  time = Date.now(); // the store stamps a task's status changes with the real clock
  private seq = 0;
  private timers: { id: number; at: number; fn: () => void }[] = [];
  now = () => this.time;
  set = (fn: () => void, ms: number) => { const id = ++this.seq; this.timers.push({ id, at: this.time + ms, fn }); return id; };
  clear = (h: unknown) => { this.timers = this.timers.filter((t) => t.id !== h); };
  advance(ms: number) { this.time += ms; }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe.each(storeBackends)('one task per key ($name)', ({ open }) => {
  let store: Store;
  let clock: FakeClock;
  let projectId: string;
  let scheduler: TriggerScheduler;
  let started: Array<{ runId: string; trigger: TriggerContext }>;
  let heard: Array<{ taskId: string; trigger?: TriggerContext; text?: string }>;
  let asked: GateRequest[];
  let gate: ((ask: GateRequest) => GateVerdict | Promise<GateVerdict>) | undefined;

  beforeEach(async () => {
    store = await open();
    clock = new FakeClock();
    projectId = (await store.createProject('P')).id;
    started = [];
    heard = [];
    asked = [];
    gate = undefined;
  });
  afterEach(async () => { await scheduler?.stop(); });

  const errors: EventTrigger = { kind: 'event', type: 'app.error', recurring: true, concurrency: { key: '{{$key}}', mode: 'continue' } };

  const series = async (trigger: TaskTrigger): Promise<TaskRecord> => {
    const task = await store.createTask({ projectId, title: 'Fix: {{summary}}', workflow: 'software-dev', workflowVersion: '1.30.0',
      params: { prompt: 'fix it', triggers: [trigger], repeatable: true } });
    await store.updateTaskParams(task.id, { ...task.params, triggerState: 'armed' });
    return (await store.getTask(task.id))!;
  };

  /** Like the API: `clone` records a run of the series, `followUp` says something to a task. */
  const fire = async (taskId: string, mode: 'self' | 'clone' | 'followUp', trigger?: TriggerContext, _cause?: TaskTrigger, text?: string) => {
    if (mode === 'followUp') { heard.push({ taskId, ...(trigger ? { trigger } : {}), ...(text ? { text } : {}) }); return { startedTaskId: taskId, told: true }; }
    const source = (await store.getTask(taskId))!;
    const run = await store.createTask({ projectId: source.projectId, title: 'run', workflow: 'software-dev', workflowVersion: '1.30.0',
      params: { prompt: 'p', runOf: taskId, ...(trigger ? { trigger } : {}) } as never });
    started.push({ runId: run.id, trigger: trigger! });
    return { startedTaskId: run.id };
  };

  const start = async () => {
    scheduler = new TriggerScheduler({ store, bus: new KarmaxBus(), fire, now: clock.now, setTimer: clock.set, clearTimer: clock.clear,
      reconcileMs: 0, inboxSweepMs: 0, gate: async (ask) => { asked.push(ask); if (!gate) throw new Error('no model'); return gate(ask); } });
    await scheduler.start();
  };

  /** Record `times` occurrences of an error, then let the dispatcher see them. */
  const occur = async (key: string, times = 1, payload: Record<string, unknown> = {}) => {
    let event!: ProjectEvent;
    for (let i = 0; i < times; i++) {
      event = (await store.recordProjectEvent({ organizationId: 'org_personal', projectId, source: 'user:usr_1', type: 'app.error', key,
        occurredAt: clock.time, receivedAt: clock.time, origin: 'external', hops: 0, payload: { summary: `${key} failed`, ...payload }, distinct: ['customer'] })).event;
    }
    await sweep();
    return event;
  };
  /** The dispatcher's periodic pass; a gate answers off the queue, so wait for it. */
  const sweep = async () => {
    for (let i = 0; i < 4; i++) {
      await scheduler.sweepProjectEvents();
      await scheduler.drain();
      await new Promise((resolve) => setImmediate(resolve));
      await scheduler.drain();
    }
  };

  const finish = async (taskId: string, view: Partial<TaskView> = {}, status = 'done') => {
    await store.saveView(taskId, { taskId, title: 'run', workflow: 'software-dev', stage: 'done', status, messages: [], actions: [], state: {}, updatedAt: clock.time, ...view } as TaskView);
  };
  const landed = { prs: [{ repo: 'app', slug: 'o/app', number: 7, url: 'https://github.com/o/app/pull/7', state: 'closed', merged: true, headSha: 'c0ffee'.padEnd(40, '0') }] } as Partial<TaskView>;

  it('counts a repeat on its event instead of dropping it, with the latest repeats and who it happened to', async () => {
    await start();
    const first = await occur('checkout', 1, { customer: 'acme' });
    clock.advance(HOUR);
    for (const customer of ['acme', 'globex', 'initech', 'umbrella', 'hooli']) await occur('checkout', 1, { customer });
    const event = (await store.getProjectEvent(first.id))!;
    expect(event).toMatchObject({ count: 6, receivedAt: first.receivedAt, lastSeenAt: clock.time, payload: { customer: 'acme' } });
    expect(event.distinct).toEqual({ customer: ['acme', 'globex', 'initech', 'umbrella', 'hooli'] });
    expect(event.recent!.map((occurrence) => occurrence.payload.customer)).toEqual(['initech', 'umbrella', 'hooli']);
    expect(await store.listProjectEvents(projectId)).toHaveLength(1);
    // Once offered, it is not offered again until it comes again.
    expect(await store.undispatchedProjectEvents()).toEqual([]);
    await store.recordProjectEvent({ organizationId: 'org_personal', projectId, source: 'user:usr_1', type: 'app.error', key: 'checkout',
      occurredAt: clock.time + 1, receivedAt: clock.time + 1, origin: 'external', hops: 0, payload: {} });
    expect((await store.undispatchedProjectEvents()).map((e) => e.id)).toEqual([first.id]);
  });

  it('starts one task per key and never a second, however often the event comes', async () => {
    const fixer = await series(errors);
    await start();
    const checkout = await occur('checkout');
    await occur('login');
    expect(started.map((run) => run.trigger.key)).toEqual(['checkout', 'login']);
    // Nine more: counted, not said.
    await occur('checkout', 8);
    expect(started).toHaveLength(2);
    expect(heard).toEqual([]);
    // The tenth is worth a word to the task at work on it: once, with the count.
    await occur('checkout');
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ taskId: started[0]!.runId, trigger: { key: 'checkout', count: 10 } });
    expect(heard[0]!.text).toMatch(/keeps coming: 9 more times/);
    await occur('checkout', 60);
    expect(heard).toHaveLength(1);
    await occur('checkout', 30);
    expect(heard).toHaveLength(2);
    expect(heard[1]!.text).toMatch(/90 more times/);
    expect(started).toHaveLength(2);
    expect(await store.listKeyedRuns(fixer.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'checkout', taskId: started[0]!.runId, state: 'run', seen: 100 }),
      expect.objectContaining({ key: 'login', taskId: started[1]!.runId, state: 'run', seen: 1 })]));
    expect(await store.listProjectEventClaims(checkout.id)).toMatchObject([{ taskId: fixer.id, state: 'told', runId: started[0]!.runId }]);
  });

  it('gives a different event of the same key to the key\'s task', async () => {
    await series({ kind: 'event', type: 'github.issues.*', recurring: true, concurrency: { key: '{{issue.number}}', mode: 'continue' } });
    await start();
    const record = async (type: string, key: string) => {
      await store.recordProjectEvent({ organizationId: 'org_personal', projectId, source: 'github', type, key, occurredAt: clock.time, receivedAt: clock.time,
        origin: 'external', hops: 0, payload: { issue: { number: 12 } } });
      await sweep();
    };
    await record('github.issues.opened', 'delivery-1');
    await record('github.issues.labeled', 'delivery-2');
    expect(started).toHaveLength(1);
    expect(heard).toMatchObject([{ taskId: started[0]!.runId, trigger: { type: 'github.issues.labeled', key: 'delivery-2' } }]);
    // …also once it has finished: it carries on (the API continues it in a new task).
    await finish(started[0]!.runId);
    await record('github.issues.reopened', 'delivery-3');
    expect(started).toHaveLength(1);
    expect(heard).toHaveLength(2);
    expect(heard[1]).toMatchObject({ taskId: started[0]!.runId, trigger: { type: 'github.issues.reopened' } });
  });

  it('waits a few minutes before starting, so the run starts knowing how often it happened', async () => {
    await series({ ...errors, settleMinutes: 5 });
    await start();
    const event = await occur('checkout');
    await occur('checkout', 6);
    expect(started).toEqual([]);
    expect(await store.listProjectEventClaims(event.id)).toMatchObject([{ state: 'deferred', reason: 'letting what comes with it arrive' }]);
    clock.advance(5 * MINUTE);
    await sweep();
    expect(started).toHaveLength(1);
    expect(started[0]!.trigger).toMatchObject({ key: 'checkout', count: 7 });
  });

  it('keeps only so many at work, and starts what happened most first', async () => {
    await series({ ...errors, maxRunning: 2 });
    await start();
    await occur('a');
    await occur('b');
    const rare = await occur('rare', 2);
    clock.advance(MINUTE);
    await occur('common', 40);
    expect(started.map((run) => run.trigger.key)).toEqual(['a', 'b']);
    expect(await store.listProjectEventClaims(rare.id)).toMatchObject([{ state: 'deferred', reason: 'queued: 2 of its runs are at work' }]);
    await finish(started[0]!.runId);
    await sweep();
    expect(started.map((run) => run.trigger.key)).toEqual(['a', 'b', 'common']);
    await finish(started[1]!.runId);
    await sweep();
    expect(started.map((run) => run.trigger.key)).toEqual(['a', 'b', 'common', 'rare']);
  });

  it('asks its gate first: a skipped key starts nothing, and is asked about again once it has grown tenfold', async () => {
    const fixer = await series({ ...errors, gate: { prompt: 'Only our own defects.' } });
    gate = (ask) => ask.event.count >= 10 ? { decision: 'start' } : { decision: 'skip', reason: 'the customer\'s repository refuses writes' };
    await start();
    const event = await occur('push', 3);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ series: { id: fixer.id }, trigger: { gate: { prompt: 'Only our own defects.' } }, event: { key: 'push' }, keys: [] });
    expect(started).toEqual([]);
    expect(await store.listProjectEventClaims(event.id)).toMatchObject([{ state: 'skipped', reason: 'its gate: the customer\'s repository refuses writes' }]);
    expect(await store.keyedRun(fixer.id, 'push')).toMatchObject({ state: 'skipped', seen: 3 });
    await occur('push', 20);
    expect(asked).toHaveLength(1); // 23 < 30
    await occur('push', 7);
    expect(asked).toHaveLength(2);
    expect(started.map((run) => run.trigger)).toMatchObject([{ key: 'push', count: 30 }]);
    expect(await store.keyedRun(fixer.id, 'push')).toMatchObject({ state: 'run', taskId: started[0]!.runId });
  });

  it('lets its gate hand an event to the task of another key, and starts the run when the gate cannot be asked', async () => {
    const fixer = await series({ ...errors, gate: { prompt: 'Group by cause.' } });
    await start(); // no model yet: the gate throws
    await occur('ssh-timeout');
    expect(started.map((run) => run.trigger.key)).toEqual(['ssh-timeout']);
    gate = (ask) => ask.keys.some((key) => key.key === 'ssh-timeout') ? { decision: 'merge', into: 'ssh-timeout', reason: 'the same stopped machine' } : { decision: 'start' };
    const other = await occur('ssh-handshake');
    expect(asked.at(-1)!.keys).toMatchObject([{ key: 'ssh-timeout', taskId: started[0]!.runId, status: 'active' }]);
    expect(started).toHaveLength(1);
    expect(heard).toMatchObject([{ taskId: started[0]!.runId, trigger: { key: 'ssh-handshake' } }]);
    expect(await store.keyedRun(fixer.id, 'ssh-handshake')).toMatchObject({ taskId: started[0]!.runId, state: 'run' });
    expect(await store.listProjectEventClaims(other.id)).toMatchObject([{ state: 'told', runId: started[0]!.runId }]);
  });

  it('carries a finished task on only when the event comes again after its change went live', async () => {
    const fixer = await series({ ...errors, concurrency: { key: '{{$key}}', mode: 'continue', after: { type: 'app.deployed' } } });
    await start();
    await occur('checkout', 4);
    const run = started[0]!.runId;
    clock.advance(HOUR);
    await finish(run, landed);
    // Still the old release: it keeps coming, which says nothing about the fix.
    clock.advance(MINUTE);
    await occur('checkout', 5);
    expect(heard).toEqual([]);
    const deploy = async (commits: string[]) => {
      await store.recordProjectEvent({ organizationId: 'org_personal', projectId, source: 'user:usr_1', type: 'app.deployed', key: `d${clock.time}`,
        occurredAt: clock.time, receivedAt: clock.time, origin: 'external', hops: 0, payload: { revision: commits[0], commits } });
    };
    // A deploy that does not carry the fix (it was already building) changes nothing.
    clock.advance(MINUTE);
    await deploy(['deadbeef'.padEnd(40, '0')]);
    clock.advance(MINUTE);
    await occur('checkout');
    expect(heard).toEqual([]);
    // The deploy that ships it: from now on a repeat means the fix did not hold.
    clock.advance(10 * MINUTE);
    await deploy(['f00d'.padEnd(40, '0'), 'c0ffee'.padEnd(40, '0')]);
    const liveAt = clock.time;
    clock.advance(MINUTE);
    await occur('checkout');
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ taskId: run, trigger: { key: 'checkout', count: 11 } });
    expect(heard[0]!.text).toMatch(/came again after its change went live/);
    expect(started).toHaveLength(1);
    expect(await store.keyedRun(fixer.id, 'checkout')).toMatchObject({ taskId: run, liveAt, seen: 11 });
  });

  it('counts an occurrence when it happened: one only heard of after its change went live does not reopen its task', async () => {
    const fixer = await series({ ...errors, concurrency: { key: '{{$key}}', mode: 'continue', after: { type: 'app.deployed' } } });
    await start();
    await occur('checkout');
    const run = started[0]!.runId;
    const failedAt = clock.time; // a task showed this error, and still shows it
    clock.advance(HOUR);
    await finish(run, landed);
    clock.advance(MINUTE);
    await store.recordProjectEvent({ organizationId: 'org_personal', projectId, source: 'user:usr_1', type: 'app.deployed', key: 'd1',
      occurredAt: clock.time, receivedAt: clock.time, origin: 'external', hops: 0, payload: { commits: ['c0ffee'.padEnd(40, '0')] } });
    // Days later someone reports what that task showed: it happened before the fix was out.
    clock.advance(3 * 24 * HOUR);
    const reported = (await store.recordProjectEvent({ organizationId: 'org_personal', projectId, source: 'user:usr_1', type: 'app.error', key: 'checkout',
      occurredAt: failedAt, receivedAt: clock.time, origin: 'external', hops: 0, payload: { summary: 'checkout failed' } })).event;
    await sweep();
    // Heard now (what keeps it), happened then (what says whether the fix held).
    expect(reported).toMatchObject({ count: 2, lastSeenAt: clock.time });
    expect(reported.recent!.at(-1)).toMatchObject({ at: failedAt });
    expect(heard).toEqual([]);
    expect(started).toHaveLength(1);
    // A clock ahead of ours is not believed: it is seen when it is heard.
    const ahead = (await store.recordProjectEvent({ organizationId: 'org_personal', projectId, source: 'user:usr_1', type: 'app.error', key: 'checkout',
      occurredAt: clock.time + 365 * 24 * HOUR, receivedAt: clock.time, origin: 'external', hops: 0, payload: {} })).event;
    expect(ahead.recent!.at(-1)!.at).toBe(clock.time);
    await sweep();
    expect(heard).toHaveLength(1);
    expect((await store.keyedRun(fixer.id, 'checkout'))!.taskId).toBe(run);
  });

  it('keeps what its gate said on the claim of a run it started', async () => {
    await series({ ...errors, gate: { prompt: 'Only our own defects.' }, maxRunning: 1 });
    gate = (ask) => ({ decision: 'start', reason: `${ask.event.key} is a defect in our own code` });
    await start();
    const first = await occur('push');
    const second = await occur('pull');
    expect(started.map((run) => run.trigger.key)).toEqual(['push']);
    expect(await store.listProjectEventClaims(first.id)).toMatchObject([{ state: 'started', gated: true, gateReason: 'push is a defect in our own code' }]);
    // Approved, then queued behind the run at work: it still says why it will start.
    expect(await store.listProjectEventClaims(second.id)).toMatchObject([{ state: 'deferred', reason: 'queued: 1 of its runs are at work', gateReason: 'pull is a defect in our own code' }]);
    await finish(started[0]!.runId);
    await sweep();
    expect(await store.listProjectEventClaims(second.id)).toMatchObject([{ state: 'started', gateReason: 'pull is a defect in our own code' }]);
    expect(asked).toHaveLength(2);
  });

  it('takes a change to be live a day after it landed when no event says so', async () => {
    await series({ ...errors, concurrency: { key: '{{$key}}', mode: 'continue', after: { type: 'app.deployed' } } });
    await start();
    await occur('checkout');
    await finish(started[0]!.runId, landed);
    clock.advance(23 * HOUR);
    await occur('checkout');
    expect(heard).toEqual([]);
    clock.advance(2 * HOUR);
    await occur('checkout');
    expect(heard).toHaveLength(1);
  });

  it('leaves a task that changed nothing alone until the event has grown tenfold', async () => {
    await series(errors);
    await start();
    await occur('timeout', 2);
    await finish(started[0]!.runId); // "not ours": no pull request
    await occur('timeout', 10);
    expect(heard).toEqual([]);
    await occur('timeout', 8);
    expect(heard).toHaveLength(1);
    expect(heard[0]!.text).toMatch(/came again after it finished: 18 more times/);
  });

  it('treats a cancelled task as turned down, and frees a key whose task is gone', async () => {
    const fixer = await series(errors);
    await start();
    await occur('noise', 2);
    await finish(started[0]!.runId, {}, 'cancelled');
    await occur('noise', 5);
    expect(started).toHaveLength(1);
    expect(heard).toEqual([]);
    expect(await store.keyedRun(fixer.id, 'noise')).toMatchObject({ state: 'skipped', reason: 'its task was cancelled' });
    await occur('noise', 80);
    expect(started.map((run) => run.trigger)).toMatchObject([{ key: 'noise' }, { key: 'noise', count: 87 }]);
    // Split: a key freed from its task starts a task of its own the next time it comes.
    expect(await store.deleteKeyedRun(fixer.id, 'noise')).toBe(true);
    await occur('noise');
    expect(started).toHaveLength(3);
    expect(await store.keyedRun(fixer.id, 'noise')).toMatchObject({ taskId: started[2]!.runId });
  });
});
