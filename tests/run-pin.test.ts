import { it, expect, vi } from 'vitest';
import { Context } from '@temporalio/activity';
import { WorkflowNotFoundError } from '@temporalio/client';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { makeCoreActivities } from '../src/activities/core.js';

// A task's `_workflowRunId` names the run every signal, query and lifecycle
// action targets. Continue-as-new moves it to the next run (WF-3, WF-4), so a
// whole-params write from an older read must not put a closed run back.
it('keeps the stored run pin through a whole-params write', async () => {
  const store = await Store.create(':memory:');
  try {
    const project = await store.createProject('Pins');
    const task = await store.createTask({ projectId: project.id, title: 'T', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'p', _workflowRunId: 'run-1' } });
    const read = (await store.getTask(task.id))!.params;
    expect(await store.swapTaskRun(task.id, 'run-1', '')).toBe(true);
    expect(await store.swapTaskRun(task.id, '', 'run-2')).toBe(true);
    await store.updateTaskParams(task.id, { ...read, paymentPolicy: 'ask' } as any);
    expect((await store.taskMetadata(task.id))?.params).toMatchObject({ paymentPolicy: 'ask', _workflowRunId: 'run-2' });
    const { _workflowRunId: _, ...unpinned } = read;
    await store.updateTaskParams(task.id, unpinned as any);
    expect((await store.taskMetadata(task.id))?.params._workflowRunId).toBe('run-2');
  } finally { await store.close(); }
});

it.each([['closed', { status: { name: 'CONTINUED_AS_NEW' } }], ['unknown', new WorkflowNotFoundError('gone', 'task', 'run-1')]] as const)(
  'lets the live run take over a pin naming a %s run of its task', async (_kind, described) => {
    const store = await Store.create(':memory:');
    const describe = vi.fn(async () => { if (described instanceof Error) throw described; return described; });
    const live = { status: { name: 'RUNNING' } };
    const client = { workflow: { getHandle: (_id: string, runId?: string) => ({
      describe: runId === 'run-1' ? describe : async () => live }) } };
    const core = makeCoreActivities({ store, client: client as any, worlds: new WorldRegistry(), adapters: new Map(),
      profiles: new ProfileResolver(store, 'mock') });
    let runId = 'run-3';
    const ctx = vi.spyOn(Context, 'current').mockImplementation(() => ({ info: { workflowExecution: { runId } } }) as any);
    try {
      const project = await store.createProject('Pins');
      const task = await store.createTask({ projectId: project.id, title: 'T', workflow: 'software-dev',
        workflowVersion: '1.26.0', params: { prompt: 'p', _workflowRunId: 'run-1' } });
      expect(await core.adoptTaskRun(task.id)).toBe(true);
      expect((await store.taskMetadata(task.id))?.params._workflowRunId).toBe('run-3');
      // A pin naming another live run is not taken.
      await store.swapTaskRun(task.id, 'run-3', 'run-4');
      runId = 'run-5';
      expect(await core.adoptTaskRun(task.id)).toBe(false);
      expect(await core.releaseTaskRun(task.id)).toBe('foreign');
      // A continuing run whose pin was overwritten by a closed run releases it.
      await store.swapTaskRun(task.id, 'run-4', 'run-1');
      expect(await core.releaseTaskRun(task.id)).toBe('released');
      expect((await store.taskMetadata(task.id))?.params._workflowRunId).toBe('');
    } finally { ctx.mockRestore(); await store.close(); }
  });
