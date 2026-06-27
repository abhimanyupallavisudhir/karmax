import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '../src/store/db.js';

describe('Store', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(':memory:');
  });

  it('creates a project with a default task list', () => {
    const p = store.createProject('Acme', { defaultBase: 'main' });
    expect(p.id).toMatch(/^proj_/);
    const lists = store.listLists(p.id);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.name).toBe('Tasks');
    expect(store.getProject(p.id)!.config.defaultBase).toBe('main');
  });

  it('creates and lists tasks in order', () => {
    const p = store.createProject('Acme');
    const t1 = store.createTask({
      projectId: p.id,
      title: 'First',
      workflow: 'software-dev',
      workflowVersion: '1.0.0',
      params: { prompt: 'do a thing' },
    });
    const t2 = store.createTask({
      projectId: p.id,
      title: 'Second',
      workflow: 'just-do',
      workflowVersion: '1.0.0',
      params: { prompt: 'do another' },
    });
    const tasks = store.listTasks(p.id);
    expect(tasks.map((t) => t.id)).toEqual([t1.id, t2.id]);
    expect(tasks[0]!.params.prompt).toBe('do a thing');
  });

  it('tracks parent/child relationships', () => {
    const p = store.createProject('Acme');
    const parent = store.createTask({
      projectId: p.id,
      title: 'Parent',
      workflow: 'software-dev',
      workflowVersion: '1.0.0',
      params: { prompt: 'parent' },
    });
    const child = store.createTask({
      projectId: p.id,
      title: 'Child',
      workflow: 'software-dev',
      workflowVersion: '1.0.0',
      params: { prompt: 'child' },
      parentTaskId: parent.id,
    });
    expect(store.childTasks(parent.id).map((t) => t.id)).toEqual([child.id]);
  });

  it('persists and replays a view snapshot', () => {
    const p = store.createProject('Acme');
    const t = store.createTask({
      projectId: p.id,
      title: 'X',
      workflow: 'software-dev',
      workflowVersion: '1.0.0',
      params: { prompt: 'x' },
    });
    store.saveView(t.id, {
      taskId: t.id,
      title: 'X',
      workflow: 'software-dev',
      stage: 'done',
      status: 'done',
      messages: [],
      actions: [],
      state: { ok: true },
      updatedAt: Date.now(),
    });
    expect(store.getTask(t.id)!.lastView!.stage).toBe('done');
  });

  it('appends and reads events incrementally', () => {
    const p = store.createProject('Acme');
    const t = store.createTask({
      projectId: p.id,
      title: 'X',
      workflow: 'software-dev',
      workflowVersion: '1.0.0',
      params: { prompt: 'x' },
    });
    store.appendEvent({ type: 'do.output', taskId: t.id, ts: 1, payload: { text: 'a' } });
    const s2 = store.appendEvent({ type: 'do.output', taskId: t.id, ts: 2, payload: { text: 'b' } });
    expect(store.eventsSince(t.id, 0)).toHaveLength(2);
    expect(store.eventsSince(t.id, s2 - 1).map((e) => e.payload.text)).toEqual(['b']);
  });

  it('round-trips profiles', () => {
    store.upsertProfile({
      id: 'do-default',
      name: 'Do',
      provider: 'mock',
      role: 'do',
      capabilities: ['create-sub-task'],
    });
    expect(store.getProfile('do-default')!.provider).toBe('mock');
    store.upsertProfile({
      id: 'do-default',
      name: 'Do',
      provider: 'claude',
      role: 'do',
      capabilities: [],
    });
    expect(store.getProfile('do-default')!.provider).toBe('claude');
    expect(store.listProfiles()).toHaveLength(1);
  });
});
