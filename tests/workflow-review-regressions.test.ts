import { beforeEach, describe, expect, it, vi } from 'vitest';

const wf = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  activities: {} as Record<string, any>,
  wait: undefined as undefined | (() => void),
  patches: true,
  // Patch ids that answer false even when `patches` is true.
  absentPatches: new Set<string>(),
  timeout: undefined as unknown,
  childSignal: vi.fn(async () => undefined),
  startChild: undefined as undefined | ((...args: any[]) => any),
  info: { runId: 'run', historyLength: 1, historySize: 0 },
  // Signals and updates that reach a run before it registers their handlers,
  // dispatched at registration as the SDK does.
  buffered: [] as [string, unknown[]][],
}));
vi.mock('@temporalio/workflow', async (importOriginal) => ({
  ...await importOriginal<typeof import('@temporalio/workflow')>(),
  proxyActivities: () => new Proxy({}, { get: (_target, name: string) => wf.activities[name] ?? vi.fn(async () => undefined) }),
  defineSignal: (name: string) => name,
  defineQuery: (name: string) => name,
  defineUpdate: (name: string) => name,
  setHandler: (name: string, fn: (...args: any[]) => any, options?: { validator?: (...args: any[]) => void }) => {
    wf.handlers.set(name, fn);
    for (const [signal, args] of wf.buffered.filter(([signal]) => signal === name)) {
      wf.buffered.splice(wf.buffered.findIndex(([candidate]) => candidate === signal), 1);
      options?.validator?.(...args);
      void fn(...args);
    }
  },
  workflowInfo: () => wf.info,
  allHandlersFinished: () => true,
  continueAsNew: async (next: unknown) => { throw Object.assign(new Error('continued as new'), { next }); },
  patched: (id: string) => wf.patches && !wf.absentPatches.has(id),
  isCancellation: () => false,
  log: { warn: vi.fn() },
  condition: async (predicate: () => boolean, timeout?: unknown) => {
    wf.timeout = timeout;
    if (!predicate()) wf.wait?.();
    if (!predicate() && timeout !== undefined) return false;
    // A handler may wait for the main flow (a continued run's conversation load).
    // A pending wake (the barrier's hoisted one) stays pending while the flow runs on.
    for (let tick = 0; tick < 500 && !predicate(); tick++) await new Promise((resolve) => setImmediate(resolve));
    if (!predicate()) throw new Error('test: unexpected wait');
    return true;
  },
  startChild: async (...args: any[]) => wf.startChild?.(...args) ?? { result: () => new Promise(() => {}) },
  getExternalWorkflowHandle: () => ({ signal: wf.childSignal }),
  CancellationScope: class { async run(fn: () => any) { return fn(); } cancel() {} },
}));
import { justDoV1_7 } from '../src/workflows/just-do.js';
import { mergeOnlyV1_7 } from '../src/workflows/merge-only.js';
import { softwareDevV1_20, softwareDevV1_26, softwareDevV1_27, subtaskRaiseText } from '../src/workflows/software-dev.js';
import { createAgentTurnLeaser } from '../src/workflows/agent-turn-lease.js';
import { makeTurnPreparationActivities } from '../src/activities/turn-preparation.js';

const input = { taskId: 'task', projectId: 'project', title: 'T', prompt: 'work',
  project: { repos: [] }, confirm: { layers: [] } } as any;
beforeEach(() => {
  wf.childSignal.mockClear(); wf.handlers.clear(); wf.wait = undefined; wf.patches = true; wf.startChild = undefined;
  wf.buffered = [];
  wf.absentPatches = new Set();
  wf.info = { runId: 'run', historyLength: 1, historySize: 0 };
  wf.activities = {
    restoreChildTasks: vi.fn(async () => []),
    unsavedResourceCandidates: vi.fn(async () => []),
    settledChildTasks: vi.fn(async () => []),
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

/** A landing whose unchanged CI failure repeats on the same head (duplicate
 * repair fingerprint), recorded by tests/fixtures/history-landing-duplicate-prechange. */
function repeatedLandingFailure() {
  const prs = [{ slug: 'test/repo', number: 1, headSha: 'abc', url: 'https://github.com/test/repo/pull/1' }];
  const failure = { status: 'needs-revision', prs, detail: 'CI failed on the same head.',
    repair: { kind: 'ci', preserveAuthorization: true, fingerprint: 'test/repo#1:abc:ci' } };
  Object.assign(wf.activities, {
    accountPoolSize: vi.fn(async () => 0),
    checkProposal: vi.fn(async () => ({ ready: true })), openPr: vi.fn(async () => prs),
    settleResourceReview: vi.fn(async () => ({ settled: true })), stageResourceCandidates: vi.fn(async () => ({ staged: 0, failed: 0 })), closePrs: vi.fn(async () => prs),
    mergeGithubPrs: vi.fn(async () => failure),
    withdrawGithubPrs: vi.fn(async () => ({ withdrawn: [], reconciled: prs })),
    enqueueMerge: vi.fn(async () => wf.handlers.get('mergeGranted')!()),
    mergeQueuePosition: vi.fn(async () => ({ position: 0, total: 1 })),
  });
  return { failure, input: { ...input, project: { repos: ['/tmp/repo'], remote: 'pr' }, recovery: {
    resumeStage: 'merge', messages: [], prs, world: { id: 'task', kind: 'worktree', root: '/tmp/test', branch: 'b', base: 'main' },
    landing: { authorization: 'authorized', validation: 'pending', provider: 'admitting', authorizedHeads: { 'test/repo#1': 'abc' },
      lastRepairFingerprint: 'test/repo#1:abc:ci', repairAttempts: 1 } } } };
}

it('LT-12: an unchanged landing failure waits in the watcher, not a parent poll', async () => {
  const { failure, input: landingInput } = repeatedLandingFailure();
  const watches: any[] = [];
  wf.startChild = (_type: unknown, options: any) => {
    watches.push(options.args[0]);
    return { signal: vi.fn(), result: async () => { wf.handlers.get('cancel')!(); return failure; } };
  };
  wf.wait = () => { throw new Error('the parent must not poll'); };
  expect(await softwareDevV1_26(landingInput)).toEqual({ stage: 'cancelled' });
  expect(watches).toHaveLength(1);
  expect(watches[0]).toMatchObject({ previous: { status: 'needs-revision', repair: failure.repair } });
  // One read-only preflight observed the failure; the watcher owns every later poll.
  expect(wf.activities.mergeGithubPrs).toHaveBeenCalledOnce();
});

it('LT-12: historical landing polls back off while GitHub is unchanged', async () => {
  const { input: landingInput } = repeatedLandingFailure();
  const polls: unknown[] = [];
  wf.wait = () => {
    polls.push(wf.timeout);
    if (polls.length === 8) wf.handlers.get('cancel')!();
  };
  expect(await softwareDevV1_20(landingInput)).toEqual({ stage: 'cancelled' });
  expect(polls).toEqual(['30s', 60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000]);
});

it('WF-3/WF-4: a long run continues as new with its in-flight state', async () => {
  const { applyConversationPatch, conversationPage, transcriptOf } = await import('../src/domain/view-publication.js');
  const snapshots = new Map<string, any>();
  wf.activities.accountPoolSize.mockResolvedValue(0);
  wf.activities.publishView.mockImplementation(async (_id: string, view: any, reference: string) => {
    snapshots.set(reference, view.conversationPatch ? applyConversationPatch(snapshots.get(view.conversationPatch.base), view.conversationPatch)
      : view.messages ? { messages: view.messages, transcripts: view.transcripts } : snapshots.get(reference));
  });
  wf.activities.readConversationPage = vi.fn(async (_id: string, reference: string, offset: number) =>
    conversationPage(snapshots.get(reference), offset, 200));
  wf.activities.releaseTaskRun = vi.fn(async () => 'unpinned');
  wf.activities.adoptTaskRun = vi.fn();
  wf.activities.prepareChildTask = vi.fn(async () => ({ taskId: 'child-1' }));
  const turns: any[] = [];
  wf.activities.runAgentTurn.mockImplementation(async (args: any) => {
    const base = args.messagesBase;
    if (turns.length >= 2) throw new Error('the long run did not continue as new');
    turns.push([...(base ? transcriptOf(snapshots.get(base.reference), 'do').slice(0, base.count) : []), ...args.messages]);
    return turns.length === 1
      ? { output: 'Delegating', providerCompleted: true, subTasks: [{ title: 'Child', prompt: 'Part' }] }
      : { output: `Reply ${turns.length}`, providerCompleted: true, completed: true };
  });
  // Run 1 parks on its child; the child asks a question while a collaboration
  // is pending and a person edits the target and switches to Goal.
  wf.wait = () => {
    wf.handlers.get('collaborationRequested')!('request-1');
    wf.handlers.get('setTarget')!('release');
    void wf.handlers.get('changeWorkflow')!('goal');
    wf.handlers.get('raiseFromChild')!({ childTaskId: 'child-1', childTitle: 'Child', type: 'needs_info', detail: 'Which API?' });
    wf.info = { ...wf.info, historyLength: 5_000 };
  };
  const first = await softwareDevV1_26({ ...input, project: { repos: ['/tmp/repo'] }, paramWindows: { target: 'untilUsed' } })
    .catch((error) => error);
  const next = first.next;
  expect(next?.recovery).toMatchObject({ resumeStage: 'do', messages: [], target: 'release', seen: 2,
    continued: { runPinned: false, goalMode: true, subTasks: { ids: ['child-1'], outstanding: ['child-1'], awaitingResponse: ['child-1'] },
      collaborations: { pending: ['request-1'] } } });
  expect(JSON.stringify(next).length).toBeLessThan(5_000);
  expect(turns).toHaveLength(1);

  // Run 2 loads the conversation in pages and resumes exactly there.
  wf.handlers.clear();
  wf.info = { runId: 'run-2', historyLength: 1, historySize: 0 };
  wf.activities.restoreChildTasks.mockClear();
  wf.wait = () => {
    const view = wf.handlers.get('view')!();
    expect(view).toMatchObject({ workflow: 'goal', targetBranch: 'release', subTasks: ['child-1'] });
    expect(view.updatedAt).toBeGreaterThan(5_000);
    wf.handlers.get('cancel')!();
  };
  expect(await softwareDevV1_26(next)).toEqual({ stage: 'cancelled' });
  expect(wf.activities.readConversationPage.mock.calls.length).toBeGreaterThan(1);
  expect(wf.activities.restoreChildTasks).not.toHaveBeenCalled();
  expect(wf.activities.adoptTaskRun).not.toHaveBeenCalled();
  expect(turns).toHaveLength(2);
  expect(turns[1].map((m: any) => m.id)).toEqual(turns[0].map((m: any) => m.id).concat(
    [expect.any(String), 'mode-2', expect.stringMatching(/^st-/)]));
  expect(turns[1].at(-1).text).toContain('Which API?');
});

/** Run 1 delegates to a child, which asks a question while a collaboration is
 * pending, and continues as new: returns the next run's input. */
async function continuedRun(taskInput = input) {
  const { applyConversationPatch, conversationPage, transcriptOf } = await import('../src/domain/view-publication.js');
  const snapshots = new Map<string, any>();
  wf.activities.accountPoolSize.mockResolvedValue(0);
  wf.activities.publishView.mockImplementation(async (_id: string, view: any, reference: string) => {
    snapshots.set(reference, view.conversationPatch ? applyConversationPatch(snapshots.get(view.conversationPatch.base), view.conversationPatch)
      : view.messages ? { messages: view.messages, transcripts: view.transcripts } : snapshots.get(reference));
  });
  wf.activities.readConversationPage = vi.fn(async (_id: string, reference: string, offset: number) =>
    conversationPage(snapshots.get(reference), offset, 200));
  wf.activities.releaseTaskRun = vi.fn(async () => 'unpinned');
  wf.activities.adoptTaskRun = vi.fn();
  wf.activities.prepareChildTask = vi.fn(async () => ({ taskId: 'child-1' }));
  const turns: any[][] = [];
  const full = (args: any) => [...(args.messagesBase ? transcriptOf(snapshots.get(args.messagesBase.reference), 'do')
    .slice(0, args.messagesBase.count) : []), ...args.messages];
  wf.activities.runAgentTurn.mockImplementation(async (args: any) => {
    turns.push(full(args));
    return { output: 'Delegating', providerCompleted: true, subTasks: [{ title: 'Child', prompt: 'Part' }] };
  });
  wf.wait = () => {
    wf.handlers.get('collaborationRequested')!('request-1');
    wf.handlers.get('raiseFromChild')!({ childTaskId: 'child-1', childTitle: 'Child', type: 'needs_info', detail: 'Which API?' });
    wf.info = { ...wf.info, historyLength: 5_000 };
  };
  const first = await softwareDevV1_26({ ...taskInput, project: { repos: ['/tmp/repo'] } }).catch((error) => error);
  expect(first.next?.recovery?.continued).toBeDefined();
  wf.handlers.clear();
  wf.info = { runId: 'run-2', historyLength: 1, historySize: 0 };
  return { next: first.next, turns, full };
}

it('WF-3/WF-4: signals that reach a continued run before it loads keep their effect', async () => {
  const { next, turns, full } = await continuedRun();
  // The child failed while run 1 continued; the collaboration settles and a
  // person writes before run 2 has loaded the conversation.
  wf.activities.restoreChildTasks.mockResolvedValue([]);
  wf.activities.settledChildTasks = vi.fn(async () => [{ taskId: 'child-1', stage: 'failed' }]);
  wf.buffered = [['collaborationSettled', ['request-1', { id: 'collab-1', role: 'user', text: 'Collaboration result', ts: 0 }]],
    ['followUp', [{ id: 'u-late', role: 'user', text: 'Also check the docs', ts: 0 }]]];
  const loading: unknown[] = [];
  const pages = wf.activities.readConversationPage.getMockImplementation()!;
  wf.activities.readConversationPage.mockImplementation(async (...args: any[]) => {
    loading.push(wf.activities.publishView.mock.calls.length);
    expect(() => wf.handlers.get('view')!()).toThrow('loading');
    return pages(...args);
  });
  const published = wf.activities.publishView.mock.calls.length;
  wf.activities.runAgentTurn.mockImplementation(async (args: any) => {
    turns.push(full(args));
    return { output: 'Done', providerCompleted: true };
  });
  let parked: any;
  wf.wait = () => { parked = wf.handlers.get('view')!(); wf.handlers.get('cancel')!(); };
  expect(await softwareDevV1_26(next)).toEqual({ stage: 'cancelled' });
  // Nothing was published before the conversation was loaded.
  expect(loading.every((count) => count === published)).toBe(true);
  // Neither the settled collaboration nor the failed child holds the task.
  expect(parked).toMatchObject({ stage: 'do', waitingFor: { kind: 'human', detail: 'Done' } });
  const delivered = turns[1]!.map((m: any) => m.text);
  expect(delivered).toEqual(expect.arrayContaining(['Collaboration result', 'Also check the docs',
    expect.stringContaining('Sub-task child-1 finished: failed')]));
});

it('WF-3/WF-4: a mode switch that reaches a continued run first is kept and published once loaded', async () => {
  const { next, turns, full } = await continuedRun();
  wf.wait = undefined;
  wf.buffered = [['changeWorkflow', ['goal']]];
  wf.activities.runAgentTurn.mockImplementation(async (args: any) => {
    turns.push(full(args));
    wf.handlers.get('cancel')!();
    return {};
  });
  await softwareDevV1_26(next);
  expect(wf.handlers.get('view')!()).toMatchObject({ workflow: 'goal' });
  const run2 = wf.activities.publishView.mock.calls.filter((call: any[]) => call[2]?.startsWith('run-2:'));
  // Every publication of run 2 carries the whole conversation, never just the mode message.
  expect(run2.every((call: any[]) => !call[1].messages || call[1].messages.length > 1)).toBe(true);
  const ids = turns[1]!.map((m: any) => m.id);
  expect(ids.slice(0, turns[0]!.length + 1)).toEqual([...turns[0]!.map((m: any) => m.id), expect.any(String)]);
  expect(ids).toContainEqual(expect.stringMatching(/^mode-/));
  expect(new Set(ids).size).toBe(ids.length);
});

it('WF-3/WF-4: a refused continuation is retried once the run has grown further', async () => {
  const { applyConversationPatch } = await import('../src/domain/view-publication.js');
  const snapshots = new Map<string, any>();
  wf.activities.accountPoolSize.mockResolvedValue(0);
  wf.activities.publishView.mockImplementation(async (_id: string, view: any, reference: string) => {
    snapshots.set(reference, view.conversationPatch ? applyConversationPatch(snapshots.get(view.conversationPatch.base), view.conversationPatch)
      : view.messages ? { messages: view.messages, transcripts: view.transcripts } : snapshots.get(reference));
  });
  // A replacement briefly held the pin, then released it.
  wf.activities.releaseTaskRun = vi.fn().mockResolvedValueOnce('foreign').mockResolvedValue('unpinned');
  let turns = 0;
  wf.activities.runAgentTurn.mockImplementation(async () => {
    if (++turns > 4) throw new Error('the run never continued as new');
    wf.info = { ...wf.info, historyLength: wf.info.historyLength + 3_000 };
    return { output: `Reply ${turns}`, providerCompleted: true };
  });
  wf.wait = () => wf.handlers.get('followUp')!({ id: `u${turns}`, role: 'user', text: 'More', ts: turns });
  const result = await softwareDevV1_26({ ...input, project: { repos: ['/tmp/repo'] },
    confirm: { layers: [{ kind: 'human' }] } }).catch((error) => error);
  expect(result.next?.recovery?.continued).toBeDefined();
  expect(wf.activities.releaseTaskRun).toHaveBeenCalledTimes(2);
});

it('WF-3/WF-4: a run does not continue when its carried input would exceed the payload budget in bytes', async () => {
  wf.activities.accountPoolSize.mockResolvedValue(0);
  wf.activities.releaseTaskRun = vi.fn(async () => 'unpinned');
  let turns = 0;
  wf.activities.runAgentTurn.mockImplementation(async () => {
    if (++turns === 2) wf.handlers.get('cancel')!();
    wf.info = { ...wf.info, historyLength: wf.info.historyLength + 5_000 };
    return { output: `Reply ${turns}`, providerCompleted: true };
  });
  wf.wait = () => wf.handlers.get('followUp')!({ id: `u${turns}`, role: 'user', text: 'More', ts: turns });
  // 400,000 characters, but 1.2 MB once encoded.
  expect(await softwareDevV1_26({ ...input, prompt: '€'.repeat(400_000), project: { repos: ['/tmp/repo'] } }))
    .toEqual({ stage: 'cancelled' });
  expect(wf.activities.releaseTaskRun).not.toHaveBeenCalled();
});

it('WF-3: a merge-queue wait watches the position in a child, not a parent poll', async () => {
  const world = { id: 'task', kind: 'worktree', root: '/tmp/test', branch: 'b', base: 'main', repos: [{ path: '/tmp/repo' }] };
  Object.assign(wf.activities, {
    accountPoolSize: vi.fn(async () => 0), checkProposal: vi.fn(async () => ({ ready: true })),
    enqueueMerge: vi.fn(async () => undefined),
    mergeQueuePosition: vi.fn(async () => ({ position: 2, total: 3 })),
  });
  const watches: any[] = [];
  wf.startChild = (_type: unknown, options: any) => {
    watches.push(options.args[0]);
    return { signal: vi.fn(), result: () => new Promise(() => {}) };
  };
  wf.wait = () => {
    expect(wf.timeout).toBeUndefined();
    expect(wf.handlers.get('view')!()).toMatchObject({ mergeQueue: { position: 2, total: 3 } });
    wf.handlers.get('cancel')!();
  };
  expect(await softwareDevV1_26({ ...input, project: { repos: ['/tmp/repo'] },
    recovery: { resumeStage: 'merge', messages: [], world } })).toEqual({ stage: 'cancelled' });
  expect(watches).toEqual([expect.objectContaining({ taskId: 'task', previous: { position: 2, total: 3 } })]);
  expect(wf.activities.mergeQueuePosition).toHaveBeenCalledOnce();
});

it('WF-3/WF-4: a continued parent at the sub-task barrier notices a child whose settlement signal was lost', async () => {
  const { next, full } = await continuedRun();
  next.recovery.continued.subTasks = { ...next.recovery.continued.subTasks, awaitingResponse: [], raises: [] };
  // The child fails after run 2 has started, and the platform's signal is lost.
  wf.activities.settledChildTasks = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([])
    .mockResolvedValue([{ taskId: 'child-1', stage: 'failed' }]);
  const turns: any[][] = [];
  wf.activities.runAgentTurn.mockImplementation(async (args: any) => {
    turns.push(full(args));
    if (turns.length === 2) wf.handlers.get('cancel')!();
    return { output: 'Waiting for the child', providerCompleted: true, waitForSubtasks: true };
  });
  const waits: unknown[] = [];
  // The read races an untimed wake condition, which the harness also reports.
  wf.wait = () => { if (wf.timeout !== undefined) waits.push(wf.timeout); };
  expect(await softwareDevV1_26(next)).toEqual({ stage: 'cancelled' });
  // Rereads back off from an hour, doubling up to a day.
  expect(waits).toEqual([3_600_000, 7_200_000, 14_400_000]);
  expect(wf.activities.settledChildTasks).toHaveBeenLastCalledWith('task', ['child-1']);
  expect(turns[1]!.at(-1).text).toContain('Sub-task child-1 finished: failed');
});

it('WF-3/WF-4: a follow-up wakes the sub-task barrier while it rereads its children', async () => {
  const { next, full } = await continuedRun();
  next.recovery.continued.subTasks = { ...next.recovery.continued.subTasks, awaitingResponse: [], raises: [] };
  wf.activities.settledChildTasks = vi.fn().mockResolvedValueOnce([]).mockImplementation(() => {
    wf.handlers.get('followUp')!({ id: 'u-during-read', role: 'user', text: 'Stop waiting', ts: 0 });
    return new Promise(() => {});
  });
  const turns: any[][] = [];
  wf.activities.runAgentTurn.mockImplementation(async (args: any) => {
    turns.push(full(args));
    if (turns.length === 2) wf.handlers.get('cancel')!();
    return { output: 'Waiting for the child', providerCompleted: true, waitForSubtasks: true };
  });
  wf.wait = () => undefined;
  expect(await softwareDevV1_26(next)).toEqual({ stage: 'cancelled' });
  expect(turns[1]!.at(-1).text).toBe('Stop waiting');
});

it('WF-3/WF-4: a child replaced under its parent is reread like a restored one', async () => {
  wf.activities.accountPoolSize.mockResolvedValue(0);
  wf.activities.prepareChildTask = vi.fn(async () => ({ ...input, taskId: 'child-1' }));
  // The child's run is replaced: its handle's result is not its settlement.
  wf.startChild = () => ({ signal: vi.fn(), result: async () => ({ stage: 'cancelled', lifecycleReplacement: true }) });
  let turns = 0;
  wf.activities.runAgentTurn.mockImplementation(async () => {
    if (++turns === 1) return { output: 'Delegating', providerCompleted: true, subTasks: [{ title: 'Child', prompt: 'Part' }] };
    return { output: 'Waiting', providerCompleted: true, waitForSubtasks: true };
  });
  const waits: unknown[] = [];
  // The barrier's untimed wake condition is reported too; the reread is timed.
  wf.wait = () => { if (wf.timeout === undefined) return; waits.push(wf.timeout); wf.handlers.get('cancel')!(); };
  expect(await softwareDevV1_26({ ...input, project: { repos: ['/tmp/repo'] } })).toEqual({ stage: 'cancelled' });
  expect(waits[0]).toBe(3_600_000);
});

/** Run 1 spawns a child and parks at the sub-task barrier, holding its handle. */
async function parkedOnSpawnedChild(childResult: Promise<unknown>) {
  wf.activities.accountPoolSize.mockResolvedValue(0);
  wf.activities.prepareChildTask = vi.fn(async () => ({ ...input, taskId: 'child-1' }));
  wf.startChild = () => ({ signal: vi.fn(), result: () => childResult });
  wf.activities.runAgentTurn.mockImplementation(async () =>
    ({ output: 'Delegating', providerCompleted: true, subTasks: [{ title: 'Child', prompt: 'Part' }] }));
}

it('WF-3/WF-4: a child replaced while its parent waits at the barrier is reread', async () => {
  let replace!: () => void;
  await parkedOnSpawnedChild(new Promise((resolve) => { replace = () => resolve({ stage: 'cancelled', lifecycleReplacement: true }); }));
  const waits: unknown[] = [];
  wf.wait = () => {
    waits.push(wf.timeout);
    // A person marks the child done while the parent holds its handle.
    if (waits.length === 1) replace();
    if (wf.timeout === 3_600_000) wf.handlers.get('cancel')!();
  };
  expect(await softwareDevV1_26({ ...input, project: { repos: ['/tmp/repo'] } })).toEqual({ stage: 'cancelled' });
  expect(waits[0]).toBeUndefined();
  expect(waits).toContain(3_600_000);
  // It chose the reread without leaving the barrier for another turn.
  expect(wf.activities.runAgentTurn).toHaveBeenCalledOnce();
});

it('WF-3/WF-4: without the forget patch a replaced child keeps its handle and the untimed wait', async () => {
  wf.absentPatches = new Set(['software-dev-forget-replaced-child-handle-v1']);
  await parkedOnSpawnedChild(Promise.resolve({ stage: 'cancelled', lifecycleReplacement: true }));
  const waits: unknown[] = [];
  wf.wait = () => { waits.push(wf.timeout); wf.handlers.get('cancel')!(); };
  expect(await softwareDevV1_26({ ...input, project: { repos: ['/tmp/repo'] } })).toEqual({ stage: 'cancelled' });
  expect(waits[0]).toBeUndefined();
});

it('WF-3/WF-4: without the reread patch a restored child takes the untimed wait', async () => {
  wf.absentPatches = new Set(['software-dev-child-settlement-recheck-v1']);
  const { next } = await continuedRun();
  next.recovery.continued.subTasks = { ...next.recovery.continued.subTasks, awaitingResponse: [], raises: [] };
  wf.activities.runAgentTurn.mockImplementation(async () => ({ output: 'Waiting', providerCompleted: true, waitForSubtasks: true }));
  const waits: unknown[] = [];
  wf.wait = () => { waits.push(wf.timeout); wf.handlers.get('cancel')!(); };
  expect(await softwareDevV1_26(next)).toEqual({ stage: 'cancelled' });
  expect(waits[0]).toBeUndefined();
});

describe('WF-37: a failed merge-only or just-do run releases its world', () => {
  const remote = { id: 'task', kind: 'e2b', root: '/sandbox', branch: 'b', base: 'main' };
  beforeEach(() => {
    wf.activities.accountPoolSize.mockResolvedValue(0);
    wf.activities.destroyWorld = vi.fn(async () => undefined);
    wf.activities.enqueueMerge = vi.fn(async () => wf.handlers.get('mergeGranted')!());
    wf.activities.releaseMerge = vi.fn(async () => undefined);
  });

  it('merge-only: a failed merge publishes the failure, then destroys the world', async () => {
    wf.activities.finalizeMergeActivity = vi.fn(async () => ({ merged: false, conflict: 'CONFLICT in index.js' }));
    expect(await mergeOnlyV1_7({ ...input, branch: 'b' })).toEqual({ stage: 'failed' });
    expect(wf.activities.destroyWorld).toHaveBeenCalledWith(expect.objectContaining({ id: 'task', kind: 'worktree' }));
    const failed = wf.activities.publishView.mock.invocationCallOrder[
      wf.activities.publishView.mock.calls.findIndex((call: any[]) => call[1].status === 'failed')];
    expect(failed).toBeLessThan(wf.activities.destroyWorld.mock.invocationCallOrder[0]);
  });

  it('merge-only: a remote world is dropped from the view once released', async () => {
    wf.activities.createWorld.mockResolvedValue(remote);
    wf.activities.finalizeMergeActivity = vi.fn(async () => { throw new Error('merge activity failed'); });
    await expect(mergeOnlyV1_7({ ...input, branch: 'b', project: { repos: [], worldProvider: 'e2b' } }))
      .rejects.toThrow('merge activity failed');
    expect(wf.activities.releaseMerge).toHaveBeenCalled();
    expect(wf.activities.destroyWorld).toHaveBeenCalledWith(expect.objectContaining({ kind: 'e2b' }));
    expect(wf.activities.publishView.mock.calls.at(-1)[1].world).toBeUndefined();
  });

  it('merge-only: a failure before the Review gate releases the world too', async () => {
    wf.activities.accountPoolSize.mockRejectedValue(new Error('coordinator unavailable'));
    await expect(mergeOnlyV1_7({ ...input, branch: 'b' })).rejects.toThrow('coordinator unavailable');
    expect(wf.activities.destroyWorld).toHaveBeenCalledOnce();
  });

  it('just-do: a failed turn destroys its remote world and drops it from the view', async () => {
    wf.activities.createWorld.mockResolvedValue(remote);
    wf.activities.runAgentTurn.mockRejectedValue(new Error('agent refused the task'));
    await expect(justDoV1_7({ ...input, project: { repos: [], worldProvider: 'e2b' } })).rejects.toThrow('agent refused the task');
    expect(wf.activities.destroyWorld).toHaveBeenCalledWith(expect.objectContaining({ kind: 'e2b' }));
    expect(wf.activities.publishView.mock.calls.at(-1)[1].world).toBeUndefined();
  });

  it('just-do: a failed turn keeps a local worktree for inspection, as a finished one does', async () => {
    wf.activities.runAgentTurn.mockRejectedValue(new Error('agent refused the task'));
    await expect(justDoV1_7(input)).rejects.toThrow('agent refused the task');
    expect(wf.activities.destroyWorld).not.toHaveBeenCalled();
  });

  it('just-do: an approved run whose work cannot be saved still retains its world', async () => {
    wf.activities.createWorld.mockResolvedValue(remote);
    wf.activities.checkpointResourceOnlyWork = vi.fn(async () => false);
    wf.activities.commitWork.mockResolvedValue({ committed: false });
    await expect(justDoV1_7({ ...input, project: { repos: ['/repo'], worldProvider: 'e2b' } }))
      .rejects.toThrow('retaining the world for recovery');
    expect(wf.activities.destroyWorld).not.toHaveBeenCalled();
  });

  it('just-do: a failure while applying approved resources retains the world', async () => {
    wf.activities.createWorld.mockResolvedValue(remote);
    wf.activities.settleResourceReview = vi.fn(async () => { throw new Error('resource store unavailable'); });
    await expect(justDoV1_7({ ...input, project: { repos: [], worldProvider: 'e2b' } })).rejects.toThrow('resource store unavailable');
    expect(wf.activities.destroyWorld).not.toHaveBeenCalled();
  });

  it('keeps histories recorded without the patch releasing nothing', async () => {
    wf.absentPatches = new Set(['merge-only-failure-releases-world-v1', 'just-do-failure-releases-world-v1']);
    wf.activities.finalizeMergeActivity = vi.fn(async () => ({ merged: false, conflict: 'CONFLICT in index.js' }));
    expect(await mergeOnlyV1_7({ ...input, branch: 'b' })).toEqual({ stage: 'failed' });
    wf.activities.createWorld.mockResolvedValue(remote);
    wf.activities.runAgentTurn.mockRejectedValue(new Error('agent refused the task'));
    await expect(justDoV1_7({ ...input, project: { repos: [], worldProvider: 'e2b' } })).rejects.toThrow();
    expect(wf.activities.destroyWorld).not.toHaveBeenCalled();
  });
});

// pramana#3: a sub-task whose resource publication was refused failed its
// workflow outright, leaving its output in a kept world and its parent with
// only "finished: failed".
describe('resource publication by sub-tasks', () => {
  const child = { ...input, taskId: 'child', parentTaskId: 'parent' };
  const conflict = 'raw_data: a file was changed both by this task and in a newer published version (index.txt). Keep one version: rename or remove this task\'s copy.';

  function reviewAndConfirm() {
    wf.activities.accountPoolSize.mockResolvedValue(0);
    wf.activities.runAgentTurn.mockResolvedValue({ openPrRequested: true, completed: true });
    wf.activities.pendingResourceCandidates = vi.fn(async () => 0);
    const views: any[] = [];
    wf.activities.publishView.mockImplementation(async (_id: string, view: any) => {
      views.push(view);
      if (view.stage === 'review' && view.waitingFor?.kind === 'parent') wf.handlers.get('parentResponse')!({ action: 'confirm' });
    });
    return views;
  }

  it('escalates a refused publication to the parent, and Retry publishes again', async () => {
    const views = reviewAndConfirm();
    wf.activities.settleResourceReview = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Activity task failed'), { cause: new Error(conflict) }))
      .mockResolvedValue(undefined);
    let escalated: any;
    wf.wait = () => {
      const view = wf.handlers.get('view')!();
      if (view.stage !== 'escalated' || escalated) return;
      escalated = view;
      wf.handlers.get('parentResponse')!({ action: 'retry' });
    };
    const result = await softwareDevV1_27(child);
    expect(escalated).toMatchObject({ status: 'blocked', waitingFor: { kind: 'parent' },
      error: `Could not publish resources: ${conflict} Nothing was lost; Retry publishes again.` });
    expect(wf.childSignal).toHaveBeenCalledWith('raiseFromChild', expect.objectContaining({ type: 'blocked', detail: escalated.error }));
    expect(wf.activities.settleResourceReview).toHaveBeenCalledTimes(2);
    expect(result.stage).toBe('done');
    expect(views.at(-1).error).toBeUndefined();
  });

  // pramana#3 (2026-10-09): 7,854 pages both sides had added differently; the
  // escalation's only way forward was removing the task's copy.
  it('offers to keep this task\'s version of conflicting files, and publishes with it', async () => {
    const views = reviewAndConfirm();
    const refused = Object.assign(new Error('Activity task failed'), { cause: Object.assign(new Error(conflict), { type: 'resource-conflict' }) });
    wf.activities.settleResourceReview = vi.fn()
      .mockRejectedValueOnce(refused)
      .mockResolvedValue(undefined);
    let escalated: any;
    wf.wait = () => {
      const view = wf.handlers.get('view')!();
      if (view.stage !== 'escalated' || escalated) return;
      escalated = view;
      wf.handlers.get('keepOwnResources')!();
    };
    const result = await softwareDevV1_27(child);
    expect(escalated.actions.map((a: any) => a.name)).toEqual(expect.arrayContaining(['retry', 'keepOwnResources']));
    expect(escalated.actions.find((a: any) => a.name === 'keepOwnResources').label).toBe('Keep this task’s version');
    expect(escalated.error).toMatch(/or keep this task’s version of those files\.$/);
    expect(wf.activities.settleResourceReview.mock.calls).toEqual([['child'], ['child', { keepOwn: true }]]);
    expect(result.stage).toBe('done');
    expect(views.at(-1).actions.map((a: any) => a.name)).not.toContain('keepOwnResources');
  });

  // A sub-task's escalation goes to its parent, whose agent answers with
  // respond_to_sub_task: it must have the same choice a person has.
  it('offers its parent the version choice, and keeps its version when the parent says so', async () => {
    reviewAndConfirm();
    const refused = Object.assign(new Error('Activity task failed'), { cause: Object.assign(new Error(conflict), { type: 'resource-conflict' }) });
    wf.activities.settleResourceReview = vi.fn()
      .mockRejectedValueOnce(refused)
      .mockResolvedValue(undefined);
    let answered = false;
    wf.wait = () => {
      if (answered || wf.handlers.get('view')!().stage !== 'escalated') return;
      answered = true;
      wf.handlers.get('parentResponse')!({ action: 'keep_own' });
    };
    expect((await softwareDevV1_27(child)).stage).toBe('done');
    expect(wf.childSignal).toHaveBeenCalledWith('raiseFromChild', expect.objectContaining({ type: 'blocked', choices: ['keep_own'] }));
    expect(wf.activities.settleResourceReview.mock.calls).toEqual([['child'], ['child', { keepOwn: true }]]);
  });

  it('names the extra answers a raise accepts', () => {
    const raise = { childTaskId: 'c', childTitle: 'OCR', type: 'blocked' as const, detail: 'Could not publish resources' };
    expect(subtaskRaiseText(raise)).toMatch(/\(confirm \| comment \| retry \| cancel\)\.$/);
    expect(subtaskRaiseText({ ...raise, choices: ['keep_own'] }))
      .toMatch(/\(confirm \| comment \| retry \| cancel \| keep_own: publish again keeping its version of the conflicting files\)\.$/);
  });

  it('offers no version choice when publishing failed for another reason', async () => {
    reviewAndConfirm();
    wf.activities.settleResourceReview = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Activity task failed'), { cause: new Error('resource store unavailable') }))
      .mockResolvedValue(undefined);
    let escalated: any;
    wf.wait = () => {
      const view = wf.handlers.get('view')!();
      if (view.stage !== 'escalated' || escalated) return;
      escalated = view;
      wf.handlers.get('keepOwnResources')!(); // ignored: there is nothing to choose
      wf.handlers.get('parentResponse')!({ action: 'retry' });
    };
    await softwareDevV1_27(child);
    expect(escalated.actions.map((a: any) => a.name)).not.toContain('keepOwnResources');
    expect(wf.activities.settleResourceReview.mock.calls).toEqual([['child'], ['child']]);
  });

  it('keeps histories recorded before the escalation failing the task', async () => {
    reviewAndConfirm();
    wf.absentPatches = new Set(['resource-publish-escalates-v1']);
    wf.activities.settleResourceReview = vi.fn(async () => { throw new Error(conflict); });
    await expect(softwareDevV1_27(child)).rejects.toThrow(conflict);
  });

  it('brings a landed sub-task\'s data into the parent\'s world before its next turn', async () => {
    wf.activities.accountPoolSize.mockResolvedValue(0);
    wf.activities.prepareChildTask = vi.fn(async () => ({ ...input, taskId: 'child' }));
    let finish!: (value: { stage: string }) => void;
    wf.startChild = async () => ({ result: () => new Promise((resolve) => { finish = resolve; }) });
    wf.activities.refreshResourceForks = vi.fn(async () => [
      { attachmentId: 'r1', name: 'raw_data', path: 'resources/raw_data', revisionId: 'rev', added: 12, modified: 1, deleted: 0 },
      { attachmentId: 'r2', name: 'index', path: 'resources/index', revisionId: 'rev2', added: 0, modified: 0, deleted: 0, conflicts: ['a.txt'] },
    ]);
    const prompts: string[] = [];
    wf.activities.runAgentTurn.mockImplementation(async (args: any) => {
      prompts.push(JSON.stringify(args.messages ?? args));
      if (prompts.length === 1) return { subTasks: [{ title: 'child', prompt: 'work' }] };
      if (prompts.length === 2) { finish({ stage: 'done' }); return { waitForSubtasks: true }; }
      wf.handlers.get('cancel')!();
      return {};
    });
    wf.wait = () => { if (prompts.length >= 3) wf.handlers.get('cancel')!(); };
    await softwareDevV1_27(input);
    expect(wf.activities.refreshResourceForks).toHaveBeenCalledOnce();
    expect(wf.activities.refreshResourceForks).toHaveBeenCalledWith('task');
    // The agent reads them at the top of the turn after the sub-task landed.
    const texts = wf.handlers.get('view')!().messages.map((m: any) => m.text);
    const landed = texts.findIndex((text: string) => text.startsWith('Sub-task child finished: done'));
    expect(texts.slice(landed + 1, landed + 3)).toEqual([
      'resources/raw_data now includes a sub-task\'s data: 12 new, 1 changed, 0 removed files.',
      'resources/index was not updated with a sub-task\'s data: a file you changed differs from the sub-task\'s (a.txt). Keep one version (rename or remove yours); it comes in when the next sub-task finishes, and your publication fails until it does.',
    ]);
    expect(prompts).toHaveLength(3);
  });

  // pramana#3: W2's 7.7 GB took hours to come in, while the task still read
  // "Waiting 90 min" from the pause it had left, and a follow-up seemed ignored.
  it('shows that it is bringing a sub-task\'s data in while it does', async () => {
    wf.activities.accountPoolSize.mockResolvedValue(0);
    wf.activities.prepareChildTask = vi.fn(async () => ({ ...input, taskId: 'child' }));
    let finish!: (value: { stage: string }) => void;
    wf.startChild = async () => ({ result: () => new Promise((resolve) => { finish = resolve; }) });
    const views: any[] = [];
    wf.activities.publishView.mockImplementation(async (_id: string, view: any) => { views.push(view); });
    let during: any;
    wf.activities.refreshResourceForks = vi.fn(async () => { during = views.at(-1); return []; });
    let turns = 0;
    wf.activities.runAgentTurn.mockImplementation(async () => {
      turns++;
      if (turns === 1) return { subTasks: [{ title: 'child', prompt: 'work' }] };
      if (turns === 2) { finish({ stage: 'done' }); return { waitForSubtasks: true }; }
      wf.handlers.get('cancel')!();
      return {};
    });
    wf.wait = () => { if (turns >= 3) wf.handlers.get('cancel')!(); };
    await softwareDevV1_27(input);
    expect(during).toMatchObject({ stage: 'do', status: 'active', state: { refreshingResources: true } });
    expect(during.waitingFor).toBeUndefined();
    expect(views.at(-1).state.refreshingResources).toBeUndefined();
  });

  // pramana#3: a deploy restarted the worker during W2's delivery once per
  // attempt until none were left; the delivery then waited for Confirm, and
  // the parent never had W2's OCR to build on.
  it('tries a failed delivery again before the next turn, once', async () => {
    wf.activities.accountPoolSize.mockResolvedValue(0);
    wf.activities.prepareChildTask = vi.fn(async () => ({ ...input, taskId: 'child' }));
    let finish!: (value: { stage: string }) => void;
    wf.startChild = async () => ({ result: () => new Promise((resolve) => { finish = resolve; }) });
    const heartbeat = Object.assign(new Error('Activity task failed'), { cause: new Error('activity Heartbeat timeout') });
    wf.activities.refreshResourceForks = vi.fn()
      .mockRejectedValueOnce(heartbeat)
      .mockResolvedValueOnce([{ attachmentId: 'r1', name: 'raw_data', path: 'raw_data', revisionId: 'rev', added: 706_916, modified: 0, deleted: 0 }]);
    let turns = 0;
    wf.activities.runAgentTurn.mockImplementation(async () => {
      turns++;
      if (turns === 1) return { subTasks: [{ title: 'child', prompt: 'work' }] };
      if (turns === 2) { finish({ stage: 'done' }); return { waitForSubtasks: true }; }
      if (turns === 4) wf.handlers.get('cancel')!();
      return {};
    });
    // The user's follow-up after the turn the failure was reported in.
    wf.wait = () => turns >= 4 ? wf.handlers.get('cancel')!()
      : wf.handlers.get('followUp')!({ id: `u${turns}`, role: 'user', text: 'Would an R2 bucket help?', ts: turns });
    await softwareDevV1_27(input);
    expect(wf.activities.refreshResourceForks).toHaveBeenCalledTimes(2);
    const texts = wf.handlers.get('view')!().messages.map((m: any) => m.text);
    expect(texts).toContain('Could not bring sub-tasks\' saved data into your world: activity Heartbeat timeout It is kept, and is tried again before your next turn.');
    expect(texts).toContain('raw_data now includes a sub-task\'s data: 706916 new, 0 changed, 0 removed files.');
  });

  it('keeps histories recorded before the retry waiting for the next sub-task or Confirm', async () => {
    wf.absentPatches = new Set(['subtask-resource-refresh-retry-v1']);
    wf.activities.accountPoolSize.mockResolvedValue(0);
    wf.activities.prepareChildTask = vi.fn(async () => ({ ...input, taskId: 'child' }));
    let finish!: (value: { stage: string }) => void;
    wf.startChild = async () => ({ result: () => new Promise((resolve) => { finish = resolve; }) });
    wf.activities.refreshResourceForks = vi.fn(async () => { throw new Error('restic exited 1'); });
    let turns = 0;
    wf.activities.runAgentTurn.mockImplementation(async () => {
      turns++;
      if (turns === 1) return { subTasks: [{ title: 'child', prompt: 'work' }] };
      if (turns === 2) { finish({ stage: 'done' }); return { waitForSubtasks: true }; }
      if (turns === 4) wf.handlers.get('cancel')!();
      return {};
    });
    // The user's follow-up after the turn the failure was reported in.
    wf.wait = () => turns >= 4 ? wf.handlers.get('cancel')!()
      : wf.handlers.get('followUp')!({ id: `u${turns}`, role: 'user', text: 'Would an R2 bucket help?', ts: turns });
    await softwareDevV1_27(input);
    expect(wf.activities.refreshResourceForks).toHaveBeenCalledOnce();
  });
});
