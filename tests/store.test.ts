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
