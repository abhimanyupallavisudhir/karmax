import { describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxApi } from '../src/platform/api.js';
import { KarmaxBus } from '../src/contrib/bus.js';

describe('conversation message events', () => {
  it('journals and broadcasts a follow-up as soon as its workflow signal is accepted', async () => {
    const store = new Store(':memory:');
    const tokens = new TokenAuthority();
    const token = tokens.mint({
      taskId: 'operator',
      profileId: 'do',
      principal: 'user:test',
      ceiling: ['read-task', 'signal-task'],
      grantorCaps: ['read-task', 'signal-task'],
    }).token;
    const project = store.createProject('Conversation');
    const task = store.createTask({
      projectId: project.id,
      title: 'Running task',
      workflow: 'software-dev',
      workflowVersion: '1.2.0',
      params: { prompt: 'start' },
    });
    store.saveView(task.id, {
      taskId: task.id,
      title: task.title,
      workflow: task.workflow,
      stage: 'do',
      status: 'active',
      messages: [{ id: 'm0', role: 'user', text: 'start', ts: 1 }],
      actions: [],
      state: {},
      updatedAt: 1,
    });

    const signal = vi.fn(async () => undefined);
    const client = { workflow: { getHandle: () => ({ signal }) } } as any;
    const bus = new KarmaxBus();
    const broadcast: any[] = [];
    bus.onTask(task.id, (event) => broadcast.push(event));
    const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, bus });

    const message = await api.signalTask(token, task.id, 'followUp', 'One more requirement', 'do');

    expect(signal).toHaveBeenCalledWith('followUp', message, 'do');
    expect(message).toMatchObject({ role: 'user', text: 'One more requirement' });
    const events = store.eventsSince(task.id, 0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'conversation.message',
      payload: { role: 'do', message: { id: message?.id, text: 'One more requirement' } },
    });
    expect(broadcast).toEqual(events);
    // The workflow owns its replay-sensitive snapshot; the event bridges the UI
    // until that snapshot is naturally published at the next lifecycle boundary.
    expect(store.getTask(task.id)?.lastView?.messages).toHaveLength(1);
  });
});
