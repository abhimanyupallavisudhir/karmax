import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { reconcileTasks } from '../src/platform/reconcile.js';
import type { TaskView } from '../src/domain/types.js';

const transcript = [
  { role: 'user', text: 'Fix the flaky merge test', ts: 1 },
  { role: 'agent', text: 'Found the race in merge-wait and fixed it.', ts: 2 },
] as TaskView['messages'];

async function activeTask(store: Store, projectId: string, title: string, reference?: string) {
  const task = await store.createTask({ projectId, title, workflow: 'software-dev', workflowVersion: '1.30.0',
    params: { prompt: title } });
  const view: TaskView = { taskId: task.id, title, workflow: task.workflow, stage: 'do', status: 'active',
    messages: transcript, transcripts: [{ role: 'do', label: 'Do', messages: transcript }], actions: [], state: {}, updatedAt: 7 };
  if (reference) {
    await store.kvSet(`view-conversation:${task.id}:${reference}`, JSON.stringify({ messages: transcript, transcripts: [{ role: 'do', label: 'Do', messages: transcript }] }));
    await store.saveView(task.id, { ...view, messages: [], transcripts: undefined }, reference);
  } else await store.saveView(task.id, view);
  return task;
}

// PS-1: reconcile settles exactly the tasks whose workflow ended unexpectedly;
// its candidates are read without the conversation column, and settling one
// must not erase the transcript that explains what happened.
describe('reconcile keeps stored conversations', () => {
  it('settles lost, completed and terminated workflows with their transcripts intact', async () => {
    const store = await Store.create(':memory:');
    try {
      const project = await store.createProject('Reconcile');
      const lost = await activeTask(store, project.id, 'Lost on restart');
      const completed = await activeTask(store, project.id, 'Completed');
      const terminated = await activeTask(store, project.id, 'Terminated', 'run:3');
      const outcomes: Record<string, () => Promise<unknown>> = {
        [lost.id]: async () => { throw new Error('workflow not found'); },
        [completed.id]: async () => ({ status: { name: 'COMPLETED' }, runId: 'r' }),
        [terminated.id]: async () => ({ status: { name: 'TERMINATED' }, runId: 'r' }),
      };
      const client = { workflow: { getHandle: (id: string) => ({
        describe: outcomes[id], result: async () => undefined,
      }) } } as any;

      expect(await reconcileTasks(store, client)).toEqual({ checked: 3, settled: 3 });

      for (const [task, status] of [[lost, 'failed'], [completed, 'done'], [terminated, 'failed']] as const) {
        const view = (await store.getTask(task.id))!.lastView!;
        expect(view.status).toBe(status);
        expect(view.messages).toEqual(transcript);
        expect(view.transcripts).toEqual([{ role: 'do', label: 'Do', messages: transcript }]);
      }
    } finally { await store.close(); }
  });
});

// WF-3/WF-4: a parent that continued as new has no handle to see its child's
// execution fail or be terminated; the settled durable view must tell it.
it('tells a parent when reconcile settles its child', async () => {
  const store = await Store.create(':memory:');
  try {
    const project = await store.createProject('Reconcile');
    const parent = await activeTask(store, project.id, 'Parent');
    const children: { id: string }[] = [];
    for (const title of ['Terminated child', 'Lost child']) {
      const child = await store.createTask({ projectId: project.id, title, workflow: 'software-dev', workflowVersion: '1.26.0',
        params: { prompt: title }, parentTaskId: parent.id });
      await store.saveView(child.id, { taskId: child.id, title, workflow: 'software-dev', stage: 'do', status: 'active',
        messages: [], actions: [], state: {}, updatedAt: 1 });
      children.push(child);
    }
    const signals: unknown[][] = [];
    const client = { workflow: { getHandle: (id: string) => ({
      describe: async () => id === parent.id ? { status: { name: 'RUNNING' }, runId: 'p' }
        : id === children[0]!.id ? { status: { name: 'TERMINATED' }, runId: 'c' } : Promise.reject(new Error('workflow not found')),
      result: async () => undefined,
      signal: async (...args: unknown[]) => { signals.push([id, ...args]); },
    }) } } as any;
    await reconcileTasks(store, client);
    expect(signals).toEqual(expect.arrayContaining(children.map((child) =>
      [parent.id, 'childSettled', { childTaskId: child.id, stage: 'failed' }])));
  } finally { await store.close(); }
});
