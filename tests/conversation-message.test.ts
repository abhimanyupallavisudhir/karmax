import { describe, expect, it, vi, onTestFinished } from 'vitest';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxApi } from '../src/platform/api.js';
import { KarmaxBus } from '../src/contrib/bus.js';

describe('conversation message events', () => {
  it.each([false, true])('journals and broadcasts a follow-up as soon as its workflow signal is accepted (timing enabled: %s)', async (enabled) => {
    const store = (await Store.create(':memory:'));
    onTestFinished(async () => (await store.close()));
    if (enabled) (await store.setSettings('global', 'timing', { enabled: true }));
    const tokens = new TokenAuthority();
    const token = (await tokens.mint({
      taskId: 'operator',
      profileId: 'do',
      principal: 'user:test',
      ceiling: ['read-task', 'signal-task'],
      grantorCaps: ['read-task', 'signal-task'],
    })).token;
    const project = (await store.createProject('Conversation'));
    const task = (await store.createTask({
      projectId: project.id,
      title: 'Running task',
      workflow: 'software-dev',
      workflowVersion: '1.2.0',
      params: { prompt: 'start' },
    }));
    (await store.saveView(task.id, {
      taskId: task.id,
      title: task.title,
      workflow: task.workflow,
      stage: 'do',
      status: 'active',
      messages: [{ id: 'm0', role: 'user', text: 'start', ts: 1 }],
      actions: [],
      state: {},
      updatedAt: 1,
    }));

    const signal = vi.fn(async () => undefined);
    const client = { workflow: { getHandle: () => ({ signal }) } } as any;
    const bus = new KarmaxBus();
    const broadcast: any[] = [];
    bus.onTask(task.id, (event) => broadcast.push(event));
    const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, bus });

    const message = await api.signalTask(token, task.id, 'followUp', 'One more requirement', 'do');

    expect(signal).toHaveBeenCalledWith('followUp', message, 'do');
    expect(message).toMatchObject({ role: 'user', text: 'One more requirement' });
    const journal = (await store.eventsSince(task.id, 0));
    const events = journal.filter(event => event.type === 'conversation.message');
    const timing = journal.filter(event => event.type === 'timing').map(event => event.payload);
    expect(timing).toEqual(enabled ? [
      expect.objectContaining({ name: 'request.received', phase: 'mark', requestIds: [`${task.id}:${message?.id}`] }),
      expect.objectContaining({ name: 'workflow.dispatch', phase: 'start' }),
      expect.objectContaining({ name: 'workflow.dispatch', phase: 'end', status: 'ok' }),
    ] : []);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'conversation.message',
      payload: { role: 'do', message: { id: message?.id, text: 'One more requirement' } },
    });
    expect(broadcast).toEqual(events);
    // The workflow owns its replay-sensitive snapshot; the event bridges the UI
    // until that snapshot is naturally published at the next lifecycle boundary.
    expect((await store.getTask(task.id))?.lastView?.messages).toHaveLength(1);
  });

  /** PL-6: message_agent is advertised as task:conversation:message ("Message
   *  forked agents"), but was sent as a task:signal followUp — so the capability
   *  it is granted under never let it run, and task:signal (which also confirms,
   *  cancels and retries) was the real requirement. */
  it('authorizes message_agent as a conversation message, not a workflow signal', async () => {
    const store = (await Store.create(':memory:'));
    onTestFinished(async () => (await store.close()));
    const tokens = new TokenAuthority();
    const mint = async (caps: string[]) => (await tokens.mint({
      taskId: 'operator', profileId: 'do', principal: 'user:test', ceiling: caps, grantorCaps: caps,
    })).token;
    const project = (await store.createProject('Conversation'));
    const task = (await store.createTask({
      projectId: project.id, title: 'Fork', workflow: 'software-dev', workflowVersion: '1.2.0', params: { prompt: 'start' },
    }));
    (await store.saveView(task.id, {
      taskId: task.id, title: task.title, workflow: task.workflow, stage: 'do', status: 'active',
      messages: [], actions: [], state: {}, updatedAt: 1,
    }));
    const signal = vi.fn(async () => undefined);
    const api = new KarmaxApi({ store, client: { workflow: { getHandle: () => ({ signal }) } } as any, taskQueue: 'test', tokens });

    const messenger = (await mint(['task:read', 'task:conversation:message']));
    const message = await api.messageAgent(messenger, task.id, 'Please rebase', 'do');
    expect(signal).toHaveBeenCalledWith('followUp', message, 'do');
    expect(message).toMatchObject({ role: 'user', text: 'Please rebase' });
    await expect(api.signalTask(messenger, task.id, 'cancel')).rejects.toThrow(/task:signal/);

    signal.mockClear();
    await expect(api.messageAgent((await mint(['task:read', 'task:signal'])), task.id, 'hi', 'do'))
      .rejects.toThrow(/task:conversation:message/);
    expect(signal).not.toHaveBeenCalled();
  });
});
