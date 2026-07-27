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
    s1.upsertProfile({ id: 'do-default', name: 'Do', role: 'do', provider: 'claude',
      capabilities: ['create-sub-task', 'create-review-info', 'signal-completion', 'save-skill'], maxTurns: 24 } as any);
    s1.upsertProfile({ id: 'custom-big', name: 'Big', role: 'do', provider: 'claude', capabilities: [], maxTurns: 99 } as any);
    // reopening runs migrateData
    const s2 = new Store(dbPath);
    expect(s2.getProfile('do-default')!.maxTurns).toBeUndefined(); // legacy cap stripped
    expect(s2.getProfile('do-default')!.capabilities).toEqual(expect.arrayContaining(['task:git:publish', 'task:git:import']));
    expect(s2.getProfile('do-default')!.capabilities).not.toContain('task:world:read');
    expect(s2.getProfile('custom-big')!.maxTurns).toBe(99); // non-default profiles untouched
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('backfills folder-as-domain metadata on legacy pass-connector vault items', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-vault-domain-mig-'));
    const dbPath = path.join(dir, 'karmax.db');
    const s1 = new Store(dbPath);
    const org = 'org_personal';
    const item = (o: any) => ({ type: 'login', fields: ['password'], policy: { use: 'auto', reveal: 'ask' }, ...o });
    s1.kvSet(`vault:items:${org}`, JSON.stringify([
      // legacy mirror: domain is the top folder, username missing → repaired
      item({ id: 'vi_a', label: '.wifi/bbm.glidestudent.co.uk/abhimanyu0', domains: ['.wifi'],
        provenance: { source: 'connector:pass', externalId: '.wifi/bbm.glidestudent.co.uk/abhimanyu0', at: 1 } }),
      // already-correct mirror: left untouched (idempotent)
      item({ id: 'vi_b', label: 'services/github.com/alice', domains: ['github.com'], username: 'alice',
        provenance: { source: 'connector:pass', externalId: 'services/github.com/alice', at: 1 } }),
      // no DNS-looking segment: nothing to derive, stays as-is
      item({ id: 'vi_c', label: 'secrets/rootpw', domains: ['secrets'],
        provenance: { source: 'connector:pass', externalId: 'secrets/rootpw', at: 1 } }),
      // task-created item (not a connector mirror): never touched
      item({ id: 'vi_d', label: 'Conduit', domains: ['demo.realworld.show'],
        provenance: { source: 'task:task_x', taskId: 'task_x', at: 1 } }),
    ]));
    // reopening runs migrateData
    const s2 = new Store(dbPath);
    const byId: Record<string, any> = Object.fromEntries(
      (JSON.parse(s2.kvGet(`vault:items:${org}`)!) as any[]).map((i) => [i.id, i]));
    expect(byId.vi_a.domains).toEqual(['bbm.glidestudent.co.uk']);
    expect(byId.vi_a.username).toBe('abhimanyu0');
    expect(byId.vi_b.domains).toEqual(['github.com']); // already correct
    expect(byId.vi_b.username).toBe('alice');
    expect(byId.vi_c.domains).toEqual(['secrets']); // nothing derivable
    expect(byId.vi_c.username).toBeUndefined();
    expect(byId.vi_d.domains).toEqual(['demo.realworld.show']); // task item untouched
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('migrates expanded legacy project infrastructure defaults back to organization inheritance', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-project-policy-mig-'));
    const dbPath = path.join(dir, 'karmax.db');
    const legacy = {
      defaultBase: 'main', repos: ['/repo'], worldProvider: 'worktree', runnerPoolId: null,
      resources: { cpu: 2, memoryMb: 2048 },
      network: { allowDomains: [], allowCidrs: [], unrestricted: false },
      environment: {}, monthlyBudgetMicros: null, hibernateAfterMs: 7 * 24 * 60 * 60 * 1000,
    };
    const s1 = new Store(dbPath);
    const migrated = s1.createProject('Legacy', legacy as any);
    const intentional = s1.createProject('Intentional restriction', {
      ...legacy, network: { unrestricted: false, allowDomains: ['internal.example'], allowCidrs: [] },
    } as any);
    s1.close();

    const s2 = new Store(dbPath);
    expect(s2.getProject(migrated.id)!.config).toEqual({
      defaultBase: 'main', repos: ['/repo'], worldProvider: 'worktree',
    });
    expect(s2.effectiveProjectConfig(migrated.id).network).toEqual({ unrestricted: true });
    expect(s2.getProject(intentional.id)!.config.network).toEqual({
      unrestricted: false, allowDomains: ['internal.example'], allowCidrs: [],
    });
    s2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('adds tag descriptions to an existing tag catalogue', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-tag-description-mig-'));
    const dbPath = path.join(dir, 'karmax.db');
    const legacy = new Store(dbPath);
    const project = legacy.createProject('Legacy tags');
    const tag = legacy.createTag({ projectId: project.id, name: 'frontend' });
    // Recreate the pre-description schema while preserving its catalogue rows.
    legacy.db.exec('ALTER TABLE tags DROP COLUMN description');
    legacy.close();

    const migrated = new Store(dbPath);
    expect((migrated.db.prepare('PRAGMA table_info(tags)').all() as any[]).map((column) => column.name)).toContain('description');
    expect(migrated.getTag(tag.id)).toMatchObject({ name: 'frontend' });
    expect(migrated.updateTag(tag.id, { description: 'Client-facing work.' })?.description).toBe('Client-facing work.');
    migrated.close();
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

  it('rejects reserved routing names for projects and organizations', () => {
    // A project is addressed at /<org>/<project> by the slug of its name, and an
    // organization owns the top URL segment — a name that slugifies to a built-in
    // route word (wiki, settings, dashboard, api, …) would be unreachable.
    for (const name of ['wiki', 'Settings', 'DASHBOARD', 'inbox', 'api', 'tasks', 'queue', ' Wiki ']) {
      expect(() => store.createProject(name)).toThrow(/reserved/i);
      expect(() => store.createOrganization({ name })).toThrow(/reserved/i);
    }
    // An explicit organization slug is checked too, not just the derived one.
    expect(() => store.createOrganization({ name: 'Fine name', slug: 'settings' })).toThrow(/reserved/i);
    // Ordinary names still work, and a name merely containing a reserved word is fine.
    expect(() => store.createProject('My Wiki Notes')).not.toThrow();
    expect(store.createOrganization({ name: 'Acme' }).slug).toBe('acme');
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
    expect(store.listTasks(p.id).map((t) => t.id)).toEqual([first.id]);
    expect(store.listTaskAttempts(p.id).map((t) => t.id)).toEqual([first.id, second.id]);
    const cancelled = { taskId: first.id, title: first.title, workflow: first.workflow, stage: 'cancelled' as const, status: 'cancelled' as const, messages: [], actions: [], state: {}, updatedAt: 1 };
    store.saveView(first.id, cancelled);
    expect(store.attemptGroup(first.id)!.principalAttemptId).toBe(second.id);
    expect(store.listTasks(p.id).map((t) => t.id)).toEqual([second.id]);
    expect(store.listTasks(p.id)[0]!.num).toBe(first.num); // logical # is stable
    expect(store.getTaskByNum(p.id, first.num!)!.id).toBe(second.id); // permalink follows principal
    expect(store.attemptGroup(second.id)!.confirmer).toEqual({ mode: 'agent' });
    expect(() => store.setIntentConfirmer(first.intentId!, 'confirm', { mode: 'agent' })).not.toThrow();
    expect(() => store.setIntentConfirmer(first.intentId!, 'confirm', { mode: 'human' })).toThrow(/freezes/);
  });

  it('does not turn persisted attempts into top-level tasks on restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-attempt-mig-'));
    const dbPath = path.join(dir, 'karmax.db');
    const s1 = new Store(dbPath);
    const p = s1.createProject('Acme');
    const first = s1.createTask({ projectId: p.id, title: 'Intent', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'first' } });
    const second = s1.createTask({ projectId: p.id, title: 'Intent', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'second' }, intentId: first.intentId });
    s1.close();

    // Re-running schema migrations must create an intent only for the root task.
    const s2 = new Store(dbPath);
    expect(s2.db.prepare('SELECT id FROM task_intents WHERE id=?').get(second.id)).toBeUndefined();
    expect(s2.listTasks(p.id).map((t) => t.id)).toEqual([first.id]);

    // Repair databases already polluted by the old migration.
    s2.db.prepare('INSERT INTO task_intents (id, principalAttemptId, createdAt) VALUES (?, ?, ?)')
      .run(second.id, second.id, second.createdAt);
    s2.close();
    const s3 = new Store(dbPath);
    expect(s3.db.prepare('SELECT id FROM task_intents WHERE id=?').get(second.id)).toBeUndefined();
    expect(s3.listTasks(p.id).map((t) => t.id)).toEqual([first.id]);
    expect(s3.attemptsOf(first.id)).toHaveLength(2);
    s3.close();
    fs.rmSync(dir, { recursive: true, force: true });
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

  it('hydrates tags onto attempt-group records (task page reads these)', () => {
    const p = store.createProject('Acme');
    const t = store.createTask({ projectId: p.id, title: 'Tagged', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'x' } });
    const tag = store.createTag({ projectId: p.id, name: 'dontmerge' });
    store.setTaskTags(t.id, [tag.id]);
    // The task page resolves its record via attemptGroup — its attempts must carry tags,
    // just like listPrincipalTasks does, or the tag renders on the list but not the page.
    const group = store.attemptGroup(t.id)!;
    expect(group.attempts.find((a) => a.id === t.id)?.tags).toEqual([tag.id]);
    expect(store.attemptsOf(t.id).find((a) => a.id === t.id)?.tags).toEqual([tag.id]);
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
    const s3 = store.appendEvent({ type: 'do.output', taskId: t.id, ts: 3, payload: { text: 'c' } });
    expect(store.eventsSince(t.id, 0)).toHaveLength(3);
    expect(store.eventsSince(t.id, s2 - 1).map((e) => e.payload.text)).toEqual(['b', 'c']);
    expect(store.eventsSince(t.id, 0, 2).map((e) => e.payload.text)).toEqual(['b', 'c']);
    expect(store.latestEventSeq()).toBe(s3);
    expect(store.nextEventsSince(0, 2).map((e) => e.payload.text)).toEqual(['a', 'b']);
  });

  it('reads list summaries without materializing conversation history', () => {
    const project = store.createProject('Acme');
    const task = store.createTask({
      projectId: project.id,
      title: 'X',
      workflow: 'software-dev',
      workflowVersion: '1.0.0',
      params: { prompt: 'x' },
    });
    store.saveView(task.id, {
      taskId: task.id,
      title: 'X',
      workflow: 'software-dev',
      stage: 'do',
      status: 'active',
      messages: [{ id: 'm', role: 'agent', text: 'large conversation', ts: 1 }],
      transcripts: [{ role: 'do', label: 'Do', messages: [{ id: 'm', role: 'agent', text: 'large conversation', ts: 1 }] }],
      actions: [],
      state: {},
      updatedAt: 1,
    });

    expect(store.listTasks(project.id)[0]?.lastView?.messages).toHaveLength(1);
    const summary = store.listTaskSummaries(project.id)[0]?.lastView;
    expect(summary).toMatchObject({ stage: 'do', status: 'active' });
    expect(summary?.messages).toBeUndefined();
    expect(summary?.transcripts).toBeUndefined();
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
