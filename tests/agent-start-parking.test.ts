import { describe, expect, it, vi } from 'vitest';
import { Context } from '@temporalio/activity';
import { Store } from '../src/store/db.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { makeCoreActivities } from '../src/activities/core.js';
import type { TaskView } from '../src/domain/types.js';

describe('parking during agent admission', () => {
  it.each((['do', 'review', 'merge', 'resolve'] as const).flatMap(stage =>
    (['status', 'checkpoint'] as const).flatMap(boundary => [false, true].map(separateLifecycle =>
      ({ stage, boundary, separateLifecycle })))))('defers idle parking: $stage/$boundary/separate=$separateLifecycle', async ({ stage, boundary, separateLifecycle }) => {
    const store = await Store.create(':memory:');
    const project = await store.createProject('Follow-up');
    const task = await store.createTask({ projectId: project.id, title: 'Resume', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'work' } });
    const handle = { id: task.id, kind: 'container', root: '/workspace', branch: 'task', base: 'main' };
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const atBoundary = new Promise<void>(resolve => { entered = resolve; });
    const wait = async () => { entered(); await gate; };
    const worlds = { get: () => ({ parkable: true }),
      status: vi.fn(async () => { if (boundary === 'status') await wait(); return 'ready'; }),
      park: vi.fn(async () => handle) };
    const checkpoint = vi.fn(async () => { if (boundary === 'checkpoint') await wait(); return { id: 'saved', generation: 1 }; });
    const core = makeCoreActivities({ store, worlds: worlds as any, adapters: new Map(),
      profiles: new ProfileResolver(store, 'mock'), checkpoints: { checkpoint } as any });
    const view = { taskId: task.id, title: task.title, workflow: task.workflow, stage, status: 'waiting',
      waitingFor: { kind: 'human', audience: ['@creator'] }, messages: [], actions: [], updatedAt: 1,
      state: {}, world: handle } as TaskView;
    try {
      const publication = separateLifecycle
        ? core.publishView(task.id, view, undefined, { separateLifecycle: true }).then(fence => core.parkWaitingWorld(task.id, view, fence!))
        : core.publishView(task.id, view);
      await atBoundary;
      await store.appendEvent({ taskId: task.id, type: 'conversation.message', ts: Date.now(),
        payload: { role: stage === 'review' ? 'do' : stage, message: { id: 'new', role: 'user', text: 'Continue' } } });
      release();
      await publication;
      expect(worlds.park).not.toHaveBeenCalled();
      expect(checkpoint).toHaveBeenCalledTimes(boundary === 'checkpoint' ? 1 : 0);
      expect((await store.eventsOfType(task.id, 'world.park-deferred'))).toHaveLength(1);
      // The next real wait still parks; an old accepted message is no longer
      // grounds to defer another publication indefinitely.
      await core.publishView(task.id, view);
      expect(worlds.park).toHaveBeenCalledTimes(1);
    } finally { release(); await store.close(); }
  });

  it('retains the original follow-up boundary when a legacy publication retries', async () => {
    const store = await Store.create(':memory:');
    const project = await store.createProject('Retry');
    const task = await store.createTask({ projectId: project.id, title: 'Resume', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'work' } });
    const handle = { id: task.id, kind: 'container', root: '/workspace', branch: 'task', base: 'main' };
    const park = vi.fn(async () => handle);
    const worlds = { get: () => ({ parkable: true }), status: async () => 'ready', park };
    let interrupted = true;
    let cancellation = new AbortController();
    const checkpoint = vi.fn(async () => {
      if (interrupted) { cancellation.abort(); throw new Error('worker lost'); }
      return { id: 'saved', generation: 1 };
    });
    const core = makeCoreActivities({ store, worlds: worlds as any, adapters: new Map(),
      profiles: new ProfileResolver(store, 'mock'), checkpoints: { checkpoint } as any });
    const view = { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'do', status: 'waiting',
      waitingFor: { kind: 'human', audience: ['@creator'] }, messages: [], actions: [], updatedAt: 1,
      state: {}, world: handle } as TaskView;
    const ctx = vi.spyOn(Context, 'current').mockImplementation(() => ({ cancellationSignal: cancellation.signal,
      info: { workflowExecution: { runId: 'same-run' }, activityId: '37' } } as any));
    try {
      await expect(core.publishView(task.id, view)).rejects.toThrow('worker lost');
      await store.appendEvent({ taskId: task.id, type: 'conversation.message', ts: Date.now(),
        payload: { role: 'do', message: { id: 'reply', role: 'user', text: 'Continue' } } });
      interrupted = false;
      cancellation = new AbortController();
      checkpoint.mockClear(); park.mockClear();
      await core.publishView(task.id, view);
      expect(checkpoint).not.toHaveBeenCalled();
      expect(park).not.toHaveBeenCalled();
    } finally { ctx.mockRestore(); await store.close(); }
  });

  it('stops checkpoint work at its next safe boundary after a follow-up', async () => {
    const store = await Store.create(':memory:');
    const project = await store.createProject('Interrupt capture');
    const task = await store.createTask({ projectId: project.id, title: 'Resume', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'work' } });
    const handle = { id: task.id, kind: 'container', root: '/workspace', branch: 'task', base: 'main' };
    const park = vi.fn(async () => handle);
    const expensiveRemainder = vi.fn();
    const checkpoint = async (_handle: unknown, options?: { checkContinue?: () => Promise<void> }) => {
      await store.appendEvent({ taskId: task.id, type: 'conversation.message', ts: Date.now(),
        payload: { role: 'do', message: { id: 'reply', role: 'user', text: 'Continue' } } });
      await options?.checkContinue?.();
      expensiveRemainder();
      return { id: 'saved', generation: 1 };
    };
    const core = makeCoreActivities({ store, worlds: { get: () => ({ parkable: true }),
      status: async () => 'ready', park } as any, adapters: new Map(),
      profiles: new ProfileResolver(store, 'mock'), checkpoints: { checkpoint } as any });
    const view = { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'do', status: 'waiting',
      waitingFor: { kind: 'human', audience: ['@creator'] }, messages: [], actions: [], updatedAt: 1,
      state: {}, world: handle } as TaskView;
    try {
      await core.publishView(task.id, view);
      expect(expensiveRemainder).not.toHaveBeenCalled();
      expect(park).not.toHaveBeenCalled();
      expect(await store.eventsOfType(task.id, 'checkpoint.warning')).toHaveLength(0);
    } finally { await store.close(); }
  });

  it.each([false, true])('publishes startup without checkpointing or parking (recovery handle: %s)', async recovery => {
    const store = (await Store.create(':memory:'));
    const project = (await store.createProject('Admission'));
    const task = (await store.createTask({ projectId: project.id, title: 'Start', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'work' } }));
    const handle = { id: task.id, kind: 'e2b', root: '/workspace', branch: 'task', base: 'main' };
    let parked = false;
    const worlds = { get: () => ({ parkable: true }),
      status: vi.fn(async () => parked ? 'parked' : 'ready'),
      park: vi.fn(async () => { parked = true; return handle; }) };
    const checkpoint = vi.fn(async () => { throw new Error('startup must not enter an expensive checkpoint'); });
    const deps = { store, worlds: worlds as any, adapters: new Map(), profiles: new ProfileResolver(store, 'mock') };
    const core = makeCoreActivities({ ...deps, checkpoints: { checkpoint } as any });
    const view = { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'do', status: 'waiting',
      waitingFor: { kind: 'agentSlot', detail: 'Starting agent' }, messages: [], actions: [], updatedAt: 1,
      state: recovery ? { recoveryWorld: handle } : {}, ...(recovery ? {} : { world: handle }) } as TaskView;
    try {
      await core.publishView(task.id, view);
      expect((await store.getTask(task.id))?.lastView?.waitingFor).toEqual(view.waitingFor);
      expect(worlds.status).not.toHaveBeenCalled();
      expect(worlds.park).not.toHaveBeenCalled();
      expect(checkpoint).not.toHaveBeenCalled();

      // Actual resource waits retain the cost-control behavior, including old
      // workflow versions that expose their world only in recovery state.
      const parking = makeCoreActivities(deps);
      for (const waitingFor of [{ kind: 'agentSlot', detail: 'Waiting for host capacity to start agent' },
        { kind: 'account', provider: 'codex' }, { kind: 'human', audience: ['@creator'] }]) {
        parked = false;
        await parking.publishView(task.id, { ...view, waitingFor } as TaskView);
        expect(parked).toBe(true);
      }
      expect(worlds.park).toHaveBeenCalledTimes(3);
    } finally { (await store.close()); }
  });

  it.each(['heartbeat', 'durable'])('heartbeats slow world setup with the %s retry session and clears its timer on failure', async source => {
    const store = (await Store.create(':memory:'));
    const project = (await store.createProject('Slow setup'));
    const task = (await store.createTask({ projectId: project.id, title: 'Resume', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'work' } }));
    const heartbeat = vi.fn();
    const turnId = `${task.id}#1`;
    (await store.kvSet(`turnsession:${turnId}`, 'prior-session'));
    const context = vi.spyOn(Context, 'current').mockReturnValue({ heartbeat,
      cancellationSignal: new AbortController().signal,
      info: { attempt: 2, workflowExecution: { runId: 'run', workflowId: task.id }, activityId: '1',
        currentAttemptScheduledTimestampMs: Date.now(),
        ...(source === 'heartbeat' ? { heartbeatDetails: { session: 'prior-session' } } : {}) },
    } as any);
    let rejectOpen!: (error: Error) => void;
    const opening = new Promise<never>((_, reject) => { rejectOpen = reject; });
    const worlds = { get: () => ({ capabilities: { remote: false } }), open: () => opening } as any;
    const core = makeCoreActivities({ store, worlds, adapters: new Map(), profiles: new ProfileResolver(store, 'mock') });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const run = core.runAgentTurn({ taskId: task.id, role: 'do', agentTurnId: turnId, messages: [],
        worldHandle: { id: task.id, kind: 'memory', root: '/workspace', branch: 'task', base: 'main' },
        task: { taskId: task.id, projectId: project.id, title: task.title, prompt: 'work', project: {},
          workflow: 'software-dev', agents: { do: { provider: 'mock' } } },
      } as any);
      const failed = expect(run).rejects.toThrow('setup unavailable');
      await vi.advanceTimersByTimeAsync(130_000);
      expect(heartbeat.mock.calls.length).toBeGreaterThanOrEqual(130);
      expect(heartbeat.mock.calls.every(([details]) => details?.session === 'prior-session')).toBe(true);
      rejectOpen(new Error('setup unavailable'));
      await failed;
      const beats = heartbeat.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(heartbeat).toHaveBeenCalledTimes(beats);
    } finally { vi.useRealTimers(); context.mockRestore(); (await store.close()); }
  });
});
