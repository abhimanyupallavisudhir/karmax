import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Store } from '../src/store/db.js';

/**
 * The inbox is a list of LIVE asks, not a copy of the event log. These tests pin
 * the three properties that made the real one unusable (2,492 unread rows over
 * 216 tasks): every lifecycle tick minted a new row, machine waits were reported
 * as review requests, and nothing was ever removed once it had been answered.
 */

function fixture() {
  const store = new Store(':memory:');
  const organization = store.createOrganization({ name: 'Team', ownerUserId: 'owner' });
  store.setOrganizationMembership(organization.id, 'reviewer', 'member');
  const project = store.createProject('App', {}, organization.id);
  store.setProjectMembership(project.id, { kind: 'user', userId: 'reviewer' }, 'reviewer');
  const task = store.createTask({ projectId: project.id, title: 'Ship', workflow: 'software-dev',
    workflowVersion: '1.0.0', params: { prompt: 'ship it' }, createdBy: { kind: 'user', userId: 'owner' } });
  store.setTaskResponsibility(task.id, {
    confirmationPolicy: { targets: [{ kind: 'project-role', projectId: project.id, role: 'reviewer' }], rule: 'any' },
  });
  const view = (patch: Record<string, unknown>) => {
    const next = { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'do', status: 'active',
      messages: [], actions: [], state: {}, updatedAt: Date.now(), ...patch } as any;
    store.saveView(task.id, next);
    store.appendEvent({ taskId: task.id, type: 'view.updated', ts: Date.now(), payload: {
      stage: next.stage, status: next.status, waitingFor: next.waitingFor?.kind ?? null,
    } });
  };
  const inbox = (userId = 'reviewer') => store.listInbox(userId, organization.id);
  // A second task in the same project, with its own live view, so ordering across
  // asks can be tested (one task holds at most one actionable row per user).
  const other = (title: string, patch: Record<string, unknown>) => {
    const extra = store.createTask({ projectId: project.id, title, workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: title }, createdBy: { kind: 'user', userId: 'owner' } });
    store.setTaskResponsibility(extra.id, {
      confirmationPolicy: { targets: [{ kind: 'project-role', projectId: project.id, role: 'reviewer' }], rule: 'any' },
    });
    const next = { taskId: extra.id, title, workflow: 'software-dev', stage: 'do', status: 'active',
      messages: [], actions: [], state: {}, updatedAt: Date.now(), ...patch } as any;
    store.saveView(extra.id, next);
    return { task: extra, next };
  };
  return { store, organization, project, task, view, inbox, other };
}

const humanWait = (stage: string) => ({ stage, status: 'waiting', waitingFor: { kind: 'human', audience: ['user:reviewer'] } });

describe('inbox', () => {
  it('keeps dismissed approvals silent across waiting lifecycle ticks', () => {
    const f = fixture();
    f.store.appendEvent({ taskId: f.task.id, type: 'permission.approval-requested', ts: Date.now(),
      payload: { requestId: 'request', recipients: ['reviewer'] } });
    expect(f.inbox()).toHaveLength(1);
    f.store.appendEvent({ taskId: f.task.id, type: 'permission.approval-dismissed', ts: Date.now(),
      payload: { requestId: 'request' } });
    expect(f.inbox()).toEqual([]);
    f.view({ status: 'waiting', waitingFor: { kind: 'human' } });
    expect(f.inbox()).toEqual([]);
    f.store.pruneStaleInbox();
    expect(f.inbox()).toEqual([]);
  });

  it('keeps one row per ask instead of one per lifecycle event', () => {
    const f = fixture();
    f.view(humanWait('review'));
    const first = f.inbox();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ kind: 'review-requested', actionable: true, unread: true });

    // The same ask, re-published a dozen times while the task sits in review.
    for (let i = 0; i < 12; i++) f.view(humanWait('review'));
    const collapsed = f.inbox();
    expect(collapsed).toHaveLength(1);
    // The ask keeps its original age — a repeat is not "just now".
    expect(collapsed[0]!.createdAt).toBe(first[0]!.createdAt);
    expect(collapsed[0]!.id).toBe(first[0]!.id);
  });

  it('does not report machine waits or internal review events as an ask', () => {
    const f = fixture();
    f.view({ stage: 'do', status: 'waiting', waitingFor: { kind: 'account' } });
    f.view({ stage: 'do', status: 'waiting', waitingFor: { kind: 'agentSlot' } });
    f.view({ stage: 'merge', status: 'waiting', waitingFor: { kind: 'mergeSlot' } });
    f.store.appendEvent({ taskId: f.task.id, type: 'review.built', ts: Date.now(), payload: { files: 12 } });
    expect(f.inbox()).toEqual([]);
  });

  it('splits a human wait into review vs escalation by stage', () => {
    const f = fixture();
    f.view(humanWait('review'));
    expect(f.inbox().map((item) => item.kind)).toEqual(['review-requested']);
    f.view({ stage: 'do', status: 'active' });
    f.view(humanWait('do'));
    expect(f.inbox().map((item) => item.kind)).toEqual(['escalated']);
  });

  it('removes an ask once the task stops waiting on a human', () => {
    const f = fixture();
    f.view(humanWait('review'));
    expect(f.inbox()).toHaveLength(1);
    f.view({ stage: 'merge', status: 'waiting', waitingFor: { kind: 'mergeSlot' } });
    expect(f.inbox()).toEqual([]);
  });

  it('clears every ask when the task finishes and leaves one update', () => {
    const f = fixture();
    f.store.subscribeTask(f.task.id, { kind: 'user', userId: 'reviewer' });
    f.view(humanWait('review'));
    expect(f.inbox()).toHaveLength(1);
    f.view({ stage: 'done', status: 'done' });
    expect(f.inbox().map((item) => item.kind)).toEqual(['update']);
    expect(f.inbox()[0]).toMatchObject({ actionable: false });
    // A duplicate terminal event (a finishing task emits several) is not news twice.
    f.view({ stage: 'done', status: 'done' });
    expect(f.inbox()).toHaveLength(1);
    // ...and once the task runs again its old outcome stops being current.
    f.view({ stage: 'do', status: 'active' });
    expect(f.inbox()).toEqual([]);
  });

  it('supersedes the previous ask on the same task rather than stacking asks', () => {
    const f = fixture();
    f.store.setTaskResponsibility(f.task.id, { assignee: { kind: 'user', userId: 'reviewer' } });
    expect(f.inbox().map((item) => item.kind)).toEqual(['assigned']);
    f.view(humanWait('review'));
    expect(f.inbox().map((item) => item.kind)).toEqual(['review-requested']);
  });

  it('drops an approval ask only once every request on the task is resolved', () => {
    const f = fixture();
    const request = (requestId: string) => f.store.appendEvent({ taskId: f.task.id,
      type: 'credential.approval-requested', ts: Date.now(), payload: { requestId, status: 'approval-needed' } });
    const resolve = (requestId: string) => f.store.appendEvent({ taskId: f.task.id,
      type: 'credential.approval-resolved', ts: Date.now(), payload: { requestId, action: 'task' } });
    request('vreq_1');
    request('vreq_2');
    expect(f.inbox('owner').map((item) => item.kind)).toEqual(['approval-requested']);
    resolve('vreq_1');
    expect(f.inbox('owner').map((item) => item.kind)).toEqual(['approval-requested']);
    resolve('vreq_2');
    expect(f.inbox('owner')).toEqual([]);
  });

  it('leaves the approval ask in place while the task parks on a human for it', () => {
    const f = fixture();
    f.store.appendEvent({ taskId: f.task.id, type: 'permission.approval-requested', ts: Date.now(),
      payload: { requestId: 'preq_1', recipients: ['reviewer'] } });
    f.view(humanWait('do'));
    expect(f.inbox().map((item) => item.kind)).toEqual(['approval-requested']);
  });

  it('collapses and prunes a legacy event-per-row inbox on boot', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-inbox-mig-'));
    const dbPath = path.join(dir, 'karmax.db');
    const legacy = new Store(dbPath);
    const organization = legacy.createOrganization({ name: 'Team', ownerUserId: 'owner' });
    const project = legacy.createProject('App', {}, organization.id);
    const task = legacy.createTask({ projectId: project.id, title: 'Ship', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'ship it' }, createdBy: { kind: 'user', userId: 'owner' } });
    const live = legacy.createTask({ projectId: project.id, title: 'Still going', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'go' }, createdBy: { kind: 'user', userId: 'owner' } });
    const base = { taskId: task.id, title: 'Ship', workflow: 'software-dev', messages: [], actions: [], state: {}, updatedAt: 1 } as any;
    legacy.saveView(task.id, { ...base, stage: 'done', status: 'done' });
    legacy.saveView(live.id, { ...base, taskId: live.id, stage: 'review', status: 'waiting',
      waitingFor: { kind: 'human', audience: ['@creator'] } });
    // The shape older builds wrote: one row per event, none ever removed.
    legacy.db.exec('DROP INDEX idx_inbox_live');
    for (let seq = 1; seq <= 40; seq++) {
      legacy.db.prepare(`INSERT INTO inbox (id, organizationId, userId, eventSeq, taskId, kind, unread, actionable, createdAt)
        VALUES (?, ?, 'owner', ?, ?, 'review-requested', 1, 1, ?)`)
        .run(`inbox_legacy_${seq}`, organization.id, seq, seq <= 30 ? task.id : live.id, 1000 + seq);
      legacy.db.prepare(`INSERT INTO delivery_outbox (id, inboxId, channel, state, attempts, nextAt, createdAt)
        VALUES (?, ?, 'browser', 'pending', 0, 0, 0)`).run(`delivery_legacy_${seq}`, `inbox_legacy_${seq}`);
    }
    legacy.close();

    const migrated = new Store(dbPath);
    const items = migrated.listInbox('owner', organization.id);
    expect(items).toHaveLength(1);                       // the finished task's 30 rows are gone
    expect(items[0]).toMatchObject({ taskId: live.id, kind: 'review-requested' });
    expect(items[0]!.createdAt).toBe(1031);              // the surviving row keeps the ask's true age
    // Deliveries never outlive the row they belong to: `claimDelivery` inner-joins
    // `inbox`, so an orphan would sit in the outbox forever.
    const orphans = migrated.db.prepare(`SELECT COUNT(*) c FROM delivery_outbox d
      LEFT JOIN inbox i ON i.id = d.inboxId WHERE i.id IS NULL`).get() as any;
    expect(Number(orphans.c)).toBe(0);
    migrated.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * Urgency is how loudly an ask asks. The requester states it once; the inbox
 * orders by it before anything else, so the thing that most needs a person is
 * the thing they see first.
 */
describe('inbox urgency', () => {
  it('gives each kind of ask a sensible level when nobody said', () => {
    // An approval blocks an agent on a person: it is the one ask that starts high.
    const approval = fixture();
    approval.store.appendEvent({ taskId: approval.task.id, type: 'credential.approval-requested',
      ts: Date.now(), payload: { requestId: 'vreq_1', status: 'approval-needed' } });
    expect(approval.inbox('owner')[0]).toMatchObject({ kind: 'approval-requested', urgency: 'high' });

    const review = fixture();
    review.view(humanWait('review'));
    expect(review.inbox()[0]).toMatchObject({ kind: 'review-requested', urgency: 'normal' });

    // An outcome report asks nothing of anyone, so it sits at the bottom.
    const outcome = fixture();
    outcome.store.subscribeTask(outcome.task.id, { kind: 'user', userId: 'reviewer' });
    outcome.view({ stage: 'done', status: 'done' });
    expect(outcome.inbox()).toEqual([expect.objectContaining({ kind: 'update', urgency: 'low' })]);
  });

  it('takes the urgency the agent stated, and keeps it while the ask is restated', () => {
    const f = fixture();
    f.store.appendEvent({ taskId: f.task.id, type: 'task.escalated', ts: Date.now(),
      payload: { audience: ['user:reviewer'], detail: 'the disk is filling up', urgency: 'critical' } });
    expect(f.inbox()[0]).toMatchObject({ kind: 'escalated', urgency: 'critical' });

    // The lifecycle ticks that follow restate the same ask and carry no urgency.
    // They must not quietly demote it back to the kind's default.
    f.view(humanWait('do'));
    f.view(humanWait('do'));
    expect(f.inbox()).toHaveLength(1);
    expect(f.inbox()[0]).toMatchObject({ urgency: 'critical' });

    // Nonsense is not an error — urgency is advisory metadata and must never be
    // the reason an escalation fails to reach anyone.
    const g = fixture();
    g.store.appendEvent({ taskId: g.task.id, type: 'task.escalated', ts: Date.now(),
      payload: { audience: ['user:reviewer'], detail: 'hi', urgency: 'EXTREMELY' } });
    expect(g.inbox()[0]).toMatchObject({ urgency: 'normal' });
  });

  it('puts the most urgent ask first, whatever its age', () => {
    const f = fixture();
    const wait = { status: 'waiting', waitingFor: { kind: 'human', audience: ['user:reviewer'] } };
    const raise = (title: string, urgency: string | undefined, ts: number) => {
      const { task } = f.other(title, { stage: 'do', ...wait });
      f.store.appendEvent({ taskId: task.id, type: 'task.escalated', ts,
        payload: { audience: ['user:reviewer'], detail: title, ...(urgency ? { urgency } : {}) } });
    };
    raise('oldest, but critical', 'critical', 1_000);
    raise('newest, but low', 'low', 3_000);
    raise('middling', undefined, 2_000);
    raise('also critical, older', 'critical', 500);

    expect(f.inbox().map((item) => item.urgency)).toEqual(['critical', 'critical', 'normal', 'low']);
    // Ties fall back to recency, so equally urgent asks still read newest-first.
    expect(f.inbox().slice(0, 2).map((item) => item.createdAt)).toEqual([1_000, 500]);

    // A limit therefore truncates the quiet tail, never the loud head.
    expect(f.store.listInbox('reviewer', f.organization.id, { limit: 1 })[0])
      .toMatchObject({ urgency: 'critical', createdAt: 1_000 });
  });

  it('adds the column to an inbox that predates it, reading old asks as normal', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-urgency-mig-'));
    const dbPath = path.join(dir, 'karmax.db');
    const before = new Store(dbPath);
    const organization = before.createOrganization({ name: 'Team', ownerUserId: 'owner' });
    const project = before.createProject('App', {}, organization.id);
    const task = before.createTask({ projectId: project.id, title: 'Ship', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'ship it' }, createdBy: { kind: 'user', userId: 'owner' } });
    before.saveView(task.id, { taskId: task.id, title: 'Ship', workflow: 'software-dev', stage: 'review',
      status: 'waiting', waitingFor: { kind: 'human', audience: ['@creator'] },
      messages: [], actions: [], state: {}, updatedAt: 1 } as any);
    before.db.prepare(`INSERT INTO inbox (id, organizationId, userId, eventSeq, taskId, kind, unread, actionable, createdAt)
      VALUES ('inbox_old', ?, 'owner', 1, ?, 'review-requested', 1, 1, 1000)`).run(organization.id, task.id);
    // Exactly the schema shipped before urgency existed.
    before.db.exec('ALTER TABLE inbox DROP COLUMN urgency');
    before.close();

    const migrated = new Store(dbPath);
    expect(migrated.listInbox('owner', organization.id)).toEqual([
      expect.objectContaining({ id: 'inbox_old', urgency: 'normal' }),
    ]);
    migrated.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
