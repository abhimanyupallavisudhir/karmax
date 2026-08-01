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

  it('treats "N/step" as "N-max/step" (standard cron), not a single value', () => {
    // "5/15" in the minute field means 5,20,35,50 — not just minute 5.
    const next = nextCronFire('5/15 * * * *', at('2026-01-01T10:06:00Z'));
    expect(new Date(next!).toISOString()).toBe('2026-01-01T10:20:00.000Z');
    const wrap = nextCronFire('5/15 * * * *', at('2026-01-01T10:55:00Z'));
    expect(new Date(wrap!).toISOString()).toBe('2026-01-01T11:05:00.000Z');
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

  it('arms a Feb-29 cron that is years away, instead of silently never firing', () => {
    // Regression: the search horizon was 366 days, so every `* * 29 2 *` returned
    // undefined. TriggerScheduler.armCron's undefined branch sets no timer at all,
    // so the task stayed "armed" forever and never ran.
    const next = nextCronFire('0 0 29 2 *', at('2026-07-27T00:00:00Z'));
    expect(new Date(next!).toISOString()).toBe('2028-02-29T00:00:00.000Z');
    // The worst legal gap is a century non-leap year: 2096 → 2104.
    const century = nextCronFire('0 0 29 2 *', at('2096-03-01T00:00:00Z'));
    expect(new Date(century!).toISOString()).toBe('2104-02-29T00:00:00.000Z');
  });

  it('rejects a parseable but impossible cron rather than arming a dead task', () => {
    // Feb 30 never occurs. It used to validate fine and then never fire.
    expect(nextCronFire('0 0 30 2 *', at('2026-01-01T00:00:00Z'))).toBeUndefined();
    expect(validateTriggers([{ kind: 'schedule', cron: '0 0 30 2 *' } as TaskTrigger]))
      .toEqual([expect.stringContaining('never occurs')]);
    // A far-future-but-real schedule must still validate.
    expect(validateTriggers([{ kind: 'schedule', cron: '0 0 29 2 *' } as TaskTrigger])).toEqual([]);
  });

  it('rejects malformed ranges instead of reading them as 0-N', () => {
    // `Number('') === 0`, so `-5` used to parse as "minutes 0 through 5": the dash
    // sits at index 0, the low token is empty, and 0 passes Number.isInteger. The
    // typo then ran the task six times an hour. Same for every field whose min is 0.
    expect(parseCron('-5 * * * *')).toBeUndefined();
    expect(parseCron('* -3 * * *')).toBeUndefined();
    expect(parseCron('5- * * * *')).toBeUndefined(); // empty high token
    expect(parseCron('* * * * -2')).toBeUndefined();
    expect(parseCron('+5 * * * *')).toBeUndefined(); // Number('+5') is 5, but this is not cron
    expect(parseCron('*/ * * * *')).toBeUndefined(); // empty step
    // Well-formed ranges still parse.
    expect(parseCron('0-5 * * * *')).toBeTruthy();
  });

  it('accepts 7 as Sunday in day-of-week (POSIX cron)', () => {
    expect(parseCron('0 9 * * 7')).toBeTruthy();
    // 2026-01-04 is a Sunday; from Jan 2 the next `7` (Sunday) 09:00 is Jan 4.
    const next = nextCronFire('0 9 * * 7', at('2026-01-02T12:00:00Z'));
    expect(new Date(next!).toISOString()).toBe('2026-01-04T09:00:00.000Z');
    // 0 and 7 mean the same day.
    expect(nextCronFire('0 9 * * 0', at('2026-01-02T12:00:00Z'))).toBe(next);
    // A range spanning into 7 normalizes too (6-7 = Saturday + Sunday).
    expect(nextCronFire('0 9 * * 6-7', at('2026-01-01T12:00:00Z')))
      .toBe(at('2026-01-03T09:00:00Z')); // Saturday Jan 3
    expect(parseCron('0 9 * * 8')).toBeUndefined();
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

  it('rejects the two zombie schedule shapes', () => {
    // `at` + recurring: armSchedule sets one timer and fireFor never disarms a
    // repeatable entry, so it fires once and then sits armed forever with no timer.
    expect(validateTriggers([{ kind: 'schedule', at: 1_000, recurring: true }]))
      .toEqual([expect.stringContaining('cannot be recurring')]);
    expect(validateTriggers([{ kind: 'schedule', at: 1_000 }])).toHaveLength(0);
    // cron + at: armSchedule checks `at` first and silently drops the cron.
    expect(validateTriggers([{ kind: 'schedule', cron: '0 9 * * *', at: 1_000 }]))
      .toEqual([expect.stringContaining('not both')]);
  });

  it('rejects self-reference, dangling deps, and cycles in the dependency graph', () => {
    // Graph-shaped errors are invisible at runtime: the dispatcher simply never
    // fires, so the task sits `armed` forever with no signal.
    const graph: Record<string, string[]> = { a: [], b: ['a'], c: ['b'] };
    const dependenciesOf = (id: string) => graph[id];

    // self-reference (the web picker's exclusion is client-side only)
    expect(validateTriggers([{ kind: 'dependency', tasks: ['me'] }], { taskId: 'me' }))
      .toEqual([expect.stringContaining('cannot depend on itself')]);

    // dangling / deleted dep id
    expect(validateTriggers([{ kind: 'dependency', tasks: ['gone'] }], { taskId: 'me', dependenciesOf }))
      .toEqual([expect.stringContaining('does not exist')]);

    // A→B→A cycle: `a` would depend on `c`, but c→b→a already reaches a.
    expect(validateTriggers([{ kind: 'dependency', tasks: ['c'] }], { taskId: 'a', dependenciesOf }))
      .toEqual([expect.stringContaining('cycle')]);

    // A legal edge in the same graph still validates.
    expect(validateTriggers([{ kind: 'dependency', tasks: ['c'] }], { taskId: 'd', dependenciesOf })).toEqual([]);
    // Without a resolver, only self-reference is checkable (back-compat).
    expect(validateTriggers([{ kind: 'dependency', tasks: ['gone'] }])).toEqual([]);
  });

  it('terminates on a pre-existing cycle elsewhere in the graph', () => {
    const graph: Record<string, string[]> = { x: ['y'], y: ['x'], z: ['x'] };
    expect(validateTriggers([{ kind: 'dependency', tasks: ['z'] }],
      { taskId: 'new', dependenciesOf: (id) => graph[id] })).toEqual([]);
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
    const cloned = cloneParamsWithoutTriggers({ prompt: 'p', triggers: [{ kind: 'schedule', cron: '* * * * *' }], triggerState: 'armed', triggerPending: true, draft: true });
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

  it('does not re-fire a repeatable dependency series on duplicate lifecycle events', () => {
    const dep = store.createTask({ projectId, title: 'dep', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'd' } });
    const series = store.createTask({ projectId, title: 'series', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'p', repeatable: true, triggers: [{ kind: 'dependency', tasks: [dep.id] }] } });
    store.updateTaskParams(series.id, { ...series.params, triggerState: 'armed' });
    const s = makeScheduler();
    s.start();
    // A finishing task emits several terminal `view.updated` events; a repeatable
    // series never disarms, so only the first (newly-satisfied) one may fire.
    emitDone(dep.id, 'done');
    emitDone(dep.id, 'done');
    emitDone(dep.id, 'done');
    expect(fired).toEqual([[series.id, 'clone']]);
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

  it('holds an event activation across a restart until dependencies finish', async () => {
    const dep = store.createTask({ projectId, title: 'dep', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'd' } });
    const t = armedTask([
      { kind: 'dependency', tasks: [dep.id] },
      { kind: 'event', type: 'release.approved' },
    ]);
    const first = makeScheduler();
    first.start();

    bus.emit({ type: 'release.approved', taskId: 'release', ts: 0, payload: {} } as KarmaxEvent);
    expect(fired).toHaveLength(0);
    expect(store.getTask(t.id)!.params.triggerPending).toBe(true);

    first.stop();
    const restarted = makeScheduler();
    restarted.start();
    emitDone(dep.id);
    expect(fired).toEqual([[t.id, 'self']]);
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getTask(t.id)!.params.triggerPending).toBeUndefined();
    restarted.stop();
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

  it('waits for dependencies when a one-shot schedule becomes due first', () => {
    const dep = store.createTask({ projectId, title: 'dep', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'd' } });
    const t = armedTask([
      { kind: 'dependency', tasks: [dep.id] },
      { kind: 'schedule', at: 5000 },
    ]);
    const s = makeScheduler();
    s.start();

    clock.advance(5000);
    expect(fired).toHaveLength(0); // due, but its prerequisite is still running
    expect(s.size).toBe(1);

    emitDone(dep.id);
    expect(fired).toEqual([[t.id, 'self']]);
    expect(s.size).toBe(0);
  });

  it('waits for the one-shot schedule when dependencies finish first', () => {
    const dep = store.createTask({ projectId, title: 'dep', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'd' } });
    const t = armedTask([
      { kind: 'dependency', tasks: [dep.id] },
      { kind: 'schedule', at: 5000 },
    ]);
    const s = makeScheduler();
    s.start();

    emitDone(dep.id);
    expect(fired).toHaveLength(0); // prerequisite met, but the earliest start is still ahead

    clock.advance(5000);
    expect(fired).toEqual([[t.id, 'self']]);
    expect(s.size).toBe(0);
  });

  it('fires a cron schedule as a recurring clone and stays armed', async () => {
    // every minute; clock starts at 0 → next fire at 60_000.
    const t = armedTask([{ kind: 'schedule', cron: '* * * * *' }]);
    const s = makeScheduler();
    s.start();
    clock.advance(60_000);
    expect(fired).toEqual([[t.id, 'clone']]);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.size).toBe(1); // still armed for the next occurrence
    clock.advance(60_000);
    await new Promise((r) => setTimeout(r, 0));
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

  /**
   * Pausing is not missing. `cancelTrigger` stripped `triggerState` but kept
   * `triggerLastFiredAt`, so a cron task paused for days and then re-queued
   * looked to `catchUpCron` like one that had slept through an occurrence — and
   * fired a spurious run the moment it was re-queued. A task deliberately not
   * armed has nothing to catch up on.
   */
  it('re-queuing a paused cron task does not fire a catch-up run', async () => {
    store.updateProjectConfig(projectId, { repos: ['/tmp/karmax-test-repo'] });
    const client = { workflow: { start: async () => {}, getHandle: () => ({}) } } as any;
    const tokens = new TokenAuthority();
    const token = tokens.mintPrincipal('u', ['*']).token;
    const api = new KarmaxApi({ store, client, taskQueue: 'q', tokens });
    api.setTriggerArmer({ arm: () => {}, disarm: () => {} });

    const t = await api.createTask(token, { projectId, workflow: 'just-do',
      params: { prompt: 'p', triggers: [{ kind: 'schedule', cron: '0 9 * * *' }] } });
    // It has fired before, a week ago — the mark a real armed cron carries.
    store.updateTaskParams(t.id, {
      ...store.getTask(t.id)!.params, triggerLastFiredAt: Date.parse('2026-01-01T09:00:00Z'),
    });

    await api.cancelTrigger(token, t.id); // pause it
    // The stale mark must not survive the pause, or the re-queue below catches up.
    expect(store.getTask(t.id)!.params.triggerLastFiredAt).toBeUndefined();

    await api.queueTask(token, t.id); // re-queue, days later
    const fired: [string, string][] = [];
    const s = new TriggerScheduler({ store, bus, fire: async (id, mode) => void fired.push([id, mode]),
      now: () => Date.parse('2026-01-08T10:00:00Z'), setTimer: clock.set, clearTimer: clock.clear });
    s.start();
    expect(fired).toHaveLength(0); // no phantom run for the week it was paused
    s.stop();
  });

  it('rejects an invalid trigger graph BEFORE marking the task armed', async () => {
    store.updateProjectConfig(projectId, { repos: ['/tmp/karmax-test-repo'] });
    const client = { workflow: { start: async () => {}, getHandle: () => ({}) } } as any;
    const tokens = new TokenAuthority();
    const token = tokens.mintPrincipal('u', ['*']).token;
    const api = new KarmaxApi({ store, client, taskQueue: 'q', tokens });
    // A real armer rejects a self-dependency — the graph half of validation, which
    // only the armer can do because it needs the store to resolve dependency ids.
    api.setTriggerArmer({
      arm: () => { throw new Error('invalid trigger(s): a task cannot depend on itself'); },
      disarm: () => {},
      validationErrors: () => ['a task cannot depend on itself'],
    });

    const draft = await api.createTask(token, { projectId, workflow: 'just-do', draft: true,
      params: { prompt: 'p', triggers: [{ kind: 'event', type: 'x.y' }] } });
    await expect(api.queueTask(token, draft.id)).rejects.toThrow(/depend on itself/);

    // The decisive part: the rejection left NOTHING behind. Validation used to run
    // after clearDraft + `triggerState: armed` were already persisted, so a task the
    // dispatcher had refused sat marked `armed` but unregistered — waiting forever,
    // indistinguishable from one that is legitimately still waiting.
    const after = store.getTask(draft.id)!;
    expect(after.params.triggerState).not.toBe('armed');
    expect(after.params.draft).toBe(true);
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

  it('does not double-fire a cron occurrence when the clock steps backwards', () => {
    // The timer callback used to re-arm from `this.now()`, and nextCronFire floors
    // to the whole minute — so a clock reading even 1 ms BEFORE the instant that
    // just fired (backward NTP step, VM resume, early libuv timer) returned that
    // same instant and fired it a second time. Nothing dedupes it: a repeatable
    // entry never sets `fired`.
    const lagging = () => Math.max(0, clock.now() - 1);
    const t = armedTask([{ kind: 'schedule', cron: '* * * * *' }]);
    const s = new TriggerScheduler({ store, bus, fire: async (id, mode) => void fired.push([id, mode]),
      now: lagging, setTimer: clock.set, clearTimer: clock.clear });
    s.start();
    clock.advance(60_100);
    expect(fired).toEqual([[t.id, 'clone']]); // exactly one fire for the 60s occurrence
    s.stop();
  });

  it('catches up on a cron occurrence missed while karmax was down (exactly once)', () => {
    const nine = (day: string) => Date.parse(`2026-01-${day}T09:00:00Z`);
    const t = armedTask([{ kind: 'schedule', cron: '0 9 * * *' }]);
    // Pretend it last fired on Jan 1 and karmax was then down for a week.
    store.updateTaskParams(t.id, { ...store.getTask(t.id)!.params, triggerLastFiredAt: nine('01') });
    clock.time = Date.parse('2026-01-08T10:00:00Z');
    const s = makeScheduler();
    s.start();
    // One catch-up run — not seven, one per missed day.
    expect(fired).toEqual([[t.id, 'clone']]);
    expect(store.getTask(t.id)!.params.triggerLastFiredAt).toBe(nine('08'));
    // ...and it is still armed for tomorrow, not re-firing today's.
    expect(s.size).toBe(1);
    clock.advance(3600_000);
    expect(fired).toHaveLength(1);
    s.stop();
  });

  it('durably holds a due cron occurrence until its dependencies finish', async () => {
    const dep = store.createTask({ projectId, title: 'dep', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'd' } });
    const series = armedTask([
      { kind: 'dependency', tasks: [dep.id] },
      { kind: 'schedule', cron: '* * * * *' },
    ]);
    const first = makeScheduler();
    first.start();

    clock.advance(120_000); // two blocked occurrences coalesce into one pending run
    expect(fired).toHaveLength(0);
    expect(store.getTask(series.id)!.params.triggerPending).toBe(true);

    first.stop();
    const restarted = makeScheduler();
    restarted.start();
    expect(fired).toHaveLength(0);

    emitDone(dep.id);
    expect(fired).toEqual([[series.id, 'clone']]);
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getTask(series.id)!.params.triggerPending).toBeUndefined();

    clock.advance(60_000);
    expect(fired).toEqual([[series.id, 'clone'], [series.id, 'clone']]);
    restarted.stop();
  });

  it('keeps a claimed cron occurrence pending when its run fails to start', async () => {
    const series = armedTask([{ kind: 'schedule', cron: '* * * * *' }]);
    let failedAttempts = 0;
    const first = new TriggerScheduler({
      store,
      bus,
      fire: async () => {
        failedAttempts += 1;
        throw new Error('engine unavailable');
      },
      now: clock.now,
      setTimer: clock.set,
      clearTimer: clock.clear,
    });
    first.start();
    clock.advance(60_000);
    await new Promise((r) => setTimeout(r, 0));
    expect(failedAttempts).toBe(1);
    expect(store.getTask(series.id)!.params.triggerPending).toBe(true);

    first.stop();
    const restarted = makeScheduler();
    restarted.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(fired).toEqual([[series.id, 'clone']]);
    expect(store.getTask(series.id)!.params.triggerPending).toBeUndefined();
    restarted.stop();
  });

  it('seeds the catch-up mark on first arm rather than firing retroactively', () => {
    clock.time = Date.parse('2026-01-08T10:00:00Z');
    const t = armedTask([{ kind: 'schedule', cron: '0 9 * * *' }]);
    const s = makeScheduler();
    s.start();
    expect(fired).toHaveLength(0); // never fired before ⇒ nothing to catch up on
    expect(store.getTask(t.id)!.params.triggerLastFiredAt).toBe(clock.time);
    // A mark with no elapsed occurrence is likewise inert across a restart.
    s.stop();
    const again = makeScheduler();
    again.start();
    expect(fired).toHaveLength(0);
    again.stop();
  });

  it('re-fires a repeatable dependency series each time the dep completes again', () => {
    const dep = store.createTask({ projectId, title: 'dep', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'd' } });
    const series = store.createTask({ projectId, title: 'series', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'p', repeatable: true, triggers: [{ kind: 'dependency', tasks: [dep.id] }] } });
    store.updateTaskParams(series.id, { ...series.params, triggerState: 'armed' });
    const s = makeScheduler();
    s.start();
    emitDone(dep.id, 'done');
    expect(fired).toHaveLength(1);
    // The dep genuinely runs again: it reports a non-terminal status first, which
    // must drop it back out of the satisfied set (which used to be append-only, so
    // the series fired at most once in its whole life and then sat armed doing nothing).
    emitDone(dep.id, 'active');
    emitDone(dep.id, 'done');
    expect(fired).toEqual([[series.id, 'clone'], [series.id, 'clone']]);
    // Duplicate terminal events are still deduped.
    emitDone(dep.id, 'done');
    expect(fired).toHaveLength(2);
    s.stop();
  });

  it('fires a repeatable series once per event, not once per matching trigger', () => {
    const series = store.createTask({ projectId, title: 'series', workflow: 'just-do', workflowVersion: '1.0.0',
      params: { prompt: 'p', repeatable: true, triggers: [
        { kind: 'event', type: 'x.y', recurring: true },
        { kind: 'event', type: 'x.y', where: { a: 1 }, recurring: true },
      ] } });
    store.updateTaskParams(series.id, { ...series.params, triggerState: 'armed' });
    const s = makeScheduler();
    s.start();
    bus.emit({ type: 'x.y', taskId: 'z', ts: 0, payload: { a: 1 } } as KarmaxEvent);
    expect(fired).toEqual([[series.id, 'clone']]); // both triggers matched; one run
    s.stop();
  });

  it('refuses to arm an unsatisfiable dependency graph instead of waiting forever', () => {
    const t = store.createTask({ projectId, title: 'self', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'p' } });
    store.updateTaskParams(t.id, { triggers: [{ kind: 'dependency', tasks: [t.id] }], triggerState: 'armed' } as any);
    const s = makeScheduler();
    expect(() => s.arm(store.getTask(t.id)!)).toThrow(/itself/);

    const dangling = armedTask([{ kind: 'dependency', tasks: ['task_deleted'] }]);
    expect(() => s.arm(store.getTask(dangling.id)!)).toThrow(/does not exist/);

    // Boot must survive a stored row that has gone bad: it logs and arms the rest.
    const logs: string[] = [];
    const booted = new TriggerScheduler({ store, bus, fire: async () => {}, now: clock.now,
      setTimer: clock.set, clearTimer: clock.clear, log: (m) => logs.push(m) });
    const ok = armedTask([{ kind: 'event', type: 'a.b' }]);
    booted.start();
    expect(logs.some((l) => l.includes('refusing to arm'))).toBe(true);
    expect(booted.size).toBe(1);
    expect(store.getTask(ok.id)).toBeTruthy();
    booted.stop();
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
