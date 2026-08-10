import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { IdentityService } from '../src/auth/identity.js';
import { openStore, Store } from '../src/store/db.js';

const url = process.env.KARMAX_TEST_POSTGRES_URL;
const integration = url ? describe : describe.skip;
const admin = url ? new Pool({ connectionString: url }) : undefined;

integration('PostgreSQL cutover', () => {
  beforeEach(async () => {
    await admin!.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  });
  afterAll(async () => { await admin?.end(); });

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
});
