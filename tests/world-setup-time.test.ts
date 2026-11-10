import { afterEach, expect, it, vi } from 'vitest';
import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { SetupClock, SetupTimeout } from '../src/world/setup-clock.js';
import type { SetupTime } from '../src/world/setup-clock.js';

// pramana #191 (task_mw99g7e57bfec55b52, 2026-11-09): a sub-task's 31 GB,
// 1.2M-file copy of its parent's raw_data restored into a Fly volume at
// ~20 MB/s while `createWorld` had 30 minutes for everything. Each attempt
// timed out restoring, threw its machine away with what it had restored and
// started over: 18 attempts in 9 h, then "infrastructure: Activity task timed
// out → activity StartToClose timeout (still failing after 5 waits)". Setup
// now has 30 minutes for everything but restoring data, which takes as long
// as it keeps moving.

let store: Store;
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await store?.close(); });

const MINUTE = 60_000;
const handle = { id: 'setup-time', kind: 'memory', root: '/fixture', base: 'main', branch: 'task' };

async function fixture(options: { create?: () => Promise<unknown>; materialize?: (clock: SetupTime | undefined) => Promise<unknown> }) {
  store = await Store.create(':memory:');
  const project = await store.createProject('Setup time');
  const task = await store.createTask({ projectId: project.id, title: 'Big data', workflow: 'software-dev',
    workflowVersion: '1.30.0', params: { prompt: 'fixture' } });
  const destroyed = vi.fn(async () => {});
  // Real I/O comes first (the store, the git profile); fake time passes only once setup is in the step under test.
  let reached!: () => void;
  const entered = new Promise<void>((resolve) => { reached = resolve; });
  const worlds = new WorldRegistry();
  worlds.register({ kind: 'memory', create: async () => {
    if (options.create) { reached(); await options.create(); }
    return { handle: { ...handle, id: task.id }, destroy: destroyed };
  } } as any);
  const heartbeat = vi.fn();
  const cancel = new AbortController();
  vi.spyOn(Context, 'current').mockReturnValue({ heartbeat, cancellationSignal: cancel.signal,
    info: { attempt: 1, workflowExecution: { runId: 'run', workflowId: task.id }, activityId: 'setup',
      currentAttemptScheduledTimestampMs: Date.now(), startToCloseTimeoutMs: 12 * 60 * MINUTE } } as any);
  const core = makeCoreActivities({ store, worlds, adapters: new Map(), profiles: new ProfileResolver(store, 'mock'),
    resources: { materialize: async (_p: string, _t: string, world: any, _g: number, _r: unknown, opts: { clock?: SetupTime }) => {
      reached();
      await options.materialize?.(opts.clock);
      return world.handle;
    }, release: async () => {} } as any });
  return { core, task, project, destroyed, cancel, entered };
}

/** Let fake time pass a minute at a time, so intervals and awaits interleave. */
async function pass(ms: number, each = MINUTE) {
  for (let left = ms; left > 0; left -= each) await vi.advanceTimersByTimeAsync(Math.min(each, left));
}

it('lets a restore that keeps moving run past the 30-minute setup budget', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  let restored = false;
  const f = await fixture({ materialize: async (clock) => {
    expect(clock).toBeDefined();
    await clock!.offClock(async (progress) => {
      // 45 minutes of restoring, moving every minute: 31 GB at ~12 MB/s.
      for (let minute = 0; minute < 45; minute++) { await new Promise((resolve) => setTimeout(resolve, MINUTE)); progress(); }
      restored = true;
    });
  } });
  const creating = f.core.createWorld({ taskId: f.task.id, projectId: f.project.id, kind: 'memory', base: 'main' });
  const outcome = creating.then(() => 'made', (error) => error);
  await f.entered;
  await pass(50 * MINUTE);
  expect(await outcome).toBe('made');
  expect(restored).toBe(true);
  expect(f.destroyed).not.toHaveBeenCalled();
});

it('fails a restore that stops moving for 10 minutes, as infrastructure the workflow retries', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  const f = await fixture({ materialize: async (clock) => {
    // Moves once, then never again, and never returns by itself.
    await clock!.offClock(async (progress) => { progress(); await new Promise(() => {}); });
  } });
  const creating = f.core.createWorld({ taskId: f.task.id, projectId: f.project.id, kind: 'memory', base: 'main' });
  const outcome = creating.then(() => 'made', (error) => error);
  await f.entered;
  await pass(11 * MINUTE);
  const failure = await outcome;
  expect(failure).toBeInstanceOf(ApplicationFailure);
  expect(failure).toMatchObject({ type: 'world-infra', nonRetryable: false });
  expect(failure.message).toMatch(/restoring the project's data made no progress for 10 minutes/);
});

it('still gives everything but restoring data 30 minutes, even when a step never returns', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  const f = await fixture({ create: () => new Promise(() => {}) });
  const creating = f.core.createWorld({ taskId: f.task.id, projectId: f.project.id, kind: 'memory', base: 'main' });
  const outcome = creating.then(() => 'made', (error) => error);
  await f.entered;
  await pass(29 * MINUTE);
  expect(await Promise.race([outcome, Promise.resolve('pending')])).toBe('pending');
  await pass(2 * MINUTE);
  const failure = await outcome;
  expect(failure).toMatchObject({ type: 'world-infra', nonRetryable: false });
  expect(failure.message).toMatch(/world setup took longer than 30 minutes \(not counting restoring the project's data\)/);
});

it('counts the time before and after a restore against the budget, and not the restore itself', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  const clock = new SetupClock({ budgetMs: 30 * MINUTE, stallMs: 10 * MINUTE });
  try {
    await pass(20 * MINUTE);
    const restoring = clock.offClock(async (progress) => {
      for (let i = 0; i < 60; i++) { await new Promise((resolve) => setTimeout(resolve, MINUTE)); progress(); }
    });
    await pass(60 * MINUTE);
    await restoring;
    expect(clock.signal.aborted).toBe(false);
    await pass(9 * MINUTE);
    expect(clock.signal.aborted).toBe(false);
    await pass(2 * MINUTE);
    expect(clock.expired).toBeInstanceOf(SetupTimeout);
  } finally { clock.dispose(); }
});

it('waits for a machine at most half the setup budget, however long the activity may run', () => {
  const clock = new SetupClock({ budgetMs: 30 * MINUTE, now: () => 1_000 });
  try { expect(clock.leaseWaitUntil).toBe(1_000 + 15 * MINUTE); }
  finally { clock.dispose(); }
});

it('passes the activity\'s own cancellation through', () => {
  const parent = new AbortController();
  const clock = new SetupClock({ parent: parent.signal });
  try {
    parent.abort(new Error('cancelled by the workflow'));
    expect(clock.signal.aborted).toBe(true);
    expect(clock.expired).toBeUndefined();
  } finally { clock.dispose(); }
});
