import { describe, it, expect } from 'vitest';
import { storeBackends } from './helpers/store-backends.js';

/**
 * A pull request of a task with several branches (SPEC §11.1) lands through a
 * record of its own, but it is part of its task, not a task: no number, no row
 * in any task list or search, and what it asks of people is asked as its
 * task's — the inbox and notifications name the task, and opening it opens it.
 */
describe.each(storeBackends)('pull requests of a task ($name)', ({ open }) => {
  it('are no tasks of their own: unnumbered, unlisted, and their asks are their task\'s', async () => {
    const store = await open();
    const organization = await store.createOrganization({ name: 'Team', ownerUserId: 'owner' });
    const project = await store.createProject('App', {}, organization.id);
    const parent = await store.createTask({ projectId: project.id, title: 'Split change', workflow: 'software-dev',
      workflowVersion: '1.30.0', params: { prompt: 'x' }, createdBy: { kind: 'user', userId: 'owner' } });
    const pr = await store.createTask({ projectId: project.id, title: 'docs: Split change', workflow: 'software-dev',
      workflowVersion: '1.30.0', params: { prompt: 'p', _shippedFrom: { taskId: parent.id, checkout: 'docs' } },
      parentTaskId: parent.id, createdBy: { kind: 'task-agent', taskId: parent.id, role: 'do' } });
    const child = await store.createTask({ projectId: project.id, title: 'An ordinary sub-task', workflow: 'software-dev',
      workflowVersion: '1.30.0', params: { prompt: 'c' }, parentTaskId: parent.id,
      createdBy: { kind: 'task-agent', taskId: parent.id, role: 'do' } });

    expect(parent.num).toBeTypeOf('number');
    expect(child.num).toBeTypeOf('number');
    expect(pr.num).toBeUndefined();
    expect((await store.getTask(pr.id))?.num ?? undefined).toBeUndefined();

    const ids = (tasks: Array<{ id: string }>) => tasks.map((task) => task.id).sort();
    const listed = [parent.id, child.id].sort();
    expect(ids(await store.listTasks(project.id))).toEqual(listed);
    expect(ids(await store.listTaskSummaries(project.id))).toEqual(listed);
    expect(ids(await store.listTasksAsync(project.id, false))).toEqual(listed);
    expect(ids((await store.taskSummaryPage(project.id, { includeArchived: true })).tasks)).toEqual(listed);
    // Its task still finds it, for its Branches.
    expect((await store.childTaskSummaries(parent.id)).map((summary) => summary.id)).toContain(pr.id);
    // Each says whether it is a pull request of its task, whatever the task's run remembers (pramana#102).
    const summaries = new Map((await store.childTaskSummaries(parent.id)).map((summary) => [summary.id, summary]));
    expect(summaries.get(pr.id)?.pullRequest).toEqual({ checkout: 'docs' });
    expect(summaries.get(child.id)?.pullRequest).toBeUndefined();

    // Named as its task wherever it asks something.
    const headers = await store.taskHeaders([pr.id, child.id]);
    expect(headers.get(pr.id)).toMatchObject({ id: parent.id, num: parent.num, title: 'Split change · pull request "docs"',
      pullRequest: { taskId: pr.id, checkout: 'docs' } });
    expect(headers.get(child.id)).toMatchObject({ id: child.id, num: child.num, title: 'An ordinary sub-task' });

    // Waiting for Review, it asks its task's reviewer — as its task.
    const next = { taskId: pr.id, title: pr.title, workflow: 'software-dev', stage: 'review', status: 'waiting',
      waitingFor: { kind: 'human', audience: ['@creator'] }, messages: [], actions: [], state: {}, updatedAt: Date.now() } as any;
    await store.saveView(pr.id, next, undefined, undefined, undefined, { lifecycleEvent: false });
    await store.appendEvent({ taskId: pr.id, type: 'view.updated', ts: Date.now(),
      payload: { stage: 'review', status: 'waiting', waitingFor: 'human' } });
    const asks = await store.attentionAsks('owner', organization.id);
    expect([...asks.keys()]).toEqual([parent.id]);
    expect(asks.get(parent.id)?.kinds).toEqual(['review-requested']);
    // …and says which of its pull requests asks it, so a list can tell that
    // apart from the task itself waiting for Review (pramana#102).
    expect(asks.get(parent.id)?.pullRequests).toEqual([{ checkout: 'docs', kind: 'review-requested' }]);
  });
});
