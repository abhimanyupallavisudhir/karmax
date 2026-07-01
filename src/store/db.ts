import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

// node:sqlite is a newer builtin that bundlers (vite/vitest) cannot statically
// resolve, so load it through createRequire at runtime.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import {
  Project,
  ProjectConfig,
  TaskList,
  TaskRecord,
  TaskParams,
  AgentProfile,
  TaskView,
  KarmaxEvent,
} from '../domain/types.js';
import { newId } from '../util/id.js';

/**
 * The metadata index. Temporal holds the authoritative live workflow state;
 * this store is the searchable index of projects/lists/tasks/profiles plus an
 * append-only event log that powers the live UI stream.
 */
export class Store {
  readonly db: DatabaseSyncType;

  constructor(dbPath = ':memory:') {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
    this.migrateData();
  }

  /** One-time data migrations (idempotent; run every boot). */
  private migrateData() {
    // Turn caps are now optional (unlimited by default). Strip the legacy caps
    // that older builds seeded onto the role-default profiles so existing installs
    // match the new "no limit unless you set one" behavior.
    const rows = this.db.prepare("SELECT id, json FROM profiles WHERE id LIKE '%-default'").all() as any[];
    for (const r of rows) {
      const p = JSON.parse(r.json);
      if (p.maxTurns !== undefined) {
        delete p.maxTurns;
        this.db.prepare('UPDATE profiles SET json = ? WHERE id = ?').run(JSON.stringify(p), r.id);
      }
    }
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt INTEGER NOT NULL, config TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_lists (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL,
        createdAt INTEGER NOT NULL, ord INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, listId TEXT NOT NULL,
        title TEXT NOT NULL, workflow TEXT NOT NULL, workflowVersion TEXT NOT NULL,
        params TEXT NOT NULL, createdAt INTEGER NOT NULL, ord INTEGER NOT NULL,
        parentTaskId TEXT, lastView TEXT
      );
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY, json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL,
        type TEXT NOT NULL, ts INTEGER NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (
        k TEXT PRIMARY KEY, v TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        scopeKey TEXT NOT NULL, workflow TEXT NOT NULL, json TEXT NOT NULL,
        PRIMARY KEY (scopeKey, workflow)
      );
      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, scope TEXT NOT NULL,
        scopeId TEXT, label TEXT NOT NULL, cap INTEGER NOT NULL,
        available INTEGER NOT NULL, merchantLock TEXT, createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(projectId);
      CREATE INDEX IF NOT EXISTS idx_events_task ON events(taskId, seq);
    `);
  }

  // ─── Projects ──────────────────────────────────────────────────────────────

  createProject(name: string, config: ProjectConfig = {}): Project {
    const p: Project = { id: newId('proj'), name, createdAt: Date.now(), config };
    this.db
      .prepare('INSERT INTO projects (id, name, createdAt, config) VALUES (?, ?, ?, ?)')
      .run(p.id, p.name, p.createdAt, JSON.stringify(p.config));
    // every project gets a default task list
    this.createList(p.id, 'Tasks');
    return p;
  }

  getProject(id: string): Project | undefined {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;
    return r ? rowToProject(r) : undefined;
  }

  listProjects(): Project[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY createdAt').all() as any[]).map(
      rowToProject,
    );
  }

  updateProjectConfig(id: string, config: ProjectConfig): Project {
    const existing = this.getProject(id);
    if (!existing) throw new Error(`no project ${id}`);
    const merged = { ...existing.config, ...config };
    this.db.prepare('UPDATE projects SET config = ? WHERE id = ?').run(JSON.stringify(merged), id);
    return { ...existing, config: merged };
  }

  deleteProject(id: string) {
    this.db.prepare('DELETE FROM tasks WHERE projectId = ?').run(id);
    this.db.prepare('DELETE FROM task_lists WHERE projectId = ?').run(id);
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  // ─── Task lists ──────────────────────────────────────────────────────────────

  createList(projectId: string, name: string): TaskList {
    const ord =
      (this.db
        .prepare('SELECT COALESCE(MAX(ord), -1) AS m FROM task_lists WHERE projectId = ?')
        .get(projectId) as any).m + 1;
    const l: TaskList = { id: newId('list'), projectId, name, createdAt: Date.now(), order: ord };
    this.db
      .prepare('INSERT INTO task_lists (id, projectId, name, createdAt, ord) VALUES (?, ?, ?, ?, ?)')
      .run(l.id, l.projectId, l.name, l.createdAt, l.order);
    return l;
  }

  listLists(projectId: string): TaskList[] {
    return (
      this.db
        .prepare('SELECT * FROM task_lists WHERE projectId = ? ORDER BY ord')
        .all(projectId) as any[]
    ).map(rowToList);
  }

  // ─── Tasks ──────────────────────────────────────────────────────────────────

  createTask(input: {
    projectId: string;
    listId?: string;
    title: string;
    workflow: string;
    workflowVersion: string;
    params: TaskParams;
    parentTaskId?: string;
  }): TaskRecord {
    const listId =
      input.listId ?? this.listLists(input.projectId)[0]?.id ?? this.createList(input.projectId, 'Tasks').id;
    const ord =
      (this.db
        .prepare('SELECT COALESCE(MAX(ord), -1) AS m FROM tasks WHERE listId = ?')
        .get(listId) as any).m + 1;
    const t: TaskRecord = {
      id: newId('task'),
      projectId: input.projectId,
      listId,
      title: input.title,
      workflow: input.workflow,
      workflowVersion: input.workflowVersion,
      params: input.params,
      createdAt: Date.now(),
      order: ord,
      parentTaskId: input.parentTaskId,
    };
    this.db
      .prepare(
        `INSERT INTO tasks (id, projectId, listId, title, workflow, workflowVersion, params, createdAt, ord, parentTaskId, lastView)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.id,
        t.projectId,
        t.listId,
        t.title,
        t.workflow,
        t.workflowVersion,
        JSON.stringify(t.params),
        t.createdAt,
        t.order,
        t.parentTaskId ?? null,
        null,
      );
    return t;
  }

  getTask(id: string): TaskRecord | undefined {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
    return r ? rowToTask(r) : undefined;
  }

  listTasks(projectId: string): TaskRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM tasks WHERE projectId = ? ORDER BY ord, createdAt')
        .all(projectId) as any[]
    ).map(rowToTask);
  }

  childTasks(parentTaskId: string): TaskRecord[] {
    return (
      this.db.prepare('SELECT * FROM tasks WHERE parentTaskId = ? ORDER BY createdAt').all(parentTaskId) as any[]
    ).map(rowToTask);
  }

  saveView(taskId: string, view: TaskView) {
    this.db.prepare('UPDATE tasks SET lastView = ? WHERE id = ?').run(JSON.stringify(view), taskId);
  }

  reorderTask(taskId: string, ord: number) {
    this.db.prepare('UPDATE tasks SET ord = ? WHERE id = ?').run(ord, taskId);
  }

  updateTaskParams(taskId: string, params: TaskParams) {
    this.db.prepare('UPDATE tasks SET params = ? WHERE id = ?').run(JSON.stringify(params), taskId);
  }

  /** Mark a draft task as queued (clear its draft flag). */
  clearDraft(taskId: string) {
    const t = this.getTask(taskId);
    if (!t) return;
    this.updateTaskParams(taskId, { ...t.params, draft: false });
  }

  /** Hard-delete a task row + its events (used for drafts, which never ran). */
  deleteTask(taskId: string) {
    this.db.prepare('DELETE FROM events WHERE taskId = ?').run(taskId);
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  }

  // ─── Profiles ──────────────────────────────────────────────────────────────

  upsertProfile(p: AgentProfile) {
    this.db
      .prepare('INSERT INTO profiles (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json')
      .run(p.id, JSON.stringify(p));
  }

  getProfile(id: string): AgentProfile | undefined {
    const r = this.db.prepare('SELECT json FROM profiles WHERE id = ?').get(id) as any;
    return r ? (JSON.parse(r.json) as AgentProfile) : undefined;
  }

  listProfiles(): AgentProfile[] {
    return (this.db.prepare('SELECT json FROM profiles').all() as any[]).map((r) => JSON.parse(r.json));
  }

  deleteProfile(id: string) {
    this.db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
  }

  // ─── Event log (live stream) ─────────────────────────────────────────────────

  appendEvent(ev: KarmaxEvent): number {
    const info = this.db
      .prepare('INSERT INTO events (taskId, type, ts, payload) VALUES (?, ?, ?, ?)')
      .run(ev.taskId, ev.type, ev.ts, JSON.stringify(ev.payload));
    return Number(info.lastInsertRowid);
  }

  eventsSince(taskId: string, seq: number): (KarmaxEvent & { seq: number })[] {
    return (
      this.db
        .prepare('SELECT * FROM events WHERE taskId = ? AND seq > ? ORDER BY seq')
        .all(taskId, seq) as any[]
    ).map((r) => ({ seq: r.seq, type: r.type, taskId: r.taskId, ts: r.ts, payload: JSON.parse(r.payload) }));
  }

  allEventsSince(seq: number): (KarmaxEvent & { seq: number })[] {
    return (this.db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq').all(seq) as any[]).map(
      (r) => ({ seq: r.seq, type: r.type, taskId: r.taskId, ts: r.ts, payload: JSON.parse(r.payload) }),
    );
  }

  // ─── Settings (per-scope × workflow parameter values; SPEC §10.4) ────────────

  /** scopeKey = 'global' or a projectId. Returns the stored field-value map (or undefined). */
  getSettings(scopeKey: string, workflow: string): Record<string, unknown> | undefined {
    const r = this.db.prepare('SELECT json FROM settings WHERE scopeKey = ? AND workflow = ?').get(scopeKey, workflow) as any;
    return r ? (JSON.parse(r.json) as Record<string, unknown>) : undefined;
  }

  setSettings(scopeKey: string, workflow: string, values: Record<string, unknown>) {
    this.db
      .prepare('INSERT INTO settings (scopeKey, workflow, json) VALUES (?, ?, ?) ON CONFLICT(scopeKey, workflow) DO UPDATE SET json = excluded.json')
      .run(scopeKey, workflow, JSON.stringify(values));
  }

  // ─── Cards (payment resources; SPEC §7.6) ────────────────────────────────────

  createCard(c: { id: string; provider: string; scope: 'project' | 'global'; scopeId?: string; label: string; cap: number; available: number; merchantLock?: string[]; createdAt: number }) {
    this.db
      .prepare('INSERT INTO cards (id, provider, scope, scopeId, label, cap, available, merchantLock, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(c.id, c.provider, c.scope, c.scopeId ?? null, c.label, c.cap, c.available, c.merchantLock ? JSON.stringify(c.merchantLock) : null, c.createdAt);
  }
  getCard(id: string): any {
    const r = this.db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as any;
    return r ? cardRow(r) : undefined;
  }
  /** Cards visible to a project: its own project-scope cards plus all global cards. */
  listCards(projectId?: string): any[] {
    const rows = projectId
      ? (this.db.prepare("SELECT * FROM cards WHERE scope='global' OR (scope='project' AND scopeId=?) ORDER BY createdAt").all(projectId) as any[])
      : (this.db.prepare('SELECT * FROM cards ORDER BY createdAt').all() as any[]);
    return rows.map(cardRow);
  }
  updateCard(id: string, patch: { available?: number; cap?: number }) {
    const c = this.getCard(id);
    if (!c) return;
    this.db.prepare('UPDATE cards SET available = ?, cap = ? WHERE id = ?').run(patch.available ?? c.available, patch.cap ?? c.cap, id);
  }

  // ─── KV (misc small state) ───────────────────────────────────────────────────

  kvGet(k: string): string | undefined {
    const r = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as any;
    return r?.v;
  }

  kvSet(k: string, v: string) {
    this.db
      .prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(k, v);
  }

  close() {
    this.db.close();
  }
}

function cardRow(r: any) {
  return {
    id: r.id,
    provider: r.provider,
    scope: r.scope,
    scopeId: r.scopeId ?? undefined,
    label: r.label,
    cap: r.cap,
    available: r.available,
    merchantLock: r.merchantLock ? JSON.parse(r.merchantLock) : undefined,
    createdAt: r.createdAt,
  };
}

function rowToProject(r: any): Project {
  return { id: r.id, name: r.name, createdAt: r.createdAt, config: JSON.parse(r.config) };
}
function rowToList(r: any): TaskList {
  return { id: r.id, projectId: r.projectId, name: r.name, createdAt: r.createdAt, order: r.ord };
}
function rowToTask(r: any): TaskRecord {
  return {
    id: r.id,
    projectId: r.projectId,
    listId: r.listId,
    title: r.title,
    workflow: r.workflow,
    workflowVersion: r.workflowVersion,
    params: JSON.parse(r.params),
    createdAt: r.createdAt,
    order: r.ord,
    parentTaskId: r.parentTaskId ?? undefined,
    lastView: r.lastView ? JSON.parse(r.lastView) : undefined,
  };
}
