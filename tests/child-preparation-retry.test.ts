import { expect, it, vi } from 'vitest';
import { Context } from '@temporalio/activity';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { makeCoreActivities } from '../src/activities/core.js';

it('RT-15 reuses the child after a post-create activity failure but distinguishes new requests', async () => {
  const store = await Store.create(':memory:');
  const project = await store.createProject('Children');
  const parent = await store.createTask({ projectId: project.id, title: 'Parent', workflow: 'software-dev', workflowVersion: '1', params: { prompt: 'fixture' } });
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

// Upgrade rehearsal (#421): a hosted project without a repository has no parent
// branch to seed, and requiring one pushed made every sub-task fail its parent.
it('prepares a child of a remote world whose project has no repository', async () => {
  const store = await Store.create(':memory:');
  const project = await store.createProject('Notes');
  const parent = await store.createTask({ projectId: project.id, title: 'Parent', workflow: 'software-dev', workflowVersion: '1', params: { prompt: 'fixture' } });
  const handle = { id: parent.id, kind: 'e2b', root: '/home/user/world', branch: `karmax/${parent.id}`, base: 'main', meta: { projectId: project.id } };
  await store.registerWorld(handle as any, project.id);
  vi.spyOn(Context, 'current').mockImplementation(() => ({ info: { activityId: 'prepare',
    workflowExecution: { workflowId: parent.id, runId: 'run-1' } } }) as any);
  const worlds = new WorldRegistry();
  const exec = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
  vi.spyOn(worlds, 'open').mockResolvedValue({ handle, exec } as any);
  const core = makeCoreActivities({ store, worlds, adapters: new Map(), profiles: new ProfileResolver(store, 'mock') });
  try {
    const child = await core.prepareChildTask({ parentTaskId: parent.id, projectId: project.id, title: 'Child', prompt: 'work',
      base: 'main', target: 'main', parentBranch: `karmax/${parent.id}`, project: {}, profiles: {} } as any);
    expect(await store.getTask(child.taskId)).toMatchObject({ parentTaskId: parent.id });
  } finally { vi.restoreAllMocks(); await store.close(); }
});
