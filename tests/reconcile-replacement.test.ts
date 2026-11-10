import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { reconcileTasks } from '../src/platform/reconcile.js';
import { lifecycleReplacementKey } from '../src/platform/lifecycle-replacement.js';
import { PermissionRequests } from '../src/platform/permission-requests.js';
import type { TaskView } from '../src/domain/types.js';

// Task #904: an agent's request_permission replaces the task's run with one
// that waits for the approval. The old run winds down first (its `cancelled`
// frame is suppressed), so for a moment Temporal says COMPLETED while the
// stored view is still active. A reconcile sweep in that moment settled the
// task `done`, which withdrew the very request it was about to wait on: the
// task then waited as a bare "Needs input" with no approval to give.
async function replacing(store: Store, projectId: string, runId: string, pinned?: string) {
  const task = await store.createTask({ projectId, title: 'Asks for a project', workflow: 'software-dev',
    workflowVersion: '1.30.0', params: { prompt: 'x', ...(pinned ? { _workflowRunId: pinned } : {}) } });
  const view: TaskView = { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'do', status: 'active',
    messages: [], actions: [], state: {}, updatedAt: 1 };
  await store.saveView(task.id, view);
  const request = await new PermissionRequests(store, 'org_personal').request({
    taskId: task.id, projectId, role: 'do', capabilities: ['project:create'], audience: ['@creator'],
    recipients: ['user_owner'], reason: 'needs it', requestedBy: `task-agent:${task.id}:do-default`,
  });
  return { task, request, runId };
}

// The id's latest run is closed; `running` names runs of it still live.
const completed = (runs: Record<string, string>, running: string[] = []) => ({ workflow: {
  getHandle: (id: string, runId?: string) => ({
    describe: async () => runId
      ? { status: { name: running.includes(runId) ? 'RUNNING' : 'COMPLETED' }, runId }
      : { status: { name: 'COMPLETED' }, runId: runs[id] },
    result: async () => undefined,
  }),
} }) as any;

describe('reconcile leaves a run being replaced alone', () => {
  it('does not settle a completed run while its lifecycle replacement is in flight', async () => {
    const store = await Store.create(':memory:');
    try {
      const project = await store.createProject('Replacement');
      const { task, request } = await replacing(store, project.id, 'old');
      await store.kvSet(lifecycleReplacementKey(task.id), JSON.stringify({ runId: 'old', requestedAt: Date.now() }));

      expect(await reconcileTasks(store, completed({ [task.id]: 'old' }))).toMatchObject({ settled: 0 });
      expect((await store.getTask(task.id))!.lastView!.status).toBe('active');
      const [still] = await new PermissionRequests(store, 'org_personal').requests({ taskId: task.id });
      expect(still).toMatchObject({ id: request.id, status: 'pending' });
    } finally { await store.close(); }
  });

  it('does not settle a completed run once its successor is pinned', async () => {
    // The successor started and was pinned, and the marker was cleared, between
    // the sweep's describe of the old run and its settlement.
    const store = await Store.create(':memory:');
    try {
      const project = await store.createProject('Replacement');
      const { task } = await replacing(store, project.id, 'old', 'new');
      expect(await reconcileTasks(store, completed({ [task.id]: 'old' }, ['new']))).toMatchObject({ settled: 0 });
      expect((await store.getTask(task.id))!.lastView!.status).toBe('active');
    } finally { await store.close(); }
  });

  it('still settles a closed run when its pin names another closed run', async () => {
    // A whole-params write can restore an older run's pin (closedRunPin).
    const store = await Store.create(':memory:');
    try {
      const project = await store.createProject('Replacement');
      const { task } = await replacing(store, project.id, 'latest', 'older');
      expect(await reconcileTasks(store, completed({ [task.id]: 'latest' }))).toMatchObject({ settled: 1 });
      expect((await store.getTask(task.id))!.lastView!.status).toBe('done');
    } finally { await store.close(); }
  });

  it('still settles a run whose replacement was abandoned long ago', async () => {
    const store = await Store.create(':memory:');
    try {
      const project = await store.createProject('Replacement');
      const { task } = await replacing(store, project.id, 'old', 'old');
      await store.kvSet(lifecycleReplacementKey(task.id), JSON.stringify({ runId: 'old', requestedAt: Date.now() - 60 * 60_000 }));
      expect(await reconcileTasks(store, completed({ [task.id]: 'old' }))).toMatchObject({ settled: 1 });
      expect((await store.getTask(task.id))!.lastView!.status).toBe('done');
    } finally { await store.close(); }
  });
});
