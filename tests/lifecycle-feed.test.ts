import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { TriggerScheduler } from '../src/platform/trigger-scheduler.js';
import type { KarmaxEvent, TaskView } from '../src/domain/types.js';

// The task lifecycle feed (`view.updated`) is what dependency triggers, the
// inbox, completion stamps, collaboration requests and live consoles follow.
// Only workflow publications used to record it, so a lifecycle change written
// any other way — a person marking #367 Done after its workflow had failed —
// was invisible to all of them, and #367's dependents never started.
// The wider class: an event a writer recorded but never put on the bus (a local
// materialization's `push.branch`, an approval resolved inside the store) was
// invisible to event triggers and collaboration requests until the next boot.

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fixture() {
  const store = (await Store.create(':memory:'));
  const bus = new KarmaxBus();
  store.onEventRecorded((event) => bus.emit(event)); // as src/main.ts wires it
  const project = (await store.createProject('Feed', { repos: ['/tmp/karmax-test-repo'] }));
  const started: string[] = [];
  const client = {
    workflow: {
      start: async (_type: string, options: { workflowId: string }) => void started.push(options.workflowId),
      getHandle: () => ({ signal: async () => undefined, query: async () => { throw new Error('no live workflow'); } }),
    },
  } as any;
  const tokens = new TokenAuthority();
  const token = (await tokens.mintPrincipal('u', ['*'])).token;
  const api = new KarmaxApi({ store, client, taskQueue: 'q', tokens, bus });
  const view = (taskId: string, patch: Partial<TaskView>): TaskView => ({
    taskId, title: 'dep', workflow: 'software-dev', stage: 'do', status: 'active',
    messages: [], actions: [], state: {}, updatedAt: 1, ...patch,
  });
  const dependency = async (patch: Partial<TaskView>) => {
    const task = (await store.createTask({ projectId: project.id, title: 'dep', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'dep' } }));
    (await store.saveView(task.id, view(task.id, patch)));
    return task;
  };
  return { store, bus, project, api, token, started, view, dependency };
}

let cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const step of cleanup.reverse()) await step();
  cleanup = [];
});

describe('the lifecycle feed covers every lifecycle write', () => {
  it('records one view.updated per lifecycle change a direct write makes, and delivers it after commit', async () => {
    const f = await fixture();
    cleanup.push(() => f.store.close());
    const heard: (KarmaxEvent & { seq: number })[] = [];
    f.store.onEventRecorded((event) => void (event.type === 'view.updated' && heard.push(event)));
    const dep = (await f.dependency({}));

    // Same lifecycle, new conversation: nothing to report.
    (await f.store.saveView(dep.id, f.view(dep.id, { messages: [{ id: 'm', role: 'user', text: 'x', ts: 1 }], updatedAt: 2 })));
    (await f.store.saveView(dep.id, f.view(dep.id, { stage: 'done', status: 'done', updatedAt: 3 })));
    // A caller that records its own event (the workflow publisher) opts out.
    (await f.store.saveView(dep.id, f.view(dep.id, { stage: 'review', status: 'waiting' }), undefined, undefined, undefined,
      { lifecycleEvent: false }));
    // A rolled-back write reports nothing.
    await expect(f.store.transaction(async () => {
      (await f.store.saveView(dep.id, f.view(dep.id, { stage: 'failed', status: 'failed' })));
      throw new Error('rolled back');
    })).rejects.toThrow('rolled back');
    await settle();

    const recorded = (await f.store.eventsOfType(dep.id, 'view.updated'));
    expect(recorded.map((event) => [event.payload.stage, event.payload.status])).toEqual([['do', 'active'], ['done', 'done']]);
    expect(recorded[1]!.payload).toEqual({ stage: 'done', status: 'done', waitingFor: null, waitingDetail: null,
      waitingSummary: null, waitingProvider: null, waitingResetAt: null, waitingUntil: null, agentTurn: null, agentRole: null });
    expect(heard.map((event) => event.seq)).toEqual(recorded.map((event) => event.seq));
  });

  it('starts the dependents of a failed task a person marks Done (#367)', async () => {
    const f = await fixture();
    const scheduler = new TriggerScheduler({ store: f.store, bus: f.bus, reconcileMs: 0, // the feed alone must do it
      fire: (id, mode) => f.api.fireTriggeredTask(f.token, id, mode) });
    f.api.setTriggerArmer(scheduler);
    cleanup.push(() => f.store.close(), () => scheduler.stop());
    (await scheduler.start());
    // #367's workflow was terminated (history size limit), so no workflow will
    // ever publish again; only the person's Done can settle it.
    const dep = (await f.dependency({ stage: 'failed', status: 'failed', error: 'workflow terminated' }));
    const dependent = await f.api.createTask(f.token, { projectId: f.project.id, workflow: 'just-do',
      params: { prompt: 'after #367', triggers: [{ kind: 'dependency', tasks: [dep.id], on: 'success' }] } });
    expect(dependent.params.triggerState).toBe('armed');

    expect(await f.api.moveTaskStage(f.token, dep.id, 'done')).toMatchObject({ stage: 'done', status: 'done' });

    await vi.waitFor(() => expect(f.started).toContain(dependent.id));
    expect((await f.store.getTask(dependent.id))?.params.triggerState).toBe('fired');
  });

  it('reports a restored outcome, so `failed` dependents see the undone Done', async () => {
    const f = await fixture();
    cleanup.push(() => f.store.close());
    const dep = (await f.dependency({ stage: 'failed', status: 'failed' }));
    (await f.api.moveTaskStage(f.token, dep.id, 'done'));
    (await f.api.moveTaskStage(f.token, dep.id, 'failed'));
    const statuses = (await f.store.eventsOfType(dep.id, 'view.updated')).map((event) => event.payload.status);
    expect(statuses).toEqual(['failed', 'done', 'failed']);
  });

  it('delivers every recorded event to local subscribers exactly once, emitted by its writer or not', async () => {
    const f = await fixture();
    cleanup.push(() => f.store.close());
    const dep = (await f.dependency({}));
    const heard: number[] = [];
    f.bus.onAny((event) => void (event.type === 'push.branch' && heard.push(event.seq!)));
    // As world/handoff.ts records a local materialization's publication: no emit.
    const silent = (await f.store.appendEvent({ taskId: dep.id, type: 'push.branch', ts: 1, payload: { branch: 'b' } }));
    // As most API writers do: record, then emit by hand.
    const event = { taskId: dep.id, type: 'push.branch', ts: 2, payload: { branch: 'b' } };
    const emitted = (await f.store.appendEvent(event));
    (await f.bus.emit({ ...event, seq: emitted }));
    await settle();
    expect(heard).toEqual([silent, emitted]);
  });

  it('fires an event trigger on an event its writer never emitted', async () => {
    const f = await fixture();
    const scheduler = new TriggerScheduler({ store: f.store, bus: f.bus, reconcileMs: 0,
      fire: (id, mode) => f.api.fireTriggeredTask(f.token, id, mode) });
    f.api.setTriggerArmer(scheduler);
    cleanup.push(() => f.store.close(), () => scheduler.stop());
    (await scheduler.start());
    const source = (await f.dependency({}));
    const dependent = await f.api.createTask(f.token, { projectId: f.project.id, workflow: 'just-do',
      params: { prompt: 'after publish', triggers: [{ kind: 'event', type: 'push.branch', taskId: source.id }] } });
    (await f.store.appendEvent({ taskId: source.id, type: 'push.branch', ts: 1, payload: { branch: 'b', reason: 'local-materialization' } }));
    await vi.waitFor(() => expect(f.started).toContain(dependent.id));
  });
});
