import { describe, it, expect, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { Store } from '../src/store/db.js';

describe('Store', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(':memory:');
  });

  it('migrates away legacy turn caps on role-default profiles (task 1a)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-mig-'));
    const dbPath = path.join(dir, 'karmax.db');
    // an older build persisted a role default with maxTurns
    const s1 = new Store(dbPath);
    s1.upsertProfile({ id: 'do-default', name: 'Do', role: 'do', provider: 'claude', capabilities: [], maxTurns: 24 } as any);
    s1.upsertProfile({ id: 'custom-big', name: 'Big', role: 'do', provider: 'claude', capabilities: [], maxTurns: 99 } as any);
    // reopening runs migrateData
    const s2 = new Store(dbPath);
    expect(s2.getProfile('do-default')!.maxTurns).toBeUndefined(); // legacy cap stripped
    expect(s2.getProfile('custom-big')!.maxTurns).toBe(99); // non-default profiles untouched
    fs.rmSync(dir, { recursive: true, force: true });
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

  it('groups alternate attempts behind one principal list row and re-elects on cancellation', () => {
    const p = store.createProject('Acme');
    const first = store.createTask({ projectId: p.id, title: 'Intent', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'first' }, confirmer: { mode: 'agent' } });
    const second = store.createTask({ projectId: p.id, listId: first.listId, title: first.title, workflow: first.workflow, workflowVersion: first.workflowVersion, params: { prompt: 'second', draft: true }, intentId: first.intentId });
    expect(second.attemptNumber).toBe(2);
    expect(second.num).toBeUndefined();
    expect(store.listPrincipalTasks(p.id).map((t) => t.id)).toEqual([first.id]);
    const cancelled = { taskId: first.id, title: first.title, workflow: first.workflow, stage: 'cancelled' as const, status: 'cancelled' as const, messages: [], actions: [], state: {}, updatedAt: 1 };
    store.saveView(first.id, cancelled);
    expect(store.attemptGroup(first.id)!.principalAttemptId).toBe(second.id);
    expect(store.listPrincipalTasks(p.id).map((t) => t.id)).toEqual([second.id]);
    expect(store.listPrincipalTasks(p.id)[0]!.num).toBe(first.num); // logical # is stable
    expect(store.getTaskByNum(p.id, first.num!)!.id).toBe(second.id); // permalink follows principal
    expect(store.attemptGroup(second.id)!.confirmer).toEqual({ mode: 'agent' });
    expect(() => store.setIntentConfirmer(first.intentId!, 'confirm', { mode: 'agent' })).not.toThrow();
    expect(() => store.setIntentConfirmer(first.intentId!, 'confirm', { mode: 'human' })).toThrow(/freezes/);
  });

  it('grants exactly one Merge commitment and makes the winner principal', () => {
    const p = store.createProject('Acme');
    const first = store.createTask({ projectId: p.id, title: 'Intent', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'first' } });
    const second = store.createTask({ projectId: p.id, title: 'Intent', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'second' }, intentId: first.intentId });
    expect(store.claimAttempt(second.id)).toEqual({ accepted: true, cancel: [first.id] });
    expect(store.claimAttempt(first.id)).toEqual({ accepted: false, cancel: [first.id] });
    const group = store.attemptGroup(first.id)!;
    expect(group.committedAttemptId).toBe(second.id);
    expect(group.principalAttemptId).toBe(second.id);
  });

  it('numbers queued tasks per project, each starting at #1 (task 10.6)', () => {
    const a = store.createProject('Acme');
    const b = store.createProject('Beta');
    const draft = store.createTask({ projectId: a.id, title: 'A-draft', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'later', draft: true } });
    const a1 = store.createTask({ projectId: a.id, title: 'A-one', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'x' } });
    const b1 = store.createTask({ projectId: b.id, title: 'B-one', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'y' } });
    const a2 = store.createTask({ projectId: a.id, title: 'A-two', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'z' } });
    // Never-queued drafts have no number and do not consume one. Each project's
    // queued work therefore runs its own #1, #2, … independently.
    expect(draft.num).toBeUndefined();
    expect(store.getTask(draft.id)!.num).toBeUndefined();
    expect([a1.num, a2.num]).toEqual([1, 2]);
    expect(b1.num).toBe(1);
    // resolvable by (project, number) — drives the /projects/:name/tasks/:num permalink + search
    expect(store.getTaskByNum(a.id, 1)!.id).toBe(a1.id);
    expect(store.getTaskByNum(b.id, 1)!.id).toBe(b1.id); // same #1, different project
    expect(store.getTaskByNum(a.id, 2)!.id).toBe(a2.id);
    expect(store.getTaskByNum(a.id, 99)).toBeUndefined();
    expect(store.getTask(a2.id)!.num).toBe(2);

    // The number is allocated at the queue transition and remains stable if the
    // transition is invoked again.
    store.clearDraft(draft.id);
    expect(store.getTask(draft.id)!.num).toBe(3);
    store.clearDraft(draft.id);
    expect(store.getTask(draft.id)!.num).toBe(3);
  });

  it('assigns one logical number when an alternate draft is queued first', () => {
    const p = store.createProject('Acme');
    const first = store.createTask({ projectId: p.id, title: 'Intent', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'first', draft: true } });
    const second = store.createTask({ projectId: p.id, title: 'Intent', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'second', draft: true }, intentId: first.intentId });
    expect(first.num).toBeUndefined();
    expect(second.num).toBeUndefined();

    store.clearDraft(second.id);
    expect(store.getTask(first.id)!.num).toBe(1);
    expect(store.getTask(second.id)!.num).toBe(1);
    expect(store.getTaskByNum(p.id, 1)!.id).toBe(first.id);
  });

  it('backfills per-project task numbers for rows created before the column existed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-num-'));
    const dbPath = path.join(dir, 'karmax.db');
    const s1 = new Store(dbPath);
    const a = s1.createProject('Acme');
    const b = s1.createProject('Beta');
    const a1 = s1.createTask({ projectId: a.id, title: 'A older', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: '1' } });
    const b1 = s1.createTask({ projectId: b.id, title: 'B older', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: '2' } });
    const a2 = s1.createTask({ projectId: a.id, title: 'A newer', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: '3' } });
    const draft = s1.createTask({ projectId: a.id, title: 'A draft', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'later', draft: true } });
    // simulate a pre-feature install: no num column, no per-project index
    (s1 as any).db.exec('DROP INDEX IF EXISTS idx_tasks_num_project');
    (s1 as any).db.exec('ALTER TABLE tasks DROP COLUMN num');
    s1.close();
    const s2 = new Store(dbPath); // reopen → migrate() re-numbers per project in creation order
    expect(s2.getTask(a1.id)!.num).toBe(1);
    expect(s2.getTask(a2.id)!.num).toBe(2);
    expect(s2.getTask(b1.id)!.num).toBe(1); // project B starts fresh at #1
    expect(s2.getTask(draft.id)!.num).toBeUndefined(); // never-queued legacy drafts stay unnumbered
    // brand-new tasks continue each project's sequence
    expect(s2.createTask({ projectId: a.id, title: 'A next', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: '4' } }).num).toBe(3);
    expect(s2.createTask({ projectId: b.id, title: 'B next', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: '5' } }).num).toBe(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stores and clears cosmetic human notes on a task', () => {
    const p = store.createProject('Acme');
    const t = store.createTask({
      projectId: p.id,
      title: 'X',
      workflow: 'software-dev',
      workflowVersion: '1.0.0',
      params: { prompt: 'x' },
    });
    expect(store.getTask(t.id)!.notes).toBeUndefined(); // none by default
    // notes live off params (never assembled into any prompt)
    expect(store.getTask(t.id)!.params.notes).toBeUndefined();
    store.setTaskNotes(t.id, 'remember to check the flaky test');
    expect(store.getTask(t.id)!.notes).toBe('remember to check the flaky test');
    expect(store.getTask(t.id)!.params.prompt).toBe('x'); // params untouched
    store.setTaskNotes(t.id, '');
    expect(store.getTask(t.id)!.notes).toBeUndefined(); // empty clears
  });

  it('adds the notes column to a pre-existing database on reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-notes-'));
    const dbPath = path.join(dir, 'karmax.db');
    const s1 = new Store(dbPath);
    const p = s1.createProject('Acme');
    const t = s1.createTask({
      projectId: p.id,
      title: 'X',
      workflow: 'software-dev',
      workflowVersion: '1.0.0',
      params: { prompt: 'x' },
    });
    // simulate an install that predates the column, then reopen (runs migrate)
    s1.db.exec('ALTER TABLE tasks DROP COLUMN notes');
    const s2 = new Store(dbPath);
    s2.setTaskNotes(t.id, 'jotted after upgrade');
    expect(s2.getTask(t.id)!.notes).toBe('jotted after upgrade');
    fs.rmSync(dir, { recursive: true, force: true });
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

  it('auto-archives a task when it resolves to done or cancelled', () => {
    const p = store.createProject('Acme');
    const mk = (title: string) =>
      store.createTask({ projectId: p.id, title, workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'x' } });
    const view = (id: string, status: string) => ({
      taskId: id, title: 't', workflow: 'software-dev', stage: status as any, status: status as any,
      messages: [], actions: [], state: {}, updatedAt: 1,
    });

    const done = mk('done one');
    store.saveView(done.id, view(done.id, 'active'));
    expect(store.getTask(done.id)!.params.archived).toBeFalsy(); // still running → visible
    store.saveView(done.id, view(done.id, 'done'));
    expect(store.getTask(done.id)!.params.archived).toBe(true); // resolved → archived

    const cancelled = mk('cancelled one');
    store.saveView(cancelled.id, view(cancelled.id, 'cancelled'));
    expect(store.getTask(cancelled.id)!.params.archived).toBe(true);

    const failed = mk('failed one');
    store.saveView(failed.id, view(failed.id, 'failed'));
    expect(store.getTask(failed.id)!.params.archived).toBeFalsy(); // failed stays visible
  });

  it('does not re-archive a finished task the user un-archived', () => {
    const p = store.createProject('Acme');
    const t = store.createTask({ projectId: p.id, title: 'X', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'x' } });
    const view = { taskId: t.id, title: 'X', workflow: 'software-dev', stage: 'done' as const, status: 'done' as const, messages: [], actions: [], state: {}, updatedAt: 1 };
    store.saveView(t.id, view);
    expect(store.getTask(t.id)!.params.archived).toBe(true);
    // user un-archives to keep it in view, then the view is refreshed again
    store.updateTaskParams(t.id, { ...store.getTask(t.id)!.params, archived: false });
    store.saveView(t.id, { ...view, updatedAt: 2 });
    expect(store.getTask(t.id)!.params.archived).toBe(false); // respected — no re-archive on same terminal status
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

  it('opens with a busy timeout so lock collisions wait instead of failing', () => {
    expect((store.db.prepare('PRAGMA busy_timeout').get() as any).timeout).toBe(5000);
  });

  it('a write waits out another process holding the write lock (no "database is locked")', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-lock-'));
    const dbPath = path.join(dir, 'karmax.db');
    const s = new Store(dbPath);
    const sentinel = path.join(dir, 'locked');
    // A second process takes the write lock and holds it for ~800ms — the window
    // a tsx-watch restart creates when the incoming app boots (migrations,
    // credential writes) while the outgoing one is still appending events.
    const child = spawn(process.execPath, [
      '-e',
      `const { DatabaseSync } = require('node:sqlite');
       const db = new DatabaseSync(${JSON.stringify(dbPath)});
       db.exec('BEGIN IMMEDIATE');
       require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, '1');
       setTimeout(() => { db.exec('COMMIT'); }, 800);`,
    ]);
    try {
      await expect.poll(() => fs.existsSync(sentinel), { timeout: 10_000 }).toBe(true);
      // Without busy_timeout this throws ERR_SQLITE_ERROR "database is locked".
      s.upsertProfile({ id: 'p-lock', name: 'P', role: 'do', provider: 'mock', capabilities: [] } as any);
      expect(s.getProfile('p-lock')!.name).toBe('P');
    } finally {
      child.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
