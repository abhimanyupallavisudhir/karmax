import { expect, it, vi } from 'vitest';
import { Context } from '@temporalio/activity';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { makeCoreActivities } from '../src/activities/core.js';

it('RT-15 reuses the child after a post-create activity failure but distinguishes new requests', async () => {
  const store = await Store.create(':memory:');
  const project = await store.createProject('Children');
  const parent = await store.createTask({ projectId: project.id, title: 'Parent', workflow: 'software-dev', workflowVersion: '1', params: {} });
  let activityId = 'prepare-1';
  vi.spyOn(Context, 'current').mockImplementation(() => ({ info: { activityId,
    workflowExecution: { workflowId: parent.id, runId: 'run-1' } } }) as any);
  const core = makeCoreActivities({ store, worlds: new WorldRegistry(), adapters: new Map(), profiles: new ProfileResolver(store, 'mock') });
  const args: any = { parentTaskId: parent.id, projectId: project.id, title: 'Child', prompt: 'work',
    base: 'main', target: 'main', parentBranch: 'parent', project: {}, profiles: {} };
  const update = vi.spyOn(store, 'updateTaskParams').mockRejectedValueOnce(new Error('post-create failure'));
  try {
    await expect(core.prepareChildTask(args)).rejects.toThrow('post-create failure');
    update.mockRestore();
    const child = await core.prepareChildTask(args);
    expect(await store.db.prepare('SELECT id FROM tasks WHERE parentTaskId=?').all(parent.id)).toEqual([{ id: child.taskId }]);
    expect((await core.prepareChildTask(args)).taskId).toBe(child.taskId);
    activityId = 'prepare-2';
    expect((await core.prepareChildTask(args)).taskId).not.toBe(child.taskId);
  } finally { vi.restoreAllMocks(); await store.close(); }
});
