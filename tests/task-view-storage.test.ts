import { afterEach, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import type { TaskView } from '../src/domain/types.js';

let store: Store;
afterEach(() => store?.close());
it('keeps list/status rows small and preserves complete conversations across status changes', () => {
  store = new Store();
  const project = store.createProject('History');
  const task = store.createTask({ projectId: project.id, title: 'Large', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'work' } });
  const view: TaskView = { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'do', status: 'active',
    actions: [], state: {}, updatedAt: 1, messages: [{ id: 'a', role: 'agent', text: 'a'.repeat(1024 * 1024), ts: 1 }] };
  store.saveView(task.id, view);
  const raw = store.db.prepare('SELECT lastView, conversation FROM tasks WHERE id=?').get(task.id) as any;
  expect(raw.lastView.length).toBeLessThan(1000);
  expect(JSON.parse(raw.conversation).messages).toEqual(view.messages);
  expect(store.getTask(task.id)?.lastView).toEqual(view);
  expect(store.listTasks(project.id)[0]?.lastView).toEqual(view);
  expect(store.listTaskSummaries(project.id)[0]?.lastView?.messages).toBeUndefined();
  store.saveView(task.id, { ...view, stage: 'review', status: 'waiting', updatedAt: 2 });
  expect(store.getTask(task.id)?.lastView?.messages).toEqual(view.messages);
  store.checkpointReviewInfo(task.id, { summary: 'Ready' });
  expect(store.getTask(task.id)?.lastView?.reviewInfo?.summary).toBe('Ready');
  expect((store.db.prepare('SELECT lastView FROM tasks WHERE id=?').get(task.id) as any).lastView.length).toBeLessThan(1000);
});
