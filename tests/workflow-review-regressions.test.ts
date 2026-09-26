import { beforeEach, expect, it, vi } from 'vitest';

const wf = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  activities: {} as Record<string, any>,
  wait: undefined as undefined | (() => void),
  patches: true,
  childSignal: vi.fn(async () => undefined),
}));
vi.mock('@temporalio/workflow', async (importOriginal) => ({
  ...await importOriginal<typeof import('@temporalio/workflow')>(),
  proxyActivities: () => new Proxy({}, { get: (_target, name: string) => wf.activities[name] ?? vi.fn(async () => undefined) }),
  defineSignal: (name: string) => name,
  defineQuery: (name: string) => name,
  defineUpdate: (name: string) => name,
  setHandler: (name: string, fn: (...args: any[]) => any) => wf.handlers.set(name, fn),
  workflowInfo: () => ({ runId: 'run', historyLength: 1 }),
  patched: () => wf.patches,
  isCancellation: () => false,
  log: { warn: vi.fn() },
  condition: async (predicate: () => boolean) => {
    if (!predicate()) wf.wait?.();
    if (!predicate()) throw new Error('test: unexpected wait');
    return true;
  },
  startChild: async () => ({ result: () => new Promise(() => {}) }),
  getExternalWorkflowHandle: () => ({ signal: wf.childSignal }),
  CancellationScope: class { async run(fn: () => any) { return fn(); } cancel() {} },
}));
import { justDoV1_7 } from '../src/workflows/just-do.js';
import { mergeOnlyV1_7 } from '../src/workflows/merge-only.js';
import { softwareDevV1_26 } from '../src/workflows/software-dev.js';
import { createAgentTurnLeaser } from '../src/workflows/agent-turn-lease.js';

const input = { taskId: 'task', projectId: 'project', title: 'T', prompt: 'work',
  project: { repos: [] }, confirm: { layers: [] } } as any;
beforeEach(() => {
  wf.childSignal.mockClear(); wf.handlers.clear(); wf.wait = undefined; wf.patches = true;
  wf.activities = {
    createWorld: vi.fn(async () => ({ id: 'task', kind: 'worktree', root: '/tmp/test', branch: 'b', base: 'main' })),
    publishView: vi.fn(async () => undefined),
    accountPoolSize: vi.fn(async () => 1),
    resolveProvider: vi.fn(async () => 'mock'),
    leaseAccount: vi.fn(async (_task, turnId) => {
      wf.handlers.get('accountGranted')!({ turnId, accountId: '(denied)' });
      return { waiting: false };
    }),
    runAgentTurn: vi.fn(async () => ({})),
    commitWork: vi.fn(async () => ({ committed: true })),
  };
});

it('WF-9: denied credentials park just-do visibly and cancellation completes', async () => {
  wf.wait = () => {
    const view = wf.handlers.get('view')!();
    expect(view.status).toBe('waiting');
    expect(view.waitingFor?.detail).toContain('credential');
    wf.handlers.get('cancel')!();
  };
  expect(await justDoV1_7(input)).toEqual({ stage: 'cancelled' });
  expect(wf.activities.runAgentTurn).not.toHaveBeenCalled();
});

it('WF-10: a confirm signal cannot bypass failed workflow checks', async () => {
  wf.activities.accountPoolSize.mockResolvedValue(0);
  wf.activities.runWorkflowChecks = vi.fn(async () => ({ passed: false, detail: 'failing tests' }));
  wf.activities.publishView.mockImplementation(async (_id, view) => {
    if (view.stage === 'review') wf.handlers.get('confirm')!();
  });
  wf.activities.finalizeMergeActivity = vi.fn();
  wf.wait = () => wf.handlers.get('cancel')!();
  expect(await mergeOnlyV1_7({ ...input, branch: 'proposal', workflowEdit: true })).toEqual({ stage: 'cancelled' });
  expect(wf.activities.finalizeMergeActivity).not.toHaveBeenCalled();
  expect(wf.activities.publishView.mock.calls.some((call: any[]) => call[1].stage === 'merge')).toBe(false);
});

it('LT-14: just-do status publications reuse the conversation snapshot', async () => {
  wf.activities.accountPoolSize.mockResolvedValue(0);
  await justDoV1_7(input);
  const writes = wf.activities.publishView.mock.calls;
  expect(writes.length).toBeGreaterThan(3);
  expect(writes.filter((call: any[]) => call[1].messages)).toHaveLength(1);
  expect(writes.every((call: any[]) => typeof call[2] === 'string')).toBe(true);
});

it('WF-11: cancel during the pre-turn publication prevents invocation', async () => {
  let cancelled = false;
  const host = { taskId: 'task', projectId: 'project', task: () => input,
    world: () => undefined, status: () => 'active' as const, setStatus: vi.fn(),
    setWaitingFor: vi.fn(), setAgentTurn: vi.fn(), cancelled: () => cancelled,
    publish: async () => { cancelled = true; } };
  const leaser = createAgentTurnLeaser({} as any, { accountPoolSize: async () => 0 } as any, host);
  await leaser.init();
  const turn = vi.fn();
  await expect(leaser.run('do', turn)).rejects.toThrow();
  expect(turn).not.toHaveBeenCalled();
});

it('WF-22: a grant racing cancellation is returned without running the agent', async () => {
  let cancelled = false;
  const host = { taskId: 'task', projectId: 'project', task: () => input,
    world: () => undefined, status: () => 'active' as const, setStatus: vi.fn(),
    setWaitingFor: vi.fn(), setAgentTurn: vi.fn(), cancelled: () => cancelled,
    publish: async () => undefined };
  const coordinator = { accountPoolSize: async () => 1, returnAccount: vi.fn(async () => undefined),
    leaseAccount: async (_task: string, turnId: string) => {
      cancelled = true;
      wf.handlers.get('accountGranted')!({ turnId, accountId: 'login' });
    } };
  const leaser = createAgentTurnLeaser(wf.activities as any, coordinator as any, host);
  await leaser.init();
  const turn = vi.fn();
  await expect(leaser.run('do', turn)).rejects.toThrow();
  expect(turn).not.toHaveBeenCalled();
  expect(coordinator.returnAccount).toHaveBeenCalledWith('login', { taskId: 'task', turnId: expect.any(String) });
});

it('WF-11: software-dev rechecks cancellation after publishing admission', async () => {
  wf.activities.accountPoolSize.mockResolvedValue(0);
  wf.activities.publishView.mockImplementation(async (_id, view) => {
    if (view.waitingFor?.kind === 'agentSlot') wf.handlers.get('cancel')!();
  });
  expect(await softwareDevV1_26(input)).toEqual({ stage: 'cancelled' });
  expect(wf.activities.runAgentTurn).not.toHaveBeenCalled();
});

it('WF-22: software-dev returns an account granted concurrently with cancellation', async () => {
  wf.activities.leaseAccount.mockImplementation(async (_id, turnId) => {
    wf.handlers.get('accountGranted')!({ turnId, accountId: 'login' });
    wf.handlers.get('cancel')!();
  });
  wf.activities.returnAccount = vi.fn(async () => undefined);
  expect(await softwareDevV1_26(input)).toEqual({ stage: 'cancelled' });
  expect(wf.activities.runAgentTurn).not.toHaveBeenCalled();
  expect(wf.activities.returnAccount).toHaveBeenCalledWith('login', { taskId: 'task', turnId: expect.any(String) });
});

it('WF-12: a human gate after an agent layer publishes a waiting state', async () => {
  wf.activities.accountPoolSize.mockResolvedValue(0);
  wf.activities.runAgentTurn.mockImplementation(async ({ role }: any) => role === 'confirm'
    ? { confirmDecision: { action: 'confirm' } } : { openPrRequested: true, completed: true });
  let humanGate = false;
  wf.activities.publishView.mockImplementation(async (_id, view) => {
    if (view.stage === 'review' && view.waitingFor?.kind === 'human') {
      humanGate = true;
      expect(view.status).toBe('waiting');
      wf.handlers.get('cancel')!();
    }
  });
  wf.wait = () => wf.handlers.get('cancel')!();
  expect(await softwareDevV1_26({ ...input, confirm: { layers: [{ kind: 'agent' }, { kind: 'human' }] } })).toEqual({ stage: 'cancelled' });
  expect(humanGate).toBe(true);
});

it.each([['just-do', justDoV1_7], ['merge-only', mergeOnlyV1_7]] as const)(
  'WF-12: %s restores waiting after agent confirmation', async (_name, workflow) => {
    wf.activities.accountPoolSize.mockResolvedValue(0);
    wf.activities.runAgentTurn.mockResolvedValue({ confirmDecision: { action: 'confirm' } });
    let humanGate = false;
    wf.activities.publishView.mockImplementation(async (_id, view) => {
      if (view.waitingFor?.kind === 'human') {
        humanGate = true;
        expect(view.status).toBe('waiting');
        wf.handlers.get('cancel')!();
      }
    });
    wf.wait = () => wf.handlers.get('cancel')!();
    await workflow({ ...input, branch: 'b', confirm: { layers: [{ kind: 'agent' }, { kind: 'human' }] } });
    expect(humanGate).toBe(true);
  });

it('WF-16: account pool lookup failures do not enable credential passthrough', async () => {
  const error = new Error('coordinator unavailable');
  const leaser = createAgentTurnLeaser({} as any, { accountPoolSize: async () => { throw error; } } as any, {} as any);
  await expect(leaser.init()).rejects.toBe(error);
});

it('WF-16: refreshes a formerly empty pool before the next turn', async () => {
  const coordinator = { accountPoolSize: vi.fn().mockResolvedValueOnce(0).mockResolvedValue(1),
    leaseAccount: vi.fn(async (_task, turnId) => {
      wf.handlers.get('accountGranted')!({ turnId, accountId: '(denied)' });
    }) };
  const host = { taskId: 'task', projectId: 'project', task: () => input,
    world: () => undefined, status: () => 'active' as const, setStatus: vi.fn(), setWaitingFor: vi.fn(),
    setAgentTurn: vi.fn(), cancelled: () => false, publish: async () => undefined };
  const leaser = createAgentTurnLeaser(wf.activities as any, coordinator as any, host);
  await leaser.init();
  const turn = vi.fn();
  await expect(leaser.run('do', turn)).rejects.toThrow('credential');
  expect(turn).not.toHaveBeenCalled();
  expect(coordinator.leaseAccount).toHaveBeenCalled();
});

it('WF-8: lifecycle replacement preserves detached children', async () => {
  wf.activities.accountPoolSize.mockResolvedValue(0);
  wf.activities.prepareChildTask = vi.fn(async () => ({ ...input, taskId: 'child' }));
  wf.activities.runAgentTurn.mockResolvedValue({ subTasks: [{ title: 'child', prompt: 'work' }] });
  wf.activities.publishView.mockImplementation(async (_id, view) => {
    if (view.subTasks?.length) wf.handlers.get('prepareLifecycleReplacement')!();
  });
  await softwareDevV1_26(input);
  expect(wf.childSignal).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'cancel' }));
  expect(wf.childSignal).not.toHaveBeenCalledWith('cancel');
});

it('WF-8: a replacement parent restores its child barrier and pending questions', async () => {
  wf.activities.accountPoolSize.mockResolvedValue(0);
  wf.activities.restoreChildTasks = vi.fn(async () => [{ taskId: 'child', title: 'Child',
    waiting: true, detail: 'Please review' }]);
  let restored = false;
  wf.activities.publishView.mockImplementation(async (_id, view) => {
    if (view.subTasks?.includes('child')) { restored = true; wf.handlers.get('prepareLifecycleReplacement')!(); }
  });
  await softwareDevV1_26({ ...input, recovery: { messages: [], resumeStage: 'do' } });
  expect(restored).toBe(true);
  expect(wf.handlers.has('childSettled')).toBe(true);
});
