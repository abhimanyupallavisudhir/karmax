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
