import { describe, expect, it, vi } from 'vitest';
import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxApi } from '../src/platform/api.js';
import { MANIFESTS } from '../src/contrib/manifests.js';
// Derived, not hard-coded: the pinned type moves every time a workflow ships a
// new replay version, and a literal here just makes an unrelated PR red.
const bundledVersion = (name: string) => MANIFESTS.find((m) => m.name === name)!.version;
import type { TaskView } from '../src/domain/types.js';
import { QRY_ACCOUNT_TASK_LEASES, QRY_AGENT_QUEUE } from '../src/coordinators/names.js';
import { AuthorizationService, projectScope } from '../src/platform/authorization.js';
import { PermissionRequests } from '../src/platform/permission-requests.js';
import { sameProposalIdentity } from '../src/workflows/software-dev.js';
import { lifecycleReplacementKey } from '../src/platform/lifecycle-replacement.js';
import { RunnerPoolService } from '../src/world/runners.js';

async function fixture(refreshCredentialHealth?: () => Promise<void>, withAuthorization = false) {
  const store = (await Store.create(':memory:'));
  (await store.claimPersonalOrganization('test'));
  const project = (await store.createProject('Transitions', { repos: ['/tmp'], defaultBase: 'main', defaultTarget: 'main' }));
  const tokens = new TokenAuthority();
  const token = (await tokens.mintPrincipal('user:test', ['*'], project.id)).token;
  const starts: Array<{ type: string; options: any }> = [];
  const terminated: string[] = [];
  const signalled: Array<{ id: string; signal: string; args: unknown[]; runId?: string }> = [];
  const hiddenTurnIds = ['hidden-account-turn'];
  let liveViewOverride: TaskView | undefined;
  let gracefulResult: (() => Promise<unknown>) | undefined;
  const client = {
    workflow: {
      getHandle(id: string, runId?: string) {
        const handle: any = {
          async describe() { return { runId: runId ?? 'old-run', status: { name: 'COMPLETED' } }; },
          async terminate(reason: string) { terminated.push(`${id}:${reason}`); },
          async signal(signal: string, ...args: unknown[]) { signalled.push({ id, signal, args, runId }); },
          async executeUpdate(_name: string, options: { args: [string] }) {
            return { workflow: options.args[0] };
          },
          async query(name: string) {
            if (name === 'view') {
              const live = liveViewOverride ?? (await store.getTask(task.id))?.lastView;
              if (!live) throw new Error('no live view');
              return live;
            }
            if (name === QRY_AGENT_QUEUE)
              return { queue: [{ taskId: task.id, turnId: 'hidden-agent-turn' }], current: [] };
            if (name === QRY_ACCOUNT_TASK_LEASES) return hiddenTurnIds;
            throw new Error('no live query');
          },
        };
        if (gracefulResult) handle.result = gracefulResult;
        return handle;
      },
      async signalWithStart(_type: string, options: any) {
        signalled.push({ id: options.workflowId, signal: options.signal, args: options.signalArgs });
      },
      async start(type: string, options: any) {
        starts.push({ type, options });
        return {};
      },
    },
  };
  const runners = new RunnerPoolService(store);
  const authorization = withAuthorization ? (await AuthorizationService.create(store)) : undefined;
  const api = new KarmaxApi({ store, client, authorization, taskQueue: 'test', tokens, runners,
    refreshCredentialHealth } as any);
  const task = (await store.createTask({
    projectId: project.id,
    title: 'Move me',
    workflow: 'software-dev',
    workflowVersion: '1.4.0',
    createdBy: { kind: 'user', userId: 'test' },
    params: { prompt: 'work', base: 'main', target: 'main' },
  }));
  const view: TaskView = {
    taskId: task.id,
    title: task.title,
    workflow: task.workflow,
    stage: 'do',
    status: 'active',
    messages: [{ id: 'm0', role: 'user', text: 'work', ts: 0 }],
    actions: [],
    state: { turnsSeen: 1 },
    base: 'main',
    targetBranch: 'main',
    updatedAt: 1,
  };
  (await store.saveView(task.id, view));
  return {
    store, project, tokens, token, api, task, view, starts, terminated, signalled, runners, client, authorization,
    setLiveView(view?: TaskView) { liveViewOverride = view; },
    setGracefulResult(result?: () => Promise<unknown>) { gracefulResult = result; },
  };
}

describe('task stage transitions', () => {
  it('journals accepted cancellation for checkpoint interruption, but not a rejected signal', async () => {
    const f = await fixture();
    try {
      await f.api.signalTask(f.token, f.task.id, 'cancel');
      expect(await f.store.eventsOfType(f.task.id, 'task.cancel-requested')).toHaveLength(1);
      vi.spyOn(f.client.workflow, 'getHandle').mockReturnValue({ signal: async () => { throw new Error('Temporal unavailable'); } });
      await expect(f.api.signalTask(f.token, f.task.id, 'cancel')).rejects.toThrow('Temporal unavailable');
      expect(await f.store.eventsOfType(f.task.id, 'task.cancel-requested')).toHaveLength(1);
    } finally { await f.store.close(); }
  });

  it('waits for cancelled cleanup to close before restoring Review', async () => {
    const f = await fixture();
    await f.store.patchTaskParams(f.task.id, { _workflowRunId: 'old-run' });
    await f.store.saveView(f.task.id, {
      ...f.view, stage: 'cancelled', status: 'cancelled',
      state: { cancelled: true, cancelledFrom: 'review' },
    });
    let closed = false;
    const getHandle = f.client.workflow.getHandle.bind(f.client.workflow);
    const descriptions: Array<string | undefined> = [];
    vi.spyOn(f.client.workflow, 'getHandle').mockImplementation((id: string, runId?: string) => ({
      ...getHandle(id, runId),
      async describe() {
        descriptions.push(runId);
        return { runId: 'old-run', status: { name: closed ? 'COMPLETED' : 'RUNNING' } };
      },
    }));
    const start = vi.spyOn(f.client.workflow, 'start').mockImplementation(async () => {
      if (!closed) throw new WorkflowExecutionAlreadyStartedError('Workflow execution already started', f.task.id, 'softwareDev');
      return { firstExecutionRunId: 'replacement-run' };
    });
    const restore = f.api.moveTaskStage(f.token, f.task.id, 'review');
    // Attach the assertion immediately so the pre-fix rejection is observed.
    const restored = restore.then(value => ({ value }), error => ({ error }));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(start).not.toHaveBeenCalled();
    expect((await f.store.getTask(f.task.id))?.lastView?.status).toBe('cancelled');
    closed = true;
    expect(await restored).toMatchObject({ value: { stage: 'pr', state: { restoringTo: 'review' } } });
    expect(descriptions.length).toBeGreaterThan(1);
    expect(descriptions.every(runId => runId === 'old-run')).toBe(true);
    expect(f.terminated).toEqual([]);
    expect((await f.store.getTask(f.task.id))?.params._workflowRunId).toBe('replacement-run');
  });

  it.each(['COMPLETED', 'FAILED', 'CANCELLED', 'TERMINATED', 'TIMED_OUT', 'missing'])(
    'restores a terminal task whose execution is %s', async status => {
      const f = await fixture();
      await f.store.saveView(f.task.id, {
        ...f.view, stage: 'cancelled', status: 'cancelled',
        state: { cancelledFrom: 'review' },
      });
      const getHandle = f.client.workflow.getHandle.bind(f.client.workflow);
      vi.spyOn(f.client.workflow, 'getHandle').mockImplementation((id: string, runId?: string) => ({
        ...getHandle(id, runId),
        async describe() {
          if (status === 'missing') throw new WorkflowNotFoundError('expired', id, runId);
          return { runId: 'old-run', status: { name: status } };
        },
      }));
      await expect(f.api.moveTaskStage(f.token, f.task.id, 'review')).resolves.toMatchObject({ stage: 'pr' });
      expect(f.starts).toHaveLength(1);
      expect(f.terminated).toEqual([]);
    },
  );

  it.each(['review', 'draft'])('preserves a slow cancelled workspace when moving to %s times out', async target => {
    const f = await fixture();
    const cancelled = { ...f.view, stage: 'cancelled' as const, status: 'cancelled' as const,
      state: { cancelledFrom: 'review' } };
    await f.store.saveView(f.task.id, cancelled);
    const params = (await f.store.getTask(f.task.id))!.params;
    const described: Array<string | undefined> = [];
    const getHandle = f.client.workflow.getHandle.bind(f.client.workflow);
    vi.spyOn(f.client.workflow, 'getHandle').mockImplementation((id: string, runId?: string) => ({
      ...getHandle(id, runId),
      async describe() {
        described.push(runId);
        return { runId: 'old-run', status: { name: 'RUNNING' } };
      },
    }));
    vi.useFakeTimers();
    try {
      const result = f.api.moveTaskStage(f.token, f.task.id, target).then(value => ({ value }), error => ({ error }));
      await vi.advanceTimersByTimeAsync(10_500);
      expect(await result).toMatchObject({ error: { message: expect.stringContaining('still finishing cleanup') } });
      expect(f.starts).toEqual([]);
      expect(f.terminated).toEqual([]);
      expect((await f.store.getTask(f.task.id))!.lastView).toEqual(cancelled);
      expect((await f.store.getTask(f.task.id))!.params).toEqual(params);
      // An unpinned legacy record looks up the current execution once only.
      expect(described[0]).toBeUndefined();
      expect(described.slice(1).every(runId => runId === 'old-run')).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('fails closed when Temporal cannot verify terminal cleanup', async () => {
    const f = await fixture();
    await f.store.saveView(f.task.id, {
      ...f.view, stage: 'cancelled', status: 'cancelled', state: { cancelledFrom: 'review' },
    });
    const getHandle = f.client.workflow.getHandle.bind(f.client.workflow);
    vi.spyOn(f.client.workflow, 'getHandle').mockImplementation((id: string, runId?: string) => ({
      ...getHandle(id, runId),
      async describe() { throw new Error('Temporal unavailable'); },
    }));
    await expect(f.api.moveTaskStage(f.token, f.task.id, 'review')).rejects.toThrow('Cannot verify');
    expect(f.starts).toEqual([]);
    expect((await f.store.getTask(f.task.id))!.lastView!.status).toBe('cancelled');
  });

  it('never terminates or overwrites the winner of overlapping terminal restores', async () => {
    const f = await fixture();
    await f.store.patchTaskParams(f.task.id, { _workflowRunId: 'old-run' });
    await f.store.saveView(f.task.id, {
      ...f.view, stage: 'cancelled', status: 'cancelled', state: { cancelledFrom: 'review' },
    });
    let close!: () => void;
    const cleanup = new Promise<void>(resolve => { close = resolve; });
    let described = 0;
    const getHandle = f.client.workflow.getHandle.bind(f.client.workflow);
    vi.spyOn(f.client.workflow, 'getHandle').mockImplementation((id: string, runId?: string) => ({
      ...getHandle(id, runId),
      async describe() {
        expect(runId).toBe('old-run');
        described++;
        await cleanup;
        return { runId, status: { name: 'COMPLETED' } };
      },
    }));
    let started = false;
    vi.spyOn(f.client.workflow, 'start').mockImplementation(async () => {
      if (started) throw new WorkflowExecutionAlreadyStartedError('already running', f.task.id, 'softwareDev');
      started = true;
      return { firstExecutionRunId: 'winner' };
    });
    const restores = Promise.allSettled([
      f.api.moveTaskStage(f.token, f.task.id, 'review'),
      f.api.moveTaskStage(f.token, f.task.id, 'review'),
    ]);
    await expect.poll(() => described).toBe(2);
    close();
    const outcomes = await restores;
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
    expect((await f.store.getTask(f.task.id))!.params._workflowRunId).toBe('winner');
    expect((await f.store.getTask(f.task.id))!.lastView!.stage).toBe('pr');
    expect(f.terminated).toEqual([]);
  });

  it('keeps the winning run reachable when an overlapping resume finishes preparing too late', async () => {
    const f = (await fixture());
    (await f.store.updateTaskParams(f.task.id, { ...f.task.params, _workflowRunId: 'old-run' }));
    (await f.store.saveView(f.task.id, {
      ...f.view, status: 'waiting', waitingFor: { kind: 'human' },
      state: { ...f.view.state, humanPauseOrigin: 'do' },
    }));
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const preparing = new Promise<void>((resolve) => { entered = resolve; });
    const resolveParams = (f.api as any).resolveTaskParams.bind(f.api);
    let calls = 0;
    vi.spyOn(f.api as any, 'resolveTaskParams').mockImplementation(async (...args: any[]) => {
      if (++calls === 1) { entered(); await blocked; }
      return resolveParams(...args);
    });
    let started = false;
    vi.spyOn(f.client.workflow, 'start').mockImplementation(async () => {
      if (started) throw new WorkflowExecutionAlreadyStartedError('already running', f.task.id, 'softwareDev');
      started = true;
      return { firstExecutionRunId: 'new-run' };
    });

    const loser = f.api.signalTask(f.token, f.task.id, 'followUp', 'First resume');
    const rejected = expect(loser).rejects.toThrow('already running');
    await preparing;
    await f.api.signalTask(f.token, f.task.id, 'followUp', 'Second resume');
    expect((await f.store.getTask(f.task.id))?.params._workflowRunId).toBe('new-run');
    release();
    await rejected;

    // The losing preparation must not restore old-run before its start fails.
    expect((await f.store.getTask(f.task.id))?.params._workflowRunId).toBe('new-run');
    await f.api.signalTask(f.token, f.task.id, 'followUp', 'Done');
    expect(await f.api.resumeAfterCredentialDecision(f.task.id, 'Access granted')).toMatchObject({ resumed: true });
    expect(f.signalled.slice(-2)).toEqual([
      expect.objectContaining({ signal: 'followUp', runId: 'new-run' }),
      expect.objectContaining({ signal: 'followUp', runId: 'new-run' }),
    ]);
  });

  it('preserves parameter edits accepted while a replacement start is awaiting acknowledgement', async () => {
    const f = (await fixture());
    vi.spyOn(f.client.workflow, 'start').mockImplementation(async () => {
      const current = (await f.store.getTask(f.task.id))!;
      (await f.store.updateTaskParams(f.task.id, {
        ...current.params, priority: 4, _authorization: { profileId: 'updated-grant' },
      }));
      return { firstExecutionRunId: 'new-run' };
    });
    await f.api.moveTaskStage(f.token, f.task.id, 'human');
    expect((await f.store.getTask(f.task.id))?.params).toMatchObject({
      priority: 4, _authorization: { profileId: 'updated-grant' }, _workflowRunId: 'new-run',
    });
  });

  it('does not roll back a run reference when an authorization update completes late', async () => {
    const f = (await fixture());
    (await f.store.updateTaskParams(f.task.id, { ...f.task.params, _workflowRunId: 'old-run' }));
    vi.spyOn(f.client.workflow, 'getHandle').mockReturnValue({
      async executeUpdate() {
        (await f.store.patchTaskParams(f.task.id, { _workflowRunId: 'new-run', priority: 4 }));
        return { applied: true };
      },
    });
    const task = await f.api.setTaskAuthorization(f.token, f.task.id, 'maintainer');
    expect(task.params).toMatchObject({ _workflowRunId: 'new-run', priority: 4,
      _authorization: { profileId: 'maintainer' } });
  });

  it('rechecks credential health before retrying a credential escalation', async () => {
    const order: string[] = [];
    const f = (await fixture(async () => { order.push('health'); }));
    (await f.store.saveView(f.task.id, {
      ...f.view,
      stage: 'escalated',
      status: 'blocked',
      error: 'No usable codex credential — every allowed login/key needs attention.',
      actions: [{ name: 'retry', kind: 'signal', label: 'Retry', enabled: true }],
    }));
    const originalSignal = f.signalled;

    await f.api.signalTask(f.token, f.task.id, 'retry');
    if (originalSignal.some((item) => item.id === f.task.id && item.signal === 'retry')) order.push('retry');

    expect(order).toEqual(['health', 'retry']);
  });

  it('does not signal Retry when rearming the credential fails', async () => {
    const f = (await fixture(async () => { throw new Error('coordinator unavailable'); }));
    (await f.store.saveView(f.task.id, { ...f.view, stage: 'escalated', status: 'blocked',
      error: 'No usable claude credential — every allowed login/key needs attention.' }));
    await expect(f.api.signalTask(f.token, f.task.id, 'retry')).rejects.toThrow('coordinator unavailable');
    expect(f.signalled).toEqual([]);
  });

  it('force-stops a wedged Setup cancellation and releases its runner capacity', async () => {
    const f = (await fixture());
    (await f.store.setTaskWorkflowVersion(f.task.id, '1.25.0'));
    (await f.store.saveView(f.task.id, {
      ...f.view,
      stage: 'setup',
      status: 'active',
      state: {},
      actions: [{ name: 'cancel', kind: 'signal', label: 'Cancel', enabled: true, danger: true }],
    }));
    (await f.store.createRunnerPool({
      id: 'setup-capacity',
      organizationId: f.project.organizationId!,
      name: 'Setup capacity',
      provider: 'e2b',
      mode: 'managed',
      capacity: { activeWorlds: 1, cpu: 2, memoryMb: 2048, gpu: 0 },
      enabled: true,
    }));
    const lease = (await f.store.requestWorldLease({
      runnerPoolId: 'setup-capacity',
      organizationId: f.project.organizationId!,
      projectId: f.project.id,
      taskId: f.task.id,
      worldId: f.task.id,
    }));
    f.setGracefulResult(async () => { throw new Error('setup did not acknowledge cancellation'); });

    await f.api.signalTask(f.token, f.task.id, 'cancel');

    expect(f.terminated).toEqual([expect.stringContaining('Setup cancellation did not stop')]);
    expect((await f.store.getTask(f.task.id))?.lastView).toMatchObject({
      stage: 'cancelled', status: 'cancelled', state: { cancelled: true },
    });
    expect((await f.store.worldLease(lease.id))?.state).toBe('released');
  });

  it('binds restored approval to every multi-repository PR identity and head', () => {
    const reviewed = [
      { slug: 'Acme/App', number: 7, headSha: 'aaa' },
      { slug: 'acme/api', number: 9, headSha: 'bbb' },
    ];
    expect(sameProposalIdentity(reviewed, [...reviewed].reverse())).toBe(true);
    expect(sameProposalIdentity(reviewed, [reviewed[0]!, { ...reviewed[1]!, headSha: 'changed' }])).toBe(false);
    expect(sameProposalIdentity(reviewed, [reviewed[0]!])).toBe(false);
    expect(sameProposalIdentity([{ slug: 'acme/app', number: 7 }], [{ slug: 'acme/app', number: 7 }])).toBe(false);
  });

  it('uses the authoritative live stage when the persisted projection lags', async () => {
    const f = (await fixture());
    f.setLiveView({
      ...f.view,
      stage: 'merge',
      status: 'waiting',
      waitingFor: { kind: 'github', detail: 'checks' },
    });

    await f.api.moveTaskStage(f.token, f.task.id, 'do');
    expect(f.starts[0]!.options.args[0].recovery).toMatchObject({ resumeStage: 'do' });
    expect(f.terminated[0]).toContain('Task moved to do');
  });

  it('normalizes internal cancellation frames and manual completion to a safe Do recovery', async () => {
    const f = (await fixture());
    for (const origin of ['resolve', 'escalated'] as const) {
      (await f.store.saveView(f.task.id, {
        ...f.view,
        stage: 'cancelled', status: 'cancelled',
        state: { cancelled: true, cancelledFrom: origin },
      }));
      const cancelled = await f.api.getTaskView(f.token, f.task.id);
      expect(cancelled?.stageTransitions?.map((move) => move.target)).toContain('do');
      await f.api.moveTaskStage(f.token, f.task.id, 'do');
      expect(f.starts.at(-1)!.options.args[0].recovery.resumeStage).toBe('do');
    }

    (await f.store.saveView(f.task.id, {
      ...f.view,
      stage: 'done', status: 'done',
      state: { manuallyDoneFrom: 'resolve' },
    }));
    expect((await f.api.getTaskView(f.token, f.task.id))?.stageTransitions).toMatchObject([{ target: 'do' }]);
  });

  it('offers PR-to-Do but refuses lifecycle replacement during or after atomic landing', async () => {
    const f = (await fixture());
    (await f.store.saveView(f.task.id, { ...f.view, stage: 'pr' }));
    expect((await f.api.getTaskView(f.token, f.task.id))?.stageTransitions?.map((move) => move.target))
      .toContain('do');

    for (const state of [
      { lifecycleTransitionBlocked: true },
      {},
    ]) {
      (await f.store.saveView(f.task.id, {
        ...f.view,
        stage: 'merge',
        status: 'active',
        state,
        pointOfNoReturnPassed: !state.lifecycleTransitionBlocked,
      }));
      expect((await f.api.getTaskView(f.token, f.task.id))?.stageTransitions).toEqual([]);
    }
  });

  it('preserves the exact human route and question across a lifecycle replacement', async () => {
    const f = (await fixture());
    (await f.store.saveView(f.task.id, {
      ...f.view,
      stage: 'review', status: 'active',
    }));
    const held = await f.api.escalateToHuman(f.token, {
      taskId: f.task.id,
      audience: ['@creator'],
      message: 'Approve the release window',
    });
    expect(held.waitingFor).toEqual({
      kind: 'human', audience: ['@creator'], detail: 'Approve the release window',
    });
    expect(f.starts[0]!.options.args[0].recovery.humanWait).toEqual({
      audience: ['@creator'], detail: 'Approve the release window',
    });
  });

  it('interlocks a graceful old-run shutdown until its replacement is durable', async () => {
    const f = (await fixture());
    (await f.store.setTaskWorkflowVersion(f.task.id, bundledVersion('software-dev')));
    (await f.store.updateTaskParams(f.task.id, { ...f.task.params, _workflowRunId: 'old-run' }));
    let markedRun: string | undefined;
    f.setGracefulResult(async () => {
      const raw = (await f.store.kvGet(lifecycleReplacementKey(f.task.id)));
      markedRun = raw ? JSON.parse(raw).runId : undefined;
      return { stage: 'cancelled' };
    });

    await f.api.escalateToHuman(f.token, {
      taskId: f.task.id,
      audience: ['@creator'],
      message: 'Choose a direction',
    });

    expect(markedRun).toBe('old-run');
    expect((await f.store.kvGet(lifecycleReplacementKey(f.task.id)))).toBeUndefined();
    expect(f.terminated).toEqual([]);
    expect(f.signalled).toContainEqual(expect.objectContaining({
      id: f.task.id,
      signal: 'prepareLifecycleReplacement',
    }));
  });

  it('advertises human hold, destructive Draft, and reversible Done before Jayadratha', async () => {
    const f = (await fixture());
    const view = await f.api.getTaskView(f.token, f.task.id);
    expect(view?.stageTransitions?.map((move) => move.target)).toEqual(['human', 'draft', 'done']);

    (await f.store.claimAttempt(f.task.id));
    const committed = await f.api.getTaskView(f.token, f.task.id);
    expect(committed?.stageTransitions?.map((move) => move.target)).toEqual(['human', 'done']);
  });

  it('stops activity for manual Done and restores the exact origin on the latest workflow', async () => {
    const f = (await fixture());
    const done = await f.api.moveTaskStage(f.token, f.task.id, 'done');
    expect(done).toMatchObject({
      stage: 'done',
      status: 'done',
      state: { manuallyDoneFrom: 'do' },
      stageTransitions: [{ target: 'do' }],
    });
    expect(f.terminated[0]).toMatch(/marked done manually/);

    const restored = await f.api.moveTaskStage(f.token, f.task.id, 'do');
    expect(f.starts).toHaveLength(1);
    expect(f.starts[0]!.type).toBe(`softwareDev@${bundledVersion('software-dev')}`);
    expect(f.starts[0]!.options.args[0].recovery).toMatchObject({ resumeStage: 'do', messages: f.view.messages });
    expect(restored).toMatchObject({ stage: 'do', status: 'active' });
  });

  it('restores cancellation to its remembered stage and supports a cross-cutting human hold', async () => {
    const f = (await fixture());
    (await f.store.saveView(f.task.id, {
      ...f.view,
      stage: 'cancelled',
      status: 'cancelled',
      state: { ...f.view.state, cancelled: true, cancelledFrom: 'review' },
    }));
    const cancelled = await f.api.getTaskView(f.token, f.task.id);
    expect(cancelled?.stageTransitions?.map((move) => move.target)).toEqual(['review', 'draft', 'done']);

    const restored = await f.api.moveTaskStage(f.token, f.task.id, 'review');
    expect(restored).toMatchObject({ stage: 'pr', status: 'active', state: { restoringTo: 'review' } });
    expect(f.starts[0]!.options.args[0].recovery).toMatchObject({ resumeStage: 'review' });

    // The replacement honestly advertises PR while it reconstructs the proposal;
    // emulate its next published state before testing a Review-origin hold.
    (await f.store.saveView(f.task.id, {
      ...restored,
      stage: 'review',
      state: { ...restored.state, restoringTo: undefined },
    }));
    const held = await f.api.moveTaskStage(f.token, f.task.id, 'human');
    expect(held).toMatchObject({
      stage: 'review',
      status: 'waiting',
      waitingFor: { kind: 'human' },
    });
    expect(held.stageTransitions?.map((move) => move.target)).toEqual(['review', 'draft', 'done']);
    expect(f.terminated).toHaveLength(1);

    const doneFromHold = await f.api.moveTaskStage(f.token, f.task.id, 'done');
    expect(doneFromHold.state.manuallyDoneFrom).toBe('human');
    expect(doneFromHold.stageTransitions?.map((move) => move.target)).toEqual(['human']);
    const restoredHold = await f.api.moveTaskStage(f.token, f.task.id, 'human');
    expect(restoredHold).toMatchObject({ stage: 'review', status: 'waiting', waitingFor: { kind: 'human' } });
    expect(f.starts.at(-1)!.options.args[0].recovery).toMatchObject({ resumeStage: 'review', pausedForHuman: true });
  });

  it('lets an agent escalate its own task to a chosen human team and notifies only that audience', async () => {
    const f = (await fixture());
    for (const userId of ['designer', 'developer'])
      (await f.store.setOrganizationMembership('org_personal', userId, 'member'));
    const design = (await f.store.createTeam({ organizationId: 'org_personal', name: 'Design' }));
    (await f.store.setTeamMembership(design.id, 'designer'));
    (await f.store.setProjectMembership(f.project.id, { kind: 'team', teamId: design.id }, 'member'));
    (await f.store.setProjectMembership(f.project.id, { kind: 'user', userId: 'developer' }, 'member'));
    const agentToken = (await f.tokens.mint({
      taskId: f.task.id,
      profileId: 'do',
      role: 'do',
      principal: `task-agent:${f.task.id}:do`,
      projectId: f.project.id,
      ceiling: ['task:escalate'],
      grantorCaps: ['task:escalate'],
    })).token;

    expect((await f.api.humanEscalationTargets(agentToken))).toMatchObject({
      taskId: f.task.id,
      users: expect.arrayContaining([{ id: 'designer', selector: 'user:designer' }]),
      teams: [expect.objectContaining({ id: design.id, name: 'Design', selector: '@team:design' })],
    });
    const held = await f.api.escalateToHuman(agentToken, {
      audience: ['@team:design'],
      message: 'Please choose the final interaction pattern.',
    });

    expect(held).toMatchObject({
      stage: 'do',
      status: 'waiting',
      waitingFor: {
        kind: 'human',
        audience: ['@team:design'],
        detail: 'Please choose the final interaction pattern.',
      },
      state: { humanPauseOrigin: 'do' },
    });
    expect(f.terminated.at(-1)).toContain('Escalated to @team:design');
    expect((await f.store.eventsSince(f.task.id, 0))).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'task.escalated',
        payload: expect.objectContaining({
          audience: ['@team:design'],
          detail: 'Please choose the final interaction pattern.',
          requestedBy: `task-agent:${f.task.id}:do`,
        }),
      }),
    ]));
    expect((await f.store.listInbox('designer', 'org_personal'))).toEqual([
      expect.objectContaining({ taskId: f.task.id, kind: 'escalated', actionable: true, unread: true }),
    ]);
    expect((await f.store.listInbox('developer', 'org_personal'))).toEqual([]);
  });

  it('rejects an escalation to a missing audience and prevents an agent escalating another task', async () => {
    const f = (await fixture());
    const agentToken = (await f.tokens.mint({
      taskId: f.task.id,
      profileId: 'do',
      role: 'do',
      principal: `task-agent:${f.task.id}:do`,
      projectId: f.project.id,
      ceiling: ['task:escalate'],
      grantorCaps: ['task:escalate'],
    })).token;

    await expect(f.api.escalateToHuman(agentToken, {
      audience: ['@team:missing'],
      message: 'I need a decision.',
    })).rejects.toThrow(/does not resolve to a human/i);

    const other = (await f.store.createTask({
      projectId: f.project.id,
      title: 'Other',
      workflow: 'software-dev',
      workflowVersion: '1.9.0',
      params: { prompt: 'other' },
    }));
    (await f.store.saveView(other.id, { ...f.view, taskId: other.id, title: other.title }));
    await expect(f.api.escalateToHuman(agentToken, {
      taskId: other.id,
      audience: ['@creator'],
      message: 'Stop this other task.',
    })).rejects.toThrow(/only escalate its own task/i);
  });

  it('dismisses a permission ask without signaling and still allows a later decision', async () => {
    const f = (await fixture());
    const service = new PermissionRequests(f.store, 'org_personal');
    const request = (await service.request({ taskId: f.task.id, projectId: f.project.id, role: 'do',
      capabilities: ['settings:read'], audience: ['@owners'], recipients: ['test'],
      reason: 'Inspect settings', requestedBy: 'agent' }));
    (await f.store.appendEvent({ taskId: f.task.id, type: 'permission.approval-requested', ts: Date.now(),
      payload: { requestId: request.id, recipients: ['test'] } }));
    expect((await f.store.listInbox('test', 'org_personal'))).toHaveLength(1);
    const outsider = (await f.tokens.mintPrincipal('user:outsider', ['*'], f.project.id)).token;
    await expect(f.api.resolvePermissionRequest(outsider, { organizationId: 'org_personal',
      requestId: request.id, action: 'dismiss' })).rejects.toThrow(/not routed/);
    const result = await f.api.resolvePermissionRequest(f.token, { organizationId: 'org_personal',
      requestId: request.id, action: 'dismiss' });
    expect(result).toMatchObject({ status: 'pending', dismissed: { by: 'user:test' } });
    expect(f.signalled).toEqual([]);
    expect(f.starts).toEqual([]);
    expect((await service.extensionCaps(f.task.id))).toEqual([]);
    expect((await f.store.listInbox('test', 'org_personal'))).toEqual([]);
    expect((await service.requests({ taskId: f.task.id }))).toHaveLength(1);
    await expect(f.api.resolvePermissionRequest(f.token, { organizationId: 'org_personal',
      requestId: request.id, action: 'approve' })).resolves.toMatchObject({ status: 'granted' });
  });

  it('automatically resolves covered permission requests after authorization changes', async () => {
    const f = (await fixture());
    const service = new PermissionRequests(f.store, 'org_personal');
    const request = (await service.request({ taskId: f.task.id, projectId: f.project.id, role: 'do',
      capabilities: ['settings:read'], audience: ['@owners'], recipients: ['test'],
      reason: 'Inspect settings', requestedBy: 'agent' }));
    await f.api.setTaskAuthorization(f.token, f.task.id, 'developer');
    expect((await service.requests())[0]).toMatchObject({ id: request.id, status: 'granted' });
    expect((await service.extensionCaps(f.task.id))).toEqual([]);
    expect(f.signalled.at(-1)).toMatchObject({ id: f.task.id, args: [expect.any(Object), 'do'] });
    const signals = f.signalled.length;
    await f.api.setTaskAuthorization(f.token, f.task.id, 'developer');
    expect(f.signalled).toHaveLength(signals);
  });

  it('leaves requests pending until both scope and capabilities are covered', async () => {
    const f = (await fixture(undefined, true));
    const other = (await f.store.createProject('Additional project'));
    for (const projectId of [f.project.id, other.id]) (await f.authorization!.grant('system:test', {
      principalId: 'user:test', scopeKey: projectScope(projectId), profileId: 'maintainer',
    }));
    const base = { level: 'developer', scope: 'projects' as const, projectIds: [f.project.id] };
    const service = new PermissionRequests(f.store, 'org_personal');
    const request = (await service.request({ taskId: f.task.id, projectId: f.project.id, role: 'do',
      capabilities: ['github:actions:write'], projectIds: [other.id], baseAuthorization: base,
      audience: ['@owners'], recipients: ['test'], reason: 'Configure project', requestedBy: 'agent' }));
    await f.api.setTaskAuthorization(f.token, f.task.id, base);
    expect((await service.requests())[0]!.status).toBe('pending');
    await f.api.setTaskAuthorization(f.token, f.task.id, { ...base, projectIds: [f.project.id, other.id] });
    expect((await service.requests())[0]!.status).toBe('pending');
    expect(f.signalled).toEqual([]);
    await f.api.setTaskAuthorization(f.token, f.task.id, { ...base, level: 'maintainer', projectIds: [f.project.id, other.id] });
    expect((await service.requests())[0]).toMatchObject({ id: request.id, status: 'granted' });
  });

  it('recognizes an already-satisfied project request despite a changed selection', async () => {
    const f = (await fixture(undefined, true));
    const other = (await f.store.createProject('Additional project'));
    const base = { level: 'developer', scope: 'projects' as const, projectIds: [f.project.id] };
    const service = new PermissionRequests(f.store, 'org_personal');
    const request = (await service.request({ taskId: f.task.id, projectId: f.project.id, role: 'do',
      capabilities: [], projectIds: [other.id], baseAuthorization: base,
      audience: ['@owners'], recipients: ['test'], reason: 'Read additional project', requestedBy: 'agent' }));
    (await f.store.patchTaskParams(f.task.id, { _authorization: { ...base,
      projectIds: [f.project.id, other.id], capabilities: ['*'] } }));
    await expect(f.api.resolvePermissionRequest(f.token, { organizationId: 'org_personal',
      requestId: request.id, action: 'approve' })).resolves.toMatchObject({ status: 'granted' });
  });

  it('routes an exact permission elevation to selected humans and only a capable recipient may approve', async () => {
    const f = (await fixture());
    (await f.store.setOrganizationMembership('org_personal', 'outsider', 'member'));
    const agentToken = (await f.tokens.mint({
      taskId: f.task.id,
      profileId: 'do',
      role: 'do',
      principal: `task-agent:${f.task.id}:do`,
      projectId: f.project.id,
      organizationId: 'org_personal',
      ceiling: ['task:escalate'],
      grantorCaps: ['task:escalate'],
    })).token;

    const requested = await f.api.requestPermission(agentToken, {
      capabilities: ['settings:read'],
      audience: ['@owners'],
      reason: 'Inspect the outbound email configuration.',
    });
    expect(requested).toMatchObject({
      status: 'needs_approval',
      capabilities: ['settings:read'],
      audience: ['@owners'],
    });
    expect(f.terminated.at(-1)).toContain('Waiting for permission approval');
    expect(f.starts.at(-1)!.options.args[0].recovery).toMatchObject({
      resumeStage: 'do',
      pausedForHuman: true,
    });
    expect((await f.store.getTask(f.task.id))!.lastView).toMatchObject({
      stage: 'do',
      status: 'waiting',
      waitingFor: { kind: 'human', audience: ['@owners'] },
    });
    expect((await f.store.listInbox('test', 'org_personal'))).toEqual([
      expect.objectContaining({ taskId: f.task.id, kind: 'approval-requested', actionable: true }),
    ]);
    expect((await f.store.listInbox('outsider', 'org_personal'))).toEqual([]);

    const outsider = (await f.tokens.mintPrincipal(
      'user:outsider',
      ['task:read', 'settings:read'],
      f.project.id,
      undefined,
      'org_personal',
    )).token;
    await expect(f.api.resolvePermissionRequest(outsider, {
      organizationId: 'org_personal',
      requestId: requested.requestId!,
      action: 'approve',
    })).rejects.toThrow(/not routed to you/i);

    const resolved = await f.api.resolvePermissionRequest(f.token, {
      organizationId: 'org_personal',
      requestId: requested.requestId!,
      action: 'approve',
    });
    expect(resolved).toMatchObject({ status: 'granted', resume: { resumed: true } });
    expect(f.signalled.at(-1)).toMatchObject({ id: f.task.id, args: [expect.any(Object), 'do'] });
    expect((await new PermissionRequests(f.store, 'org_personal').extensionCaps(f.task.id, 'do')))
      .toEqual(['settings:read']);
    expect((await new PermissionRequests(f.store, 'org_personal').extensionCaps(f.task.id, 'merge')))
      .toEqual([]);
    // The approval was answered, so it stops being an ask sitting in the inbox.
    expect((await f.store.listInbox('test', 'org_personal'))).toEqual([]);

    (await f.store.setOrganizationMembership('org_personal', 'reviewer', 'member'));
    const second = await f.api.requestPermission(agentToken, {
      capabilities: ['settings:write'],
      audience: ['user:reviewer'],
      reason: 'Configure outbound email.',
    });
    const reviewer = (await f.tokens.mintPrincipal(
      'user:reviewer',
      ['task:read'],
      f.project.id,
      undefined,
      'org_personal',
    )).token;
    await expect(f.api.resolvePermissionRequest(reviewer, {
      organizationId: 'org_personal',
      requestId: second.requestId!,
      action: 'approve',
    })).rejects.toThrow(/cannot grant settings:write/i);
    await expect(f.api.resolvePermissionRequest(reviewer, {
      organizationId: 'org_personal',
      requestId: second.requestId!,
      action: 'deny',
    })).resolves.toMatchObject({ status: 'denied' });
  });

  it.each(['human', 'delegated-agent'])('%s approves additive scope and mints usable fresh delegation', async (kind) => {
    const f = (await fixture(undefined, true));
    const second = (await f.store.createProject('Second'));
    for (const projectId of [f.project.id, second.id]) (await f.authorization!.grant('system:test', {
      principalId: 'user:test', scopeKey: projectScope(projectId), profileId: 'maintainer',
    }));
    const initial = { ...(await f.authorization!.taskGrant('user:test', f.project.id, {
      level: 'developer', scope: 'projects', projectIds: [f.project.id],
    })), principal: 'user:test' };
    (await f.store.updateTaskParams(f.task.id, { ...f.task.params, _authorization: initial }));
    const agent = (await f.tokens.mint({ taskId: f.task.id, profileId: 'do', role: 'do',
      principal: `task-agent:${f.task.id}:do`, projectIds: [f.project.id], organizationId: 'org_personal',
      ceiling: ['task:escalate', 'task:read'], grantorCaps: ['task:escalate', 'task:read'] }));
    expect((await f.tokens.check(agent.token, 'task:read', { projectId: second.id })).ok).toBe(false);
    // task:read is already held; it must still ask because scope is missing.
    const requested = await f.api.requestPermission(agent.token, {
      capabilities: ['task:read'], projectIds: [second.id, second.id, f.project.id],
      audience: ['@owners'], reason: 'Read the phase task in the second project.',
    });
    expect(requested).toMatchObject({ status: 'needs_approval', projectIds: [second.id] });
    expect((await f.store.getTask(f.task.id))!.params._authorization).toEqual(initial);
    expect((await f.store.getTask(f.task.id))!.lastView?.status).toBe('waiting');
    let approver = f.token;
    if (kind === 'delegated-agent') {
      const human = (await f.tokens.mintPrincipal('user:test', ['*'], undefined, undefined, 'org_personal')).token;
      const delegation = (await f.tokens.delegateHuman(human, { taskId: 'approver-task',
        projectIds: [f.project.id, second.id], organizationId: 'org_personal' }))!;
      approver = (await f.tokens.mint({ taskId: 'approver-task', profileId: 'do', principal: 'user:test',
        projectIds: [f.project.id, second.id], organizationId: 'org_personal',
        ceiling: ['*'], grantorCaps: ['*'], delegationId: delegation.id })).token;
    }
    const approval = f.api.resolvePermissionRequest(approver, {
      organizationId: 'org_personal', requestId: requested.requestId!, action: 'approve',
    });
    await expect(f.api.resolvePermissionRequest(approver, {
      organizationId: 'org_personal', requestId: requested.requestId!, action: 'deny',
    })).rejects.toThrow(/decision is already in progress/);
    await expect(approval).resolves.toMatchObject({ status: 'granted', resume: { resumed: true } });
    const expanded = (await f.store.getTask(f.task.id))!.params._authorization as any;
    expect(expanded.projectIds).toEqual([f.project.id, second.id]);
    expect(expanded.level).toBe('developer');
    expect(expanded.delegationId).toMatch(/^dlg_/);
    const fresh = (await f.tokens.mint({ taskId: f.task.id, profileId: 'do', role: 'do', principal: 'user:test',
      projectIds: expanded.projectIds, organizationId: 'org_personal', delegationId: expanded.delegationId,
      ceiling: expanded.capabilities, grantorCaps: expanded.capabilities }));
    for (const projectId of [f.project.id, second.id])
      expect((await f.tokens.check(fresh.token, 'task:read', { projectId, organizationId: 'org_personal' })).ok).toBe(true);
    expect((await f.tokens.check(agent.token, 'task:read', { projectId: second.id })).ok).toBe(false);
    await expect(f.api.resolvePermissionRequest(f.token, {
      organizationId: 'org_personal', requestId: requested.requestId!, action: 'approve',
    })).rejects.toThrow(/already granted/);
  });

  it('checks target-project authority, rejects foreign projects, and leaves scope unchanged on denial', async () => {
    const f = (await fixture(undefined, true));
    const second = (await f.store.createProject('Second'));
    (await f.store.setOrganizationMembership('org_personal', 'limited', 'member'));
    (await f.authorization!.grant('system:test', {
      principalId: 'user:limited', scopeKey: projectScope(f.project.id), profileId: 'maintainer',
    }));
    const initial = { level: 'developer', scope: 'projects', projectIds: [f.project.id],
      capabilities: ['task:read'], principal: 'user:test' };
    (await f.store.updateTaskParams(f.task.id, { ...f.task.params, _authorization: initial }));
    const agent = (await f.tokens.mint({ taskId: f.task.id, profileId: 'do', role: 'do',
      principal: 'task-agent:test', projectId: f.project.id, organizationId: 'org_personal',
      ceiling: ['task:escalate'], grantorCaps: ['task:escalate'] })).token;
    await expect(f.api.requestPermission(agent, { capabilities: [], projectIds: ['foreign-or-missing'],
      audience: ['@owners'], reason: 'Read foreign work.' })).rejects.toThrow(/task organization/);
    const requested = await f.api.requestPermission(agent, { capabilities: [], projectIds: [second.id],
      audience: ['user:limited'], reason: 'Expand project scope only.' });
    const limited = (await f.tokens.mintPrincipal('user:limited', ['*'], f.project.id, undefined, 'org_personal')).token;
    await expect(f.api.resolvePermissionRequest(limited, {
      organizationId: 'org_personal', requestId: requested.requestId!, action: 'approve',
    })).rejects.toThrow(/cannot grant.*project/);
    expect((await f.store.getTask(f.task.id))!.params._authorization).toEqual(initial);
    await expect(f.api.resolvePermissionRequest(limited, {
      organizationId: 'org_personal', requestId: requested.requestId!, action: 'deny',
    })).resolves.toMatchObject({ status: 'denied', resume: { resumed: true } });
    expect((await f.store.getTask(f.task.id))!.params._authorization).toEqual(initial);
  });

  it('requires authority for earlier permission grants belonging to other roles before expanding scope', async () => {
    const f = (await fixture(undefined, true));
    const second = (await f.store.createProject('Second'));
    (await f.store.setOrganizationMembership('org_personal', 'limited', 'member'));
    for (const projectId of [f.project.id, second.id]) (await f.authorization!.grant('system:test', {
      principalId: 'user:limited', scopeKey: projectScope(projectId), profileId: 'maintainer',
    }));
    (await f.store.updateTaskParams(f.task.id, { ...f.task.params, _authorization: {
      level: 'developer', scope: 'projects', projectIds: [f.project.id], capabilities: ['task:read'],
    } }));
    const service = new PermissionRequests(f.store, 'org_personal');
    const prior = (await service.request({ taskId: f.task.id, projectId: f.project.id, role: 'merge',
      capabilities: ['settings:write'], audience: ['@owners'], recipients: ['test'],
      reason: 'Configure the platform.', requestedBy: 'task-agent:test' }));
    (await service.resolve(prior.id, { action: 'approve', by: 'user:test' }));
    const agent = (await f.tokens.mint({ taskId: f.task.id, profileId: 'do', role: 'do', principal: 'task-agent:test',
      projectId: f.project.id, organizationId: 'org_personal', ceiling: ['task:escalate'], grantorCaps: ['task:escalate'] })).token;
    const requested = await f.api.requestPermission(agent, { capabilities: [], projectIds: [second.id],
      audience: ['user:limited'], reason: 'Read phase work.' });
    const limited = (await f.tokens.mintPrincipal('user:limited', ['*'], f.project.id, undefined, 'org_personal')).token;
    await expect(f.api.resolvePermissionRequest(limited, { organizationId: 'org_personal',
      requestId: requested.requestId!, action: 'approve' })).rejects.toThrow(/cannot grant settings:write/);
    expect(((await f.store.getTask(f.task.id))!.params._authorization as any).projectIds).toEqual([f.project.id]);
  });

  it('rejects stale scope requests and checks subsequent capability grants across all selected projects', async () => {
    const f = (await fixture(undefined, true));
    const second = (await f.store.createProject('Second'));
    (await f.store.setOrganizationMembership('org_personal', 'limited', 'member'));
    (await f.authorization!.grant('system:test', { principalId: 'user:limited',
      scopeKey: projectScope(f.project.id), profileId: 'maintainer' }));
    const initial = { level: 'developer', scope: 'projects', projectIds: [f.project.id],
      capabilities: ['task:read'], principal: 'user:test' };
    (await f.store.updateTaskParams(f.task.id, { ...f.task.params, _authorization: initial }));
    const agent = (await f.tokens.mint({ taskId: f.task.id, profileId: 'do', role: 'do', principal: 'task-agent:test',
      projectId: f.project.id, organizationId: 'org_personal', ceiling: ['task:escalate'], grantorCaps: ['task:escalate'] })).token;
    const request = await f.api.requestPermission(agent, { capabilities: [], projectIds: [second.id],
      audience: ['user:limited'], reason: 'Read phase work.' });
    const expanded = { ...initial, projectIds: [f.project.id, second.id] };
    (await f.store.updateTaskParams(f.task.id, { ...f.task.params, _authorization: expanded }));
    const limited = (await f.tokens.mintPrincipal('user:limited', ['*'], f.project.id, undefined, 'org_personal')).token;
    await expect(f.api.resolvePermissionRequest(limited, {
      organizationId: 'org_personal', requestId: request.requestId!, action: 'approve',
    })).rejects.toThrow(/authorization changed/);
    const capabilityRequest = await f.api.requestPermission(agent, { capabilities: ['task:edit'],
      audience: ['user:limited'], reason: 'Edit phase work.' });
    await expect(f.api.resolvePermissionRequest(limited, {
      organizationId: 'org_personal', requestId: capabilityRequest.requestId!, action: 'approve',
    })).rejects.toThrow(/cannot grant task:edit/);
    expect((await new PermissionRequests(f.store, 'org_personal').extensionCaps(f.task.id))).toEqual([]);
  });

  it('parks and resumes the requesting Merge role so the next turn receives the grant', async () => {
    const f = (await fixture());
    (await f.store.saveView(f.task.id, { ...f.view, stage: 'merge' }));
    const agentToken = (await f.tokens.mint({
      taskId: f.task.id,
      profileId: 'merge-default',
      role: 'merge',
      principal: `task-agent:${f.task.id}:merge-default`,
      projectId: f.project.id,
      organizationId: 'org_personal',
      ceiling: ['task:escalate'],
      grantorCaps: ['task:escalate'],
    })).token;

    const requested = await f.api.requestPermission(agentToken, {
      capabilities: ['task:git:import'],
      audience: ['@owners'],
      reason: 'Refresh the protected target before resolving conflicts.',
    });
    expect(f.starts.at(-1)!.options.args[0].recovery).toMatchObject({
      resumeStage: 'merge',
      pausedForHuman: true,
    });

    await expect(f.api.resolvePermissionRequest(f.token, {
      organizationId: 'org_personal',
      requestId: requested.requestId!,
      action: 'approve',
    })).resolves.toMatchObject({ status: 'granted', role: 'merge', resume: { resumed: true } });
    expect((await new PermissionRequests(f.store, 'org_personal').extensionCaps(f.task.id, 'merge')))
      .toEqual(['task:git:import']);
    expect(f.signalled.at(-1)).toMatchObject({ id: f.task.id, args: [expect.any(Object), 'merge'] });
  });

  it('treats follow-up and Confirm as input that releases a human hold', async () => {
    const follow = (await fixture());
    (await follow.store.saveView(follow.task.id, {
      ...follow.view,
      status: 'waiting',
      waitingFor: { kind: 'human', audience: ['@creator'] },
      actions: [{ name: 'followUp', kind: 'signal', label: 'Send follow-up', enabled: true }],
      state: { ...follow.view.state, humanPauseOrigin: 'review' },
      stage: 'review',
    }));

    const message = await follow.api.signalTask(follow.token, follow.task.id, 'followUp', 'Please revise this.', 'do');
    expect(message?.text).toBe('Please revise this.');
    expect(follow.starts.at(-1)!.options.args[0].recovery).toMatchObject({ resumeStage: 'do' });
    expect(follow.starts.at(-1)!.options.args[0].recovery.messages.at(-1)).toMatchObject({ text: 'Please revise this.' });
    expect(follow.signalled).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: expect.stringContaining('agent-queue'), signal: 'cancelAgentSlot', args: [{ taskId: follow.task.id, turnId: 'hidden-agent-turn' }] }),
      expect.objectContaining({ id: expect.stringContaining('account-coordinator'), signal: 'cancelAccountLease', args: [{ taskId: follow.task.id, turnId: 'hidden-account-turn' }] }),
    ]));

    const confirm = (await fixture());
    (await confirm.store.saveView(confirm.task.id, {
      ...confirm.view,
      status: 'waiting',
      waitingFor: { kind: 'human', audience: ['@creator'] },
      actions: [{ name: 'confirm', kind: 'signal', label: 'Confirm', enabled: true }],
      state: { ...confirm.view.state, humanPauseOrigin: 'review' },
      stage: 'review',
    }));
    await confirm.api.signalTask(confirm.token, confirm.task.id, 'confirm');
    expect(confirm.starts.at(-1)!.options.args[0].recovery).toMatchObject({ resumeStage: 'pr' });
  });

  it('lets an agent confirm a Review gate only with review:approve (maintainer and above)', async () => {
    const f = (await fixture());
    (await f.store.saveView(f.task.id, {
      ...f.view, stage: 'review', status: 'waiting',
      waitingFor: { kind: 'human', audience: ['@creator'] },
      actions: [{ name: 'confirm', kind: 'signal', label: 'Confirm', enabled: true }],
    }));
    const agent = async (caps: string[]) => (await f.tokens.mint({
      taskId: f.task.id, profileId: 'do', role: 'do', principal: `task-agent:${f.task.id}:do`,
      projectId: f.project.id, ceiling: caps, grantorCaps: caps,
    })).token;
    // A developer-level agent holds task:* (so task:signal) but not review:approve.
    await expect(f.api.signalTask((await agent(['task:*'])), f.task.id, 'confirm')).rejects.toThrow(/review:approve/);
    expect(f.signalled.filter((s) => s.signal === 'confirm')).toHaveLength(0);
    // The same agent under a maintainer-level authorization stands in for the reviewer.
    await f.api.signalTask((await agent(['task:*', 'review:approve'])), f.task.id, 'confirm');
    expect(f.signalled.filter((s) => s.signal === 'confirm')).toHaveLength(1);
    expect((await f.store.eventsSince(f.task.id, 0)).filter((e) => e.type === 'task.confirmation-voted').at(-1)?.payload)
      .toMatchObject({ userId: `task-agent:${f.task.id}:do`, satisfied: true });
    // Re-routing who reviews follows the same rule.
    await expect(f.api.updateParams((await agent(['task:*'])), f.task.id, { confirm: { layers: [] } })).rejects.toThrow(/review:approve/);
    // So does switching to Goal, which has no Review gate at all (WF-7).
    await expect(f.api.changeWorkflow((await agent(['task:*'])), f.task.id, 'goal')).rejects.toThrow(/review:approve/);
    expect((await f.store.getTask(f.task.id))?.workflow).not.toBe('goal');
    await expect(f.api.changeWorkflow((await agent(['task:*'])), f.task.id, 'software-dev')).resolves.toBeTruthy();
    await expect(f.api.changeWorkflow((await agent(['task:*', 'review:approve'])), f.task.id, 'goal')).resolves.toBeTruthy();
  });

  /** PL-1: an agent stands in for the human it acts for, never for more. */
  it('refuses a review:approve agent whose human is outside the Review audience, as it refuses that human', async () => {
    const f = (await fixture());
    (await f.store.setOrganizationMembership('org_personal', 'qa', 'member'));
    (await f.store.saveView(f.task.id, {
      ...f.view, stage: 'review', status: 'waiting',
      waitingFor: { kind: 'human', audience: ['user:qa'] },
      actions: [{ name: 'confirm', kind: 'signal', label: 'Confirm', enabled: true }],
    }));
    const maintainerAgent = (await f.tokens.mint({
      taskId: f.task.id, profileId: 'do', role: 'do', principal: `task-agent:${f.task.id}:do`,
      projectId: f.project.id, ceiling: ['task:*', 'review:approve'], grantorCaps: ['task:*', 'review:approve'],
    })).token;
    // The task's creator is not the selected reviewer, and neither is their agent.
    await expect(f.api.signalTask(f.token, f.task.id, 'confirm')).rejects.toThrow(/assigned to someone else/);
    await expect(f.api.signalTask(maintainerAgent, f.task.id, 'confirm')).rejects.toThrow(/assigned to someone else/);
    expect(f.signalled.filter((s) => s.signal === 'confirm')).toHaveLength(0);
    // An agent acting for the selected reviewer confirms.
    const reviewerTask = (await f.store.createTask({ projectId: f.project.id, title: 'QA helper', workflow: 'software-dev',
      workflowVersion: '1.4.0', createdBy: { kind: 'user', userId: 'qa' }, params: { prompt: 'review' } }));
    const reviewerAgent = (await f.tokens.mint({
      taskId: reviewerTask.id, profileId: 'do', role: 'do', principal: `task-agent:${reviewerTask.id}:do`,
      projectId: f.project.id, ceiling: ['task:*', 'review:approve'], grantorCaps: ['task:*', 'review:approve'],
    })).token;
    await f.api.signalTask(reviewerAgent, f.task.id, 'confirm');
    expect(f.signalled.filter((s) => s.signal === 'confirm')).toHaveLength(1);
  });

  it('consumes a current Review-hold confirmation once instead of restoring the hold again', async () => {
    const f = (await fixture());
    (await f.store.setTaskWorkflowVersion(f.task.id, bundledVersion('software-dev')));
    (await f.store.saveView(f.task.id, {
      ...f.view,
      stage: 'review', status: 'waiting',
      waitingFor: { kind: 'human', audience: ['@creator'], detail: 'Approve this exact proposal' },
      state: {
        ...f.view.state,
        humanPauseOrigin: 'review',
        transitionCheckpoint: {
          messages: f.view.messages,
          resumeStage: 'review',
          pausedForHuman: true,
          humanWait: { audience: ['@creator'], detail: 'Approve this exact proposal' },
        },
      },
    }));

    await f.api.signalTask(f.token, f.task.id, 'confirm');
    const recovery = f.starts.at(-1)!.options.args[0].recovery;
    expect(recovery).toMatchObject({ resumeStage: 'review', reviewConfirmed: true });
    expect(recovery.pausedForHuman).toBeUndefined();
  });

  it('records manual confirmation of an escalated reviewer as GitHub merge authorization', async () => {
    const f = (await fixture());
    (await f.store.setTaskWorkflowVersion(f.task.id, bundledVersion('software-dev')));
    (await f.store.saveView(f.task.id, {
      ...f.view, stage: 'escalated', status: 'blocked',
      prs: [{ repo: 'repo', slug: 'owner/repo', number: 52, url: 'https://github.test/owner/repo/pull/52', state: 'open', headSha: 'abc123' }],
      waitingFor: { kind: 'human', audience: ['@creator'] },
      actions: [{ name: 'confirm', kind: 'signal', label: 'Confirm PR', enabled: true }],
    }));
    await f.api.signalTask(f.token, f.task.id, 'confirm');
    expect(f.signalled).toContainEqual({ id: f.task.id, signal: 'confirm', args: [] });
    expect(f.starts).toHaveLength(0);
    expect((await f.store.eventsSince(f.task.id, 0))).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'task.confirmation-voted', payload: expect.objectContaining({
        githubMergeAuthorized: true, githubMergeIntentAuthorized: true,
        githubPrHeads: [{ slug: 'owner/repo', number: 52, headSha: 'abc123' }],
      }) }),
    ]));
  });

  it.each(['1.16.0', '1.17.0', '1.18.0', '1.19.0', '1.20.0'])('upgrades a %s task at its successful Review boundary into participant Landing', async (version) => {
    const f = (await fixture());
    (await f.store.setTaskWorkflowVersion(f.task.id, version));
    (await f.store.saveView(f.task.id, {
      ...f.view,
      stage: 'review',
      status: 'waiting',
      prs: [{ repo: 'repo', slug: 'owner/repo', number: 52, url: 'https://github.test/owner/repo/pull/52', state: 'open', headSha: 'abc123' }],
      waitingFor: { kind: 'human', audience: ['@creator'] },
      actions: [{ name: 'confirm', kind: 'signal', label: 'Confirm PR', enabled: true }],
    }));

    await f.api.signalTask(f.token, f.task.id, 'confirm');

    expect(f.terminated.at(-1)).toMatch(/upgrading to per-participant provider\/fallback Landing/);
    expect(f.starts.at(-1)!.type).toBe(`softwareDev@${bundledVersion('software-dev')}`);
    expect(f.starts.at(-1)!.options.args[0].recovery).toMatchObject({
      resumeStage: 'merge',
      prs: [{ slug: 'owner/repo', number: 52, headSha: 'abc123' }],
    });
    expect((await f.store.getTask(f.task.id))?.workflowVersion).toBe(bundledVersion('software-dev'));
    expect((await f.store.eventsSince(f.task.id, 0))).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'task.confirmation-voted',
        payload: expect.objectContaining({ githubMergeIntentAuthorized: true }),
      }),
    ]));
    expect(f.signalled.some((item) => item.id === f.task.id && item.signal === 'confirm')).toBe(false);
  });

  it.each(['1.16.0', '1.17.0', '1.18.0', '1.19.0', '1.20.0'])('upgrades a blocked authorized %s Landing retry and resumes its Do session', async (version) => {
    const f = (await fixture());
    (await f.store.setTaskWorkflowVersion(f.task.id, version));
    (await f.store.kvSet(`session:${f.task.id}:do`, 'codex-session-existing'));
    (await f.store.kvSet(`sessionmeta:${f.task.id}:do`, JSON.stringify({ home: '/profiles/codex' })));
    (await f.store.saveView(f.task.id, {
      ...f.view,
      stage: 'escalated',
      status: 'blocked',
      error: 'could not push task branch: non-fast-forward',
      prs: [{ repo: 'repo', slug: 'owner/repo', number: 52, url: 'https://github.test/owner/repo/pull/52', state: 'open', headSha: 'reviewed-head' }],
      landing: {
        authorization: 'authorized',
        validation: 'failed',
        provider: 'ejected',
        authorizedHeads: { 'owner/repo#52': 'reviewed-head' },
      },
    }));

    const message = await f.api.signalTask(f.token, f.task.id, 'retry');

    expect(message?.text).toMatch(/same Do conversation/);
    expect(f.terminated.at(-1)).toMatch(/same-Do protocol/);
    expect(f.starts.at(-1)!.type).toBe(`softwareDev@${bundledVersion('software-dev')}`);
    expect(f.starts.at(-1)!.options.args[0].recovery).toMatchObject({
      resumeStage: 'do',
      session: 'codex-session-existing',
      sessionHome: '/profiles/codex',
      repairValidationPending: true,
      landing: {
        authorization: 'authorized',
        validation: 'failed',
        provider: 'ejected',
        authorizedHeads: { 'owner/repo#52': 'reviewed-head' },
      },
      prs: [{ number: 52, headSha: 'reviewed-head' }],
    });
    expect((await f.store.getTask(f.task.id))?.workflowVersion).toBe(bundledVersion('software-dev'));
  });

  it.each(['1.16.0', '1.17.0', '1.18.0', '1.19.0', '1.20.0'])('upgrades a %s exceptional Landing confirmation into participant Landing', async (version) => {
    const f = (await fixture());
    (await f.store.setTaskWorkflowVersion(f.task.id, version));
    (await f.store.kvSet(`session:${f.task.id}:do`, 'codex-session-existing'));
    (await f.store.saveView(f.task.id, {
      ...f.view,
      stage: 'merge',
      status: 'waiting',
      prs: [{ repo: 'repo', slug: 'owner/repo', number: 52, url: 'https://github.test/owner/repo/pull/52', state: 'open', headSha: 'current-head' }],
      waitingFor: { kind: 'human', audience: ['@creator'], detail: 'Confirm to authorize another automated repair attempt.' },
      actions: [{ name: 'confirm', kind: 'signal', label: 'Confirm PR', enabled: true }],
      landing: {
        authorization: 'authorized',
        validation: 'failed',
        provider: 'ejected',
        repairAttempts: 5,
        authorizedHeads: { 'owner/repo#52': 'reviewed-head' },
      },
    }));

    await f.api.signalTask(f.token, f.task.id, 'confirm');

    expect(f.terminated.at(-1)).toMatch(/upgrading to per-participant provider\/fallback Landing/);
    expect(f.starts.at(-1)!.type).toBe(`softwareDev@${bundledVersion('software-dev')}`);
    expect(f.starts.at(-1)!.options.args[0].recovery).toMatchObject({
      resumeStage: 'merge',
      session: 'codex-session-existing',
      prs: [{ number: 52, headSha: 'current-head' }],
      landing: {
        authorization: 'authorized',
        repairAttempts: 0,
        authorizedHeads: { 'owner/repo#52': 'reviewed-head' },
      },
    });
    expect((await f.store.getTask(f.task.id))?.workflowVersion).toBe(bundledVersion('software-dev'));
    expect(f.signalled.some((item) => item.id === f.task.id && item.signal === 'confirm')).toBe(false);
  });

  it('lets the selected human open a PR from a Do-stage input wait', async () => {
    const f = (await fixture());
    (await f.store.saveView(f.task.id, {
      ...f.view,
      status: 'waiting',
      waitingFor: { kind: 'human', audience: ['@creator'] },
      actions: [{ name: 'openPr', kind: 'signal', label: 'Open PR', enabled: true }],
      state: { ...f.view.state, humanPauseOrigin: 'do' },
      stage: 'do',
    }));

    await f.api.signalTask(f.token, f.task.id, 'openPr');
    expect(f.signalled.at(-1)).toMatchObject({ id: f.task.id, signal: 'openPr', args: [{ userId: 'test' }] });
  });

  it('does not turn a delegated agent PR request into a human confirmation', async () => {
    const f = (await fixture());
    const agentToken = (await f.tokens.mint({
      taskId: f.task.id, profileId: 'do', role: 'do', principal: 'user:test',
      projectId: f.project.id, ceiling: ['task:signal'], grantorCaps: ['task:signal'],
    })).token;

    await f.api.signalTask(agentToken, f.task.id, 'openPr');

    expect(f.signalled.at(-1)).toEqual({ id: f.task.id, signal: 'openPr', args: [] });
    expect((await f.store.eventsSince(f.task.id, 0)).filter((e) => e.type === 'task.confirmation-voted')).toEqual([]);
    (await f.store.close());
  });

  it('resumes a held Do task when Goal mode supplies autonomous direction', async () => {
    const f = (await fixture());
    (await f.store.saveView(f.task.id, {
      ...f.view,
      status: 'waiting',
      waitingFor: { kind: 'human', audience: ['@creator'] },
      workflowOptions: ['software-dev', 'goal'],
      workflowSwitchable: true,
      state: { ...f.view.state, humanPauseOrigin: 'do' },
    }));

    await f.api.changeWorkflow(f.token, f.task.id, 'goal');

    expect(f.starts.at(-1)!.type).toBe(`goal@${bundledVersion('goal')}`);
    expect(f.starts.at(-1)!.options.args[0]).toMatchObject({ recovery: { resumeStage: 'do' } });
    expect(f.starts.at(-1)!.options.args[0].recovery.messages.at(-1).text).toMatch(/continue autonomously/i);
    expect((await f.store.getTask(f.task.id))?.workflow).toBe('goal');
  });

  it('offers held Merge input only on the Merge conversation', async () => {
    const f = (await fixture());
    (await f.store.saveView(f.task.id, {
      ...f.view,
      stage: 'merge',
      status: 'waiting',
      waitingFor: { kind: 'human', audience: ['@creator'] },
      transcripts: [
        { role: 'do', label: 'Do agent', messages: f.view.messages },
        { role: 'merge', label: 'Merge agent', messages: [{ id: 'merge-1', role: 'agent', text: 'conflict', ts: 1 }] },
      ],
      actions: [{ name: 'cancel', kind: 'signal', label: 'Cancel', enabled: true }],
      state: { ...f.view.state, humanPauseOrigin: 'merge' },
    }));

    const held = await f.api.getTaskView(f.token, f.task.id);
    expect(held?.actions.map((action) => action.name)).toEqual(['followUp', 'cancel']);
    expect(held?.actions[0]?.roles).toEqual(['merge']);
    await expect(f.api.signalTask(f.token, f.task.id, 'followUp', 'wrong agent', 'do'))
      .rejects.toThrow(/waiting on the merge agent/i);
  });

  it('falls back to the Do conversation when the held stage never ran an agent', async () => {
    // Task #350 was paused during `merge` while still queued for its slot, so the
    // merge agent had never run and there was no merge transcript. The hold then
    // resolved to no conversation at all: `followUp` was filtered out and nothing
    // spliced back, leaving a task with 13 hours of Do context and no way to say
    // anything to it — Cancel was the only action. Do always exists once a task
    // has worked, and it owns the context the follow-up is about.
    const f = (await fixture());
    (await f.store.saveView(f.task.id, {
      ...f.view,
      stage: 'merge',
      status: 'waiting',
      waitingFor: { kind: 'human', audience: ['@creator'] },
      transcripts: [{ role: 'do', label: 'Do agent', messages: f.view.messages }],
      actions: [{ name: 'cancel', kind: 'signal', label: 'Cancel', enabled: true }],
      state: { ...f.view.state, humanPauseOrigin: 'merge' },
    }));

    const held = await f.api.getTaskView(f.token, f.task.id);
    expect(held?.actions.map((action) => action.name)).toEqual(['followUp', 'cancel']);
    expect(held?.actions[0]?.roles).toEqual(['do']);
    await expect(f.api.signalTask(f.token, f.task.id, 'followUp', 'redirect this', 'do'))
      .resolves.toBeDefined();
    expect(f.starts.at(-1)!.options.args[0].recovery).toMatchObject({ resumeStage: 'do' });
  });

  it('offers an explicit Merge-to-Do repair transition and preserves the PR checkpoint', async () => {
    const f = (await fixture());
    const prs = [{ repo: 'app', slug: 'acme/app', number: 7, url: 'https://github.test/acme/app/pull/7',
      state: 'open' as const, headSha: 'reviewed-head' }];
    (await f.store.saveView(f.task.id, {
      ...f.view,
      stage: 'merge',
      status: 'waiting',
      waitingFor: { kind: 'github', detail: 'policy blocked' },
      prs,
      landing: {
        authorization: 'authorized',
        validation: 'pending',
        provider: 'queued',
        authorizedHeads: { 'acme/app#7': 'reviewed-head' },
      },
    }));

    const merge = await f.api.getTaskView(f.token, f.task.id);
    expect(merge?.stageTransitions?.map((move) => move.target)).toEqual(['human', 'do', 'draft', 'done']);
    await f.api.moveTaskStage(f.token, f.task.id, 'do');
    expect(f.starts.at(-1)!.options.args[0].recovery).toMatchObject({
      resumeStage: 'do',
      prs,
      repairValidationPending: true,
      landing: {
        authorization: 'authorized',
        validation: 'failed',
        provider: 'ejected',
        authorizedHeads: { 'acme/app#7': 'reviewed-head' },
      },
    });
  });

  it('does not advertise a lossy human hold from the internal Resolve frame', async () => {
    const f = (await fixture());
    (await f.store.saveView(f.task.id, {
      ...f.view,
      stage: 'resolve',
      status: 'active',
      transcripts: [
        { role: 'do', label: 'Do agent', messages: f.view.messages },
        { role: 'resolve', label: 'Resolve agent', messages: [{ id: 'resolve-1', role: 'agent', text: 'repairing', ts: 1 }] },
      ],
    }));

    const resolving = await f.api.getTaskView(f.token, f.task.id);
    expect(resolving?.stageTransitions?.map((move) => move.target)).toEqual(['draft', 'done']);
  });

  it('moves a draft to Done and back without starting an execution', async () => {
    const f = (await fixture());
    (await f.store.updateTaskParams(f.task.id, { ...f.task.params, draft: true }));
    const done = await f.api.moveTaskStage(f.token, f.task.id, 'done');
    expect(done.state.manuallyDoneFrom).toBe('draft');
    expect(f.starts).toHaveLength(0);

    const draft = await f.api.moveTaskStage(f.token, f.task.id, 'draft');
    expect(draft).toMatchObject({ stage: 'setup', state: { draft: true } });
    expect((await f.store.getTask(f.task.id))?.params.draft).toBe(true);
  });

  it('makes destructive Draft reset a one-shot input to the next Setup', async () => {
    const f = (await fixture());
    const draft = await f.api.moveTaskStage(f.token, f.task.id, 'draft');
    expect(draft.state.draft).toBe(true);
    expect((await f.store.getTask(f.task.id))?.params._discardProgress).toBe(true);

    await f.api.moveTaskStage(f.token, f.task.id, 'do');
    expect(f.starts[0]!.options.args[0].discardProgress).toBe(true);
    expect((await f.store.getTask(f.task.id))?.params._discardProgress).toBeUndefined();
  });
});
