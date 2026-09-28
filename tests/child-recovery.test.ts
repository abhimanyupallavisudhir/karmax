import { expect, it, vi } from 'vitest';
import { makeChildActivities } from '../src/activities/children.js';
import { notifyChildSettlement } from '../src/platform/child-settlement.js';

it('restores only unfinished children and carries their pending question', async () => {
  const store = { childTasks: vi.fn(async () => [
    { id: 'live', title: 'Child', lastView: { status: 'waiting', waitingFor: { kind: 'parent', detail: 'Review me' } } },
    ...['done', 'cancelled', 'failed'].map(status => ({ id: status, lastView: { status } })),
  ]) };
  expect(await makeChildActivities(store as any).restoreChildTasks('parent')).toEqual([
    { taskId: 'live', title: 'Child', waiting: true, detail: 'Review me' },
  ]);
  expect(store.childTasks).toHaveBeenCalledWith('parent');
});

it('signals the durable parent only for a terminal child, excluding lifecycle replacement', async () => {
  const signal = vi.fn(async () => undefined);
  const getHandle = vi.fn(() => ({ signal }));
  const store = { taskMetadata: vi.fn(async () => ({ id: 'child', parentTaskId: 'parent' })) };
  const client = { workflow: { getHandle } };
  const view = { taskId: 'child', status: 'cancelled', stage: 'cancelled' } as any;
  await notifyChildSettlement(store as any, client as any, { ...view, state: { lifecycleReplacement: true } });
  await notifyChildSettlement(store as any, client as any, { ...view, status: 'active' });
  expect(signal).not.toHaveBeenCalled();
  await notifyChildSettlement(store as any, client as any, view);
  expect(getHandle).toHaveBeenCalledWith('parent');
  expect(signal).toHaveBeenCalledWith('childSettled', { childTaskId: 'child', stage: 'cancelled' });
});

it('retries a child settlement when the parent signal transport is unavailable', async () => {
  const error = new Error('UNAVAILABLE');
  const store = { taskMetadata: async () => ({ id: 'child', parentTaskId: 'parent' }) };
  const client = { workflow: { getHandle: () => ({ signal: async () => { throw error; } }) } };
  await expect(notifyChildSettlement(store as any, client as any,
    { taskId: 'child', stage: 'done', status: 'done' } as any)).rejects.toBe(error);
});

it('reports which outstanding children settled, excluding lifecycle replacement', async () => {
  const { Store } = await import('../src/store/db.js');
  const store = await Store.create(':memory:');
  try {
    const project = await store.createProject('Children');
    const parent = await store.createTask({ projectId: project.id, title: 'Parent', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'p' } });
    const child = async (title: string, status: string, state: Record<string, unknown> = {}) => {
      const task = await store.createTask({ projectId: project.id, title, workflow: 'software-dev',
        workflowVersion: '1.26.0', params: { prompt: title }, parentTaskId: parent.id });
      await store.saveView(task.id, { taskId: task.id, title, workflow: 'software-dev', stage: status === 'waiting' ? 'review' : status,
        status, messages: [{ id: 'm', role: 'agent', text: 'long transcript', ts: 0 }], actions: [], state, updatedAt: 1 } as any);
      return task.id;
    };
    const live = await child('Live', 'waiting');
    const replaced = await child('Replaced', 'cancelled', { lifecycleReplacement: true });
    const [done, cancelled, failed] = [await child('Done', 'done'), await child('Cancelled', 'cancelled'), await child('Failed', 'failed')];
    const elsewhere = await child('Not outstanding', 'done');
    const settled = await makeChildActivities(store).settledChildTasks(parent.id, [live, replaced, done, cancelled, failed]);
    expect(settled).toEqual(expect.arrayContaining([{ taskId: done, stage: 'done' }, { taskId: cancelled, stage: 'cancelled' },
      { taskId: failed, stage: 'failed' }]));
    expect(settled).toHaveLength(3);
    expect(settled.map((c) => c.taskId)).not.toContain(elsewhere);
    expect(await makeChildActivities(store).settledChildTasks(parent.id, [])).toEqual([]);
  } finally { await store.close(); }
});
