import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { IdentityService } from '../src/auth/identity.js';
import { openStore, Store } from '../src/store/db.js';
import { openSqlDatabase } from '../src/store/sql.js';
import { BudgetService, MockPaymentProvider } from '../src/autonomy/payments.js';

const url = process.env.KARMAX_TEST_POSTGRES_URL;
const integration = url ? describe : describe.skip;
const admin = url ? new Pool({ connectionString: url }) : undefined;

integration('PostgreSQL cutover', () => {
  beforeEach(async () => {
    await admin!.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  });
  afterAll(async () => { await admin?.end(); });

  it('uses native asynchronous pagination with compact views and archive filtering', async () => {
    const store = new Store(url!);
    try {
      const project = store.createProject('Page');
      for (let i = 0; i < 4; i++) store.createTask({ projectId: project.id, title: `Task ${i}`, workflow: 'just-do',
        workflowVersion: '1.0.0', params: { prompt: 'work', archived: i === 0 } });
      const page = await store.taskSummaryPage(project.id, { limit: 2, offset: 1 });
      expect(page.total).toBe(3);
      expect(page.tasks.map(task => task.title)).toEqual(['Task 2', 'Task 3']);
      expect((await store.taskSummaryPage(project.id, { includeArchived: true })).total).toBe(4);
      const taskId = page.tasks[0]!.id;
      const cursor = store.latestEventSeq();
      store.appendEvent({ taskId, type: 'fixture', ts: 1, payload: { text: 'ordered' } });
      const events = await store.nextEventsSince(cursor, 500);
      expect(events.map(event => event.payload.text)).toEqual(['ordered']);
      expect(await store.taskProjectIds(events.map(event => event.taskId))).toEqual(new Map([[taskId, project.id]]));
    } finally { store.close(); }
  });

  it('looks up usage IDs in bounded batches and task ownership without loading views', () => {
    const store = new Store(url!);
    try {
      const project = store.createProject('Usage attribution');
      const task = store.createTask({ projectId: project.id, title: 'Run', workflow: 'just-do',
        workflowVersion: '1.0.0', params: { prompt: 'Run' } });
      expect(store.taskAttribution(task.id)).toEqual({ projectId: project.id, organizationId: project.organizationId });
      expect(store.taskAttribution('missing')).toBeUndefined();
      store.recordUsage({ id: 'usage:e2b:known', organizationId: project.organizationId!, provider: 'e2b',
        kind: 'world.active', quantity: 1, unit: 'second', costMicros: 14, startedAt: 1, endedAt: 1001 });
      expect(store.recordedUsageEventIds([]).size).toBe(0);
      const ids = Array.from({ length: 501 }, (_, i) => `missing-${i}`);
      expect(store.recordedUsageEventIds([...ids, 'usage:e2b:known'])).toEqual(new Set(['usage:e2b:known']));
    } finally { store.close(); }
  });

  it('tracks transactions after multi-statement commits, comments and failed statements', () => {
    const db = openSqlDatabase(url!);
    try {
      db.exec('BEGIN IMMEDIATE');
      db.exec('SELECT 1; COMMIT');
      expect(db.inTransaction()).toBe(false);
      db.exec('-- begin with a comment\nBEGIN; SELECT 1');
      expect(db.inTransaction()).toBe(true);
      expect(() => db.exec('SELECT * FROM missing_payment_table')).toThrow();
      expect(db.inTransaction()).toBe(true);
      db.exec('ROLLBACK');
      expect(db.inTransaction()).toBe(false);
      expect(() => db.exec('BEGIN; COMMIT; SELECT * FROM missing_payment_table')).toThrow();
      expect(db.inTransaction()).toBe(false);
    } finally { db.close(); }
  });

  it('locks payment accounting in a real transaction and preserves nested rollback', async () => {
    const store = new Store(url!);
    try {
      expect(store.db.inTransaction()).toBe(false);
      const project = store.createProject('Postgres payments');
      const provider = new MockPaymentProvider(store);
      const card = await provider.provisionCard({ scope: 'project', scopeId: project.id, label: 'Work', cap: 10000 });
      await provider.fund(card.id, 10000);
      const task = store.createTask({ projectId: project.id, title: 'Pay', workflow: 'just-do',
        workflowVersion: '1.0.0', params: { prompt: 'Pay', paymentPolicy: { cardIds: [card.id], budget: 100 } } });
      const service = new BudgetService(store, provider);
      const ctx = { projectId: project.id, taskId: task.id };
      const results = await Promise.all([service.request(ctx, { amount: 100, why: 'first' }),
        service.request(ctx, { amount: 100, why: 'second' })]);
      expect(results.map(r => r.status).sort()).toEqual(['granted', 'needs_approval']);
      store.updateTaskParams(task.id, { ...task.params, paymentPolicy: { cardIds: [card.id], budget: 200 } });
      expect((await service.reconcileTask(ctx)).map(r => r.status)).toEqual(['granted']);
      expect(store.paymentSpent(task.id)).toBe(200);
      expect(store.db.inTransaction()).toBe(false);
      store.db.exec('BEGIN');
      store.paymentTransaction(() => store.updateCard(card.id, { available: 1 }));
      expect(store.db.inTransaction()).toBe(true);
      store.db.exec('ROLLBACK');
      expect(store.getCard(card.id).available).toBe(9800);
    } finally { store.close(); }
  });

  it('patches task fields without replacing unrelated metadata or merging revoked grants', () => {
    const store = new Store(url!);
    try {
      const project = store.createProject('Parameter patches');
      const task = store.createTask({ projectId: project.id, title: 'Resume', workflow: 'software-dev',
        workflowVersion: '1.0.0', params: { prompt: 'work', _workflowRunId: 'live-run',
          _authorization: { capabilities: ['old'], delegationId: 'revoked' } } });
      store.patchTaskParams(task.id, { base: 'main', _authorization: { capabilities: ['new'] },
        nullable: null, ignored: undefined });
      expect(store.getTask(task.id)?.params).toEqual({ prompt: 'work', _workflowRunId: 'live-run',
        base: 'main', _authorization: { capabilities: ['new'] }, nullable: null });
    } finally { store.close(); }
  });

  it('retains shared snapshot chunks and releases only the last reference', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-postgres-chunks-'));
    const { store } = openStore(path.join(home, 'karmax.db'), url!);
    try {
      const chunks = [{ id: 'shared-chunk', bytes: 12 }];
      store.retainResourceChunks('org_personal', chunks);
      store.retainResourceChunks('org_personal', chunks);
      expect(store.releaseResourceChunks('org_personal', ['shared-chunk'])).toEqual([]);
      expect(store.releaseResourceChunks('org_personal', ['shared-chunk'])).toEqual(['shared-chunk']);
    } finally {
      store.close(); fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('transactionally imports application and identity SQLite data and is idempotent', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-postgres-'));
    const storeFile = path.join(home, 'karmax.db');
    const authFile = path.join(home, 'auth.db');
    const source = new Store(storeFile);
    const project = source.createProject('Migrated workspace');
    const task = source.createTask({ projectId: project.id, title: 'Keep me', workflow: 'software-dev',
      workflowVersion: 'software-dev@1', params: { prompt: 'Keep me', draft: false } });
    const eventSeq = source.appendEvent({ taskId: task.id, type: 'view.updated', ts: Date.now(), payload: { status: 'active' } });
    source.createTag({ projectId: project.id, name: 'database' });
    // Simulate a legacy row that needs an idempotent data migration after copy.
    source.db.prepare('UPDATE tasks SET intentId=NULL, attemptNumber=NULL WHERE id=?').run(task.id);
    source.close();

    const secret = 'test-secret-with-at-least-32-characters';
    const sqliteIdentity = await IdentityService.open(authFile, { secret });
    const user = await sqliteIdentity.createUser({ name: 'Alice', email: 'alice@example.com', password: 'correct-horse-battery' });
    await sqliteIdentity.close();

    const opened = openStore(storeFile, url!);
    expect(opened.migration).toMatchObject({ imported: true });
    expect(opened.store.getTask(task.id)).toMatchObject({ title: 'Keep me', intentId: task.id, attemptNumber: 1 });
    expect(opened.store.eventsSince(task.id, 0).map((event) => event.seq)).toEqual([eventSeq]);
    expect(opened.store.listTags(project.id).map((tag) => tag.name)).toEqual(['database']);
    opened.store.saveView(task.id, { status: 'active', stage: 'do', messages: [], transcripts: {} } as any);
    expect(opened.store.listTaskSummaries(project.id)[0]).toMatchObject({ id: task.id, lastView: { status: 'active', stage: 'do' } });
    opened.store.setTaskArchived(task.id, true);
    expect(opened.store.getTask(task.id)?.params.archived).toBe(true);
    expect(Number(opened.store.operationalSnapshot().databaseBytes)).toBeGreaterThan(0);
    expect(fs.existsSync(storeFile)).toBe(true);
    const postCutoverProject = opened.store.createProject('Post-cutover workspace');
    const postCutoverTask = opened.store.createTask({ projectId: postCutoverProject.id, title: 'Written in PostgreSQL',
      workflow: 'software-dev', workflowVersion: 'software-dev@1', params: { prompt: 'Written in PostgreSQL', draft: false } });
    expect(opened.store.appendEvent({ taskId: postCutoverTask.id, type: 'task.created', ts: Date.now(), payload: {} }))
      .toBe(eventSeq + 1);
    opened.store.deleteProject(postCutoverProject.id);
    expect(opened.store.getProject(postCutoverProject.id)).toBeUndefined();
    opened.store.close();

    const identity = await IdentityService.open(authFile, { secret, databaseUrl: url! });
    expect(identity.migration).toMatchObject({ imported: true });
    expect(identity.listUsers().map((candidate) => candidate.id)).toEqual([user.id]);
    expect((await identity.signIn('alice@example.com', 'correct-horse-battery')).status).toBe(200);
    const connectedStore = openStore(storeFile, url!).store;
    identity.connectOrganizationNames(() => connectedStore.organizationNameReservations());
    connectedStore.connectUserNames(() => identity.listUsers());
    connectedStore.claimPersonalOrganization(user.id, user.name);
    expect(connectedStore.migratePersonalOrganizationNames(identity.listUsers())).toBe(0);
    const bob = await identity.createUser({ name: 'Bob', email: 'bob@example.com', password: 'correct-horse-battery' });
    expect(identity.listUsers().map((candidate) => candidate.id)).toContain(bob.id);
    await identity.removeUser(bob.id);
    expect(identity.listUsers().map((candidate) => candidate.id)).not.toContain(bob.id);
    connectedStore.close();
    await identity.close();

    const reopened = openStore(storeFile, url!);
    expect(reopened.migration).toEqual({ imported: false, tables: 0, rows: 0 });
    expect(reopened.store.eventsSince(task.id, 0)).toHaveLength(1);
    reopened.store.close();

    const reopenedIdentity = await IdentityService.open(authFile, { secret, databaseUrl: url! });
    expect(reopenedIdentity.migration).toEqual({ imported: false, tables: 0, rows: 0 });
    expect(reopenedIdentity.listUsers()).toHaveLength(1);
    await reopenedIdentity.close();
    fs.rmSync(home, { recursive: true, force: true });
  }, 30_000);

  it('refuses to merge an unmarked SQLite source into a non-empty target', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-postgres-refusal-'));
    const sourceFile = path.join(home, 'karmax.db');
    const source = new Store(sourceFile);
    const sourceProject = source.createProject('SQLite source');
    source.createTask({ projectId: sourceProject.id, title: 'Source task', workflow: 'software-dev',
      workflowVersion: 'software-dev@1', params: { prompt: 'Source task', draft: false } });
    source.close();

    const target = new Store(url!);
    const targetProject = target.createProject('Existing PostgreSQL data');
    target.createTask({ projectId: targetProject.id, title: 'Target task', workflow: 'software-dev',
      workflowVersion: 'software-dev@1', params: { prompt: 'Target task', draft: false } });
    target.close();

    expect(() => openStore(sourceFile, url!)).toThrow(/refusing SQLite import into non-empty PostgreSQL/);
    expect(fs.existsSync(sourceFile)).toBe(true);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('disambiguates legacy organization names before PostgreSQL import', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-postgres-org-names-'));
    const sourceFile = path.join(home, 'karmax.db');
    const source = new Store(sourceFile);
    const oldest = source.createOrganization({ name: 'Acme' });
    source.db.exec('DROP INDEX idx_organizations_name_nocase');
    source.db.prepare(`INSERT INTO organizations (id, name, slug, kind, createdAt)
      VALUES ('org_duplicate', 'ACME', 'acme-2', 'team', ?)`).run(oldest.createdAt + 1);
    source.close();

    const opened = openStore(sourceFile, url!);
    expect(opened.migration).toMatchObject({ imported: true });
    expect(opened.store.getOrganization(oldest.id)?.name).toBe('Acme');
    expect(opened.store.getOrganization('org_duplicate')?.name).toBe('acme-2');
    opened.store.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
});
