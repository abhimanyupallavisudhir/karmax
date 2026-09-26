import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(),
  signal: vi.fn(async () => undefined), rotate: vi.fn(), sleep: vi.fn(), condition: vi.fn(), patches: true }));
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
  workflowInfo: () => ({ historyLength: 1, continueAsNewSuggested: false }),
}));
import { accountCoordinator } from '../src/coordinators/account.js';
import { mergeQueue } from '../src/coordinators/merge-queue.js';
const stop = new Error('continue-as-new');
beforeEach(() => {
  state.handlers.clear(); state.signal.mockClear(); state.patches = true;
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

it('WF-24: rotates a merge queue with a current holder and waiting tasks', async () => {
  await expect(mergeQueue({ domain: 'repo', state: { domain: 'repo', current: 'holder', queue: ['waiting'], processed: 500,
    historyPolicyVersion: 2 } } as any)).rejects.toBe(stop);
  expect(state.rotate).toHaveBeenCalledWith({ domain: 'repo', state: { domain: 'repo', current: 'holder', queue: ['waiting'], processed: 0,
    historyPolicyVersion: 2 } });
  expect(state.signal).not.toHaveBeenCalled();
});
