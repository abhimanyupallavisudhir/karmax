import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(),
  signal: vi.fn(async () => undefined), rotate: vi.fn(), sleep: vi.fn(), condition: vi.fn(), patches: true,
  info: { historyLength: 1, continueAsNewSuggested: false } }));
vi.mock('@temporalio/workflow', async (original) => ({
  ...await original<typeof import('@temporalio/workflow')>(),
  defineSignal: (name: string) => name, defineQuery: (name: string) => name, defineUpdate: (name: string) => name,
  setHandler: (name: string, handler: (...args: any[]) => any) => state.handlers.set(name, handler),
  proxyActivities: () => ({ isTaskAlive: async () => true }),
  getExternalWorkflowHandle: () => ({ signal: state.signal }),
  continueAsNew: (...args: any[]) => state.rotate(...args),
  sleep: (...args: any[]) => state.sleep(...args),
  condition: (...args: any[]) => state.condition(...args),
  patched: () => state.patches,
  allHandlersFinished: () => true,
  log: { warn: vi.fn() },
  workflowInfo: () => state.info,
}));
import { accountCoordinator } from '../src/coordinators/account.js';
import { mergeQueue } from '../src/coordinators/merge-queue.js';
const stop = new Error('continue-as-new');
beforeEach(() => {
  state.handlers.clear(); state.signal.mockClear(); state.patches = true;
  state.info = { historyLength: 1, continueAsNewSuggested: false };
  state.rotate.mockReset().mockImplementation(async () => { throw stop; });
  state.condition.mockReset().mockImplementation(async (predicate: () => boolean) => {
    if (state.condition.mock.calls.length > 10) throw new Error('spin');
    if (!predicate()) throw new Error('blocked');
    return true;
  });
  state.sleep.mockReset().mockImplementation(() => new Promise(() => {}));
});

it('WF-5: rotates a busy account queue with its requests and held leases intact', async () => {
  const account = { id: 'login', provider: 'mock', configHome: '/test', status: 'available', inUse: 1, maxConcurrent: 1 };
  const queue = [{ taskId: 'waiting', turnId: 'turn', allowed: ['login'] }];
  const granted = [{ taskId: 'holder', turnId: 'held', accountId: 'login', grantedAt: Date.now() }];
  await expect(accountCoordinator({ state: { accounts: [account], queue, granted, processed: 1000,
    historyPolicyVersion: 2 } } as any)).rejects.toBe(stop);
  expect(state.rotate).toHaveBeenCalledWith({ state: { accounts: [account], queue, granted, processed: 0, historyPolicyVersion: 2 } });
  expect(state.signal).not.toHaveBeenCalled();
});

it('LT-20: cancels the account park timer when a condition wakes it', async () => {
  state.condition.mockImplementation(async (predicate: () => boolean, timeout?: number) => {
    if (timeout !== undefined) throw stop;
    if (!predicate()) throw new Error('unbounded park');
    return true;
  });
  await expect(accountCoordinator({ state: { accounts: [{ id: 'login', provider: 'mock', configHome: '/test',
    status: 'available', inUse: 1, maxConcurrent: 1 }], queue: [{ taskId: 'waiting', turnId: 'turn', allowed: ['login'] }],
    processed: 0, historyPolicyVersion: 2 } } as any)).rejects.toBe(stop);
  expect(state.sleep).not.toHaveBeenCalled();
});

it('parks a bounded-history credential wall instead of spinning on a request it will not deny', async () => {
  // Credential waits never deny, so a request whose every credential needs a
  // person must not wake the park: the loop would find nothing to do and repark
  // at once, forever, without yielding a command.
  state.condition.mockImplementation(async (predicate: () => boolean, timeout?: number) => {
    if (timeout === undefined) { if (!predicate()) throw new Error('blocked'); return true; }
    if (predicate()) throw new Error('woke without a serveable request');
    throw stop;
  });
  await expect(accountCoordinator({ state: { accounts: [{ id: 'login', provider: 'mock', configHome: '/test',
    status: 'needs-attention', inUse: 0, maxConcurrent: 1 }], queue: [{ taskId: 'waiting', turnId: 'turn', allowed: ['login'] }],
    processed: 0, historyPolicyVersion: 2 } } as any)).rejects.toBe(stop);
  expect(state.signal).not.toHaveBeenCalled();
});

it('carries an owed credential re-list across a history rotation', async () => {
  const account = { id: 'login', provider: 'mock', configHome: '/test', status: 'exhausted', resetAt: Date.now() + 3_600_000,
    inUse: 0, maxConcurrent: 1 };
  const queue = [{ taskId: 'waiting', turnId: 'turn', allowed: ['login'] }];
  state.condition.mockImplementation(async (predicate: () => boolean, timeout?: number) => {
    if (timeout === undefined) return true;
    // A credential sync arrives while the request is parked, and the history
    // fills before the loop gets to hand the request back.
    state.handlers.get('registerAccounts')!({ accounts: [{ id: 'login', configHome: '/test', provider: 'mock' }] });
    state.info = { historyLength: 1, continueAsNewSuggested: true };
    return predicate();
  });
  await expect(accountCoordinator({ state: { accounts: [account], queue, processed: 0,
    historyPolicyVersion: 2 } } as any)).rejects.toBe(stop);
  expect(state.rotate).toHaveBeenCalledWith({ state: expect.objectContaining({ queue, relistRequested: true }) });
  expect(state.signal).not.toHaveBeenCalled();
});

it('WF-24: rotates a merge queue with a current holder and waiting tasks', async () => {
  await expect(mergeQueue({ domain: 'repo', state: { domain: 'repo', current: 'holder', queue: ['waiting'], processed: 500,
    historyPolicyVersion: 2 } } as any)).rejects.toBe(stop);
  expect(state.rotate).toHaveBeenCalledWith({ domain: 'repo', state: { domain: 'repo', current: 'holder', queue: ['waiting'], processed: 0,
    historyPolicyVersion: 3 } });
  expect(state.signal).not.toHaveBeenCalled();
});

// Rotation can outpace a lease window under sustained signal traffic. With a
// relative 5-minute timer restarted by every new run, a dead holder was never
// checked and the whole domain queued behind it.
it('keeps a merge lease window across rotations', async () => {
  const since = Date.now() - 4 * 60_000;
  await expect(mergeQueue({ domain: 'repo', state: { domain: 'repo', current: 'holder', currentSince: since, queue: ['waiting'],
    processed: 500, historyPolicyVersion: 3 } } as any)).rejects.toBe(stop);
  expect(state.rotate).toHaveBeenCalledWith({ domain: 'repo', state: { domain: 'repo', current: 'holder', currentSince: since,
    queue: ['waiting'], processed: 0, historyPolicyVersion: 3 } });
  const timeouts: number[] = [];
  state.condition.mockImplementation(async (predicate: () => boolean, timeout?: number) => {
    if (timeout === undefined) { if (!predicate()) throw new Error('blocked'); return true; }
    timeouts.push(timeout);
    throw stop;
  });
  await expect(mergeQueue({ domain: 'repo', state: { domain: 'repo', current: 'holder', currentSince: since, queue: [],
    processed: 0, historyPolicyVersion: 3 } } as any)).rejects.toBe(stop);
  expect(timeouts).toHaveLength(1);
  expect(timeouts[0]).toBeGreaterThan(50_000);
  expect(timeouts[0]).toBeLessThanOrEqual(60_000);
});

it('WF-23: a repeated lease signal does not queue an already granted turn', async () => {
  state.condition.mockImplementation(async () => {
    state.handlers.get('leaseAccount')!({ taskId: 'holder', turnId: 'held', allowed: ['login'] });
    throw stop;
  });
  await expect(accountCoordinator({ state: { accounts: [{ id: 'login', provider: 'mock', configHome: '/test',
    status: 'available', inUse: 1, maxConcurrent: 1 }], queue: [],
    granted: [{ taskId: 'holder', turnId: 'held', accountId: 'login', grantedAt: Date.now() }],
    processed: 0, historyPolicyVersion: 2 } } as any)).rejects.toBe(stop);
  expect(state.handlers.get('accountTaskLeases')!('holder')).toEqual(['held']);
});

it('WF-22: failed grant delivery does not return an already cancelled lease twice', async () => {
  state.signal.mockImplementationOnce(async () => {
    state.handlers.get('cancelAccountLease')!({ taskId: 'holder', turnId: 'held' });
    throw new Error('workflow closed');
  });
  state.condition.mockImplementation(async (predicate: () => boolean) => {
    if (!predicate()) throw stop;
    return true;
  });
  await expect(accountCoordinator({ state: { accounts: [{ id: 'login', provider: 'mock', configHome: '/test',
    status: 'available', inUse: 0, maxConcurrent: 1 }],
    queue: [{ taskId: 'holder', turnId: 'held', allowed: ['login'] }], processed: 0, historyPolicyVersion: 2 } } as any)).rejects.toBe(stop);
  expect(state.handlers.get('accounts')!().accounts[0].inUse).toBe(0);
});

it('WF-5: identifies acknowledgements served by a run continuing as new', async () => {
  await expect(accountCoordinator({ state: { accounts: [], queue: [{ taskId: 'waiting', turnId: 'turn' }],
    processed: 0 } })).rejects.toBe(stop);
  expect(state.handlers.get('accountLease')!({ taskId: 'waiting', turnId: 'turn' }))
    .toEqual({ waiting: false, continuingAsNew: true });
});
