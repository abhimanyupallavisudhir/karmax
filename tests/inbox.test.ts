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
  return { store, organization, project, task, view, inbox };
}

const humanWait = (stage: string) => ({ stage, status: 'waiting', waitingFor: { kind: 'human', audience: ['user:reviewer'] } });

describe('inbox', () => {
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
