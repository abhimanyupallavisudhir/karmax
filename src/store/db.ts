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
  Tag,
  SavedView,
  TaskQuery,
} from '../domain/types.js';
import { newId } from '../util/id.js';

/**
 * Terminal statuses that auto-archive a task when it first reaches one (see
 * `Store.saveView`). Only fully-resolved outcomes — a failed task stays visible
 * because it usually needs attention.
 */
const AUTO_ARCHIVE_STATUS = new Set<string>(['done', 'cancelled']);

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
    // busy_timeout first: waiting (up to 5s) on a locked database beats failing
    // the caller outright. tsx-watch restarts overlap the outgoing and incoming
    // app for a few seconds, and the newcomer's boot writes (migrations,
    // credential registration) must not instantly kill a long agent turn's
    // event append with "database is locked" (that error cost a merge-agent
    // turn mid-conflict-resolution — the 05f9802 postmortem).
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
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
      CREATE TABLE IF NOT EXISTS tags (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL,
        parentId TEXT, color TEXT, kind TEXT, createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_tags (
        taskId TEXT NOT NULL, tagId TEXT NOT NULL, PRIMARY KEY (taskId, tagId)
      );
      CREATE TABLE IF NOT EXISTS saved_views (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL,
        query TEXT NOT NULL, icon TEXT, ord INTEGER NOT NULL, createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(projectId);
      CREATE INDEX IF NOT EXISTS idx_events_task ON events(taskId, seq);
      CREATE INDEX IF NOT EXISTS idx_tags_project ON tags(projectId);
      CREATE INDEX IF NOT EXISTS idx_task_tags_tag ON task_tags(tagId);
      CREATE INDEX IF NOT EXISTS idx_saved_views_project ON saved_views(projectId);
    `);
    // Free-form human notes, added after the initial schema. Guarded so existing
    // installs pick it up without a re-create.
    const cols = this.db.prepare('PRAGMA table_info(tasks)').all() as any[];
    if (!cols.some((c) => c.name === 'notes')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN notes TEXT');
    }
    // Simple human-facing sequential id, numbered PER PROJECT (SPEC §10.6): each
    // project's tasks run #1, #2, … A separate integer alongside the opaque `id`
    // (which stays the Temporal workflowId and must never change). The per-project
    // unique index doubles as the migration marker: if it isn't present yet, we
    // (re)assign numbers per project in creation order — this both backfills fresh
    // installs and re-numbers any install that briefly had the earlier global scheme.
    if (!cols.some((c) => c.name === 'num')) this.db.exec('ALTER TABLE tasks ADD COLUMN num INTEGER');
    const hasPerProjectIdx = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_tasks_num_project'")
      .get();
    if (!hasPerProjectIdx) {
      this.db.exec('DROP INDEX IF EXISTS idx_tasks_num'); // retire the old global-unique index
      const projects = this.db.prepare('SELECT DISTINCT projectId FROM tasks').all() as any[];
      const upd = this.db.prepare('UPDATE tasks SET num = ? WHERE id = ?');
      for (const { projectId } of projects) {
        // Creation order within the project (createdAt, rowid as a stable tiebreak).
        const rows = this.db
          .prepare('SELECT id FROM tasks WHERE projectId = ? ORDER BY createdAt, rowid')
          .all(projectId) as any[];
        let n = 0;
        for (const r of rows) upd.run(++n, r.id);
      }
      this.db.exec('CREATE UNIQUE INDEX idx_tasks_num_project ON tasks(projectId, num)');
    }
  }

  /** Next task number within a project: MAX(num)+1 scoped to that project. node:sqlite
   *  is synchronous and single-threaded, so read-then-write within one createTask
   *  call cannot race. */
  private nextTaskNum(projectId: string): number {
    return (
      (this.db.prepare('SELECT COALESCE(MAX(num), 0) AS m FROM tasks WHERE projectId = ?').get(projectId) as any)
        .m as number
    ) + 1;
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
    // Clear the tag join rows for this project's tasks before the tasks vanish.
    this.db
      .prepare('DELETE FROM task_tags WHERE taskId IN (SELECT id FROM tasks WHERE projectId = ?)')
      .run(id);
    this.db.prepare('DELETE FROM tasks WHERE projectId = ?').run(id);
    this.db.prepare('DELETE FROM task_lists WHERE projectId = ?').run(id);
    this.db.prepare('DELETE FROM tags WHERE projectId = ?').run(id);
    this.db.prepare('DELETE FROM saved_views WHERE projectId = ?').run(id);
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
      num: this.nextTaskNum(input.projectId),
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
        `INSERT INTO tasks (id, num, projectId, listId, title, workflow, workflowVersion, params, createdAt, ord, parentTaskId, lastView, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.id,
        t.num ?? null,
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
        null,
      );
    return t;
  }

  getTask(id: string): TaskRecord | undefined {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
    if (!r) return undefined;
    const t = rowToTask(r);
    const tags = this.tagsFor(id);
    if (tags.length) t.tags = tags;
    return t;
  }

  /** Resolve a task by its per-project sequential number (SPEC §10.6). */
  getTaskByNum(projectId: string, num: number): TaskRecord | undefined {
    const r = this.db.prepare('SELECT * FROM tasks WHERE projectId = ? AND num = ?').get(projectId, num) as any;
    return r ? this.getTask(r.id) : undefined;
  }

  listTasks(projectId: string): TaskRecord[] {
    const tasks = (
      this.db
        .prepare('SELECT * FROM tasks WHERE projectId = ? ORDER BY ord, createdAt')
        .all(projectId) as any[]
    ).map(rowToTask);
    return this.attachTags(projectId, tasks);
  }

  childTasks(parentTaskId: string): TaskRecord[] {
    const tasks = (
      this.db.prepare('SELECT * FROM tasks WHERE parentTaskId = ? ORDER BY createdAt').all(parentTaskId) as any[]
    ).map(rowToTask);
    for (const t of tasks) {
      const tags = this.tagsFor(t.id);
      if (tags.length) t.tags = tags;
    }
    return tasks;
  }

  /** Hydrate `tags` onto a batch of a project's tasks with a single join query (no N+1). */
  private attachTags(projectId: string, tasks: TaskRecord[]): TaskRecord[] {
    if (!tasks.length) return tasks;
    const rows = this.db
      .prepare('SELECT tt.taskId AS taskId, tt.tagId AS tagId FROM task_tags tt JOIN tasks t ON t.id = tt.taskId WHERE t.projectId = ?')
      .all(projectId) as any[];
    if (!rows.length) return tasks;
    const byTask = new Map<string, string[]>();
    for (const r of rows) (byTask.get(r.taskId) ?? byTask.set(r.taskId, []).get(r.taskId)!).push(r.tagId);
    for (const t of tasks) { const ids = byTask.get(t.id); if (ids?.length) t.tags = ids; }
    return tasks;
  }

  saveView(taskId: string, view: TaskView) {
    // Auto-archive on resolution: the moment a task reaches a terminal, no-further-
    // action status (done or cancelled) it drops out of the default active list
    // without a manual archive step — the same effect the /archive endpoint has, but
    // automatic. Failed tasks are deliberately left visible (they usually need a look).
    // Fire only on the *transition* into that status (previous snapshot wasn't
    // already done/cancelled) so a later view re-save can't override a user who
    // deliberately un-archived a finished task.
    const prev = this.getTask(taskId);
    this.db.prepare('UPDATE tasks SET lastView = ? WHERE id = ?').run(JSON.stringify(view), taskId);
    const resolvedNow =
      AUTO_ARCHIVE_STATUS.has(view.status) && !AUTO_ARCHIVE_STATUS.has(prev?.lastView?.status ?? '');
    if (prev && resolvedNow && !prev.params?.archived) {
      this.updateTaskParams(taskId, { ...prev.params, archived: true });
    }
  }

  reorderTask(taskId: string, ord: number) {
    this.db.prepare('UPDATE tasks SET ord = ? WHERE id = ?').run(ord, taskId);
  }

  updateTaskParams(taskId: string, params: TaskParams) {
    this.db.prepare('UPDATE tasks SET params = ? WHERE id = ?').run(JSON.stringify(params), taskId);
  }

  /** Set the human notes on a task (cosmetic, UI-only; empty string clears them). */
  setTaskNotes(taskId: string, notes: string) {
    this.db.prepare('UPDATE tasks SET notes = ? WHERE id = ?').run(notes === '' ? null : notes, taskId);
  }

  /**
   * Set the organizational priority (0–4) on a task's stored params. Purely for
   * search/sort/grouping — never sent to any agent, so it's editable at any point in
   * the lifecycle (unlike workflow params, which freeze at queue time). Writes the
   * record directly; the running workflow neither reads nor cares about it.
   */
  setTaskPriority(taskId: string, priority: number) {
    const t = this.getTask(taskId);
    if (!t) return;
    const p = Math.max(0, Math.min(4, Math.round(priority)));
    this.updateTaskParams(taskId, { ...t.params, priority: p });
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
    this.db.prepare('DELETE FROM task_tags WHERE taskId = ?').run(taskId);
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  }

  // ─── Tags (task organization — labels + topics, hierarchical) ────────────────

  listTags(projectId: string): Tag[] {
    return (
      this.db.prepare('SELECT * FROM tags WHERE projectId = ? ORDER BY name').all(projectId) as any[]
    ).map(rowToTag);
  }

  getTag(id: string): Tag | undefined {
    const r = this.db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as any;
    return r ? rowToTag(r) : undefined;
  }

  createTag(input: { projectId: string; name: string; parentId?: string; color?: string; kind?: 'type' | 'topic' }): Tag {
    const raw = input.name.trim();
    if (!raw) throw new Error('tag name required');
    // A slash-separated name is a hierarchy path (`frontend/web`): find-or-create each
    // level under the previous, so the UI never needs a parent picker — the user just
    // types the path. `color`/`kind` apply to the leaf; ancestors created bare.
    const segments = raw.split('/').map((s) => s.trim()).filter(Boolean);
    if (segments.length > 1) {
      let parentId = input.parentId;
      let leaf: Tag | undefined;
      for (let i = 0; i < segments.length; i++) {
        const isLeaf = i === segments.length - 1;
        leaf = this.createOneTag({
          projectId: input.projectId,
          name: segments[i]!,
          parentId,
          ...(isLeaf ? { color: input.color, kind: input.kind } : {}),
        });
        parentId = leaf.id;
      }
      return leaf!;
    }
    return this.createOneTag({ ...input, name: raw });
  }

  /** Create-or-reuse a single tag under an explicit parent (no path parsing). */
  private createOneTag(input: { projectId: string; name: string; parentId?: string; color?: string; kind?: 'type' | 'topic' }): Tag {
    const name = input.name.trim();
    if (!name) throw new Error('tag name required');
    // Reuse an existing sibling with the same (case-insensitive) name rather than
    // minting a duplicate — tag catalogues should stay small and canonical.
    const existing = this.db
      .prepare("SELECT * FROM tags WHERE projectId = ? AND lower(name) = lower(?) AND IFNULL(parentId, '') = IFNULL(?, '')")
      .get(input.projectId, name, input.parentId ?? null) as any;
    if (existing) return rowToTag(existing);
    const t: Tag = {
      id: newId('tag'),
      projectId: input.projectId,
      name,
      parentId: input.parentId,
      color: input.color,
      kind: input.kind,
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO tags (id, projectId, name, parentId, color, kind, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(t.id, t.projectId, t.name, t.parentId ?? null, t.color ?? null, t.kind ?? null, t.createdAt);
    return t;
  }

  updateTag(id: string, patch: { name?: string; parentId?: string | null; color?: string | null; kind?: 'type' | 'topic' | null }): Tag | undefined {
    const cur = this.getTag(id);
    if (!cur) return undefined;
    // Guard against a cycle: a tag can't be reparented under itself or a descendant.
    if (patch.parentId) {
      const all = this.listTags(cur.projectId);
      const byId = new Map(all.map((t) => [t.id, t]));
      let p: string | undefined = patch.parentId;
      const seen = new Set<string>();
      while (p) {
        if (p === id || seen.has(p)) throw new Error('tag cannot be its own ancestor');
        seen.add(p);
        p = byId.get(p)?.parentId;
      }
    }
    const next: Tag = {
      ...cur,
      name: patch.name?.trim() || cur.name,
      parentId: patch.parentId === null ? undefined : patch.parentId ?? cur.parentId,
      color: patch.color === null ? undefined : patch.color ?? cur.color,
      kind: patch.kind === null ? undefined : patch.kind ?? cur.kind,
    };
    this.db
      .prepare('UPDATE tags SET name = ?, parentId = ?, color = ?, kind = ? WHERE id = ?')
      .run(next.name, next.parentId ?? null, next.color ?? null, next.kind ?? null, id);
    return next;
  }

  /** Delete a tag: promote its children to its own parent, and drop its task assignments. */
  deleteTag(id: string) {
    const cur = this.getTag(id);
    if (!cur) return;
    this.db.prepare('UPDATE tags SET parentId = ? WHERE parentId = ?').run(cur.parentId ?? null, id);
    this.db.prepare('DELETE FROM task_tags WHERE tagId = ?').run(id);
    this.db.prepare('DELETE FROM tags WHERE id = ?').run(id);
  }

  tagsFor(taskId: string): string[] {
    return (this.db.prepare('SELECT tagId FROM task_tags WHERE taskId = ?').all(taskId) as any[]).map((r) => r.tagId);
  }

  /** Replace the full tag set on a task (ignores unknown/foreign tag ids). */
  setTaskTags(taskId: string, tagIds: string[]) {
    const t = this.getTask(taskId);
    if (!t) return;
    const valid = new Set(this.listTags(t.projectId).map((x) => x.id));
    this.db.prepare('DELETE FROM task_tags WHERE taskId = ?').run(taskId);
    const ins = this.db.prepare('INSERT OR IGNORE INTO task_tags (taskId, tagId) VALUES (?, ?)');
    for (const id of new Set(tagIds)) if (valid.has(id)) ins.run(taskId, id);
  }

  addTaskTag(taskId: string, tagId: string) {
    const cur = new Set(this.tagsFor(taskId));
    cur.add(tagId);
    this.setTaskTags(taskId, [...cur]);
  }

  removeTaskTag(taskId: string, tagId: string) {
    this.db.prepare('DELETE FROM task_tags WHERE taskId = ? AND tagId = ?').run(taskId, tagId);
  }

  // ─── Saved views (a view is a saved query — PLAN-search-views) ───────────────

  listViews(projectId: string): SavedView[] {
    return (
      this.db.prepare('SELECT * FROM saved_views WHERE projectId = ? ORDER BY ord, createdAt').all(projectId) as any[]
    ).map(rowToView);
  }

  getView(id: string): SavedView | undefined {
    const r = this.db.prepare('SELECT * FROM saved_views WHERE id = ?').get(id) as any;
    return r ? rowToView(r) : undefined;
  }

  createView(input: { projectId: string; name: string; query: TaskQuery; icon?: string }): SavedView {
    const ord =
      (this.db.prepare('SELECT COALESCE(MAX(ord), -1) AS m FROM saved_views WHERE projectId = ?').get(input.projectId) as any).m + 1;
    const v: SavedView = {
      id: newId('view'),
      projectId: input.projectId,
      name: input.name.trim() || 'Untitled view',
      query: input.query ?? {},
      icon: input.icon,
      order: ord,
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO saved_views (id, projectId, name, query, icon, ord, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(v.id, v.projectId, v.name, JSON.stringify(v.query), v.icon ?? null, v.order, v.createdAt);
    return v;
  }

  updateView(id: string, patch: { name?: string; query?: TaskQuery; icon?: string | null }): SavedView | undefined {
    const cur = this.getView(id);
    if (!cur) return undefined;
    const next: SavedView = {
      ...cur,
      name: patch.name?.trim() || cur.name,
      query: patch.query ?? cur.query,
      icon: patch.icon === null ? undefined : patch.icon ?? cur.icon,
    };
    this.db
      .prepare('UPDATE saved_views SET name = ?, query = ?, icon = ? WHERE id = ?')
      .run(next.name, JSON.stringify(next.query), next.icon ?? null, id);
    return next;
  }

  reorderView(id: string, ord: number) {
    this.db.prepare('UPDATE saved_views SET ord = ? WHERE id = ?').run(ord, id);
  }

  deleteView(id: string) {
    this.db.prepare('DELETE FROM saved_views WHERE id = ?').run(id);
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

  allEventsSince(seq: number, limit?: number): (KarmaxEvent & { seq: number })[] {
    // Bound the read in SQL. Callers that want "the last N" would otherwise
    // materialize the ENTIRE append-only table before slicing — the events table
    // is the largest in the DB, so that is the dominant read-path allocation.
    // Grab the newest N (DESC + LIMIT), then return ascending as before.
    if (limit && limit > 0) {
      const rows = this.db
        .prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq DESC LIMIT ?')
        .all(seq, limit) as any[];
      rows.reverse();
      return rows.map((r) => ({ seq: r.seq, type: r.type, taskId: r.taskId, ts: r.ts, payload: JSON.parse(r.payload) }));
    }
    return (this.db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq').all(seq) as any[]).map(
      (r) => ({ seq: r.seq, type: r.type, taskId: r.taskId, ts: r.ts, payload: JSON.parse(r.payload) }),
    );
  }

  /** Retention: drop a task's high-volume live-output rows once it's done. The
   *  full agent text survives in the task's saved view/transcripts (saveView);
   *  these per-chunk `agent.output` rows are the biggest driver of table growth
   *  and are only useful for the live stream while the task runs. */
  pruneAgentOutput(taskId: string): number {
    const info = this.db
      .prepare("DELETE FROM events WHERE taskId = ? AND type = 'agent.output'")
      .run(taskId);
    return Number(info.changes);
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
function rowToTag(r: any): Tag {
  return {
    id: r.id,
    projectId: r.projectId,
    name: r.name,
    parentId: r.parentId ?? undefined,
    color: r.color ?? undefined,
    kind: r.kind ?? undefined,
    createdAt: r.createdAt,
  };
}
function rowToView(r: any): SavedView {
  return {
    id: r.id,
    projectId: r.projectId,
    name: r.name,
    query: JSON.parse(r.query),
    icon: r.icon ?? undefined,
    order: r.ord,
    createdAt: r.createdAt,
  };
}
function rowToList(r: any): TaskList {
  return { id: r.id, projectId: r.projectId, name: r.name, createdAt: r.createdAt, order: r.ord };
}
function rowToTask(r: any): TaskRecord {
  return {
    id: r.id,
    num: r.num ?? undefined,
    projectId: r.projectId,
    listId: r.listId,
    title: r.title,
    workflow: r.workflow,
    workflowVersion: r.workflowVersion,
    params: JSON.parse(r.params),
    createdAt: r.createdAt,
    order: r.ord,
    parentTaskId: r.parentTaskId ?? undefined,
    notes: r.notes ?? undefined,
    lastView: r.lastView ? JSON.parse(r.lastView) : undefined,
  };
}
