import { beforeEach, expect, it, vi } from 'vitest';

const wf = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  activities: {} as Record<string, any>,
  wait: undefined as undefined | (() => void),
  patches: true,
  timeout: undefined as unknown,
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
  condition: async (predicate: () => boolean, timeout?: unknown) => {
    wf.timeout = timeout;
    if (!predicate()) wf.wait?.();
    if (!predicate() && timeout !== undefined) return false;
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
import { makeTurnPreparationActivities } from '../src/activities/turn-preparation.js';

const input = { taskId: 'task', projectId: 'project', title: 'T', prompt: 'work',
  project: { repos: [] }, confirm: { layers: [] } } as any;
beforeEach(() => {
  wf.childSignal.mockClear(); wf.handlers.clear(); wf.wait = undefined; wf.patches = true;
  wf.activities = {
    restoreChildTasks: vi.fn(async () => []),
    createWorld: vi.fn(async () => ({ id: 'task', kind: 'worktree', root: '/tmp/test', branch: 'b', base: 'main' })),
    publishView: vi.fn(async () => undefined),
    accountPoolSize: vi.fn(async () => 1),
    resolveProvider: vi.fn(async () => 'mock'),
    // The real preparation over the stubbed reads, so each test's pool size and
    // provider reach the workflow however it batches them.
    prepareAgentTurn: (args: any) => makeTurnPreparationActivities(wf.activities as any, wf.activities as any).prepareAgentTurn(args),
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
  wf.activities.publishView.mockImplementation(async (_id: string, view: any) => {
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
  wf.activities.publishView.mockImplementation(async (_id: string, view: any) => {
    if (view.waitingFor?.kind === 'agentSlot') wf.handlers.get('cancel')!();
  });
  expect(await softwareDevV1_26(input)).toEqual({ stage: 'cancelled' });
  expect(wf.activities.runAgentTurn).not.toHaveBeenCalled();
});

it('WF-22: software-dev returns an account granted concurrently with cancellation', async () => {
  wf.activities.leaseAccount.mockImplementation(async (_id: string, turnId: string) => {
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
  wf.activities.publishView.mockImplementation(async (_id: string, view: any) => {
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
    wf.activities.publishView.mockImplementation(async (_id: string, view: any) => {
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
  wf.activities.publishView.mockImplementation(async (_id: string, view: any) => {
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
  wf.activities.publishView.mockImplementation(async (_id: string, view: any) => {
    if (view.subTasks?.includes('child')) { restored = true; wf.handlers.get('prepareLifecycleReplacement')!(); }
  });
  await softwareDevV1_26({ ...input, recovery: { messages: [], resumeStage: 'do' } });
  expect(restored).toBe(true);
  expect(wf.handlers.has('childSettled')).toBe(true);
});

it.each([['just-do', justDoV1_7], ['software-dev', softwareDevV1_26]] as const)(
  'WF-3: %s waits for the durable connection notification without polling', async (_name, workflow) => {
    wf.activities.accountPoolSize.mockResolvedValue(0);
    wf.activities.pendingServiceConnections = vi.fn(async () => 1);
    let waited = false;
    wf.wait = () => {
      expect(wf.handlers.get('view')!().waitingFor.detail).toContain('Connect the requested app');
      expect(wf.timeout).toBeUndefined();
      waited = true;
      wf.handlers.get('cancel')!();
    };
    await workflow(input);
    expect(waited).toBe(true);
  });

it('WF-4: recovered conversations are not copied into every agent task input', async () => {
  wf.activities.accountPoolSize.mockResolvedValue(0);
  let taskInput: any;
  wf.activities.runAgentTurn.mockImplementation(async ({ task }: any) => {
    taskInput = task;
    wf.handlers.get('cancel')!();
    return {};
  });
  await softwareDevV1_26({ ...input, recovery: { messages: [{ id: 'history', role: 'user', text: 'large history', ts: 0 }],
    resumeStage: 'do' } });
  expect(taskInput).toBeDefined();
  expect(taskInput.recovery).toBeUndefined();
});

it('WF-14: repeated Do and Responder exchanges eventually wait for a human', async () => {
  wf.activities.accountPoolSize.mockResolvedValue(0);
  let rounds = 0;
  wf.activities.runAgentTurn.mockImplementation(async ({ role }: any) => {
    if (role === 'responder') return { output: ++rounds <= 3 ? 'Continue working' : undefined };
    return {};
  });
  wf.wait = () => {
    expect(wf.handlers.get('view')!().waitingFor.kind).toBe('human');
    wf.handlers.get('cancel')!();
  };
  await softwareDevV1_26({ ...input, project: { repos: ['/tmp/repo'] }, responder: { kind: 'agent' } });
  expect(rounds).toBe(3);
});

it('WF-14: caps unanswered child nags and leaves a responsive human wait', async () => {
  wf.activities.accountPoolSize.mockResolvedValue(0);
  wf.activities.restoreChildTasks.mockResolvedValue([{ taskId: 'child', title: 'Child', waiting: true, detail: 'Review' }]);
  wf.activities.runAgentTurn.mockResolvedValue({ waitForSubtasks: true });
  let waits = 0;
  wf.wait = () => {
    if (++waits < 4) return;
    if (wf.handlers.get('view')!().stage === 'cancelled') return;
    expect(wf.handlers.get('view')!().waitingFor.kind).toBe('human');
    expect(wf.timeout).toBeUndefined();
    wf.handlers.get('cancel')!();
  };
  await softwareDevV1_26({ ...input, recovery: { messages: [], resumeStage: 'do' } });
  expect(waits).toBeGreaterThanOrEqual(4);
});

it('WF-4: a turn records its new messages, not the whole conversation', async () => {
  wf.activities.accountPoolSize.mockResolvedValue(0);
  const snapshots = new Map<string, any>();
  const { applyConversationPatch, transcriptOf } = await import('../src/domain/view-publication.js');
  wf.activities.publishView.mockImplementation(async (_id: string, view: any, reference: string) => {
    snapshots.set(reference, view.conversationPatch
      ? applyConversationPatch(snapshots.get(view.conversationPatch.base), view.conversationPatch)
      : view.messages ? { messages: view.messages, transcripts: view.transcripts } : snapshots.get(reference));
  });
  const turns: any[] = [];
  wf.activities.runAgentTurn.mockImplementation(async (args: any) => {
    const base = args.messagesBase ? transcriptOf(snapshots.get(args.messagesBase.reference), 'do')
      .slice(0, args.messagesBase.count) : [];
    turns.push({ ...args, fullMessages: [...base, ...args.messages] });
    return { output: `Reply ${turns.length} ${'r'.repeat(2_000)}`, providerCompleted: true };
  });
  wf.wait = () => {
    if (turns.length >= 4) return wf.handlers.get('cancel')!();
    wf.handlers.get('followUp')!({ id: `u${turns.length}`, role: 'user', text: `Follow-up ${turns.length}`, ts: turns.length });
  };
  await softwareDevV1_26({ ...input, project: { repos: ['/tmp/repo'] } });
  expect(turns).toHaveLength(4);
  // The last turn still receives the whole conversation, delivered by reference.
  expect(turns[3].fullMessages.map((m: any) => m.id)).toEqual(['m0', 'a1', 'u1', 'a3', 'u2', 'a5', 'u3']);
  expect(turns[3].messagesBase).toMatchObject({ role: 'do', count: 7 });
  expect(turns[3].messages).toEqual([]);
  const writes = wf.activities.publishView.mock.calls.map((call: any[]) => call[1]);
  expect(writes.filter((view: any) => view.messages)).toHaveLength(1);
  for (const view of writes.filter((view: any) => view.conversationPatch))
    expect(JSON.stringify(view.conversationPatch).length).toBeLessThan(3_000);
});

it('WF-3: plan-blocked admission waits for the queue grant, not a timer', async () => {
  const { Store } = await import('../src/store/db.js');
  const { makeCoordinatorActivities } = await import('../src/activities/coordinator.js');
  const store = (await Store.create(':memory:', { hosted: true }));
  const organization = (await store.createOrganization({ name: 'Over limit', ownerUserId: 'owner' }));
  (await store.setOrganizationPlan(organization.id, 'team'));
  (await store.setOrganizationMembership(organization.id, 'second', 'member'));
  (await store.setOrganizationPlan(organization.id, 'free'));
  const project = (await store.createProject('Product', {}, organization.id));
  const executeUpdate = vi.fn(async () => ({ granted: false, position: 1, capacity: 0 }));
  const coordinator = makeCoordinatorActivities({ store, taskQueue: 'test', client: { workflow: {
    signalWithStart: vi.fn(async () => undefined), getHandle: vi.fn(() => ({ executeUpdate, signal: vi.fn() })),
  } } as any });
  wf.activities.accountPoolSize.mockResolvedValue(0);
  wf.activities.agentUsesHostCapacity = vi.fn(async () => true);
  wf.activities.requestAgentSlot = coordinator.requestAgentSlot;
  const waits: unknown[] = [];
  wf.wait = () => {
    waits.push(wf.timeout);
    const view = wf.handlers.get('view')!();
    if (wf.activities.runAgentTurn.mock.calls.length) return wf.handlers.get('cancel')!();
    expect(view.waitingFor).toMatchObject({ kind: 'agentSlot', detail: expect.stringContaining('Free allows 1 organization user') });
    const { turnId } = (executeUpdate.mock.calls[0] as any)[1].args[0];
    wf.handlers.get('agentSlotGranted')!({ turnId });
  };
  await softwareDevV1_26({ ...input, projectId: project.id, project: { repos: ['/tmp/repo'] } });
  expect(waits[0]).toBeUndefined();
  expect(wf.activities.runAgentTurn).toHaveBeenCalledOnce();
  (await store.close());
});
