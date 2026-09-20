import { ProjectTransfers } from '../src/platform/project-transfer.js';
import { beginEnvironmentBuild, finishEnvironmentBuild } from '../src/store/project-environment.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { VaultItems } from '../src/autonomy/vault-items.js';
import { AuthorizationService } from '../src/platform/authorization.js';
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

  it('serializes build admission and rolls back failed transfers across independent pools', async () => {
    const first = await Store.create(url!);
    const otherUrl = new URL(url!);
    otherUrl.searchParams.set('application_name', 'independent-transfer-test');
    const second = await Store.create(otherUrl.href);
    try {
      const project = await first.createProject('Transfer');
      const destination = await first.createOrganization({ name: 'Receiving', ownerUserId: 'receiver' });
      const scope = { organizationId: project.organizationId!, transferGeneration: '' };
      const attempts = await Promise.allSettled([
        beginEnvironmentBuild(first, project.id, scope, 'e2b', 'digest'),
        beginEnvironmentBuild(second, project.id, scope, 'e2b', 'digest'),
      ]);
      expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const admitted = attempts.find(result => result.status === 'fulfilled');
      if (admitted?.status !== 'fulfilled') throw new Error('No build admitted');
      expect(await finishEnvironmentBuild(first, admitted.value, { status: 'failed', error: 'provider stopped' })).toBe(true);
      const actor = { principal: 'system:test', authorize: async () => {}, workflowClosed: async () => true };
      const preview = await new ProjectTransfers(first, actor).preview(project.id, destination.id);
      const audit = vi.spyOn(second, 'appendAudit').mockRejectedValueOnce(new Error('audit write failed'));
      const transfers = new ProjectTransfers(second, actor);
      await expect(transfers.move(project.id, destination.id, preview.id)).rejects.toThrow('audit write failed');
      expect((await first.getProject(project.id))?.organizationId).toBe(project.organizationId);
      expect(await first.kvGet(`project-transfer-lock:${project.id}`)).toBeUndefined();
      audit.mockRestore();
      expect((await transfers.move(project.id, destination.id, preview.id)).organizationId).toBe(destination.id);
      expect(await finishEnvironmentBuild(first, admitted.value, { status: 'ready', ref: 'stale' })).toBe(false);
    } finally { await second.close(); await first.close(); }
  });

  it('serializes compound vault edits across independent PostgreSQL pools', async () => {
    const first = await Store.create(url!);
    const otherUrl = new URL(url!);
    otherUrl.searchParams.set('application_name', 'independent-vault-test');
    const second = await Store.create(otherUrl.href);
    try {
      const a = new VaultItems(first);
      const b = new VaultItems(second);
      const created = await Promise.all([
        a.save({ type: 'note', label: 'First' }),
        b.save({ type: 'note', label: 'Second' }),
      ]);
      expect((await a.list()).map(item => item.id).sort()).toEqual(created.map(item => item.id).sort());
      await Promise.all([
        a.save({ type: 'note', id: created[0]!.id, label: 'Renamed' }),
        b.save({ type: 'note', id: created[0]!.id, tags: ['preserved'] }),
      ]);
      expect(await a.get(created[0]!.id)).toMatchObject({ label: 'Renamed', tags: ['preserved'] });
    } finally { await first.close(); await second.close(); }
  });

  it('reads dependency principals without hydrating any attempt history', async () => {
    const store = (await Store.create(url!));
    try {
      const project = (await store.createProject('Dependencies', {}));
      const first = (await store.createTask({ projectId: project.id, title: 'First', workflow: 'just-do',
        workflowVersion: '1', params: { prompt: 'work' } }));
      const second = (await store.createTask({ projectId: project.id, title: 'Second', workflow: 'just-do',
        workflowVersion: '1', intentId: first.intentId, params: { prompt: 'work', draft: true } }));
      (await store.db.prepare('UPDATE tasks SET lastView=?, conversation=?').run(
        JSON.stringify({ status: 'done' }), 'must not decode history'));
      expect((await store.attemptPrincipalState(second.id))).toEqual({ principalAttemptId: first.id, status: 'done' });
      (await store.db.prepare('UPDATE task_intents SET principalAttemptId=? WHERE id=?').run(second.id, first.intentId!));
      (await store.db.prepare('UPDATE tasks SET lastView=NULL WHERE id=?').run(second.id));
      expect((await store.attemptPrincipalState(first.id))).toEqual({ principalAttemptId: second.id, status: undefined });
      expect((await store.attemptPrincipalState('missing'))).toBeUndefined();
    } finally { (await store.close()); }
  });

  it('uses native asynchronous pagination with compact views and archive filtering', async () => {
    const store = (await Store.create(url!));
    try {
      const project = (await store.createProject('Page'));
      for (let i = 0; i < 4; i++) (await store.createTask({ projectId: project.id, title: `Task ${i}`, workflow: 'just-do',
        workflowVersion: '1.0.0', params: { prompt: 'work', archived: i === 0 } }));
      const page = await store.taskSummaryPage(project.id, { limit: 2, offset: 1 });
      expect(page.total).toBe(3);
      expect(page.tasks.map(task => task.title)).toEqual(['Task 2', 'Task 3']);
      expect((await store.taskSummaryPage(project.id, { includeArchived: true })).total).toBe(4);
      const taskId = page.tasks[0]!.id;
      const cursor = (await store.latestEventSeq());
      (await store.appendEvent({ taskId, type: 'fixture', ts: 1, payload: { text: 'ordered' } }));
      const events = await store.nextEventsSince(cursor, 500);
      expect(events.map(event => event.payload.text)).toEqual(['ordered']);
      expect(await store.taskProjectIds(events.map(event => event.taskId))).toEqual(new Map([[taskId, project.id]]));
    } finally { (await store.close()); }
  });

  it('reads task details and review audiences without the synchronous PostgreSQL bridge', async () => {
    const store = (await Store.create(url!));
    const authorization = (await AuthorizationService.create(store));
    try {
      const org = (await store.createOrganization({ name: 'Async audience', ownerUserId: 'owner' }));
      const project = (await store.createProject('Detail', {}, org.id));
      const task = (await store.createTask({ projectId: project.id, title: 'Review', workflow: 'just-do', workflowVersion: '1',
        params: { prompt: 'fixture' }, confirmationPolicy: {
          rule: 'any', targets: [{ kind: 'project-role', projectId: project.id, role: 'owner' }],
        } }));
      (await store.saveView(task.id, { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'do', status: 'active',
        messages: [{ id: 'm', text: 'history', role: 'agent', ts: 1 }], state: {}, actions: [], updatedAt: 1 }));
      const expected = (await store.getTask(task.id));
      const expectedCaps = (await authorization.capabilities('user:owner', project.id));
      const prepare = vi.spyOn(Atomics, 'wait').mockImplementation(() => { throw Error('blocking database access'); });
      try {
        expect(await authorization.capabilitiesAsync('user:owner', project.id)).toEqual(expectedCaps);
        expect(await store.getOrganizationIdentityPolicyAsync(org.id)).toMatchObject({ enforceSso: false });
        expect(await store.hasSignupAcceptanceAsync('owner')).toBe(false);
        expect(await store.getTaskAsync(task.id)).toEqual(expected);
        expect(await store.listTasksAsync(project.id)).toEqual([expected]);
        expect((await store.listTasksAsync(project.id, false))[0]?.lastView?.messages).toBeUndefined();
        expect(await store.listTagsAsync(project.id)).toEqual([]);
        expect((await store.taskSummaryPage(project.id)).tasks[0]?.reviewers).toEqual(expected?.reviewers);
        expect((await store.taskMetadataAsync(task.id))?.num).toBe(task.num);
        expect(await store.taskPointerByNumAsync(project.id, task.num!)).toEqual({ id: task.id, num: task.num, projectId: project.id });
        expect(await store.taskSnapshotAsync(task.id)).toEqual(expected?.lastView);
      } finally { prepare.mockRestore(); }
    } finally { (await store.close()); }
  });

  it('keeps the event loop live while a native permission lookup waits for the database', async () => {
    const store = (await Store.create(url!));
    const blocker = await admin!.connect();
    try {
      const authorization = (await AuthorizationService.create(store));
      (await authorization.grant('root', { principalId: 'user:reader', scopeKey: 'global', profileId: 'god' }));
      (await store.kvSet('permission-probe', 'ready'));
      await authorization.capabilitiesAsync('user:reader');
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE authorization_profiles IN ACCESS EXCLUSIVE MODE');
      const unlock = blocker.query('SELECT pg_sleep(0.4); COMMIT');
      let complete = false;
      const reading = authorization.capabilitiesAsync('user:reader').then(caps => { complete = true; return caps; });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(complete).toBe(false);
      expect(await store.kvGetAsync('permission-probe')).toBe('ready');
      expect(complete).toBe(false);
      await unlock;
      expect(await reading).toEqual(['*']);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); (await store.close()); }
  });

  it('keeps timers and independent reads live while a task-table lock delays detail and full-list reads', async () => {
    const store = (await Store.create(url!));
    const blocker = await admin!.connect();
    try {
      const project = (await store.createProject('Blocked read'));
      const task = (await store.createTask({ projectId: project.id, title: 'Lock fixture', workflow: 'just-do',
        workflowVersion: '1', params: { prompt: 'fixture' } }));
      (await store.kvSet('unrelated-read', 'ready'));
      await store.taskMetadataAsync(task.id); // establish the pool before timing the lock
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE tasks IN ACCESS EXCLUSIVE MODE');
      // Server-side release also bounds this test if a regression blocks JS timers.
      const unlock = blocker.query('SELECT pg_sleep(0.4); COMMIT');
      let finished = false;
      const read = Promise.all([store.taskMetadataAsync(task.id), store.listTasksAsync(project.id)])
        .then(([value, tasks]) => { expect(tasks.map(t => t.id)).toEqual([task.id]); finished = true; return value; });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(finished).toBe(false);
      expect(await store.kvGetAsync('unrelated-read')).toBe('ready');
      expect(finished).toBe(false);
      await unlock;
      expect((await read)?.id).toBe(task.id);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); (await store.close()); }
  });

  it('looks up usage IDs in bounded batches and task ownership without loading views', async () => {
    const store = (await Store.create(url!));
    try {
      const project = (await store.createProject('Usage attribution'));
      const task = (await store.createTask({ projectId: project.id, title: 'Run', workflow: 'just-do',
        workflowVersion: '1.0.0', params: { prompt: 'Run' } }));
      expect((await store.taskAttribution(task.id))).toEqual({ projectId: project.id, organizationId: project.organizationId });
      expect((await store.taskAttribution('missing'))).toBeUndefined();
      (await store.recordUsage({ id: 'usage:e2b:known', organizationId: project.organizationId!, provider: 'e2b',
        kind: 'world.active', quantity: 1, unit: 'second', costMicros: 14, startedAt: 1, endedAt: 1001 }));
      expect((await store.recordedUsageEventIds([])).size).toBe(0);
      const ids = Array.from({ length: 501 }, (_, i) => `missing-${i}`);
      expect((await store.recordedUsageEventIds([...ids, 'usage:e2b:known']))).toEqual(new Set(['usage:e2b:known']));
    } finally { (await store.close()); }
  });

  it('pins explicit transactions and rejects raw control and caught statement failures', async () => {
    const db = openSqlDatabase(url!);
    try {
      await expect(db.exec('BEGIN')).rejects.toThrow('use transaction()');
      await db.transaction(async () => {
        expect(db.inTransaction()).toBe(true);
        await db.exec('-- batch with a comment\nSELECT 1; SELECT 2');
      });
      expect(db.inTransaction()).toBe(false);
      await expect(db.transaction(async () => {
        await expect(db.exec('SELECT * FROM missing_payment_table')).rejects.toThrow();
        expect(db.inTransaction()).toBe(true);
      })).rejects.toThrow();
      expect(db.inTransaction()).toBe(false);
      await db.exec('SELECT 1');
    } finally { await db.close(); }
  });

  it('locks payment accounting in a real transaction and preserves nested rollback', async () => {
    const store = (await Store.create(url!));
    try {
      expect(store.db.inTransaction()).toBe(false);
      const project = (await store.createProject('Postgres payments'));
      const provider = new MockPaymentProvider(store);
      const card = await provider.provisionCard({ scope: 'project', scopeId: project.id, label: 'Work', cap: 10000 });
      await provider.fund(card.id, 10000);
      const task = (await store.createTask({ projectId: project.id, title: 'Pay', workflow: 'just-do',
        workflowVersion: '1.0.0', params: { prompt: 'Pay', paymentPolicy: { cardIds: [card.id], budget: 100 } } }));
      const service = new BudgetService(store, provider);
      const ctx = { projectId: project.id, taskId: task.id };
      const results = await Promise.all([service.request(ctx, { amount: 100, why: 'first' }),
        service.request(ctx, { amount: 100, why: 'second' })]);
      expect(results.map(r => r.status).sort()).toEqual(['granted', 'needs_approval']);
      (await store.updateTaskParams(task.id, { ...task.params, paymentPolicy: { cardIds: [card.id], budget: 200 } }));
      expect((await service.reconcileTask(ctx)).map(r => r.status)).toEqual(['granted']);
      expect((await store.paymentSpent(task.id))).toBe(200);
      expect(store.db.inTransaction()).toBe(false);
      await expect(store.transaction(async () => {
        await store.paymentTransaction(async () => store.updateCard(card.id, { available: 1 }));
        expect(store.db.inTransaction()).toBe(true);
        throw new Error('rollback outer transaction');
      })).rejects.toThrow('rollback outer transaction');
      expect((await store.getCard(card.id)).available).toBe(9800);
    } finally { (await store.close()); }
  });

  it('patches task fields without replacing unrelated metadata or merging revoked grants', async () => {
    const store = (await Store.create(url!));
    try {
      const project = (await store.createProject('Parameter patches'));
      const task = (await store.createTask({ projectId: project.id, title: 'Resume', workflow: 'software-dev',
        workflowVersion: '1.0.0', params: { prompt: 'work', _workflowRunId: 'live-run',
          _authorization: { capabilities: ['old'], delegationId: 'revoked' } } }));
      (await store.patchTaskParams(task.id, { base: 'main', _authorization: { capabilities: ['new'] },
        nullable: null, ignored: undefined }));
      expect((await store.getTask(task.id))?.params).toEqual({ prompt: 'work', _workflowRunId: 'live-run',
        base: 'main', _authorization: { capabilities: ['new'] }, nullable: null });
    } finally { (await store.close()); }
  });

  it('retains shared snapshot chunks and releases only the last reference', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-postgres-chunks-'));
    const { store } = (await openStore(path.join(home, 'karmax.db'), url!));
    try {
      const chunks = [{ id: 'shared-chunk', bytes: 12 }];
      (await store.retainResourceChunks('org_personal', chunks));
      (await store.retainResourceChunks('org_personal', chunks));
      expect((await store.releaseResourceChunks('org_personal', ['shared-chunk']))).toEqual([]);
      expect((await store.releaseResourceChunks('org_personal', ['shared-chunk']))).toEqual(['shared-chunk']);
    } finally {
      (await store.close()); fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('transactionally imports application and identity SQLite data and is idempotent', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-postgres-'));
    const storeFile = path.join(home, 'karmax.db');
    const authFile = path.join(home, 'auth.db');
    const source = (await Store.create(storeFile));
    const project = (await source.createProject('Migrated workspace'));
    const task = (await source.createTask({ projectId: project.id, title: 'Keep me', workflow: 'software-dev',
      workflowVersion: 'software-dev@1', params: { prompt: 'Keep me', draft: false } }));
    const eventSeq = (await source.appendEvent({ taskId: task.id, type: 'view.updated', ts: Date.now(), payload: { status: 'active' } }));
    (await source.createTag({ projectId: project.id, name: 'database' }));
    // Simulate a legacy row that needs an idempotent data migration after copy.
    (await source.db.prepare('UPDATE tasks SET intentId=NULL, attemptNumber=NULL WHERE id=?').run(task.id));
    (await source.close());

    const secret = 'test-secret-with-at-least-32-characters';
    const sqliteIdentity = await IdentityService.open(authFile, { secret });
    const user = await sqliteIdentity.createUser({ name: 'Alice', email: 'alice@example.com', password: 'correct-horse-battery' });
    await sqliteIdentity.close();

    const opened = (await openStore(storeFile, url!));
    expect(opened.migration).toMatchObject({ imported: true });
    expect((await opened.store.getTask(task.id))).toMatchObject({ title: 'Keep me', intentId: task.id, attemptNumber: 1 });
    expect((await opened.store.eventsSince(task.id, 0)).map((event) => event.seq)).toEqual([eventSeq]);
    expect((await opened.store.listTags(project.id)).map((tag) => tag.name)).toEqual(['database']);
    (await opened.store.saveView(task.id, { status: 'active', stage: 'do', messages: [], transcripts: {} } as any));
    expect((await opened.store.listTaskSummaries(project.id))[0]).toMatchObject({ id: task.id, lastView: { status: 'active', stage: 'do' } });
    (await opened.store.setTaskArchived(task.id, true));
    expect((await opened.store.getTask(task.id))?.params.archived).toBe(true);
    expect(Number((await opened.store.operationalSnapshot()).databaseBytes)).toBeGreaterThan(0);
    expect(fs.existsSync(storeFile)).toBe(true);
    const postCutoverProject = (await opened.store.createProject('Post-cutover workspace'));
    const postCutoverTask = (await opened.store.createTask({ projectId: postCutoverProject.id, title: 'Written in PostgreSQL',
      workflow: 'software-dev', workflowVersion: 'software-dev@1', params: { prompt: 'Written in PostgreSQL', draft: false } }));
    expect((await opened.store.appendEvent({ taskId: postCutoverTask.id, type: 'task.created', ts: Date.now(), payload: {} })))
      .toBe(eventSeq + 1);
    (await opened.store.deleteProject(postCutoverProject.id));
    expect((await opened.store.getProject(postCutoverProject.id))).toBeUndefined();
    (await opened.store.close());

    const identity = await IdentityService.open(authFile, { secret, databaseUrl: url! });
    expect(identity.migration).toMatchObject({ imported: true });
    expect((await identity.listUsers()).map((candidate) => candidate.id)).toEqual([user.id]);
    expect(await identity.providersForUserAsync(user.id)).toEqual((await identity.providersForUser(user.id)));
    expect((await identity.signIn('alice@example.com', 'correct-horse-battery')).status).toBe(200);
    const connectedStore = (await openStore(storeFile, url!)).store;
    identity.connectOrganizationNames(async () => (await connectedStore.organizationNameReservations()));
    connectedStore.connectUserNames(async () => (await identity.listUsers()));
    (await connectedStore.claimPersonalOrganization(user.id, user.name));
    expect((await connectedStore.migratePersonalOrganizationNames((await identity.listUsers())))).toBe(0);
    const bob = await identity.createUser({ name: 'Bob', email: 'bob@example.com', password: 'correct-horse-battery' });
    expect((await identity.listUsers()).map((candidate) => candidate.id)).toContain(bob.id);
    await identity.removeUser(bob.id);
    expect((await identity.listUsers()).map((candidate) => candidate.id)).not.toContain(bob.id);
    (await connectedStore.close());
    await identity.close();

    const reopened = (await openStore(storeFile, url!));
    expect(reopened.migration).toEqual({ imported: false, tables: 0, rows: 0 });
    expect((await reopened.store.eventsSince(task.id, 0))).toHaveLength(1);
    (await reopened.store.close());

    const reopenedIdentity = await IdentityService.open(authFile, { secret, databaseUrl: url! });
    expect(reopenedIdentity.migration).toEqual({ imported: false, tables: 0, rows: 0 });
    expect((await reopenedIdentity.listUsers())).toHaveLength(1);
    await reopenedIdentity.close();
    fs.rmSync(home, { recursive: true, force: true });
  }, 30_000);

  it('refuses to merge an unmarked SQLite source into a non-empty target', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-postgres-refusal-'));
    const sourceFile = path.join(home, 'karmax.db');
    const source = (await Store.create(sourceFile));
    const sourceProject = (await source.createProject('SQLite source'));
    (await source.createTask({ projectId: sourceProject.id, title: 'Source task', workflow: 'software-dev',
      workflowVersion: 'software-dev@1', params: { prompt: 'Source task', draft: false } }));
    (await source.close());

    const target = (await Store.create(url!));
    const targetProject = (await target.createProject('Existing PostgreSQL data'));
    (await target.createTask({ projectId: targetProject.id, title: 'Target task', workflow: 'software-dev',
      workflowVersion: 'software-dev@1', params: { prompt: 'Target task', draft: false } }));
    (await target.close());

    await expect((async () => (await openStore(sourceFile, url!)))()).rejects.toThrow(/refusing SQLite import into non-empty PostgreSQL/);
    expect(fs.existsSync(sourceFile)).toBe(true);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('disambiguates legacy organization names before PostgreSQL import', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-postgres-org-names-'));
    const sourceFile = path.join(home, 'karmax.db');
    const source = (await Store.create(sourceFile));
    const oldest = (await source.createOrganization({ name: 'Acme' }));
    (await source.db.exec('DROP INDEX idx_organizations_name_nocase'));
    (await source.db.prepare(`INSERT INTO organizations (id, name, slug, kind, createdAt)
      VALUES ('org_duplicate', 'ACME', 'acme-2', 'team', ?)`).run(oldest.createdAt + 1));
    (await source.close());

    const opened = (await openStore(sourceFile, url!));
    expect(opened.migration).toMatchObject({ imported: true });
    expect((await opened.store.getOrganization(oldest.id))?.name).toBe('Acme');
    expect((await opened.store.getOrganization('org_duplicate'))?.name).toBe('acme-2');
    (await opened.store.close());
    fs.rmSync(home, { recursive: true, force: true });
  });
});
