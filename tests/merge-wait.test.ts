import { describe, it, expect } from 'vitest';
import { makeCoordinatorActivities } from '../src/activities/coordinator.js';
import { samePosition, MERGE_POLL } from '../src/domain/types.js';

/**
 * Regressions from the 2026-07-28 incident: task #345 sat at "merge queued" for
 * ~11 hours while every surface said the merge queue was empty, and was then
 * TERMINATED by Temporal for exceeding its history size limit.
 *
 * Root cause was a wedged merge-queue coordinator (a nondeterminism error
 * retries its workflow task forever), but two separate defects turned that
 * recoverable stall into silent, permanent task death:
 *   1. a failed coordinator query was reported as an empty queue, and
 *   2. the acquire loop re-published the entire task view every 5 seconds.
 */

const stubClient = (query: () => unknown) => ({
  workflow: {
    getHandle: () => ({ query: async () => query() }),
    async signalWithStart() {}, // absent-task re-enqueue; asserted in coordinator-health
  },
}) as never;

const coord = (query: () => unknown) =>
  makeCoordinatorActivities({ client: stubClient(query), taskQueue: 'test' });

describe('merge-queue position reporting', () => {
  it('reports a coordinator that cannot be queried as unreachable, not empty', async () => {
    const act = coord(() => { throw new Error('workflow task is failing; query never resolves'); });
    const pos = await act.mergeQueuePosition('repo:main', 'task_a');

    // The pre-fix return was exactly {position:-1,total:0} — indistinguishable
    // from "the queue is empty and you aren't in it", which is what made the
    // real incident unreadable from the UI.
    expect(pos.unreachable).toBe(true);
  });

  it('does not flag a healthy coordinator as unreachable', async () => {
    const act = coord(() => ({ queue: ['task_b', 'task_a'], current: 'task_holder' }));
    const pos = await act.mergeQueuePosition('repo:main', 'task_a');

    expect(pos).toMatchObject({ position: 2, total: 3, current: 'task_holder' });
    expect(pos.unreachable).toBeUndefined();
  });

  it('an answering queue and a wedged one are never confusable', async () => {
    // A queue that answers can no longer leave us un-queued: an absent task
    // re-enqueues and gets a real slot, so "position -1" now means exactly one
    // thing — nobody answered. That is the distinction the incident needed.
    const answered = await coord(() => ({ queue: [] })).mergeQueuePosition('repo:main', 'task_a');
    const wedged = await coord(() => { throw new Error('x'); }).mergeQueuePosition('repo:main', 'task_a');

    expect(answered).toMatchObject({ position: 1, total: 1 });
    expect(answered.unreachable).toBeUndefined();
    expect(wedged).toMatchObject({ position: -1, total: 0, unreachable: true });
    expect(samePosition(answered, wedged)).toBe(false);
  });
});

describe('a task parked in the merge queue stays inside Temporal history limits', () => {
  it('suppresses a republish only while the position is genuinely unchanged', () => {
    expect(samePosition({ position: 3, total: 5 }, { position: 3, total: 5 })).toBe(true);
    expect(samePosition({ position: 3, total: 5 }, { position: 2, total: 5 })).toBe(false);
    expect(samePosition({ position: 3, total: 5 }, { position: 3, total: 4 })).toBe(false);
    expect(samePosition(undefined, { position: 3, total: 5 })).toBe(false);
  });

  it('never suppresses the moment a queue becomes unreachable', () => {
    // The numbers are identical, so a position-only comparison would hide a
    // coordinator going down behind an unchanging view. It must still publish.
    expect(samePosition(
      { position: -1, total: 0 },
      { position: -1, total: 0, unreachable: true },
    )).toBe(false);
  });

  it('polls slowly enough to survive a day of queueing', () => {
    // Temporal terminates a workflow past ~51,200 events (or 50MB). Each poll
    // tick costs roughly a workflow task (3) + the position activity (3) + the
    // timer (2). At the pre-fix 5s cadence — with a full view republished every
    // tick on top — #345 burned 29,060 events and ~50MB in under 12 hours.
    const EVENTS_PER_TICK = 12;
    const HISTORY_EVENT_CAP = 51_200;

    const seconds = Number(MERGE_POLL.replace('s', ''));
    expect(Number.isFinite(seconds)).toBe(true);

    const hoursOfHeadroom = (HISTORY_EVENT_CAP / EVENTS_PER_TICK) * seconds / 3600;
    expect(hoursOfHeadroom).toBeGreaterThan(24);
  });
});
