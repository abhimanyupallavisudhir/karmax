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

async function fixture() {
  const store = (await Store.create(':memory:'));
  const organization = (await store.createOrganization({ name: 'Team', ownerUserId: 'owner' }));
  (await store.setOrganizationMembership(organization.id, 'reviewer', 'member'));
  const project = (await store.createProject('App', {}, organization.id));
  (await store.setProjectMembership(project.id, { kind: 'user', userId: 'reviewer' }, 'reviewer'));
  const task = (await store.createTask({ projectId: project.id, title: 'Ship', workflow: 'software-dev',
    workflowVersion: '1.0.0', params: { prompt: 'ship it' }, createdBy: { kind: 'user', userId: 'owner' } }));
  (await store.setTaskResponsibility(task.id, {
    confirmationPolicy: { targets: [{ kind: 'project-role', projectId: project.id, role: 'reviewer' }], rule: 'any' },
  }));
  const view = async (patch: Record<string, unknown>) => {
    const next = { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'do', status: 'active',
      messages: [], actions: [], state: {}, updatedAt: Date.now(), ...patch } as any;
    (await store.saveView(task.id, next));
    (await store.appendEvent({ taskId: task.id, type: 'view.updated', ts: Date.now(), payload: {
      stage: next.stage, status: next.status, waitingFor: next.waitingFor?.kind ?? null,
    } }));
  };
  const inbox = async (userId = 'reviewer') => (await store.listInbox(userId, organization.id));
  // A second task in the same project, with its own live view, so ordering across
  // asks can be tested (one task holds at most one actionable row per user).
  const other = async (title: string, patch: Record<string, unknown>) => {
    const extra = (await store.createTask({ projectId: project.id, title, workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: title }, createdBy: { kind: 'user', userId: 'owner' } }));
    (await store.setTaskResponsibility(extra.id, {
      confirmationPolicy: { targets: [{ kind: 'project-role', projectId: project.id, role: 'reviewer' }], rule: 'any' },
    }));
    const next = { taskId: extra.id, title, workflow: 'software-dev', stage: 'do', status: 'active',
      messages: [], actions: [], state: {}, updatedAt: Date.now(), ...patch } as any;
    (await store.saveView(extra.id, next));
    return { task: extra, next };
  };
  return { store, organization, project, task, view, inbox, other };
}

const humanWait = (stage: string) => ({ stage, status: 'waiting', waitingFor: { kind: 'human', audience: ['user:reviewer'] } });

describe('inbox', () => {
  it('keeps dismissed approvals silent across waiting lifecycle ticks', async () => {
    const f = (await fixture());
    (await f.store.appendEvent({ taskId: f.task.id, type: 'permission.approval-requested', ts: Date.now(),
      payload: { requestId: 'request', recipients: ['reviewer'] } }));
    expect((await f.inbox())).toHaveLength(1);
    (await f.store.appendEvent({ taskId: f.task.id, type: 'permission.approval-dismissed', ts: Date.now(),
      payload: { requestId: 'request' } }));
    expect((await f.inbox())).toEqual([]);
    (await f.view({ status: 'waiting', waitingFor: { kind: 'human' } }));
    expect((await f.inbox())).toEqual([]);
    (await f.store.pruneStaleInbox());
    expect((await f.inbox())).toEqual([]);
  });

  it('keeps a connection ask visible while another approval is dismissed', async () => {
    const f = (await fixture());
    try {
      (await f.store.appendEvent({ taskId: f.task.id, type: 'connection.requested', ts: Date.now(),
        payload: { requestId: 'connection' } }));
      (await f.store.appendEvent({ taskId: f.task.id, type: 'permission.approval-requested', ts: Date.now(),
        payload: { requestId: 'permission', recipients: ['owner'] } }));
      (await f.store.appendEvent({ taskId: f.task.id, type: 'permission.approval-dismissed', ts: Date.now(),
        payload: { requestId: 'permission' } }));
      (await f.store.pruneStaleInbox());
      expect((await f.inbox('owner'))).toEqual([expect.objectContaining({ kind: 'approval-requested', actionable: true })]);
      (await f.store.appendEvent({ taskId: f.task.id, type: 'connection.resolved', ts: Date.now(),
        payload: { requestId: 'connection' } }));
      expect((await f.inbox('owner'))).toEqual([]);
      (await f.view({ status: 'waiting', waitingFor: { kind: 'human' } }));
      (await f.store.pruneStaleInbox());
      expect((await f.inbox('owner'))).toEqual([]);
    } finally { (await f.store.close()); }
  });

  it('keeps one row per ask instead of one per lifecycle event', async () => {
    const f = (await fixture());
    (await f.view(humanWait('review')));
    const first = (await f.inbox());
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ kind: 'review-requested', actionable: true, unread: true });

    // The same ask, re-published a dozen times while the task sits in review.
    for (let i = 0; i < 12; i++) (await f.view(humanWait('review')));
    const collapsed = (await f.inbox());
    expect(collapsed).toHaveLength(1);
    // The ask keeps its original age — a repeat is not "just now".
    expect(collapsed[0]!.createdAt).toBe(first[0]!.createdAt);
    expect(collapsed[0]!.id).toBe(first[0]!.id);
  });

  it('does not report machine waits or internal review events as an ask', async () => {
    const f = (await fixture());
    (await f.view({ stage: 'do', status: 'waiting', waitingFor: { kind: 'account' } }));
    (await f.view({ stage: 'do', status: 'waiting', waitingFor: { kind: 'agentSlot' } }));
    (await f.view({ stage: 'merge', status: 'waiting', waitingFor: { kind: 'mergeSlot' } }));
    (await f.store.appendEvent({ taskId: f.task.id, type: 'review.built', ts: Date.now(), payload: { files: 12 } }));
    expect((await f.inbox())).toEqual([]);
  });

  it('splits a human wait into review vs escalation by stage', async () => {
    const f = (await fixture());
    (await f.view(humanWait('review')));
    expect((await f.inbox()).map((item) => item.kind)).toEqual(['review-requested']);
    (await f.view({ stage: 'do', status: 'active' }));
    (await f.view(humanWait('do')));
    expect((await f.inbox()).map((item) => item.kind)).toEqual(['escalated']);
  });

  it('removes an ask once the task stops waiting on a human', async () => {
    const f = (await fixture());
    (await f.view(humanWait('review')));
    expect((await f.inbox())).toHaveLength(1);
    (await f.view({ stage: 'merge', status: 'waiting', waitingFor: { kind: 'mergeSlot' } }));
    expect((await f.inbox())).toEqual([]);
  });

  it('clears every ask when the task finishes and leaves one update', async () => {
    const f = (await fixture());
    (await f.store.subscribeTask(f.task.id, { kind: 'user', userId: 'reviewer' }));
    (await f.view(humanWait('review')));
    expect((await f.inbox())).toHaveLength(1);
    (await f.view({ stage: 'done', status: 'done' }));
    expect((await f.inbox()).map((item) => item.kind)).toEqual(['update']);
    expect((await f.inbox())[0]).toMatchObject({ actionable: false });
    // A duplicate terminal event (a finishing task emits several) is not news twice.
    (await f.view({ stage: 'done', status: 'done' }));
    expect((await f.inbox())).toHaveLength(1);
    // ...and once the task runs again its old outcome stops being current.
    (await f.view({ stage: 'do', status: 'active' }));
    expect((await f.inbox())).toEqual([]);
  });

  it('supersedes the previous ask on the same task rather than stacking asks', async () => {
    const f = (await fixture());
    (await f.store.setTaskResponsibility(f.task.id, { assignee: { kind: 'user', userId: 'reviewer' } }));
    expect((await f.inbox()).map((item) => item.kind)).toEqual(['assigned']);
    (await f.view(humanWait('review')));
    expect((await f.inbox()).map((item) => item.kind)).toEqual(['review-requested']);
  });

  it('drops an approval ask only once every request on the task is resolved', async () => {
    const f = (await fixture());
    const request = async (requestId: string) => (await f.store.appendEvent({ taskId: f.task.id,
      type: 'credential.approval-requested', ts: Date.now(), payload: { requestId, status: 'approval-needed' } }));
    const resolve = async (requestId: string) => (await f.store.appendEvent({ taskId: f.task.id,
      type: 'credential.approval-resolved', ts: Date.now(), payload: { requestId, action: 'task' } }));
    (await request('vreq_1'));
    (await request('vreq_2'));
    expect((await f.inbox('owner')).map((item) => item.kind)).toEqual(['approval-requested']);
    (await resolve('vreq_1'));
    expect((await f.inbox('owner')).map((item) => item.kind)).toEqual(['approval-requested']);
    (await resolve('vreq_2'));
    expect((await f.inbox('owner'))).toEqual([]);
  });

  it('leaves the approval ask in place while the task parks on a human for it', async () => {
    const f = (await fixture());
    (await f.store.appendEvent({ taskId: f.task.id, type: 'permission.approval-requested', ts: Date.now(),
      payload: { requestId: 'preq_1', recipients: ['reviewer'] } }));
    (await f.view(humanWait('do')));
    expect((await f.inbox()).map((item) => item.kind)).toEqual(['approval-requested']);
  });

  it('collapses and prunes a legacy event-per-row inbox on boot', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-inbox-mig-'));
    const dbPath = path.join(dir, 'karmax.db');
    const legacy = (await Store.create(dbPath));
    const organization = (await legacy.createOrganization({ name: 'Team', ownerUserId: 'owner' }));
    const project = (await legacy.createProject('App', {}, organization.id));
    const task = (await legacy.createTask({ projectId: project.id, title: 'Ship', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'ship it' }, createdBy: { kind: 'user', userId: 'owner' } }));
    const live = (await legacy.createTask({ projectId: project.id, title: 'Still going', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'go' }, createdBy: { kind: 'user', userId: 'owner' } }));
    const base = { taskId: task.id, title: 'Ship', workflow: 'software-dev', messages: [], actions: [], state: {}, updatedAt: 1 } as any;
    (await legacy.saveView(task.id, { ...base, stage: 'done', status: 'done' }));
    (await legacy.saveView(live.id, { ...base, taskId: live.id, stage: 'review', status: 'waiting',
      waitingFor: { kind: 'human', audience: ['@creator'] } }));
    // The shape older builds wrote: one row per event, none ever removed.
    (await legacy.db.exec('DROP INDEX idx_inbox_live'));
    for (let seq = 1; seq <= 40; seq++) {
      (await legacy.db.prepare(`INSERT INTO inbox (id, organizationId, userId, eventSeq, taskId, kind, unread, actionable, createdAt)
        VALUES (?, ?, 'owner', ?, ?, 'review-requested', 1, 1, ?)`)
        .run(`inbox_legacy_${seq}`, organization.id, seq, seq <= 30 ? task.id : live.id, 1000 + seq));
      (await legacy.db.prepare(`INSERT INTO delivery_outbox (id, inboxId, channel, state, attempts, nextAt, createdAt)
        VALUES (?, ?, 'browser', 'pending', 0, 0, 0)`).run(`delivery_legacy_${seq}`, `inbox_legacy_${seq}`));
    }
    (await legacy.close());

    const migrated = (await Store.create(dbPath));
    const items = (await migrated.listInbox('owner', organization.id));
    expect(items).toHaveLength(1);                       // the finished task's 30 rows are gone
    expect(items[0]).toMatchObject({ taskId: live.id, kind: 'review-requested' });
    expect(items[0]!.createdAt).toBe(1031);              // the surviving row keeps the ask's true age
    // Deliveries never outlive the row they belong to: `claimDelivery` inner-joins
    // `inbox`, so an orphan would sit in the outbox forever.
    const orphans = (await migrated.db.prepare(`SELECT COUNT(*) c FROM delivery_outbox d
      LEFT JOIN inbox i ON i.id = d.inboxId WHERE i.id IS NULL`).get()) as any;
    expect(Number(orphans.c)).toBe(0);
    (await migrated.close());
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * Urgency is how loudly an ask asks. The requester states it once; the inbox
 * orders by it before anything else, so the thing that most needs a person is
 * the thing they see first.
 */
describe('inbox urgency', () => {
  it('gives each kind of ask a sensible level when nobody said', async () => {
    // An approval blocks an agent on a person: it is the one ask that starts high.
    const approval = (await fixture());
    (await approval.store.appendEvent({ taskId: approval.task.id, type: 'credential.approval-requested',
      ts: Date.now(), payload: { requestId: 'vreq_1', status: 'approval-needed' } }));
    expect((await approval.inbox('owner'))[0]).toMatchObject({ kind: 'approval-requested', urgency: 'high' });

    const review = (await fixture());
    (await review.view(humanWait('review')));
    expect((await review.inbox())[0]).toMatchObject({ kind: 'review-requested', urgency: 'normal' });

    // An outcome report asks nothing of anyone, so it sits at the bottom.
    const outcome = (await fixture());
    (await outcome.store.subscribeTask(outcome.task.id, { kind: 'user', userId: 'reviewer' }));
    (await outcome.view({ stage: 'done', status: 'done' }));
    expect((await outcome.inbox())).toEqual([expect.objectContaining({ kind: 'update', urgency: 'low' })]);
  });

  it('takes the urgency the agent stated, and keeps it while the ask is restated', async () => {
    const f = (await fixture());
    (await f.store.appendEvent({ taskId: f.task.id, type: 'task.escalated', ts: Date.now(),
      payload: { audience: ['user:reviewer'], detail: 'the disk is filling up', urgency: 'critical' } }));
    expect((await f.inbox())[0]).toMatchObject({ kind: 'escalated', urgency: 'critical' });

    // The lifecycle ticks that follow restate the same ask and carry no urgency.
    // They must not quietly demote it back to the kind's default.
    (await f.view(humanWait('do')));
    (await f.view(humanWait('do')));
    expect((await f.inbox())).toHaveLength(1);
    expect((await f.inbox())[0]).toMatchObject({ urgency: 'critical' });

    // Nonsense is not an error — urgency is advisory metadata and must never be
    // the reason an escalation fails to reach anyone.
    const g = (await fixture());
    (await g.store.appendEvent({ taskId: g.task.id, type: 'task.escalated', ts: Date.now(),
      payload: { audience: ['user:reviewer'], detail: 'hi', urgency: 'EXTREMELY' } }));
    expect((await g.inbox())[0]).toMatchObject({ urgency: 'normal' });
  });

  it('puts the most urgent ask first, whatever its age', async () => {
    const f = (await fixture());
    const wait = { status: 'waiting', waitingFor: { kind: 'human', audience: ['user:reviewer'] } };
    const raise = async (title: string, urgency: string | undefined, ts: number) => {
      const { task } = (await f.other(title, { stage: 'do', ...wait }));
      (await f.store.appendEvent({ taskId: task.id, type: 'task.escalated', ts,
        payload: { audience: ['user:reviewer'], detail: title, ...(urgency ? { urgency } : {}) } }));
    };
    (await raise('oldest, but critical', 'critical', 1_000));
    (await raise('newest, but low', 'low', 3_000));
    (await raise('middling', undefined, 2_000));
    (await raise('also critical, older', 'critical', 500));

    expect((await f.inbox()).map((item) => item.urgency)).toEqual(['critical', 'critical', 'normal', 'low']);
    // Ties fall back to recency, so equally urgent asks still read newest-first.
    expect((await f.inbox()).slice(0, 2).map((item) => item.createdAt)).toEqual([1_000, 500]);

    // A limit therefore truncates the quiet tail, never the loud head.
    expect((await f.store.listInbox('reviewer', f.organization.id, { limit: 1 }))[0])
      .toMatchObject({ urgency: 'critical', createdAt: 1_000 });
  });

  it('adds the column to an inbox that predates it, reading old asks as normal', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-urgency-mig-'));
    const dbPath = path.join(dir, 'karmax.db');
    const before = (await Store.create(dbPath));
    const organization = (await before.createOrganization({ name: 'Team', ownerUserId: 'owner' }));
    const project = (await before.createProject('App', {}, organization.id));
    const task = (await before.createTask({ projectId: project.id, title: 'Ship', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'ship it' }, createdBy: { kind: 'user', userId: 'owner' } }));
    (await before.saveView(task.id, { taskId: task.id, title: 'Ship', workflow: 'software-dev', stage: 'review',
      status: 'waiting', waitingFor: { kind: 'human', audience: ['@creator'] },
      messages: [], actions: [], state: {}, updatedAt: 1 } as any));
    (await before.db.prepare(`INSERT INTO inbox (id, organizationId, userId, eventSeq, taskId, kind, unread, actionable, createdAt)
      VALUES ('inbox_old', ?, 'owner', 1, ?, 'review-requested', 1, 1, 1000)`).run(organization.id, task.id));
    // Exactly the schema shipped before urgency existed.
    (await before.db.exec('ALTER TABLE inbox DROP COLUMN urgency'));
    (await before.close());

    const migrated = (await Store.create(dbPath));
    expect((await migrated.listInbox('owner', organization.id))).toEqual([
      expect.objectContaining({ id: 'inbox_old', urgency: 'normal' }),
    ]);
    (await migrated.close());
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
