import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '../src/store/db.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { TriggerScheduler } from '../src/platform/trigger-scheduler.js';
import type { TaskRecord, TaskTrigger, KarmaxEvent } from '../src/domain/types.js';
import {
  parseCron,
  nextCronFire,
  validateTriggers,
  normalizeTriggers,
  eventMatchesEventTrigger,
  statusSatisfiesDependency,
  dependencyMet,
  isRecurring,
  forcesRepeatable,
  cloneParamsWithoutTriggers,
  hasActiveTriggers,
} from '../src/domain/triggers.js';

// ─── Pure: cron ──────────────────────────────────────────────────────────────

describe('cron parsing + next-fire (UTC)', () => {
  const at = (iso: string) => Date.parse(iso);

  it('rejects malformed expressions', () => {
    expect(parseCron('* * * *')).toBeUndefined(); // 4 fields
    expect(parseCron('60 * * * *')).toBeUndefined(); // minute out of range
    expect(parseCron('* 24 * * *')).toBeUndefined(); // hour out of range
    expect(parseCron('bad')).toBeUndefined();
    expect(parseCron('*/0 * * * *')).toBeUndefined(); // zero step
  });

  it('accepts stars, lists, ranges, and steps', () => {
    expect(parseCron('*/15 * * * *')).toBeTruthy();
    expect(parseCron('0 9-17 * * 1-5')).toBeTruthy();
    expect(parseCron('0,30 0 1 1 *')).toBeTruthy();
  });

  it('computes the next minute for "*/15 * * * *"', () => {
    const next = nextCronFire('*/15 * * * *', at('2026-01-01T10:07:00Z'));
    expect(new Date(next!).toISOString()).toBe('2026-01-01T10:15:00.000Z');
  });

  it('computes daily 09:00 UTC', () => {
    const next = nextCronFire('0 9 * * *', at('2026-01-01T10:00:00Z'));
    expect(new Date(next!).toISOString()).toBe('2026-01-02T09:00:00.000Z');
  });

  it('is strictly after the input even when the minute matches', () => {
    const next = nextCronFire('0 9 * * *', at('2026-01-01T09:00:00Z'));
    expect(new Date(next!).toISOString()).toBe('2026-01-02T09:00:00.000Z');
  });

  it('honors weekday (Mon 08:00) and rolls across a month/year boundary', () => {
    // 2025-12-31 is a Wednesday; next Monday 08:00 is 2026-01-05.
    const next = nextCronFire('0 8 * * 1', at('2025-12-31T12:00:00Z'));
    expect(new Date(next!).toISOString()).toBe('2026-01-05T08:00:00.000Z');
  });

  it('ORs day-of-month and day-of-week when both are set (standard cron rule)', () => {
    // "0 0 13 * 5" = midnight on the 13th OR any Friday.
    const next = nextCronFire('0 0 13 * 5', at('2026-02-01T00:00:00Z')); // Feb 1 2026 is a Sunday
    // First Friday of Feb 2026 is the 6th — earlier than the 13th.
    expect(new Date(next!).toISOString()).toBe('2026-02-06T00:00:00.000Z');
  });
});

// ─── Event catalog ───────────────────────────────────────────────────────────

describe('event catalog', () => {
  it('merges workflow + platform events with source tags, deduped by type', async () => {
    const { eventCatalog } = await import('../src/contrib/manifests.js');
    const cat = eventCatalog();
    const byType = new Map(cat.map((e) => [e.type, e]));
    // A workflow-declared event carries its workflow as source.
    expect(byType.get('software-dev.stage-changed')?.source).toBe('software-dev');
    // A curated platform event is present with payload fields to filter on.
    const view = byType.get('view.updated');
    expect(view?.source).toBe('platform');
    expect(Object.keys(view!.fields)).toContain('status');
    // No duplicate types.
    expect(new Set(cat.map((e) => e.type)).size).toBe(cat.length);
  });
});

// ─── Pure: matching + helpers ────────────────────────────────────────────────

describe('trigger helpers', () => {
  it('validates each kind', () => {
    expect(validateTriggers([{ kind: 'dependency', tasks: [] }])).toHaveLength(1);
    expect(validateTriggers([{ kind: 'dependency', tasks: ['task_1'] }])).toHaveLength(0);
    expect(validateTriggers([{ kind: 'schedule' }])).toHaveLength(1);
    expect(validateTriggers([{ kind: 'schedule', cron: 'nope' }])).toHaveLength(1);
    expect(validateTriggers([{ kind: 'schedule', cron: '0 9 * * *' }])).toHaveLength(0);
    expect(validateTriggers([{ kind: 'event', type: '' }])).toHaveLength(1);
    expect(validateTriggers([{ kind: 'event', type: 'x.y' }])).toHaveLength(0);
  });

  it('normalizes a single trigger or a list, dropping junk', () => {
    expect(normalizeTriggers({ triggers: { kind: 'schedule', cron: '0 9 * * *' } })).toHaveLength(1);
    expect(normalizeTriggers({ triggers: [{ kind: 'bogus' }, { kind: 'event', type: 'a' }] })).toHaveLength(1);
    expect(hasActiveTriggers({ triggers: [] })).toBe(false);
    expect(hasActiveTriggers({ prompt: 'x' })).toBe(false);
    expect(hasActiveTriggers({ triggers: [{ kind: 'event', type: 'a' }] })).toBe(true);
  });

  it('matches events by type, source task, and payload filter', () => {
    const ev: KarmaxEvent = { type: 'github.pr-merged', taskId: 'task_A', ts: 1, payload: { branch: 'main' } };
    expect(eventMatchesEventTrigger({ kind: 'event', type: 'github.pr-merged' }, ev)).toBe(true);
    expect(eventMatchesEventTrigger({ kind: 'event', type: 'other' }, ev)).toBe(false);
    expect(eventMatchesEventTrigger({ kind: 'event', type: 'github.pr-merged', taskId: 'task_A' }, ev)).toBe(true);
    expect(eventMatchesEventTrigger({ kind: 'event', type: 'github.pr-merged', taskId: 'task_B' }, ev)).toBe(false);
    expect(eventMatchesEventTrigger({ kind: 'event', type: 'github.pr-merged', where: { branch: 'main' } }, ev)).toBe(true);
    expect(eventMatchesEventTrigger({ kind: 'event', type: 'github.pr-merged', where: { branch: 'dev' } }, ev)).toBe(false);
  });

  it('maps dependency `on` conditions to statuses', () => {
    expect(statusSatisfiesDependency('success', 'done')).toBe(true);
    expect(statusSatisfiesDependency('success', 'failed')).toBe(false);
    expect(statusSatisfiesDependency('failed', 'failed')).toBe(true);
    expect(statusSatisfiesDependency('settled', 'cancelled')).toBe(true);
    expect(statusSatisfiesDependency(undefined, 'done')).toBe(true); // default = success
  });

  it('combines multiple deps with all/any', () => {
    const t: TaskTrigger = { kind: 'dependency', tasks: ['a', 'b'] };
    expect(dependencyMet(t, new Set(['a']))).toBe(false);
    expect(dependencyMet(t, new Set(['a', 'b']))).toBe(true);
    expect(dependencyMet({ ...t, mode: 'any' }, new Set(['a']))).toBe(true);
  });

  it('classifies recurrence and strips trigger metadata for clones', () => {
    expect(isRecurring({ kind: 'schedule', cron: '0 9 * * *' })).toBe(true); // cron recurs by default
    expect(isRecurring({ kind: 'schedule', cron: '0 9 * * *', recurring: false })).toBe(false);
    expect(isRecurring({ kind: 'schedule', at: 123 })).toBe(false); // one-shot by default
    expect(isRecurring({ kind: 'dependency', tasks: ['a'] })).toBe(false);
    expect(isRecurring({ kind: 'event', type: 'a', recurring: true })).toBe(true);
    const cloned = cloneParamsWithoutTriggers({ prompt: 'p', triggers: [{ kind: 'schedule', cron: '* * * * *' }], triggerState: 'armed', draft: true });
    expect(cloned).toEqual({ prompt: 'p' });
  });
});

// ─── Dispatcher: TriggerScheduler ────────────────────────────────────────────

class FakeClock {
  time = 0;
  private seq = 0;
  private timers: { id: number; at: number; fn: () => void }[] = [];
  now = () => this.time;
  set = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.timers.push({ id, at: this.time + ms, fn });
    return id;
  };
  clear = (h: unknown) => {
    this.timers = this.timers.filter((t) => t.id !== h);
  };
  /** Advance the clock, firing due timers in chronological order. */
  advance(ms: number) {
    const target = this.time + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.time = due.at;
      due.fn();
    }
    this.time = target;
  }
}

describe('TriggerScheduler (dispatcher)', () => {
  let store: Store;
  let bus: KarmaxBus;
  let fired: [string, string][];
  let clock: FakeClock;
  let projectId: string;

  beforeEach(() => {
    store = new Store(':memory:');
    bus = new KarmaxBus();
    fired = [];
    clock = new FakeClock();
    projectId = store.createProject('P').id;
  });

  const armedTask = (triggers: TaskTrigger[]): TaskRecord => {
    // Mirror createTask: a cron/recurring trigger forces the repeatable series flag.
    const repeatable = forcesRepeatable(triggers) || undefined;
    const t = store.createTask({ projectId, title: 't', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'p', triggers, ...(repeatable ? { repeatable: true } : {}) } });
    store.updateTaskParams(t.id, { ...t.params, triggerState: 'armed' });
    return store.getTask(t.id)!;
  };

  const makeScheduler = () =>
    new TriggerScheduler({
      store,
      bus,
      fire: async (taskId, mode) => {
        fired.push([taskId, mode]);
      },
      now: clock.now,
      setTimer: clock.set,
      clearTimer: clock.clear,
    });

  const emitDone = (taskId: string, status = 'done') =>
    bus.emit({ type: 'view.updated', taskId, ts: 0, payload: { status } } as KarmaxEvent);

  it('re-arms stored armed tasks on start()', () => {
    armedTask([{ kind: 'event', type: 'x.y' }]);
    const s = makeScheduler();
    s.start();
    expect(s.size).toBe(1);
    s.stop();
    expect(s.size).toBe(0);
  });

  it('fires a dependency trigger when the dep completes (one-shot, self)', () => {
    const dep = store.createTask({ projectId, title: 'dep', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'd' } });
    const b = armedTask([{ kind: 'dependency', tasks: [dep.id] }]);
    const s = makeScheduler();
    s.start();
    emitDone(dep.id, 'failed'); // wrong outcome for default `success` → no fire
    expect(fired).toHaveLength(0);
    emitDone(dep.id, 'done');
    expect(fired).toEqual([[b.id, 'self']]);
    expect(s.size).toBe(0); // disarmed after firing
  });

  it('binds dependencies to the logical task, not a cancelled attempt', () => {
    const first = store.createTask({ projectId, title: 'dep', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'first' } });
    const second = store.createTask({ projectId, title: 'dep', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'second', draft: true }, intentId: first.intentId });
    const dependent = armedTask([{ kind: 'dependency', tasks: [first.id], on: 'settled' }]);
    const s = makeScheduler();
    s.start();
    store.saveView(first.id, { taskId: first.id, title: 'dep', workflow: 'just-do', stage: 'cancelled', status: 'cancelled', messages: [], actions: [], state: {}, updatedAt: 1 });
    emitDone(first.id, 'cancelled');
    expect(fired).toHaveLength(0); // second is now principal and still eligible
    store.saveView(second.id, { taskId: second.id, title: 'dep', workflow: 'just-do', stage: 'done', status: 'done', messages: [], actions: [], state: {}, updatedAt: 2 });
    emitDone(second.id, 'done');
    expect(fired).toEqual([[dependent.id, 'self']]);
  });

  it('waits for all deps (mode all) but fires on the first for mode any', () => {
    const a = store.createTask({ projectId, title: 'a', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'a' } });
    const c = store.createTask({ projectId, title: 'c', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'c' } });
    const all = armedTask([{ kind: 'dependency', tasks: [a.id, c.id], mode: 'all' }]);
    const any = armedTask([{ kind: 'dependency', tasks: [a.id, c.id], mode: 'any' }]);
    const s = makeScheduler();
    s.start();
    emitDone(a.id);
    expect(fired).toEqual([[any.id, 'self']]); // any fired; all still waiting
    emitDone(c.id);
    expect(fired).toContainEqual([all.id, 'self']);
  });

  it('fires immediately at arm time if a dependency already completed', () => {
    const dep = store.createTask({ projectId, title: 'dep', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'd' } });
    store.saveView(dep.id, { taskId: dep.id, title: 'dep', workflow: 'just-do', stage: 'done', status: 'done', messages: [], actions: [], state: {}, updatedAt: 0 });
    const b = armedTask([{ kind: 'dependency', tasks: [dep.id] }]);
    const s = makeScheduler();
    s.start();
    expect(fired).toEqual([[b.id, 'self']]);
  });

  it('fires an event trigger on a matching event only', () => {
    const t = armedTask([{ kind: 'event', type: 'github.pr-merged', where: { branch: 'main' } }]);
    const s = makeScheduler();
    s.start();
    bus.emit({ type: 'github.pr-merged', taskId: 'x', ts: 0, payload: { branch: 'dev' } } as KarmaxEvent);
    expect(fired).toHaveLength(0);
    bus.emit({ type: 'github.pr-merged', taskId: 'x', ts: 0, payload: { branch: 'main' } } as KarmaxEvent);
    expect(fired).toEqual([[t.id, 'self']]);
  });

  it('fires a one-shot `at` schedule when the clock reaches it', () => {
    const t = armedTask([{ kind: 'schedule', at: 5000 }]);
    const s = makeScheduler();
    s.start();
    clock.advance(4000);
    expect(fired).toHaveLength(0);
    clock.advance(2000);
    expect(fired).toEqual([[t.id, 'self']]);
    expect(s.size).toBe(0);
  });

  it('fires a cron schedule as a recurring clone and stays armed', () => {
    // every minute; clock starts at 0 → next fire at 60_000.
    const t = armedTask([{ kind: 'schedule', cron: '* * * * *' }]);
    const s = makeScheduler();
    s.start();
    clock.advance(60_000);
    expect(fired).toEqual([[t.id, 'clone']]);
    expect(s.size).toBe(1); // still armed for the next occurrence
    clock.advance(60_000);
    expect(fired).toEqual([
      [t.id, 'clone'],
      [t.id, 'clone'],
    ]);
  });

  it('routes real bus events end-to-end through KarmaxApi arming', async () => {
    store.updateProjectConfig(projectId, { repos: ['/tmp/karmax-test-repo'] }); // satisfy the repo guard
    // A fake Temporal client that just records started workflow ids.
    const started: string[] = [];
    const client = { workflow: { start: async (_t: string, opts: { workflowId: string }) => void started.push(opts.workflowId), getHandle: () => ({}) } } as any;
    const tokens = new TokenAuthority();
    const token = tokens.mintPrincipal('u', ['*']).token;
    const api = new KarmaxApi({ store, client, taskQueue: 'q', tokens });
    const scheduler = new TriggerScheduler({ store, bus, fire: (id, mode) => api.fireTriggeredTask(token, id, mode) });
    api.setTriggerArmer(scheduler);
    scheduler.start();

    // A dependency task, and a task armed to run after it succeeds.
    const dep = await api.createTask(token, { projectId, workflow: 'just-do', params: { prompt: 'd' } });
    const b = await api.createTask(token, { projectId, workflow: 'just-do', params: { prompt: 'b', triggers: [{ kind: 'dependency', tasks: [dep.id] }] } });
    expect(b.params.triggerState).toBe('armed');
    expect(started).not.toContain(b.id); // armed, not started
    expect(scheduler.size).toBe(1);

    // Simulate the dep completing on the bus → dispatcher fires b.
    bus.emit({ type: 'view.updated', taskId: dep.id, ts: 0, payload: { status: 'done' } } as KarmaxEvent);
    await new Promise((r) => setTimeout(r, 0)); // let the async fire settle
    expect(started).toContain(b.id);
    expect(scheduler.size).toBe(0);
  });

  it('queuing a triggered draft arms it instead of starting now', async () => {
    store.updateProjectConfig(projectId, { repos: ['/tmp/karmax-test-repo'] }); // satisfy the repo guard
    const started: string[] = [];
    const client = { workflow: { start: async (_t: string, opts: { workflowId: string }) => void started.push(opts.workflowId), getHandle: () => ({}) } } as any;
    const tokens = new TokenAuthority();
    const token = tokens.mintPrincipal('u', ['*']).token;
    const api = new KarmaxApi({ store, client, taskQueue: 'q', tokens });
    const armed = new Set<string>();
    api.setTriggerArmer({ arm: (t) => armed.add(t.id), disarm: (id) => armed.delete(id) });

    // Save as a draft that carries a trigger, then queue it.
    const draft = await api.createTask(token, { projectId, workflow: 'just-do', draft: true, params: { prompt: 'p', triggers: [{ kind: 'event', type: 'x.y' }] } });
    expect(draft.params.draft).toBe(true);
    expect(draft.num).toBeUndefined();
    expect(armed.has(draft.id)).toBe(false); // a draft isn't armed yet
    const queued = await api.queueTask(token, draft.id);
    expect(queued.num).toBe(1); // arming is this task's queue transition
    expect(queued.params.triggerState).toBe('armed');
    expect(queued.params.draft).toBe(false);
    expect(armed.has(draft.id)).toBe(true);
    expect(started).toHaveLength(0); // arming does NOT start the workflow
  });

  it('edits a waiting (armed) task in place, re-arming with new triggers', async () => {
    store.updateProjectConfig(projectId, { repos: ['/tmp/karmax-test-repo'] });
    const started: string[] = [];
    const client = { workflow: { start: async (_t: string, opts: { workflowId: string }) => void started.push(opts.workflowId), getHandle: () => ({}) } } as any;
    const tokens = new TokenAuthority();
    const token = tokens.mintPrincipal('u', ['*']).token;
    const api = new KarmaxApi({ store, client, taskQueue: 'q', tokens });
    const armCalls: string[] = [];
    const disarmCalls: string[] = [];
    api.setTriggerArmer({ arm: (t) => armCalls.push(t.id), disarm: (id) => disarmCalls.push(id) });

    const t = await api.createTask(token, { projectId, workflow: 'just-do', params: { prompt: 'p', triggers: [{ kind: 'event', type: 'a.b' }] } });
    expect(t.params.triggerState).toBe('armed');
    expect(t.title).toBe('p'); // title derived from the prompt at creation

    // Edit its triggers in place, keep it armed.
    const edited = await api.updateArmedParams(token, t.id, { prompt: 'p2', triggers: [{ kind: 'event', type: 'c.d' }] }, { replace: true, keepArmed: true });
    expect(edited.params.triggerState).toBe('armed');
    expect((edited.params.triggers as any)[0].type).toBe('c.d');
    expect(edited.params.prompt).toBe('p2');
    expect(edited.title).toBe('p2'); // display title tracks the edited prompt
    expect(armCalls.filter((id) => id === t.id).length).toBe(2); // armed on create + re-armed on edit
    expect(started).toHaveLength(0);

    // Save-as-draft disarms it.
    const asDraft = await api.updateArmedParams(token, t.id, { prompt: 'p3', triggers: [{ kind: 'event', type: 'c.d' }] }, { replace: true, keepArmed: false });
    expect(asDraft.params.draft).toBe(true);
    expect(asDraft.params.triggerState).toBeUndefined();
    expect(disarmCalls).toContain(t.id);
  });

  it('a triggerless repeatable task is a series that spawns run #1 on create', async () => {
    store.updateProjectConfig(projectId, { repos: ['/tmp/karmax-test-repo'] });
    const started: string[] = [];
    const client = { workflow: { start: async (_t: string, opts: { workflowId: string }) => void started.push(opts.workflowId), getHandle: () => ({}) } } as any;
    const tokens = new TokenAuthority();
    const token = tokens.mintPrincipal('u', ['*']).token;
    const api = new KarmaxApi({ store, client, taskQueue: 'q', tokens });

    const series = await api.createTask(token, { projectId, workflow: 'just-do', params: { prompt: 'p', repeatable: true } });
    expect(series.params.repeatable).toBe(true);
    // The series itself never starts; run #1 did.
    expect(started).not.toContain(series.id);
    const runs = store.runsOf(series.id);
    expect(runs).toHaveLength(1);
    expect(started).toContain(runs[0]!.id);
    expect(runs[0]!.params.runOf).toBe(series.id);
    expect(runs[0]!.params.repeatable).toBeUndefined(); // a run is a plain one-off

    // "Run again" spawns another run, series stays put.
    await api.runAgain(token, series.id);
    expect(store.runsOf(series.id)).toHaveLength(2);
  });

  it('a cron trigger forces repeatable, and each fire spawns a run (series stays armed)', async () => {
    store.updateProjectConfig(projectId, { repos: ['/tmp/karmax-test-repo'] });
    const started: string[] = [];
    const client = { workflow: { start: async (_t: string, opts: { workflowId: string }) => void started.push(opts.workflowId), getHandle: () => ({}) } } as any;
    const tokens = new TokenAuthority();
    const token = tokens.mintPrincipal('u', ['*']).token;
    const api = new KarmaxApi({ store, client, taskQueue: 'q', tokens });
    const scheduler = new TriggerScheduler({ store, bus, fire: (id, mode) => api.fireTriggeredTask(token, id, mode), now: clock.now, setTimer: clock.set, clearTimer: clock.clear });
    api.setTriggerArmer(scheduler);
    scheduler.start();

    // cron every minute; clock starts at 0.
    const series = await api.createTask(token, { projectId, workflow: 'just-do', params: { prompt: 'p', triggers: [{ kind: 'schedule', cron: '* * * * *' }] } });
    expect(series.params.repeatable).toBe(true); // forced by the cron trigger
    expect(series.params.triggerState).toBe('armed');
    expect(store.runsOf(series.id)).toHaveLength(0); // waits for the first fire

    clock.advance(60_000);
    await new Promise((r) => setTimeout(r, 0));
    expect(store.runsOf(series.id)).toHaveLength(1);
    expect(scheduler.size).toBe(1); // series stays armed for the next occurrence
    clock.advance(60_000);
    await new Promise((r) => setTimeout(r, 0));
    expect(store.runsOf(series.id)).toHaveLength(2);
  });

  it('disarm() cancels timers and event routing', () => {
    const t = armedTask([{ kind: 'schedule', at: 5000 }]);
    const s = makeScheduler();
    s.start();
    s.disarm(t.id);
    clock.advance(10_000);
    expect(fired).toHaveLength(0);
    expect(s.size).toBe(0);
  });
});
