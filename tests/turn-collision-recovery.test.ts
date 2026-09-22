import { describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import { reconcileTasks } from '../src/platform/reconcile.js';

async function fixture(createdAt = 100) {
  const store = (await Store.create(':memory:'));
  const project = (await store.createProject('Recovery'));
  const task = (await store.createTask({ projectId: project.id, title: 'Restarted task', workflow: 'software-dev',
    workflowVersion: '1.26.0', params: { prompt: 'continue' } }));
  const view = { taskId: task.id, title: task.title, workflow: task.workflow,
    stage: 'escalated' as const, status: 'blocked' as const, state: {}, messages: [], actions: [], updatedAt: 1,
    error: 'Activity task failed → usage admission retry key belongs to different attributed work' };
  (await store.saveView(task.id, view));
  (await store.admitAgentUsage({ id: `${task.id}#0`, organizationId: project.organizationId!, projectId: project.id,
    taskId: task.id, provider: 'openai', fundingSource: 'customer', now: createdAt }));
  (await store.finishUsageAdmission(`${task.id}#0`, true));
  const handle = {
    describe: vi.fn(async () => ({ status: { name: 'RUNNING' }, runId: 'replacement', startTime: new Date(200) })),
    query: vi.fn(async () => view),
    signal: vi.fn(async (_name: string) => undefined),
  };
  const client = { workflow: { getHandle: () => handle } } as any;
  return { store, task, view, handle, client };
}

describe('historical turn collision recovery', () => {
  it('resumes the proven collision once per run without changing usage records', async () => {
    const f = (await fixture());
    try {
      await reconcileTasks(f.store, f.client);
      await reconcileTasks(f.store, f.client);
      expect(f.handle.signal).toHaveBeenCalledExactlyOnceWith('retry');
      expect((await f.store.db.prepare('SELECT state FROM usage_admissions WHERE id=?').get(`${f.task.id}#0`)))
        .toMatchObject({ state: 'completed' });
    } finally { (await f.store.close()); }
  });

  it('does not retry an attribution conflict originating in the current run', async () => {
    const f = (await fixture(201));
    try {
      await reconcileTasks(f.store, f.client);
      expect(f.handle.signal).not.toHaveBeenCalled();
    } finally { (await f.store.close()); }
  });

  it('does not resume a task whose live state has moved on', async () => {
    const f = (await fixture());
    try {
      f.handle.query.mockResolvedValue({ ...f.view, error: 'A different failure' });
      await reconcileTasks(f.store, f.client);
      expect(f.handle.signal).not.toHaveBeenCalled();
    } finally { (await f.store.close()); }
  });

  it('leaves the task intact on transport failure and retries the repair later', async () => {
    const f = (await fixture());
    try {
      f.handle.signal.mockRejectedValueOnce(new Error('temporarily unavailable'));
      await reconcileTasks(f.store, f.client);
      expect((await f.store.getTask(f.task.id))?.lastView?.stage).toBe('escalated');
      await reconcileTasks(f.store, f.client);
      expect(f.handle.signal).toHaveBeenCalledTimes(2);
    } finally { (await f.store.close()); }
  });
});
