import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(),
  signal: vi.fn(async (...args: any[]) => args.length ? undefined : undefined), rotate: vi.fn(), condition: vi.fn(), patches: new Set<string>(),
  plan: vi.fn(), info: { historyLength: 1, continueAsNewSuggested: false } }));
vi.mock('@temporalio/workflow', async (original) => ({
  ...await original<typeof import('@temporalio/workflow')>(),
  defineSignal: (name: string) => name, defineQuery: (name: string) => name, defineUpdate: (name: string) => name,
  setHandler: (name: string, handler: (...args: any[]) => any) => state.handlers.set(name, handler),
  proxyActivities: () => ({ isTaskAlive: async () => true, planAccountGrants: (...args: any[]) => state.plan(...args) }),
  getExternalWorkflowHandle: (taskId: string) => ({ signal: (...args: any[]) => state.signal(taskId, ...args) }),
  continueAsNew: (...args: any[]) => state.rotate(...args),
  sleep: () => new Promise(() => {}),
  condition: (...args: any[]) => state.condition(...args),
  patched: (id: string) => state.patches.has(id),
  allHandlersFinished: () => true,
  log: { warn: vi.fn() },
  workflowInfo: () => state.info,
}));
import { accountCoordinator } from '../src/coordinators/account.js';

/**
 * The account coordinator under the quota scheduler (wiki features/quota-scheduling):
 * it asks the planner which queued turns get which login, keeps the others back
 * until something changes or the plan's recheck time, and serves in arrival
 * order if the planner fails.
 */
const stop = new Error('stop');
const MARKERS = ['account-coordinator-return-identity-v1', 'account-coordinator-credential-wait-v1', 'account-coordinator-lease-sweep-v1',
  'account-quota-scheduler-v1'];
const login = (id: string) => ({ id, provider: 'claude', kind: 'login', configHome: `/home/${id}`, status: 'available', inUse: 0, maxConcurrent: 10 });
const run = (queue: any[], accounts = [login('a'), login('b')]) =>
  accountCoordinator({ state: { accounts, queue, processed: 0, historyPolicyVersion: 2 } } as any);
const grants = () => state.signal.mock.calls.map(([taskId, , payload]) => [taskId, (payload as any).accountId]);

beforeEach(() => {
  state.handlers.clear(); state.signal.mockClear(); state.plan.mockReset();
  state.patches = new Set(MARKERS);
  state.rotate.mockReset().mockImplementation(async () => { throw stop; });
  state.condition.mockReset();
});

it('grants what the plan says, holds the rest until the plan\'s recheck time', async () => {
  state.plan.mockResolvedValue({ grants: [{ taskId: 'urgent', turnId: 't2', accountId: 'b' }],
    holds: [{ taskId: 'low', turnId: 't1', status: 'held', until: 123 }], recheckMs: 90_000 });
  const parks: (number | undefined)[] = [];
  state.condition.mockImplementation(async (predicate: () => boolean, timeout?: number) => {
    if (timeout === undefined) { if (!predicate()) throw stop; return true; }
    parks.push(timeout);
    // The query explains the held turn while it waits.
    expect(state.handlers.get('accountLease')!({ taskId: 'low', turnId: 't1' }))
      .toEqual({ waiting: true, detail: 'Held for higher-priority work', heldUntil: 123 });
    throw stop;
  });
  await expect(run([{ taskId: 'low', turnId: 't1', provider: 'claude', allowed: ['a', 'b'] },
    { taskId: 'urgent', turnId: 't2', provider: 'claude', allowed: ['a', 'b'] }])).rejects.toBe(stop);
  expect(grants()).toEqual([['urgent', 'b']]);
  expect(parks).toEqual([90_000]);
  expect(state.plan).toHaveBeenCalledWith(expect.objectContaining({
    queue: [expect.objectContaining({ taskId: 'low' }), expect.objectContaining({ taskId: 'urgent' })],
    accounts: expect.arrayContaining([expect.objectContaining({ id: 'a', kind: 'login', inUse: 0 })]) }));
});

it('plans again as soon as something changes under a held turn', async () => {
  state.plan
    .mockResolvedValueOnce({ grants: [], holds: [{ taskId: 'low', turnId: 't1', status: 'held' }], recheckMs: 600_000 })
    .mockResolvedValueOnce({ grants: [{ taskId: 'low', turnId: 't1', accountId: 'a' }], holds: [], recheckMs: 600_000 });
  let parks = 0;
  state.condition.mockImplementation(async (predicate: () => boolean, timeout?: number) => {
    if (timeout === undefined) { if (!predicate()) throw stop; return true; }
    if (++parks > 1) throw stop;
    // Someone dragged it: the API's replan signal wakes the park.
    state.handlers.get('replanAccounts')!();
    return predicate();
  });
  await expect(run([{ taskId: 'low', turnId: 't1', provider: 'claude', allowed: ['a'] }])).rejects.toBe(stop);
  expect(state.plan).toHaveBeenCalledTimes(2);
  expect(grants()).toEqual([['low', 'a']]);
});

it('ignores a planned grant the coordinator can no longer honour', async () => {
  state.plan.mockResolvedValue({ grants: [{ taskId: 't', turnId: 'x', accountId: 'b' }], holds: [], recheckMs: 60_000 });
  state.condition.mockImplementation(async (predicate: () => boolean, timeout?: number) => {
    if (timeout === undefined) { if (!predicate()) throw stop; return true; }
    throw stop;
  });
  // The plan names a login the request may not use.
  await expect(run([{ taskId: 't', turnId: 'x', provider: 'claude', allowed: ['a'] }])).rejects.toBe(stop);
  expect(grants()).toEqual([]);
});

it('serves in arrival order when the planner fails', async () => {
  state.plan.mockRejectedValue(new Error('planner down'));
  state.condition.mockImplementation(async (predicate: () => boolean, timeout?: number) => {
    if (timeout !== undefined) throw stop;
    if (!predicate()) throw stop;
    return true;
  });
  await expect(run([{ taskId: 'first', turnId: '1', provider: 'claude', allowed: ['a'] },
    { taskId: 'second', turnId: '2', provider: 'claude', allowed: ['a'] }])).rejects.toBe(stop);
  expect(grants()).toEqual([['first', 'a'], ['second', 'a']]);
});

it('grants a passthrough (no login to spend) without planning', async () => {
  state.condition.mockImplementation(async (predicate: () => boolean, timeout?: number) => {
    if (timeout !== undefined || !predicate()) throw stop;
    return true;
  });
  await expect(run([{ taskId: 'key', turnId: '1', provider: 'claude', allowed: [] }])).rejects.toBe(stop);
  expect(state.plan).not.toHaveBeenCalled();
  expect(grants()).toEqual([['key', '(passthrough)']]);
});

it('keeps the arrival-order path for a coordinator whose history predates the scheduler', async () => {
  state.patches.delete('account-quota-scheduler-v1');
  state.condition.mockImplementation(async (predicate: () => boolean, timeout?: number) => {
    if (timeout !== undefined || !predicate()) throw stop;
    return true;
  });
  await expect(run([{ taskId: 'first', turnId: '1', provider: 'claude', allowed: ['a'] }])).rejects.toBe(stop);
  expect(state.plan).not.toHaveBeenCalled();
  expect(grants()).toEqual([['first', 'a']]);
});

it('lists queued, granted and held turns for the Queues page', async () => {
  state.plan.mockResolvedValue({ grants: [{ taskId: 'b', turnId: '2', accountId: 'a' }],
    holds: [{ taskId: 'c', turnId: '3', status: 'held', until: 9 }], recheckMs: 60_000 });
  let view: any;
  state.condition.mockImplementation(async (predicate: () => boolean, timeout?: number) => {
    if (timeout === undefined) { if (!predicate()) throw stop; return true; }
    view = state.handlers.get('accountQueue')!();
    throw stop;
  });
  await expect(run([{ taskId: 'b', turnId: '2', provider: 'claude', allowed: ['a'] },
    { taskId: 'c', turnId: '3', provider: 'claude', allowed: ['a'] }])).rejects.toBe(stop);
  expect(view).toEqual({ queue: [{ taskId: 'c', turnId: '3', provider: 'claude' }],
    granted: [expect.objectContaining({ taskId: 'b', turnId: '2', accountId: 'a' })],
    holds: [{ taskId: 'c', turnId: '3', status: 'held', until: 9 }] });
});

it('tells a lease request a decision is coming while a credential has room, so an immediate grant is acknowledged as one', async () => {
  let answer: any;
  state.plan.mockImplementation(async () => {
    // Asked while the plan is in flight.
    answer = state.handlers.get('accountLease')!({ taskId: 't', turnId: 'x' });
    return { grants: [{ taskId: 't', turnId: 'x', accountId: 'a' }], holds: [], recheckMs: 60_000 };
  });
  state.condition.mockImplementation(async (predicate: () => boolean, timeout?: number) => {
    if (timeout !== undefined || !predicate()) throw stop;
    return true;
  });
  await expect(run([{ taskId: 't', turnId: 'x', provider: 'claude', allowed: ['a'] }])).rejects.toBe(stop);
  expect(answer).toEqual({ waiting: true, planning: true });
  expect(state.handlers.get('accountLease')!({ taskId: 't', turnId: 'x' })).toEqual({ waiting: false });
});
