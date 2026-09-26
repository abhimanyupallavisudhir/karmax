import * as __asyncCollections from '../src/util/async-collections.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store, isReviewRequestEvent, deleteRows } from '../src/store/db.js';

describe('Store', () => {
  let store: Store;
  beforeEach(async () => {
    store = (await Store.create(':memory:'));
  });

  it('finds a merged result without loading the task event history', async () => {
    const project = await store.createProject('Merge');
    const task = await store.createTask({ projectId: project.id, title: 'T', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'fixture' } });
    await store.appendEvent({ taskId: task.id, type: 'merge.result', ts: 1, payload: { merged: false } });
    expect(await store.hasMergedTaskEvent(task.id)).toBe(false);
    await store.appendEvent({ taskId: task.id, type: 'merge.result', ts: 2, payload: { merged: true } });
    expect(await store.hasMergedTaskEvent(task.id)).toBe(true);
  });

  it('deduplicates GitHub PR observations and expires them after a month', async () => {
    expect(await store.claimGithubPrObservation('digest', 1000)).toBe(true);
    expect(await store.claimGithubPrObservation('digest', 1001)).toBe(false);
    expect((await store.retentionSweep(1000 + 31 * 86400_000)).githubPrObservations).toBe(1);
    expect(await store.claimGithubPrObservation('digest', 1000 + 31 * 86400_000)).toBe(true);
  });

  it('removes project admission reservations with the project', async () => {
    const project = await store.createProject('Reservations');
    const task = await store.createTask({ projectId: project.id, title: 'T', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'fixture' } });
    await store.db.prepare(`INSERT INTO usage_admissions
      (id, organizationId, projectId, taskId, kind, provider, fundingSource, state, createdAt)
      VALUES (?, ?, ?, ?, 'agent', 'mock', 'byok', 'active', 1)`)
      .run('reservation', project.organizationId, project.id, task.id);
    await store.deleteProject(project.id);
    expect(await store.db.prepare('SELECT id FROM usage_admissions WHERE projectId=?').all(project.id)).toEqual([]);
  });

  it('exports personal data without holding a database write transaction', async () => {
    vi.spyOn(store, 'getSettings').mockImplementation(async () => {
      expect(store.db.inTransaction()).toBe(false);
      return undefined;
    });
    await store.exportUserData('no-records');
  });

  it('looks up literal kv prefixes through the primary-key range', async () => {
    await store.kvSet('case:A', 'one');
    await store.kvSet('case:a', 'two');
    await store.kvSet('case%literal', 'three');
    const prepare = vi.spyOn(store.db, 'prepare');
    expect(await store.kvEntries('case:A')).toEqual([{ key: 'case:A', value: 'one' }]);
    expect(await store.kvEntries('case%')).toEqual([{ key: 'case%literal', value: 'three' }]);
    expect(prepare.mock.calls.some(([sql]) => /FROM kv WHERE k >= \? AND k < \?/.test(sql))).toBe(true);
  });

  it('indexes event type with task id for inbox and approval scans', async () => {
    const indexes = await store.db.prepare('PRAGMA index_list(events)').all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toContain('idx_events_type');
  });

  it('does not rescan completed row migrations on each boot', async () => {
    const queries: string[] = [];
    const prepare = store.db.prepare.bind(store.db);
    store.db.prepare = ((sql: string) => { queries.push(sql); return prepare(sql); }) as typeof store.db.prepare;
    await (store as any).migrateData();
    expect(queries.some((sql) => /SELECT id, config FROM projects|SELECT k, v FROM kv WHERE k LIKE 'vault:items/.test(sql))).toBe(false);
  });

  it('expires old events and audit entries while retaining recent history', async () => {
    expect(((await store.db.prepare('PRAGMA synchronous').get()) as { synchronous: number }).synchronous).toBe(1);
    const now = Date.UTC(2026, 8, 26);
    const project = await store.createProject('Retention');
    const task = await store.createTask({ projectId: project.id, title: 'T', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'fixture' } });
    await store.appendEvent({ taskId: task.id, type: 'task.note', ts: now - 91 * 86400_000, payload: { text: 'old' } });
    await store.appendEvent({ taskId: task.id, type: 'task.note', ts: now - 1 * 86400_000, payload: { text: 'new' } });
    await store.appendAudit({ principalId: 'user:a', action: 'old', ts: now - 366 * 86400_000 });
    await store.appendAudit({ principalId: 'user:a', action: 'new', ts: now - 1 * 86400_000 });
    const swept = await store.retentionSweep(now);
    expect(swept.events).toBe(1);
    expect(swept.auditEntries).toBe(1);
    expect((await store.eventsSince(task.id, 0)).map((event) => event.payload.text)).toEqual(['new']);
    expect((await store.db.prepare('SELECT action FROM audit_log ORDER BY seq').all())).toEqual([{ action: 'new' }]);
  });

  it('retains old unresolved approval requests until their resolution is recorded', async () => {
    const now = Date.UTC(2026, 8, 26);
    const project = await store.createProject('Approvals');
    const task = await store.createTask({ projectId: project.id, title: 'T', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'fixture' } });
    await store.appendEvent({ taskId: task.id, type: 'permission.approval-requested',
      ts: now - 91 * 86400_000, payload: { requestId: 'ask' } });
    expect((await store.retentionSweep(now)).events).toBe(0);
    await store.appendEvent({ taskId: task.id, type: 'permission.approval-resolved',
      ts: now, payload: { requestId: 'ask' } });
    expect((await store.retentionSweep(now)).events).toBe(1);
  });

  it('revokes project-scoped tokens through indexed project membership', async () => {
    const project = await store.createProject('Tokens');
    const task = await store.createTask({ projectId: project.id, title: 'T', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'fixture' } });
    await store.putScopedToken('by-project', 'one', { principal: 'user:a', projectId: project.id }, Date.now() + 1000);
    await store.putScopedToken('by-task', 'two', { principal: 'user:b', taskId: task.id }, Date.now() + 1000);
    await store.putScopedToken('other', 'three', { principal: 'user:c', projectIds: ['unrelated'] }, Date.now() + 1000);
    const queries: string[] = [];
    const prepare = store.db.prepare.bind(store.db);
    store.db.prepare = ((sql: string) => { queries.push(sql); return prepare(sql); }) as typeof store.db.prepare;
    expect(await store.revokeScopedTokens({ projectId: project.id })).toBe(2);
    expect((await store.db.prepare('SELECT tokenHash FROM scoped_tokens WHERE revokedAt IS NULL').all()))
      .toEqual([{ tokenHash: 'other' }]);
    expect(queries.some((sql) => sql.includes('SELECT tokenHash, json FROM scoped_tokens WHERE revokedAt IS NULL'))).toBe(false);
  });

  it('deprovisions a member without reading every live token body', async () => {
    const org = await store.createOrganization({ name: 'Tokens', ownerUserId: 'owner' });
    await store.setOrganizationMembership(org.id, 'member', 'member');
    await store.putScopedToken('member-token', 'one', { principal: 'user:member', organizationId: org.id }, Date.now() + 60_000);
    await store.putScopedToken('owner-token', 'two', { principal: 'user:owner', organizationId: org.id }, Date.now() + 60_000);
    const queries: string[] = [];
    const prepare = store.db.prepare.bind(store.db);
    store.db.prepare = ((sql: string) => { queries.push(sql); return prepare(sql); }) as typeof store.db.prepare;
    await store.deprovisionOrganizationUser(org.id, 'member');
    expect((await store.db.prepare('SELECT tokenHash FROM scoped_tokens WHERE revokedAt IS NULL').all()))
      .toEqual([{ tokenHash: 'owner-token' }]);
    expect(queries.some((sql) => sql.includes('SELECT tokenHash, json FROM scoped_tokens WHERE revokedAt IS NULL'))).toBe(false);
  });

  it('backfills indexed scopes on legacy durable tokens', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-token-scope-'));
    const file = path.join(dir, 'store.db');
    const legacy = new DatabaseSync(file);
    legacy.exec(`CREATE TABLE scoped_tokens (tokenHash TEXT PRIMARY KEY, tokenId TEXT NOT NULL UNIQUE,
      json TEXT NOT NULL, expiresAt INTEGER NOT NULL, revokedAt INTEGER)`);
    legacy.prepare('INSERT INTO scoped_tokens VALUES (?,?,?,?,NULL)')
      .run('old-token', 'old-id', JSON.stringify({ principal: 'user:old', projectIds: ['project-old'] }), Date.now() + 60_000);
    legacy.close();
    const migrated = await Store.create(file);
    try {
      expect(await migrated.revokeScopedTokens({ projectId: 'project-old' })).toBe(1);
    } finally { await migrated.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('patches task fields without replacing unrelated metadata or merging revoked grants', async () => {
    const project = (await store.createProject('Parameter patches'));
    const task = (await store.createTask({ projectId: project.id, title: 'Resume', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'work', _workflowRunId: 'live-run',
        _authorization: { capabilities: ['old'], delegationId: 'revoked' } } }));
    (await store.patchTaskParams(task.id, { base: 'main', _authorization: { capabilities: ['new'] },
      nullable: null, ignored: undefined }));
    expect((await store.getTask(task.id))?.params).toEqual({ prompt: 'work', _workflowRunId: 'live-run',
      base: 'main', _authorization: { capabilities: ['new'] }, nullable: null });
  });

  it('defaults and migrates hosted projects to PR delivery while rejecting new local-only writes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-hosted-remote-'));
    const dbPath = path.join(dir, 'karmax.db');
    const previous = process.env.KARMAX_DEPLOYMENT;
    try {
      delete process.env.KARMAX_DEPLOYMENT;
      const legacy = (await Store.create(dbPath));
      const oldDefault = (await legacy.createProject('Old default'));
      const oldNone = (await legacy.createProject('Old explicit none', { remote: 'none' }));
      (await legacy.setSettings(oldNone.id, '__common__', { remote: 'none', target: 'main' }));
      (await legacy.close());

      process.env.KARMAX_DEPLOYMENT = 'hosted';
      const hosted = (await Store.create(dbPath));
      expect((await hosted.getProject(oldDefault.id))?.config.remote).toBe('pr');
      expect((await hosted.getProject(oldNone.id))?.config.remote).toBe('pr');
      expect((await hosted.getSettings(oldNone.id, '__common__'))).toMatchObject({ remote: 'pr', target: 'main' });
      expect((await hosted.createProject('New hosted')).config.remote).toBe('pr');
      await expect((async () => (await hosted.createProject('No local-only', { remote: 'none' })))()).rejects.toThrow(/hosted GitHub projects require/i);
      await expect((async () => (await hosted.updateProjectConfig(oldNone.id, { remote: 'none' })))()).rejects.toThrow(/hosted GitHub projects require/i);
      await expect((async () => (await hosted.setSettings(oldNone.id, '__common__', { remote: 'none' })))()).rejects.toThrow(/hosted GitHub projects require/i);
      (await hosted.close());
    } finally {
      if (previous === undefined) delete process.env.KARMAX_DEPLOYMENT;
      else process.env.KARMAX_DEPLOYMENT = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes legacy E2B lease estimates while preserving reconciled executions', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-e2b-usage-mig-'));
    const dbPath = path.join(dir, 'karmax.db');
    const legacy = (await Store.create(dbPath));
    (await legacy.recordUsage({ id: 'legacy-lease', organizationId: 'org_personal', provider: 'e2b',
      kind: 'world.active', quantity: 10 * 24 * 60 * 60, unit: 'second', costMicros: 29_911_680,
      startedAt: 1, endedAt: 2, metadata: { runnerPoolId: 'old' } }));
    (await legacy.recordUsage({ id: 'provider-execution', organizationId: 'org_personal', provider: 'e2b',
      kind: 'world.active', quantity: 300, unit: 'second', costMicros: 9_075,
      startedAt: 1, endedAt: 2, metadata: { source: 'provider-lifecycle', executionId: 'execution-1' } }));
    (await legacy.kvDelete('migration:data-2026-09-26')); // Simulate a pre-migration database.
    (await legacy.close());

    const migrated = (await Store.create(dbPath));
    expect((await migrated.usageSummary('org_personal'))).toEqual({
      costMicros: 9_075, events: 1, byKind: { 'world.active': 9_075 },
      incurredCostMicros: 9_075, estimatedCostMicros: 0, activeReservationsMicros: 0,
      byCostClassification: { incurred: 9_075 },
      byFundingSource: { customer: 9_075 }, byProvider: { e2b: 9_075 }, quantities: { second: 300 },
      requests: { total: 0, managed: 0, byok: 0, customer: 0 },
      active: { agentTurns: 0, worlds: 0, executions: 0 },
    });
    (await migrated.close());
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('prorates provider executions that cross a monthly query boundary', async () => {
    const boundary = Date.UTC(2026, 7, 1);
    (await store.recordUsage({ organizationId: 'org_personal', provider: 'e2b', kind: 'world.active',
      quantity: 10, unit: 'second', costMicros: 100, startedAt: boundary - 5_000,
      endedAt: boundary + 5_000, metadata: { source: 'provider-lifecycle' } }));

    expect((await store.usageSummary('org_personal', boundary - 10_000, boundary)).costMicros).toBe(50);
    expect((await store.usageSummary('org_personal', boundary, boundary + 10_000)).costMicros).toBe(50);
  });

  it('migrates away legacy turn caps on role-default profiles (task 1a)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-mig-'));
    const dbPath = path.join(dir, 'karmax.db');
    // an older build persisted a role default with maxTurns
    const s1 = (await Store.create(dbPath));
    (await s1.upsertProfile({ id: 'do-default', name: 'Do', role: 'do', provider: 'claude',
      capabilities: ['create-sub-task', 'create-review-info', 'signal-completion', 'save-skill'], maxTurns: 24 } as any));
    (await s1.upsertProfile({ id: 'custom-big', name: 'Big', role: 'do', provider: 'claude', capabilities: [], maxTurns: 99 } as any));
    (await s1.kvDelete('migration:data-2026-09-26'));
    // reopening runs migrateData
    const s2 = (await Store.create(dbPath));
    expect((await s2.getProfile('do-default'))!.maxTurns).toBeUndefined(); // legacy cap stripped
    expect((await s2.getProfile('do-default'))!.capabilities).toEqual(expect.arrayContaining(['task:git:publish', 'task:git:import']));
    expect((await s2.getProfile('do-default'))!.capabilities).not.toContain('task:world:read');
    expect((await s2.getProfile('custom-big'))!.maxTurns).toBe(99); // non-default profiles untouched
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('backfills folder-as-domain metadata on legacy pass-connector vault items', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-vault-domain-mig-'));
    const dbPath = path.join(dir, 'karmax.db');
    const s1 = (await Store.create(dbPath));
    const org = 'org_personal';
    const item = (o: any) => ({ type: 'login', fields: ['password'], policy: { use: 'auto', reveal: 'ask' }, ...o });
    (await s1.kvSet(`vault:items:${org}`, JSON.stringify([
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
    ])));
    (await s1.kvDelete('migration:data-2026-09-26'));
    // reopening runs migrateData
    const s2 = (await Store.create(dbPath));
    const byId: Record<string, any> = Object.fromEntries(
      (JSON.parse((await s2.kvGet(`vault:items:${org}`))!) as any[]).map((i) => [i.id, i]));
    expect(byId.vi_a.domains).toEqual(['bbm.glidestudent.co.uk']);
    expect(byId.vi_a.username).toBe('abhimanyu0');
    expect(byId.vi_b.domains).toEqual(['github.com']); // already correct
    expect(byId.vi_b.username).toBe('alice');
    expect(byId.vi_c.domains).toEqual(['secrets']); // nothing derivable
    expect(byId.vi_c.username).toBeUndefined();
    expect(byId.vi_d.domains).toEqual(['demo.realworld.show']); // task item untouched
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('migrates expanded legacy project infrastructure defaults back to organization inheritance', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-project-policy-mig-'));
    const dbPath = path.join(dir, 'karmax.db');
    const legacy = {
      defaultBase: 'main', repos: ['/repo'], worldProvider: 'worktree', runnerPoolId: null,
      resources: { cpu: 2, memoryMb: 2048 },
      network: { allowDomains: [], allowCidrs: [], unrestricted: false },
      environment: {}, monthlyBudgetMicros: null, hibernateAfterMs: 7 * 24 * 60 * 60 * 1000,
    };
    const s1 = (await Store.create(dbPath));
    const migrated = (await s1.createProject('Legacy', legacy as any));
    const intentional = (await s1.createProject('Intentional restriction', {
      ...legacy, network: { unrestricted: false, allowDomains: ['internal.example'], allowCidrs: [] },
    } as any));
    (await s1.kvDelete('migration:data-2026-09-26'));
    (await s1.close());

    const s2 = (await Store.create(dbPath));
    expect((await s2.getProject(migrated.id))!.config).toEqual({
      defaultBase: 'main', repos: ['/repo'], worldProvider: 'worktree',
    });
    expect((await s2.effectiveProjectConfig(migrated.id)).network).toEqual({ unrestricted: true });
    expect((await s2.getProject(intentional.id))!.config.network).toEqual({
      unrestricted: false, allowDomains: ['internal.example'], allowCidrs: [],
    });
    (await s2.close());
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('adds tag descriptions to an existing tag catalogue', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-tag-description-mig-'));
    const dbPath = path.join(dir, 'karmax.db');
    const legacy = (await Store.create(dbPath));
    const project = (await legacy.createProject('Legacy tags'));
    const tag = (await legacy.createTag({ projectId: project.id, name: 'frontend' }));
    // Recreate the pre-description schema while preserving its catalogue rows.
    (await legacy.db.exec('ALTER TABLE tags DROP COLUMN description'));
    (await legacy.close());

    const migrated = (await Store.create(dbPath));
    expect(((await migrated.db.prepare('PRAGMA table_info(tags)').all()) as any[]).map((column) => column.name)).toContain('description');
    expect((await migrated.getTag(tag.id))).toMatchObject({ name: 'frontend' });
    expect((await migrated.updateTag(tag.id, { description: 'Client-facing work.' }))?.description).toBe('Client-facing work.');
    (await migrated.close());
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('backfills kind-less tags to topic on an existing catalogue', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-tag-kind-mig-'));
    const dbPath = path.join(dir, 'karmax.db');
    const legacy = (await Store.create(dbPath));
    const project = (await legacy.createProject('Legacy kinds'));
    const bare = (await legacy.createTag({ projectId: project.id, name: 'orphan' }));
    const typed = (await legacy.createTag({ projectId: project.id, name: 'bug', kind: 'type' }));
    const flagged = (await legacy.createTag({ projectId: project.id, name: 'no-merge', kind: 'flag' }));
    // An older build (and `tag_task` before this change) left `kind` NULL.
    (await legacy.db.prepare('UPDATE tags SET kind = NULL WHERE id = ?').run(bare.id));
    (await legacy.kvDelete('migration:data-2026-09-26'));
    (await legacy.close());

    const migrated = (await Store.create(dbPath));
    expect((await migrated.getTag(bare.id))!.kind).toBe('topic');
    // A tag that already declares a kind is never reclassified.
    expect((await migrated.getTag(typed.id))!.kind).toBe('type');
    expect((await migrated.getTag(flagged.id))!.kind).toBe('flag');
    (await migrated.close());
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('defaults a new tag to the topic kind', async () => {
    const p = (await store.createProject('Kinds'));
    // The implicit path: an agent naming a new tag via tag_task passes no kind.
    expect((await store.createTag({ projectId: p.id, name: 'auth' })).kind).toBe('topic');
    // An explicit kind is honoured.
    expect((await store.createTag({ projectId: p.id, name: 'bug', kind: 'type' })).kind).toBe('type');
    expect((await store.createTag({ projectId: p.id, name: 'no-merge', kind: 'flag' })).kind).toBe('flag');
    // Reusing an existing tag without naming a kind must not reclassify it.
    expect((await store.createTag({ projectId: p.id, name: 'bug' })).kind).toBe('type');
  });

  it('applies a path tag kind to its ancestors, not just the leaf', async () => {
    const p = (await store.createProject('Paths'));
    // A hierarchy is within-kind: kind-scoped sectioning drops a child whose
    // parent carries a different kind, so ancestors inherit the declared kind.
    const leaf = (await store.createTag({ projectId: p.id, name: 'release/blocker', kind: 'flag' }));
    expect(leaf.kind).toBe('flag');
    const parent = (await store.getTag(leaf.parentId!))!;
    expect(parent).toMatchObject({ name: 'release', kind: 'flag' });
    // With no kind declared, the whole path defaults to topic.
    const plain = (await store.createTag({ projectId: p.id, name: 'frontend/web' }));
    expect(plain.kind).toBe('topic');
    expect((await store.getTag(plain.parentId!))!.kind).toBe('topic');
  });

  it('creates a project with a default task list', async () => {
    const p = (await store.createProject(' Work / Clients / Acme ', { defaultBase: 'main' }));
    expect(p.id).toMatch(/^proj_/);
    expect(p).toMatchObject({ name: 'Acme', folder: 'Work/Clients' });
    const lists = (await store.listLists(p.id));
    expect(lists).toHaveLength(1);
    expect(lists[0]!.name).toBe('Tasks');
    expect((await store.getProject(p.id))!.config.defaultBase).toBe('main');
  });

  it('keeps the final project name unique within its organization', async () => {
    const other = (await store.createOrganization({ name: 'Other org' }));
    const first = (await store.createProject('Work/Clients/Web Site'));
    expect(first).toMatchObject({ name: 'Web Site', folder: 'Work/Clients' });
    // Folder paths do not enter the URL, so the leaf slug is the unique key.
    await expect((async () => (await store.createProject('Personal/web site')))()).rejects.toThrow(/already exists/i);
    await expect((async () => (await store.createProject('Other/Web-site')))()).rejects.toThrow(/already exists/i);
    await expect((async () => (await store.createProject('')))()).rejects.toThrow(/required/i);
    // The same leaf is valid in a different organization.
    expect((await store.createProject('Archive/Web Site', {}, other.id))).toMatchObject({ name: 'Web Site', folder: 'Archive' });

    const second = (await store.createProject('Second'));
    await expect((async () => (await store.renameProject(second.id, 'New/Web Site')))()).rejects.toThrow(/already exists/i);
    expect((await store.getProject(second.id))).toMatchObject({ name: 'Second' });
    expect((await store.renameProject(second.id, 'New/Console'))).toMatchObject({ name: 'Console', folder: 'New' });
    expect((await store.renameProject(second.id, 'Console'))).not.toHaveProperty('folder');
  });

  it('reorders projects in the sidebar, per organization', async () => {
    const other = (await store.createOrganization({ name: 'Acme Inc' }));
    const [a, b, c] = (await __asyncCollections.map(['A', 'B', 'C'], async (n) => (await store.createProject(n))));
    const foreign = (await store.createProject('Z', {}, other.id));
    const order = async () => (await store.listProjects()).filter((p) => p.organizationId === 'org_personal').map((p) => p.name);
    expect((await order())).toEqual(['A', 'B', 'C']); // creation order until someone drags

    // Drop C above A: "before" names the project it now sits on top of.
    (await store.reorderProject(c!.id, a!.id));
    expect((await order())).toEqual(['C', 'A', 'B']);
    // Positions are re-densified, so the next drag reads an unambiguous list.
    expect((await store.listProjects()).filter((p) => p.organizationId === 'org_personal').map((p) => p.order)).toEqual([0, 1, 2]);

    // No `before` = drop past the last project.
    (await store.reorderProject(c!.id));
    expect((await order())).toEqual(['A', 'B', 'C']);
    // A no-op drag (dropped back where it was) is stable.
    (await store.reorderProject(b!.id, c!.id));
    expect((await order())).toEqual(['A', 'B', 'C']);

    // Another organization's projects are never touched, and a project created
    // after a reorder still lands at the end of its own organization.
    expect((await store.getProject(foreign.id))!.order).toBe(0);
    const d = (await store.createProject('D'));
    expect((await order())).toEqual(['A', 'B', 'C', 'D']);
    expect(d.order).toBe(3);
    // A `before` in a foreign organization is meaningless — treat it as "last".
    (await store.reorderProject(a!.id, foreign.id));
    expect((await order())).toEqual(['B', 'C', 'D', 'A']);
    await expect((async () => (await store.reorderProject('proj_nope')))()).rejects.toThrow(/no project/);
  });

  it('files projects into implicit sidebar folders', async () => {
    const [a, b] = (await __asyncCollections.map(['A', 'B'], async (n) => (await store.createProject(n))));
    // A folder is nothing but a path a project names — no entity to create.
    expect((await store.setProjectFolder(a!.id, 'Work/Clients')).folder).toBe('Work/Clients');
    expect((await store.getProject(a!.id))!.folder).toBe('Work/Clients');
    // Paths are canonicalized: segments trimmed, empty segments dropped.
    expect((await store.setProjectFolder(a!.id, '  Work / Clients / ')).folder).toBe('Work/Clients');
    // Clearing returns the project to the top level, with no folder key at all.
    expect((await store.setProjectFolder(a!.id, ''))).not.toHaveProperty('folder');
    expect((await store.getProject(a!.id))!.folder).toBeUndefined();
    await expect((async () => (await store.setProjectFolder('proj_nope', 'X')))()).rejects.toThrow(/no project/);

    // A drop can move and re-file in one gesture; the returned order carries it.
    const moved = (await store.reorderProject(b!.id, a!.id, 'Work'));
    expect(moved.find((p) => p.id === b!.id)!.folder).toBe('Work');
    expect((await store.getProject(b!.id))!.folder).toBe('Work');
    // …and folder '' on a reorder is an explicit move back to the top level,
    // while an omitted folder leaves it alone.
    (await store.reorderProject(b!.id, a!.id));
    expect((await store.getProject(b!.id))!.folder).toBe('Work');
    (await store.reorderProject(b!.id, a!.id, ''));
    expect((await store.getProject(b!.id))!.folder).toBeUndefined();
  });

  it('renames an implicit sidebar folder and its nested projects atomically', async () => {
    const direct = (await store.createProject('Work/Clients/Site'));
    const nested = (await store.createProject('Work/Clients/Internal/Admin'));
    const sibling = (await store.createProject('Work/Notes'));

    expect((await store.projectFolderProjects(direct.id, 'Work/Clients')).map((project) => project.id))
      .toEqual([direct.id, nested.id]);
    const renamed = (await store.renameProjectFolder(direct.id, 'Work/Clients', 'Customers'));
    expect(renamed.folder).toBe('Work/Customers');
    expect(renamed.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: direct.id, folder: 'Work/Customers' }),
      expect.objectContaining({ id: nested.id, folder: 'Work/Customers/Internal' }),
    ]));
    expect((await store.getProject(sibling.id))!.folder).toBe('Work');

    (await store.createProject('Work/Archive/Old'));
    await expect((async () => (await store.renameProjectFolder(direct.id, 'Work/Customers', 'Archive')))()).rejects.toThrow(/already exists/i);
    expect((await store.getProject(direct.id))!.folder).toBe('Work/Customers');
    await expect((async () => (await store.renameProjectFolder(direct.id, 'Work/Customers', 'Bad/Name')))()).rejects.toThrow(/cannot contain/i);
    await expect((async () => (await store.projectFolderProjects(sibling.id, 'Work/Customers')))()).rejects.toThrow(/does not belong/i);
  });

  it('keeps creation order for projects that predate the sidebar ordering column', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-project-ord-mig-'));
    const dbPath = path.join(dir, 'karmax.db');
    const legacy = (await Store.create(dbPath));
    const ids = (await __asyncCollections.map(['A', 'B', 'C'], async (n) => (await legacy.createProject(n)).id));
    // Undo the column so the reopened store has to migrate a pre-`ord` schema.
    (legacy as any).db.exec('ALTER TABLE projects DROP COLUMN ord');

    const store2 = (await Store.create(dbPath));
    expect((await store2.listProjects()).map((p) => p.name)).toEqual(['A', 'B', 'C']);
    // …and the first drag still works off that implicit order.
    (await store2.reorderProject(ids[2]!, ids[0]!));
    expect((await store2.listProjects()).map((p) => p.name)).toEqual(['C', 'A', 'B']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects reserved routing names for projects and organizations', async () => {
    // A project is addressed at /<org>/<project> by the slug of its name, and an
    // organization owns the top URL segment — a name that slugifies to a built-in
    // route word (wiki, settings, dashboard, api, …) would be unreachable.
    for (const name of ['wiki', 'Settings', 'DASHBOARD', 'Insights', 'inbox', 'profile', 'api', 'tasks', 'queue', ' Wiki ']) {
      await expect((async () => (await store.createProject(name)))()).rejects.toThrow(/reserved/i);
      await expect((async () => (await store.createOrganization({ name })))()).rejects.toThrow(/reserved/i);
    }
    // An explicit organization slug is checked too, not just the derived one.
    await expect((async () => (await store.createOrganization({ name: 'Fine name', slug: 'settings' })))()).rejects.toThrow(/reserved/i);
    // Ordinary names still work, and a name merely containing a reserved word is fine.
    await (async () => (await store.createProject('My Wiki Notes')))();
    expect((await store.createOrganization({ name: 'Acme' })).slug).toBe('acme');
  });

  it('renames projects and organizations without changing their identity', async () => {
    const organization = (await store.createOrganization({ name: 'Acme' }));
    const project = (await store.createProject('Website', {}, organization.id));

    expect((await store.renameProject(project.id, '  Commerce / Storefront  '))).toMatchObject({
      id: project.id, organizationId: organization.id, name: 'Storefront', folder: 'Commerce',
    });
    expect((await store.renameOrganization(organization.id, '  Acme Labs  '))).toMatchObject({
      id: organization.id, name: 'Acme Labs', slug: organization.slug,
    });
    expect((await store.getProject(project.id))).toMatchObject({ name: 'Storefront', folder: 'Commerce' });
    expect((await store.getOrganization(organization.id))?.name).toBe('Acme Labs');
    await expect((async () => (await store.renameProject(project.id, 'settings')))()).rejects.toThrow(/reserved/i);
    await expect((async () => (await store.renameProject(project.id, '   ')))()).rejects.toThrow(/required/i);
    await expect((async () => (await store.renameOrganization(organization.id, '')))()).rejects.toThrow(/required/i);
  });

  it('keeps organization names unique across organizations and users', async () => {
    const store = (await Store.create(':memory:'));
    store.connectUserNames(() => [{ id: 'alice', name: 'Alice' }]);
    const acme = (await store.createOrganization({ name: 'Acme' }));

    await expect((async () => (await store.createOrganization({ name: '  ACME  ' })))()).rejects.toThrow(/already used by an organization/i);
    await expect((async () => (await store.createOrganization({ name: 'alice' })))()).rejects.toThrow(/already used by a user/i);
    await expect((async () => (await store.renameOrganization(acme.id, 'ALICE')))()).rejects.toThrow(/already used by a user/i);
    expect((await store.createOrganization({ name: 'Alice', kind: 'personal', ownerUserId: 'alice' })).name).toBe('Alice');
  });

  it('disambiguates organization names that predate the unique-name index', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-org-name-mig-'));
    const dbPath = path.join(dir, 'karmax.db');
    try {
      const legacy = (await Store.create(dbPath));
      const oldest = (await legacy.createOrganization({ name: 'Acme' }));
      (await legacy.db.exec('DROP INDEX idx_organizations_name_nocase'));
      (await legacy.db.prepare(`INSERT INTO organizations (id, name, slug, kind, createdAt)
        VALUES ('org_duplicate', 'ACME', 'acme-2', 'team', ?)`).run(oldest.createdAt + 1));
      const project = (await legacy.createProject('Legacy project', {}, 'org_duplicate'));
      (await legacy.close());

      const migrated = (await Store.create(dbPath));
      expect((await migrated.getOrganization(oldest.id))?.name).toBe('Acme');
      expect((await migrated.getOrganization('org_duplicate'))?.name).toBe('acme-2');
      expect((await migrated.getProject(project.id))?.organizationId).toBe('org_duplicate');
      expect((await migrated.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_organizations_name_nocase'").get()))
        .toBeTruthy();
      (await migrated.close());

      const reopened = (await Store.create(dbPath));
      expect((await reopened.getOrganization('org_duplicate'))?.name).toBe('acme-2');
      (await reopened.close());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates and lists tasks in order', async () => {
    const p = (await store.createProject('Acme'));
    const t1 = (await store.createTask({
      projectId: p.id,
      title: 'First',
      workflow: 'software-dev',
      workflowVersion: '1.0.0',
      params: { prompt: 'do a thing' },
    }));
    const t2 = (await store.createTask({
      projectId: p.id,
      title: 'Second',
      workflow: 'just-do',
      workflowVersion: '1.0.0',
      params: { prompt: 'do another' },
    }));
    const tasks = (await store.listTasks(p.id));
    expect(tasks.map((t) => t.id)).toEqual([t1.id, t2.id]);
    expect(tasks[0]!.params.prompt).toBe('do a thing');
  });

  it('groups alternate attempts behind one principal list row and re-elects on cancellation', async () => {
    const p = (await store.createProject('Acme'));
    const first = (await store.createTask({ projectId: p.id, title: 'Intent', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'first' }, confirmer: { mode: 'agent' } }));
    const second = (await store.createTask({ projectId: p.id, listId: first.listId, title: first.title, workflow: first.workflow, workflowVersion: first.workflowVersion, params: { prompt: 'second', draft: true }, intentId: first.intentId }));
    expect(second.attemptNumber).toBe(2);
    expect(second.num).toBeUndefined();
    expect((await store.listTasks(p.id)).map((t) => t.id)).toEqual([first.id]);
    expect((await store.listTaskAttempts(p.id)).map((t) => t.id)).toEqual([first.id, second.id]);
    const cancelled = { taskId: first.id, title: first.title, workflow: first.workflow, stage: 'cancelled' as const, status: 'cancelled' as const, messages: [], actions: [], state: {}, updatedAt: 1 };
    (await store.saveView(first.id, cancelled));
    expect((await store.attemptGroup(first.id))!.principalAttemptId).toBe(second.id);
    expect((await store.listTasks(p.id)).map((t) => t.id)).toEqual([second.id]);
    expect((await store.listTasks(p.id))[0]!.num).toBe(first.num); // logical # is stable
    expect((await store.getTaskByNum(p.id, first.num!))!.id).toBe(second.id); // permalink follows principal
    expect((await store.attemptGroup(second.id))!.confirmer).toEqual({ mode: 'agent' });
    await (async () => (await store.setIntentConfirmer(first.intentId!, 'confirm', { mode: 'agent' })))();
    // The task FORM can't tell whether a live attempt's gate has already played, so it
    // still refuses to diverge the shared route once an attempt is queued...
    await expect((async () => (await store.setIntentConfirmer(first.intentId!, 'confirm', { mode: 'human' })))()).rejects.toThrow(/shared/);
    // ...but the route is `untilUsed`, not `queue`: KarmaxApi.updateParams passes
    // `inFlight` once the live workflow itself has accepted the re-route (SPEC §4.5/§5.5).
    (await store.setIntentConfirmer(first.intentId!, 'confirm', { mode: 'human' }, { inFlight: true }));
    expect((await store.attemptGroup(second.id))!.confirmer).toEqual({ mode: 'human' });
    expect((await store.getTask(second.id))!.params.confirm).toEqual({ mode: 'human' }); // mirrored onto every attempt
  });

  it('does not turn persisted attempts into top-level tasks on restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-attempt-mig-'));
    const dbPath = path.join(dir, 'karmax.db');
    const s1 = (await Store.create(dbPath));
    const p = (await s1.createProject('Acme'));
    const first = (await s1.createTask({ projectId: p.id, title: 'Intent', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'first' } }));
    const second = (await s1.createTask({ projectId: p.id, title: 'Intent', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'second' }, intentId: first.intentId }));
    (await s1.close());

    // Re-running schema migrations must create an intent only for the root task.
    const s2 = (await Store.create(dbPath));
    expect((await s2.db.prepare('SELECT id FROM task_intents WHERE id=?').get(second.id))).toBeUndefined();
    expect((await s2.listTasks(p.id)).map((t) => t.id)).toEqual([first.id]);

    // Repair databases already polluted by the old migration.
    (await s2.db.prepare('INSERT INTO task_intents (id, principalAttemptId, createdAt) VALUES (?, ?, ?)')
      .run(second.id, second.id, second.createdAt));
    (await s2.close());
    const s3 = (await Store.create(dbPath));
    expect((await s3.db.prepare('SELECT id FROM task_intents WHERE id=?').get(second.id))).toBeUndefined();
    expect((await s3.listTasks(p.id)).map((t) => t.id)).toEqual([first.id]);
    expect((await s3.attemptsOf(first.id))).toHaveLength(2);
    (await s3.close());
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('grants exactly one Merge commitment and makes the winner principal', async () => {
    const p = (await store.createProject('Acme'));
    const first = (await store.createTask({ projectId: p.id, title: 'Intent', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'first' } }));
    const second = (await store.createTask({ projectId: p.id, title: 'Intent', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'second' }, intentId: first.intentId }));
    (await store.kvSet(`attempt-choice:${second.id}`, 'cancel'));
    expect((await store.claimAttempt(second.id))).toEqual({ accepted: true, cancel: [first.id] });
    expect((await store.claimAttempt(first.id))).toEqual({ accepted: false, cancel: [first.id] });
    const group = (await store.attemptGroup(first.id))!;
    expect(group.committedAttemptId).toBe(second.id);
    expect(group.principalAttemptId).toBe(second.id);
  });

  it('hydrates tags onto attempt-group records (task page reads these)', async () => {
    const p = (await store.createProject('Acme'));
    const t = (await store.createTask({ projectId: p.id, title: 'Tagged', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'x' } }));
    const tag = (await store.createTag({ projectId: p.id, name: 'dontmerge' }));
    (await store.setTaskTags(t.id, [tag.id]));
    // The task page resolves its record via attemptGroup — its attempts must carry tags,
    // just like listPrincipalTasks does, or the tag renders on the list but not the page.
    const group = (await store.attemptGroup(t.id))!;
    expect(group.attempts.find((a) => a.id === t.id)?.tags).toEqual([tag.id]);
    expect((await store.attemptsOf(t.id)).find((a) => a.id === t.id)?.tags).toEqual([tag.id]);
  });

  it('numbers queued tasks per project, each starting at #1 (task 10.6)', async () => {
    const a = (await store.createProject('Acme'));
    const b = (await store.createProject('Beta'));
    const draft = (await store.createTask({ projectId: a.id, title: 'A-draft', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'later', draft: true } }));
    const a1 = (await store.createTask({ projectId: a.id, title: 'A-one', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'x' } }));
    const b1 = (await store.createTask({ projectId: b.id, title: 'B-one', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'y' } }));
    const a2 = (await store.createTask({ projectId: a.id, title: 'A-two', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'z' } }));
    // Never-queued drafts have no number and do not consume one. Each project's
    // queued work therefore runs its own #1, #2, … independently.
    expect(draft.num).toBeUndefined();
    expect((await store.getTask(draft.id))!.num).toBeUndefined();
    expect([a1.num, a2.num]).toEqual([1, 2]);
    expect(b1.num).toBe(1);
    // resolvable by (project, number) — drives the /projects/:name/tasks/:num permalink + search
    expect((await store.getTaskByNum(a.id, 1))!.id).toBe(a1.id);
    expect((await store.getTaskByNum(b.id, 1))!.id).toBe(b1.id); // same #1, different project
    expect((await store.getTaskByNum(a.id, 2))!.id).toBe(a2.id);
    expect((await store.getTaskByNum(a.id, 99))).toBeUndefined();
    expect((await store.getTask(a2.id))!.num).toBe(2);

    // The number is allocated at the queue transition and remains stable if the
    // transition is invoked again.
    (await store.clearDraft(draft.id));
    expect((await store.getTask(draft.id))!.num).toBe(3);
    (await store.clearDraft(draft.id));
    expect((await store.getTask(draft.id))!.num).toBe(3);
  });

  it('assigns one logical number when an alternate draft is queued first', async () => {
    const p = (await store.createProject('Acme'));
    const first = (await store.createTask({ projectId: p.id, title: 'Intent', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'first', draft: true } }));
    const second = (await store.createTask({ projectId: p.id, title: 'Intent', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'second', draft: true }, intentId: first.intentId }));
    expect(first.num).toBeUndefined();
    expect(second.num).toBeUndefined();

    (await store.clearDraft(second.id));
    expect((await store.getTask(first.id))!.num).toBe(1);
    expect((await store.getTask(second.id))!.num).toBe(1);
    expect((await store.getTaskByNum(p.id, 1))!.id).toBe(first.id);
  });

  it('backfills per-project task numbers for rows created before the column existed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-num-'));
    const dbPath = path.join(dir, 'karmax.db');
    const s1 = (await Store.create(dbPath));
    const a = (await s1.createProject('Acme'));
    const b = (await s1.createProject('Beta'));
    const a1 = (await s1.createTask({ projectId: a.id, title: 'A older', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: '1' } }));
    const b1 = (await s1.createTask({ projectId: b.id, title: 'B older', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: '2' } }));
    const a2 = (await s1.createTask({ projectId: a.id, title: 'A newer', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: '3' } }));
    const draft = (await s1.createTask({ projectId: a.id, title: 'A draft', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'later', draft: true } }));
    // simulate a pre-feature install: no num column, no per-project index
    (s1 as any).db.exec('DROP INDEX IF EXISTS idx_tasks_num_project');
    (s1 as any).db.exec('ALTER TABLE tasks DROP COLUMN num');
    (await s1.close());
    const s2 = (await Store.create(dbPath)); // reopen → migrate() re-numbers per project in creation order
    expect((await s2.getTask(a1.id))!.num).toBe(1);
    expect((await s2.getTask(a2.id))!.num).toBe(2);
    expect((await s2.getTask(b1.id))!.num).toBe(1); // project B starts fresh at #1
    expect((await s2.getTask(draft.id))!.num).toBeUndefined(); // never-queued legacy drafts stay unnumbered
    // brand-new tasks continue each project's sequence
    expect((await s2.createTask({ projectId: a.id, title: 'A next', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: '4' } })).num).toBe(3);
    expect((await s2.createTask({ projectId: b.id, title: 'B next', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: '5' } })).num).toBe(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stores and clears cosmetic human notes on a task', async () => {
    const p = (await store.createProject('Acme'));
    const t = (await store.createTask({
      projectId: p.id,
      title: 'X',
      workflow: 'software-dev',
      workflowVersion: '1.0.0',
      params: { prompt: 'x' },
    }));
    expect((await store.getTask(t.id))!.notes).toBeUndefined(); // none by default
    // notes live off params (never assembled into any prompt)
    expect((await store.getTask(t.id))!.params.notes).toBeUndefined();
    (await store.setTaskNotes(t.id, 'remember to check the flaky test'));
    expect((await store.getTask(t.id))!.notes).toBe('remember to check the flaky test');
    expect((await store.getTask(t.id))!.params.prompt).toBe('x'); // params untouched
    (await store.setTaskNotes(t.id, ''));
    expect((await store.getTask(t.id))!.notes).toBeUndefined(); // empty clears
  });

  it('adds the notes column to a pre-existing database on reopen', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-notes-'));
    const dbPath = path.join(dir, 'karmax.db');
    const s1 = (await Store.create(dbPath));
    const p = (await s1.createProject('Acme'));
    const t = (await s1.createTask({
      projectId: p.id,
      title: 'X',
      workflow: 'software-dev',
      workflowVersion: '1.0.0',
      params: { prompt: 'x' },
    }));
    // simulate an install that predates the column, then reopen (runs migrate)
    (await s1.db.exec('ALTER TABLE tasks DROP COLUMN notes'));
    const s2 = (await Store.create(dbPath));
    (await s2.setTaskNotes(t.id, 'jotted after upgrade'));
    expect((await s2.getTask(t.id))!.notes).toBe('jotted after upgrade');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('tracks parent/child relationships', async () => {
    const p = (await store.createProject('Acme'));
    const parent = (await store.createTask({
      projectId: p.id,
      title: 'Parent',
      workflow: 'software-dev',
      workflowVersion: '1.0.0',
      params: { prompt: 'parent' },
    }));
    const child = (await store.createTask({
      projectId: p.id,
      title: 'Child',
      workflow: 'software-dev',
      workflowVersion: '1.0.0',
      params: { prompt: 'child' },
      parentTaskId: parent.id,
    }));
    expect((await store.childTasks(parent.id)).map((t) => t.id)).toEqual([child.id]);
  });

  it('persists and replays a view snapshot', async () => {
    const p = (await store.createProject('Acme'));
    const t = (await store.createTask({
      projectId: p.id,
      title: 'X',
      workflow: 'software-dev',
      workflowVersion: '1.0.0',
      params: { prompt: 'x' },
    }));
    (await store.saveView(t.id, {
      taskId: t.id,
      title: 'X',
      workflow: 'software-dev',
      stage: 'done',
      status: 'done',
      messages: [],
      actions: [],
      state: { ok: true },
      updatedAt: Date.now(),
    }));
    expect((await store.getTask(t.id))!.lastView!.stage).toBe('done');
  });

  it('auto-archives a task when it resolves to done or cancelled', async () => {
    const p = (await store.createProject('Acme'));
    const mk = async (title: string) =>
      (await store.createTask({ projectId: p.id, title, workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'x' } }));
    const view = (id: string, status: string) => ({
      taskId: id, title: 't', workflow: 'software-dev', stage: status as any, status: status as any,
      messages: [], actions: [], state: {}, updatedAt: 1,
    });

    const done = (await mk('done one'));
    (await store.saveView(done.id, view(done.id, 'active')));
    expect((await store.getTask(done.id))!.params.archived).toBeFalsy(); // still running → visible
    (await store.saveView(done.id, view(done.id, 'done')));
    expect((await store.getTask(done.id))!.params.archived).toBe(true); // resolved → archived

    const cancelled = (await mk('cancelled one'));
    (await store.saveView(cancelled.id, view(cancelled.id, 'cancelled')));
    expect((await store.getTask(cancelled.id))!.params.archived).toBe(true);

    const failed = (await mk('failed one'));
    (await store.saveView(failed.id, view(failed.id, 'failed')));
    expect((await store.getTask(failed.id))!.params.archived).toBeFalsy(); // failed stays visible
  });

  it('does not re-archive a finished task the user un-archived', async () => {
    const p = (await store.createProject('Acme'));
    const t = (await store.createTask({ projectId: p.id, title: 'X', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'x' } }));
    const view = { taskId: t.id, title: 'X', workflow: 'software-dev', stage: 'done' as const, status: 'done' as const, messages: [], actions: [], state: {}, updatedAt: 1 };
    (await store.saveView(t.id, view));
    expect((await store.getTask(t.id))!.params.archived).toBe(true);
    // user un-archives to keep it in view, then the view is refreshed again
    (await store.updateTaskParams(t.id, { ...(await store.getTask(t.id))!.params, archived: false }));
    (await store.saveView(t.id, { ...view, updatedAt: 2 }));
    expect((await store.getTask(t.id))!.params.archived).toBe(false); // respected — no re-archive on same terminal status
  });

  it('archives a logical task consistently when its principal is a draft attempt', async () => {
    const p = (await store.createProject('Acme'));
    const original = (await store.createTask({
      projectId: p.id, title: 'X', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'x' },
    }));
    (await store.saveView(original.id, {
      taskId: original.id, title: 'X', workflow: 'software-dev', stage: 'cancelled', status: 'cancelled',
      messages: [], actions: [], state: {}, updatedAt: 1,
    }));
    const draft = (await store.createTask({
      projectId: p.id, title: 'X', workflow: 'software-dev', workflowVersion: '1.0.0',
      params: { prompt: 'try again', draft: true }, intentId: original.intentId,
    }));
    (await store.electPrincipal(original.intentId!));
    expect((await store.attemptGroup(original.id))?.principalAttemptId).toBe(draft.id);

    // The archive action may originate from any selected attempt. The projected
    // principal must still move to Archived, and every sibling must agree so a
    // later principal election cannot resurrect the task on the active list.
    (await store.setTaskArchived(original.id, true));
    expect((await store.listTasks(p.id))[0]?.params).toMatchObject({ draft: true, archived: true });
    expect((await store.attemptsOf(original.id)).every((attempt) => attempt.params.archived === true)).toBe(true);

    (await store.setTaskArchived(draft.id, false));
    expect((await store.attemptsOf(original.id)).every((attempt) => attempt.params.archived === false)).toBe(true);
  });

  it('appends and reads events incrementally', async () => {
    const p = (await store.createProject('Acme'));
    const t = (await store.createTask({
      projectId: p.id,
      title: 'X',
      workflow: 'software-dev',
      workflowVersion: '1.0.0',
      params: { prompt: 'x' },
    }));
    (await store.appendEvent({ type: 'do.output', taskId: t.id, ts: 1, payload: { text: 'a' } }));
    const s2 = (await store.appendEvent({ type: 'do.output', taskId: t.id, ts: 2, payload: { text: 'b' } }));
    const s3 = (await store.appendEvent({ type: 'do.output', taskId: t.id, ts: 3, payload: { text: 'c' } }));
    expect((await store.eventsSince(t.id, 0))).toHaveLength(3);
    expect((await store.eventsSince(t.id, s2 - 1)).map((e) => e.payload.text)).toEqual(['b', 'c']);
    expect((await store.eventBySeq(t.id, s2))?.payload.text).toBe('b');
    expect((await store.eventsSince(t.id, 0, 2)).map((e) => e.payload.text)).toEqual(['b', 'c']);
    expect((await store.latestEventSeq())).toBe(s3);
    expect((await store.nextEventsSince(0, 2)).map((e) => e.payload.text)).toEqual(['a', 'b']);
    (await store.appendEvent({ type: 'conversation.explanation', taskId: t.id, ts: 4, payload: { text: 'plain language' } }));
    expect((await store.eventsOfType(t.id, 'conversation.explanation')).map((e) => e.payload.text)).toEqual(['plain language']);
  });

  it('reads list summaries without materializing conversation history', async () => {
    const project = (await store.createProject('Acme'));
    const task = (await store.createTask({
      projectId: project.id,
      title: 'X',
      workflow: 'software-dev',
      workflowVersion: '1.0.0',
      params: { prompt: 'x' },
    }));
    (await store.saveView(task.id, {
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
    }));

    expect((await store.listTasks(project.id))[0]?.lastView?.messages).toHaveLength(1);
    const summary = (await store.listTaskSummaries(project.id))[0]?.lastView;
    expect(summary).toMatchObject({ stage: 'do', status: 'active' });
    expect(summary?.messages).toBeUndefined();
    expect(summary?.transcripts).toBeUndefined();
  });

  it('round-trips profiles', async () => {
    (await store.upsertProfile({
      id: 'do-default',
      name: 'Do',
      provider: 'mock',
      role: 'do',
      capabilities: ['create-sub-task'],
    }));
    expect((await store.getProfile('do-default'))!.provider).toBe('mock');
    (await store.upsertProfile({
      id: 'do-default',
      name: 'Do',
      provider: 'claude',
      role: 'do',
      capabilities: [],
    }));
    expect((await store.getProfile('do-default'))!.provider).toBe('claude');
    expect((await store.listProfiles())).toHaveLength(1);
  });

  it('opens with a busy timeout so lock collisions wait instead of failing', async () => {
    expect(((await store.db.prepare('PRAGMA busy_timeout').get()) as any).timeout).toBe(5000);
  });


  // ─── retention, projections, and delete completeness ───────────────────────

  it('counts statuses in SQL rather than parsing every task transcript', async () => {
    const project = (await store.createProject('Ops'));
    const big = 'x'.repeat(2000);
    for (const status of ['done', 'active', 'active'] as const) {
      const t = (await store.createTask({ projectId: project.id, title: status, workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'p' } }));
      (await store.saveView(t.id, { taskId: t.id, title: status, workflow: 'just-do', stage: 'do', status,
        messages: [{ role: 'assistant', text: big } as any], actions: [], state: {}, updatedAt: 1 } as any));
    }
    // A task that has never produced a view reads as `setup`.
    (await store.createTask({ projectId: project.id, title: 'fresh', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'p' } }));
    expect((await store.operationalSnapshot()).tasks).toMatchObject({ done: 1, active: 2, setup: 1 });
  });

  it('filters armed tasks and series runs in SQL', async () => {
    const project = (await store.createProject('Triggers'));
    const armed = (await store.createTask({ projectId: project.id, title: 'a', workflow: 'just-do', workflowVersion: '1.0.0',
      params: { prompt: 'p', triggers: [{ kind: 'event', type: 'x.y' }], triggerState: 'armed' } }));
    const plain = (await store.createTask({ projectId: project.id, title: 'b', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'p' } }));
    const run = (await store.createTask({ projectId: project.id, title: 'r', workflow: 'just-do', workflowVersion: '1.0.0',
      params: { prompt: 'p', runOf: plain.id } }));
    expect((await store.listArmedTasks()).map((t) => t.id)).toEqual([armed.id]);
    expect((await store.runsOf(plain.id)).map((t) => t.id)).toEqual([run.id]);
    expect((await store.runsOf(armed.id))).toEqual([]);
  });

  it('prunes high-volume agent.output rows when a task settles (and only then)', async () => {
    const project = (await store.createProject('Retention'));
    const t = (await store.createTask({ projectId: project.id, title: 't', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'p' } }));
    for (let i = 0; i < 5; i++) (await store.appendEvent({ taskId: t.id, type: 'agent.output', ts: i, payload: { text: 'chunk' } }));
    (await store.appendEvent({ taskId: t.id, type: 'view.updated', ts: 9, payload: { status: 'active' } }));
    const outputCount = async () => Number(((await store.db.prepare("SELECT COUNT(*) n FROM events WHERE taskId=? AND type='agent.output'").get(t.id)) as any).n);
    const view = (status: string) => ({ taskId: t.id, title: 't', workflow: 'just-do', stage: 'do', status, messages: [], actions: [], state: {}, updatedAt: 1 } as any);
    (await store.saveView(t.id, view('active')));
    expect((await outputCount())).toBe(5); // still running: the live stream needs them
    (await store.saveView(t.id, view('done')));
    expect((await outputCount())).toBe(0);
    // Non-output history survives.
    expect((await store.eventsSince(t.id, 0)).some((e) => e.type === 'view.updated')).toBe(true);
  });

  it('keeps agent.output for a FAILED task — that is the one a human has to read', async () => {
    const project = (await store.createProject('Retention failed'));
    const t = (await store.createTask({ projectId: project.id, title: 't', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'p' } }));
    for (let i = 0; i < 5; i++) (await store.appendEvent({ taskId: t.id, type: 'agent.output', ts: i, payload: { text: 'chunk' } }));
    const outputCount = async () => Number(((await store.db.prepare("SELECT COUNT(*) n FROM events WHERE taskId=? AND type='agent.output'").get(t.id)) as any).n);
    const view = (status: string) => ({ taskId: t.id, title: 't', workflow: 'just-do', stage: 'do', status, messages: [], actions: [], state: {}, updatedAt: 1 } as any);
    (await store.saveView(t.id, view('active')));
    // Pruning is only safe because the agent text is already in the view/transcripts.
    // For `failed` it is not: reconcile.ts SYNTHESIZES a failed view for any task
    // whose Temporal execution died, so a boot-time reconcile after a crash wiped
    // the streamed output of everything that was mid-flight — exactly the evidence
    // needed to work out why. `failed` also does not auto-archive, for the same reason.
    (await store.saveView(t.id, view('failed')));
    expect((await outputCount())).toBe(5);
  });

  it('sweeps expired scoped tokens and aged-out webhook deliveries', async () => {
    const now = Date.now();
    const token = store.db.prepare('INSERT INTO scoped_tokens (tokenHash, tokenId, json, expiresAt) VALUES (?, ?, ?, ?)');
    (await token.run('h-old', 'tok-old', '{}', now - 1_000));
    (await token.run('h-live', 'tok-live', '{}', now + 60_000));
    expect((await store.recordGithubDelivery('d-old', 'push'))).toBe(true);
    (await store.db.prepare('UPDATE github_webhook_deliveries SET receivedAt=? WHERE deliveryId=?').run(now - 30 * 86400_000, 'd-old'));
    expect((await store.recordGithubDelivery('d-new', 'push'))).toBe(true);
    const swept = (await store.retentionSweep(now));
    expect(swept.scopedTokens).toBe(1);
    expect(swept.githubDeliveries).toBe(1);
    expect(Number(((await store.db.prepare('SELECT COUNT(*) n FROM scoped_tokens').get()) as any).n)).toBe(1);
    // The aged-out id can be claimed again; the recent one is still deduped.
    expect((await store.recordGithubDelivery('d-old', 'push'))).toBe(true);
    expect((await store.recordGithubDelivery('d-new', 'push'))).toBe(false);
  });

  it('deleteTask clears every table deleteProject does, in one transaction', async () => {
    const project = (await store.createProject('Cleanup'));
    const other = (await store.createTask({ projectId: project.id, title: 'other', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'p' } }));
    const t = (await store.createTask({ projectId: project.id, title: 't', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'p' } }));
    (await store.appendEvent({ taskId: t.id, type: 'agent.output', ts: 1, payload: {} }));
    (await store.db.prepare("INSERT INTO task_confirmation (taskId, cycle, policy, createdAt) VALUES (?, 1, '{}', 1)").run(t.id));
    (await store.db.prepare("INSERT INTO confirmation_votes (taskId, cycle, userId, votedAt) VALUES (?, 1, 'u', 1)").run(t.id));
    (await store.db.prepare(`INSERT INTO collaboration_requests (id, requesterTaskId, targetTaskId, targetRole, action, status, afterSeq, createdAt, updatedAt)
      VALUES ('c1', ?, ?, 'do', 'ask', 'open', 0, 1, 1)`).run(t.id, other.id));
    (await store.db.prepare("INSERT INTO world_instances (worldId, generation, handle, state, createdAt, updatedAt) VALUES (?, 1, '{}', 'ready', 1, 1)").run(t.id));
    (await store.db.prepare(`INSERT INTO inbox (id, organizationId, userId, eventSeq, taskId, kind, unread, actionable, createdAt)
      VALUES ('ib1', 'org_personal', 'u', 1, ?, 'update', 1, 0, 1)`).run(t.id));
    (await store.db.prepare(`INSERT INTO delivery_outbox (id, inboxId, channel, state, attempts, nextAt, createdAt)
      VALUES ('do1', 'ib1', 'email', 'pending', 0, 0, 1)`).run());

    await store.resourceReview(t.id, { begin: 'review' });
    await store.kvSet(`view-publication-fence:${t.id}:run:37`, '1:fence');
    await store.kvSet(`view-publication-fence:${other.id}:run:37`, '2:other');
    (await store.deleteTask(t.id));
    expect(await store.kvGet(`resource-review:${t.id}`)).toBeUndefined();
    expect(await store.kvGet(`view-publication-fence:${t.id}:run:37`)).toBeUndefined();
    expect(await store.kvGet(`view-publication-fence:${other.id}:run:37`)).toBe('2:other');

    const count = async (sql: string, ...args: any[]) => Number(((await store.db.prepare(sql).get(...args)) as any).n);
    expect((await count('SELECT COUNT(*) n FROM tasks WHERE id=?', t.id))).toBe(0);
    expect((await count('SELECT COUNT(*) n FROM events WHERE taskId=?', t.id))).toBe(0);
    expect((await count('SELECT COUNT(*) n FROM task_confirmation WHERE taskId=?', t.id))).toBe(0);
    expect((await count('SELECT COUNT(*) n FROM confirmation_votes WHERE taskId=?', t.id))).toBe(0);
    expect((await count('SELECT COUNT(*) n FROM collaboration_requests'))).toBe(0);
    expect((await count('SELECT COUNT(*) n FROM world_instances WHERE worldId=?', t.id))).toBe(0);
    expect((await count('SELECT COUNT(*) n FROM inbox WHERE taskId=?', t.id))).toBe(0);
    // claimDelivery inner-joins inbox, so an orphaned outbox row would be
    // permanently unclaimable — it must go with its inbox row.
    expect((await count('SELECT COUNT(*) n FROM delivery_outbox'))).toBe(0);
  });

  it('routes only a genuine review REQUEST to the review audience', () => {
    // `ev.type.includes('review')` is a substring match on an open vocabulary:
    // every `preview.*` type contains it, and so would any package-declared type.
    // Matching a whole `review` segment fixed that but still swept in
    // `review.built`, which a task emits on every agent turn — dozens of
    // identical "review requested" rows for one task actually sitting in review.
    expect(isReviewRequestEvent('software-dev.review-requested')).toBe(true);
    expect(isReviewRequestEvent('review.requested')).toBe(true);
    expect(isReviewRequestEvent('review.built')).toBe(false);
    expect(isReviewRequestEvent('github.pr.review')).toBe(false);
    expect(isReviewRequestEvent('preview.requested')).toBe(false);
    expect(isReviewRequestEvent('preview.active')).toBe(false);
    expect(isReviewRequestEvent('world.preview-created')).toBe(false);
    expect(isReviewRequestEvent('agent.previewed')).toBe(false);
  });

  it('chunks IN(...) deletes past SQLite\'s variable limit', async () => {
    const project = (await store.createProject('Big'));
    // 40k ids exceeds SQLITE_MAX_VARIABLE_NUMBER (32,766) — one placeholder each
    // used to make deleteProject a hard error for a large project.
    const ids = Array.from({ length: 40_000 }, (_, i) => `t_${i}`);
    (await store.db.prepare("INSERT INTO task_tags (taskId, tagId) VALUES ('t_5', 'tag_x')").run());
    expect(() => deleteRows(store.db as any, 'task_tags', 'taskId', ids)).not.toThrow();
    expect(Number(((await store.db.prepare('SELECT COUNT(*) n FROM task_tags').get()) as any).n)).toBe(0);
    expect(project.id).toBeTruthy();
  });

  it('a write waits out another process holding the write lock (no "database is locked")', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-lock-'));
    const dbPath = path.join(dir, 'karmax.db');
    const s = (await Store.create(dbPath));
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
      (await s.upsertProfile({ id: 'p-lock', name: 'P', role: 'do', provider: 'mock', capabilities: [] } as any));
      expect((await s.getProfile('p-lock'))!.name).toBe('P');
    } finally {
      child.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
