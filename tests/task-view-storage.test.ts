import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import type { TaskView } from '../src/domain/types.js';

let store: Store;
afterEach(async () => { (await store?.close()); store = undefined!; });
it('keeps list/status rows small and preserves complete conversations across status changes', async () => {
  store = (await Store.create());
  const project = (await store.createProject('History'));
  const task = (await store.createTask({ projectId: project.id, title: 'Large', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'work' } }));
  const view: TaskView = { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'do', status: 'active',
    actions: [], state: {}, updatedAt: 1, messages: [{ id: 'a', role: 'agent', text: 'a'.repeat(1024 * 1024), ts: 1 }] };
  (await store.saveView(task.id, view));
  const raw = (await store.db.prepare('SELECT lastView, conversation FROM tasks WHERE id=?').get(task.id)) as any;
  expect(raw.lastView.length).toBeLessThan(1000);
  expect(JSON.parse(raw.conversation).messages).toEqual(view.messages);
  expect((await store.getTask(task.id))?.lastView).toEqual(view);
  expect((await store.listTasks(project.id))[0]?.lastView).toEqual(view);
  expect((await store.listTaskSummaries(project.id))[0]?.lastView?.messages).toBeUndefined();
  (await store.saveView(task.id, { ...view, stage: 'review', status: 'waiting', updatedAt: 2 }));
  expect((await store.getTask(task.id))?.lastView?.messages).toEqual(view.messages);
  (await store.checkpointReviewInfo(task.id, { summary: 'Ready' }));
  expect((await store.getTask(task.id))?.lastView?.reviewInfo?.summary).toBe('Ready');
  expect(((await store.db.prepare('SELECT lastView FROM tasks WHERE id=?').get(task.id)) as any).lastView.length).toBeLessThan(1000);
});

it('bounds SQL pages, filters archives, and scopes relationships to the returned tasks', async () => {
  store = (await Store.create());
  const project = (await store.createProject('Pages'));
  const other = (await store.createProject('Other'));
  const ids: string[] = [];
  for (let i = 0; i < 207; i++) {
    const task = (await store.createTask({ projectId: project.id, title: `Task ${i}`, workflow: 'just-do',
      workflowVersion: '1.0.0', params: { prompt: 'work', archived: i < 3 } }));
    ids.push(task.id);
  }
  (await store.createTask({ projectId: other.id, title: 'Private', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'work' } }));
  const first = await store.taskSummaryPage(project.id, { limit: 200 });
  const second = await store.taskSummaryPage(project.id, { limit: 200, offset: 200 });
  expect(first.total).toBe(204);
  expect(first.tasks).toHaveLength(200);
  expect(second.tasks).toHaveLength(4);
  expect(new Set([...first.tasks, ...second.tasks].map(t => t.id))).toEqual(new Set(ids.slice(3)));
  expect((await store.taskSummaryPage(project.id, { includeArchived: true, offset: 200 })).tasks).toHaveLength(7);
  expect((await store.taskSummaryPage(other.id)).tasks.map(t => t.title)).toEqual(['Private']);
  await expect(store.taskSummaryPage(project.id, { limit: 201 })).rejects.toThrow('limit');
  await expect(store.taskSummaryPage(project.id, { offset: -1 })).rejects.toThrow('offset');
});

it('migrates a legacy on-disk conversation once and survives reopening', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-view-migration-'));
  const file = path.join(root, 'store.sqlite');
  try {
    store = (await Store.create(file));
    const project = (await store.createProject('Legacy'));
    const task = (await store.createTask({ projectId: project.id, title: 'Legacy', workflow: 'just-do',
      workflowVersion: '1.0.0', params: { prompt: 'fixture' } }));
    const view = { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'review', status: 'waiting',
      messages: [{ id: 'm', text: 'preserve me', role: 'agent', ts: 1 }], actions: [], state: {}, updatedAt: 1 };
    (await store.db.prepare('UPDATE tasks SET lastView=?, conversation=NULL WHERE id=?').run(JSON.stringify(view), task.id));
    (await store.close());
    store = (await Store.create(file));
    expect((await store.getTask(task.id))?.lastView).toEqual(view);
    expect((await store.taskMetadata(task.id))?.lastView?.messages).toBeUndefined();
    (await store.close());
    store = (await Store.create(file));
    expect((await store.getTask(task.id))?.lastView).toEqual(view);
  } finally { (await store.close()); store = undefined!; fs.rmSync(root, { recursive: true, force: true }); }
});
