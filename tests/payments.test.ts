import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { cardRemaining, evaluateSpend, MockPaymentProvider, StripeIssuingProvider, PaymentRegistry, BudgetService } from '../src/autonomy/payments.js';
import { Store } from '../src/store/db.js';

describe('payment providers — the connect surface (SPEC §7.6, task 1g)', () => {
  it('lists local (connected) + Stripe (oauth, needs connecting)', async () => {
    const reg = new PaymentRegistry();
    reg.register(new MockPaymentProvider((await Store.create(':memory:'))));
    reg.register(new StripeIssuingProvider());
    const list = (await reg.list());
    const mock = list.find((p) => p.name === 'mock')!;
    const stripe = list.find((p) => p.name === 'stripe')!;
    expect(mock).toMatchObject({ kind: 'local', available: true, connected: true });
    expect(stripe).toMatchObject({ kind: 'oauth', available: false, connected: false });
  });
  it('mock connects trivially; Stripe stays unavailable until the real rail exists', async () => {
    const prevId = process.env.STRIPE_CLIENT_ID;
    expect((await new MockPaymentProvider((await Store.create(':memory:'))).connect()).status).toBe('connected');
    expect((await new StripeIssuingProvider().connect()).status).toBe('unavailable');
    process.env.STRIPE_CLIENT_ID = 'ca_test123';
    const r = await new StripeIssuingProvider().connect();
    expect(r.status).toBe('unavailable');
    expect(r.detail).toContain('each organization');
    if (prevId === undefined) delete process.env.STRIPE_CLIENT_ID; else process.env.STRIPE_CLIENT_ID = prevId;
  });
});

describe('evaluateSpend (four outcomes; SPEC §7.6)', () => {
  const base = { amount: 100, spent: 0, available: 1000, hardCap: 100000 };
  it('grants within policy + funds', () => {
    expect(evaluateSpend({ ...base, allowance: 1000, threshold: 500 }).status).toBe('granted');
  });
  it('needs_approval over the agent allowance', () => {
    expect(evaluateSpend({ ...base, amount: 200, spent: 900, allowance: 1000 }).status).toBe('needs_approval');
  });
  it('ignores the removed review threshold', () => {
    expect(evaluateSpend({ ...base, amount: 600, allowance: 100000, threshold: 500 }).status).toBe('granted');
  });
  it('needs_funding when the card lacks money (policy ok)', () => {
    const d = evaluateSpend({ ...base, amount: 800, available: 300, allowance: 100000 });
    expect(d.status).toBe('needs_funding');
    expect(d.shortfall).toBe(500);
  });
  it('denied over the hard cap, regardless of allowance', () => {
    expect(evaluateSpend({ ...base, amount: 999999, allowance: 100000, available: 100000 }).status).toBe('denied');
  });
  it('denied on a disallowed merchant', () => {
    expect(evaluateSpend({ ...base, merchant: 'evil.com', merchantLock: ['good.com'] }).status).toBe('denied');
  });
  it('denied when a merchant-locked card request omits the merchant', () => {
    expect(evaluateSpend({ ...base, merchantLock: ['good.com'] }).status).toBe('denied');
  });
});

describe('BudgetService over the mock rail', () => {
  let store: Store;
  let provider: MockPaymentProvider;
  let budget: BudgetService;
  let projectId: string;
  beforeEach(async () => {
    store = (await Store.create(':memory:'));
    provider = new MockPaymentProvider(store);
    budget = new BudgetService(store, provider);
    projectId = (await store.createProject('P', {})).id;
    (await store.setSettings(projectId, 'payments', { budget: null }));
  });

  it('limits settled card fills by expiry and attempt count (AU-4)', async () => {
    const card = await provider.provisionCard({ scope: 'project', scopeId: projectId, label: 'Fill', cap: 1000 });
    await provider.fund(card.id, 1000);
    const ctx = { projectId, taskId: 'fill-task' , capabilities: ['use-card:*'] };
    const result = await budget.request(ctx, { amount: 100, merchant: 'shop.example.com' });
    for (let i = 0; i < 3; i++) expect((await budget.claimFill(ctx, result.requestId!)).domain).toBe('shop.example.com');
    await expect(budget.claimFill(ctx, result.requestId!)).rejects.toThrow(/limit/);
    await store.updatePaymentSpendRequest(result.requestId!, { expiresAt: Date.now() - 1 });
    await expect(budget.claimFill(ctx, result.requestId!)).rejects.toThrow(/active/);
  });

  it('refuses public suffixes as checkout domains (AU-4)', async () => {
    const card = await provider.provisionCard({ scope: 'project', scopeId: projectId, label: 'Fill', cap: 1000 });
    await provider.fund(card.id, 1000);
    const ctx = { projectId, taskId: 'suffix-task' , capabilities: ['use-card:*'] };
    const result = await budget.request(ctx, { amount: 100, merchant: 'co.uk' });
    await expect(budget.claimFill(ctx, result.requestId!)).rejects.toThrow(/domain/);
  });

  it('denies cards when no card capability is held (AU-7)', async () => {
    await provider.provisionCard({ scope: 'project', scopeId: projectId, label: 'Private', cap: 1000 });
    expect(await budget.cards({ projectId, taskId: 'no-grant', capabilities: [] })).toEqual([]);
  });

  it('shares a parent budget across children and tasks created by agents (AU-9)', async () => {
    const card = await provider.provisionCard({ scope: 'project', scopeId: projectId, label: 'Shared', cap: 10000 });
    await provider.fund(card.id, 10000);
    const params = { paymentPolicy: { budget: 100, cardIds: [card.id] }, _authorization: { capabilities: ['use-card:*'] } };
    const parent = await store.createTask({ projectId, title: 'Parent', workflow: 'software-dev', workflowVersion: '1', params });
    const a = await store.createTask({ projectId, title: 'Child A', workflow: 'software-dev', workflowVersion: '1', params, parentTaskId: parent.id });
    const b = await store.createTask({ projectId, title: 'Child B', workflow: 'software-dev', workflowVersion: '1', params,
      createdBy: { kind: 'task-agent', taskId: parent.id, role: 'do' } });
    expect((await budget.request({ projectId, taskId: a.id , capabilities: ['use-card:*'] }, { amount: 70 })).status).toBe('granted');
    expect((await budget.request({ projectId, taskId: b.id , capabilities: ['use-card:*'] }, { amount: 70 })).status).toBe('needs_approval');
    expect((await budget.request({ projectId, taskId: parent.id , capabilities: ['use-card:*'] }, { amount: 70 })).status).toBe('needs_approval');
  });

  it('needs_funding when no card is configured', async () => {
    const r = await budget.request({ projectId, taskId: 't1' , capabilities: ['use-card:*'] }, { amount: 100 });
    expect(r.status).toBe('needs_funding');
  });

  it('grants within funds, decrements available, and records spend', async () => {
    const card = await provider.provisionCard({ scope: 'project', scopeId: projectId, label: 'Ops', cap: 100000 });
    await provider.fund(card.id, 5000);
    const r = await budget.request({ projectId, taskId: 't1' , capabilities: ['use-card:*'] }, { amount: 2000 });
    expect(r.status).toBe('granted');
    expect(r.transactionId).toBeTruthy();
    expect((await provider.getCard(card.id))!.available).toBe(3000);
    expect(Number((await store.kvGet('spent:t1')))).toBe(2000);
  });

  it('needs_funding when the card is short, then grants after funding', async () => {
    const card = await provider.provisionCard({ scope: 'project', scopeId: projectId, label: 'Ops', cap: 100000 });
    await provider.fund(card.id, 1000);
    const task_t2 = await store.createTask({ projectId: projectId, title: 't2', workflow: 'just-do', workflowVersion: '1', params: { _authorization: { capabilities: ['use-card:*'] } } });
    let r = await budget.request({ projectId, taskId: task_t2.id , capabilities: ['use-card:*'] }, { amount: 4000 });
    expect(r.status).toBe('needs_funding');
    expect(r.shortfall).toBe(3000);
    // human funds the shortfall, then the held request settles
    await provider.fund(card.id, 3000);
    r = await budget.settleApproved({ projectId, taskId: task_t2.id , capabilities: ['use-card:*'] }, { amount: 4000, cardId: card.id });
    expect(r.status).toBe('granted');
    expect((await provider.getCard(card.id))!.available).toBe(0);
    const retry = await budget.request({ projectId, taskId: task_t2.id , capabilities: ['use-card:*'] }, { amount: 4000, cardId: card.id });
    expect(retry).toMatchObject({ status: 'granted', requestId: r.requestId, transactionId: r.transactionId });
    expect((await provider.getCard(card.id))!.available).toBe(0);
  });

  it('denying an already-settled request does not refund the allowance', async () => {
    const card = await provider.provisionCard({ scope: 'project', scopeId: projectId, label: 'Ops', cap: 100000 });
    await provider.fund(card.id, 5000);
    const r = await budget.request({ projectId, taskId: 't-deny' , capabilities: ['use-card:*'] }, { amount: 2000 });
    expect(r.status).toBe('granted');
    const spentAfterCharge = Number((await store.kvGet('spent:t-deny')));
    expect(spentAfterCharge).toBe(2000);
    const availableAfterCharge = (await provider.getCard(card.id))!.available;

    // A reviewer clicks Deny on a stale list, after the immediate rail already
    // settled the charge. `deny` had no status guard, so it flipped the SETTLED row
    // to `denied`; `paymentSpent` counts only consumed/settled/authorized rows, so
    // the money vanished from the allowance while the merchant had really been
    // paid — the agent got that budget back and could spend it twice.
    const denied = (await budget.deny(r.requestId!, 'user:alice'));
    expect(denied.status).not.toBe('denied');
    expect(Number((await store.kvGet('spent:t-deny')))).toBe(spentAfterCharge);
    expect((await provider.getCard(card.id))!.available).toBe(availableAfterCharge);
  });

  it('needs_approval over the configured allowance', async () => {
    const card = await provider.provisionCard({ scope: 'project', scopeId: projectId, label: 'Ops', cap: 100000 });
    await provider.fund(card.id, 100000);
    (await store.setSettings(projectId, 'payments', { allowance: 1000 }));
    const r = await budget.request({ projectId, taskId: 't3' , capabilities: ['use-card:*'] }, { amount: 5000 });
    expect(r.status).toBe('needs_approval');
  });

  it('does not let an explicit card id escape the project organization', async () => {
    const other = (await store.createOrganization({ name: 'Other' }));
    const otherProject = (await store.createProject('Other project', {}, other.id));
    const card = await provider.provisionCard({ scope: 'project', scopeId: otherProject.id, label: 'Other card', cap: 100000 });
    await provider.fund(card.id, 100000);
    const r = await budget.request({ projectId, taskId: 't4' , capabilities: ['use-card:*'] }, { amount: 100, cardId: card.id });
    expect(r.status).toBe('denied');
    expect(r.reason).toContain('not available');
    expect((await provider.getCard(card.id))!.available).toBe(100000);
  });

  it('uses the owning organization payment policy, not installation-global policy', async () => {
    const other = (await store.createOrganization({ name: 'Other' }));
    const otherProject = (await store.createProject('Other project', {}, other.id));
    const card = await provider.provisionCard({ scope: 'project', scopeId: otherProject.id, label: 'Other card', cap: 100000 });
    await provider.fund(card.id, 100000);
    (await store.setSettings('global', 'payments', { allowance: 1 }));
    (await store.setSettings(`organization:${other.id}`, 'payments', { allowance: 1000 }));
    const r = await budget.request({ projectId: otherProject.id, organizationId: other.id, taskId: 't5', capabilities: ['use-card:*'] }, { amount: 100 });
    expect(r.status).toBe('granted');
  });

  it('selects only cards attenuated by use-card capabilities', async () => {
    const first = await provider.provisionCard({ scope: 'project', scopeId: projectId, label: 'First', cap: 100000 });
    const permitted = await provider.provisionCard({ scope: 'project', scopeId: projectId, label: 'Permitted', cap: 100000 });
    await provider.fund(first.id, 1000);
    await provider.fund(permitted.id, 1000);
    const r = await budget.request(
      { projectId, taskId: 'card-cap', capabilities: [`use-card:${permitted.id}`] },
      { amount: 250, why: 'capability routing' },
    );
    expect(r).toMatchObject({ status: 'granted', cardId: permitted.id });
    expect((await provider.getCard(first.id))!.available).toBe(1000);
    expect((await provider.getCard(permitted.id))!.available).toBe(750);
  });

  it('enforces the card hard cap cumulatively, not once per purchase', async () => {
    const card = await provider.provisionCard({ scope: 'project', scopeId: projectId, label: 'Capped', cap: 500 });
    await provider.fund(card.id, 2000);
    expect((await budget.request({ projectId, taskId: 'cap-a' , capabilities: ['use-card:*'] },
      { amount: 300, cardId: card.id, why: 'first' })).status).toBe('granted');
    const second = await budget.request({ projectId, taskId: 'cap-b' , capabilities: ['use-card:*'] },
      { amount: 300, cardId: card.id, why: 'second' });
    expect(second).toMatchObject({ status: 'denied', reason: 'exceeds the card hard cap' });
    expect((await provider.getCard(card.id))!.available).toBe(1700);
  });

  it('re-counts the card cap at the review gate, not only when the spend is requested', async () => {
    const card = await provider.provisionCard({ scope: 'project', scopeId: projectId, label: 'Capped', cap: 500 });
    await provider.fund(card.id, 5000);
    (await store.setSettings(projectId, 'payments', { budget: 100 }));
    // Both clear the request-time check independently — 300 ≤ the full 500 cap,
    // because neither is counted until the gate decides. Approving both would put
    // 600 on a card capped at 500: the cumulative ceiling has to be re-counted
    // here, exactly as the budget coordinator does (src/coordinators/budget.ts).
    const task_gate_a = await store.createTask({ projectId: projectId, title: 'gate-a', workflow: 'just-do', workflowVersion: '1', params: { _authorization: { capabilities: ['use-card:*'] } } });
    const first = await budget.request({ projectId, taskId: task_gate_a.id , capabilities: ['use-card:*'] }, { amount: 300, cardId: card.id, why: 'first' });
    const task_gate_b = await store.createTask({ projectId: projectId, title: 'gate-b', workflow: 'just-do', workflowVersion: '1', params: { _authorization: { capabilities: ['use-card:*'] } } });
    const second = await budget.request({ projectId, taskId: task_gate_b.id , capabilities: ['use-card:*'] }, { amount: 300, cardId: card.id, why: 'second' });
    expect([first.status, second.status]).toEqual(['needs_approval', 'needs_approval']);
    expect((await budget.approve(first.requestId!, 'user:alice')).status).toBe('granted');
    expect(await budget.approve(second.requestId!, 'user:alice'))
      .toMatchObject({ status: 'denied', reason: 'exceeds the card hard cap' });
    expect((await store.cardPaymentSpent(card.id))).toBe(300);
  });

  it('reports what is left of the cap, bounded by the funds the rail reports', async () => {
    const card = await provider.provisionCard({ scope: 'project', scopeId: projectId, label: 'Capped', cap: 500 });
    await provider.fund(card.id, 5000);
    // Funds exceed the ceiling, so the ceiling is what is left.
    expect(cardRemaining((await provider.getCard(card.id))!, 0)).toBe(500);
    await budget.request({ projectId, taskId: 'left' , capabilities: ['use-card:*'] }, { amount: 300, cardId: card.id });
    const spent = (await store.cardPaymentSpent(card.id));
    expect(cardRemaining((await provider.getCard(card.id))!, spent)).toBe(200);
    // A rail with no ceiling of its own (the human's own card) can only run out
    // of funds, so `available` is the whole answer — never `cap - spent`, which
    // on an issuing rail would double-count what `available` already reflects.
    expect(cardRemaining({ cap: 500, available: 4700, status: 'active' }, spent, false)).toBe(4700);
    expect(cardRemaining({ cap: 500, available: 4700, status: 'canceled' }, spent)).toBe(0);
  });

  it('exports and deletes both organization and project cards with their tenant', async () => {
    const other = (await store.createOrganization({ name: 'Other' }));
    const otherProject = (await store.createProject('Other project', {}, other.id));
    const organizationCard = await provider.provisionCard({ scope: 'organization', scopeId: other.id, label: 'Shared', cap: 1000 });
    const projectCard = await provider.provisionCard({ scope: 'project', scopeId: otherProject.id, label: 'Project', cap: 1000 });
    const exported = (await store.exportOrganization(other.id)) as any;
    expect(exported.tables.cards.map((card: any) => card.id).sort()).toEqual([organizationCard.id, projectCard.id].sort());
    (await store.deleteOrganization(other.id));
    expect((await store.getCard(organizationCard.id))).toBeUndefined();
    expect((await store.getCard(projectCard.id))).toBeUndefined();
  });

  it('rejects zero, fractional, and negative local funding', async () => {
    const card = await provider.provisionCard({ scope: 'project', scopeId: projectId, label: 'Ops', cap: 1000 });
    await expect(provider.fund(card.id, 0)).rejects.toThrow(/positive/);
    await expect(provider.fund(card.id, -1)).rejects.toThrow(/positive/);
    await expect(provider.fund(card.id, 1.5)).rejects.toThrow(/positive/);
  });
});


describe('task payment policy', () => {
  it('defaults to zero and inherits editable organization and project budgets', async () => {
    const store = (await Store.create(':memory:'));
    try {
      const project = (await store.createProject('Default budget', {}));
      const provider = new MockPaymentProvider(store);
      const service = new BudgetService(store, provider);
      const card = await provider.provisionCard({ scope: 'project', scopeId: project.id, label: 'Work', cap: 1000 });
      await provider.fund(card.id, 1000);
      expect((await service.policy(project.id)).budget).toBe(0);
      expect((await service.request({ projectId: project.id, taskId: 'default-budget' , capabilities: ['use-card:*'] }, { amount: 1 })).status).toBe('needs_approval');
      expect((await store.paymentSpent('default-budget'))).toBe(0);
      const org = `organization:${project.organizationId}`;
      (await store.setSettings(org, 'payments', { budget: 500 }));
      expect((await service.policy(project.id)).budget).toBe(500);
      (await store.setSettings(project.id, 'payments', { cardIds: [card.id] }));
      expect((await service.policy(project.id)).budget).toBe(500);
      (await store.setSettings(org, 'payments', { budget: null }));
      expect((await service.policy(project.id)).budget).toBeNull();
      (await store.setSettings(project.id, 'payments', { budget: 200 }));
      expect((await service.policy(project.id)).budget).toBe(200);
      (await store.setSettings(project.id, 'payments', { budget: null }));
      expect((await service.policy(project.id)).budget).toBeNull();
    } finally { (await store.close()); }
  });

  it('selects by name, counts across cards, and releases pending requests in order', async () => {
    const store = (await Store.create(':memory:'));
    const provider = new MockPaymentProvider(store);
    const budget = new BudgetService(store, provider);
    const project = (await store.createProject('Payments', {}));
    const first = await provider.provisionCard({ scope: 'project', scopeId: project.id, label: 'Employer', cap: 10000 });
    const second = await provider.provisionCard({ scope: 'project', scopeId: project.id, label: 'Personal', cap: 10000 });
    await provider.fund(first.id, 10000);
    await provider.fund(second.id, 10000);
    const task = (await store.createTask({ projectId: project.id, title: 'Pay', workflow: 'just-do', workflowVersion: '1.0.0', params: { _authorization: { capabilities: ['use-card:*'] }, paymentPolicy: { cardIds: [first.id, second.id], budget: 100 } } } as any));
    const ctx = { projectId: project.id, taskId: task.id , capabilities: ['use-card:*'] };
    expect((await budget.request(ctx, { amount: 100, cardName: 'Employer' })).status).toBe('granted');
    const pending = await budget.request(ctx, { amount: 200, cardName: 'Personal' });
    expect(pending.status).toBe('needs_approval');
    // A human may return after the checkout reservation window has elapsed.
    (await store.updatePaymentSpendRequest(pending.requestId!, { expiresAt: Date.now() - 1000 }));
    const later = await budget.request(ctx, { amount: 50, cardName: 'Employer' });
    expect(later.status).toBe('needs_approval');
    (await store.updateTaskParams(task.id, { ...task.params, paymentPolicy: { cardIds: [first.id, second.id], budget: 300 } } as any));
    const released = await budget.reconcileTask(ctx);
    expect(released.map(r => r.requestId)).toEqual([pending.requestId]);
    expect((await store.getPaymentSpendRequest(later.requestId!))?.status).toBe('pending_approval');
    expect((await store.paymentSpent(task.id))).toBe(300);
    expect((await budget.request(ctx, { amount: 200, cardName: 'Personal' })).requestId).toBe(pending.requestId);
    (await store.close());
  });
  it('requires unique names across all projects in an organization', async () => {
    const store = (await Store.create(':memory:'));
    const provider = new MockPaymentProvider(store);
    const a = (await store.createProject('A', {})), b = (await store.createProject('B', {}));
    await provider.provisionCard({ scope: 'project', scopeId: a.id, label: 'Employer', cap: 100 });
    await expect(provider.provisionCard({ scope: 'project', scopeId: b.id, label: ' employer ', cap: 100 })).rejects.toThrow(/name.*unique/i);
    (await store.close());
  });
});

describe('payment reservations under concurrency', () => {
  it('counts in-progress charges and never charges the same approval twice', async () => {
    const store = (await Store.create(':memory:'));
    const provider = new MockPaymentProvider(store);
    const project = (await store.createProject('Concurrent', {}));
    const card = await provider.provisionCard({ scope: 'project', scopeId: project.id, label: 'Expenses', cap: 10000 });
    await provider.fund(card.id, 10000);
    (await store.setSettings(project.id, 'payments', { budget: 100 }));
    const one = new BudgetService(store, provider), two = new BudgetService(store, provider);
    const task_concurrent = await store.createTask({ projectId: project.id, title: 'concurrent', workflow: 'just-do', workflowVersion: '1', params: { _authorization: { capabilities: ['use-card:*'] } } });
    const ctx = { projectId: project.id, taskId: task_concurrent.id , capabilities: ['use-card:*'] };
    const results = await Promise.all([one.request(ctx, { amount: 100, why: 'one' }), two.request(ctx, { amount: 100, why: 'two' })]);
    expect(results.map(r => r.status).sort()).toEqual(['granted', 'needs_approval']);
    const pending = results.find(r => r.status === 'needs_approval')!;
    await Promise.all([one.approve(pending.requestId!, 'user:a'), two.approve(pending.requestId!, 'user:a')]);
    expect((await store.paymentSpent(ctx.taskId))).toBe(200);
    expect((await store.getCard(card.id)).available).toBe(9800);
    (await store.close());
  });

  it('an empty card selection grants no access and task budget overrides defaults', async () => {
    const store = (await Store.create(':memory:'));
    const provider = new MockPaymentProvider(store);
    const project = (await store.createProject('Selection', {}));
    const card = await provider.provisionCard({ scope: 'project', scopeId: project.id, label: 'Expenses', cap: 10000 });
    await provider.fund(card.id, 10000);
    (await store.setSettings(project.id, 'payments', { budget: 5000, cardIds: [card.id] }));
    const task = (await store.createTask({ projectId: project.id, title: 'None', workflow: 'just-do', workflowVersion: '1.0.0', params: { _authorization: { capabilities: ['use-card:*'] }, paymentPolicy: { budget: 0, cardIds: [] } } } as any));
    const service = new BudgetService(store, provider), ctx = { projectId: project.id, taskId: task.id , capabilities: ['use-card:*'] };
    expect((await service.request(ctx, { amount: 100, cardName: 'Expenses' })).status).toBe('denied');
    (await store.updateTaskParams(task.id, { ...task.params, paymentPolicy: { budget: 0, cardIds: [card.id] } } as any));
    const pending = await service.request(ctx, { amount: 100, cardName: 'Expenses' });
    expect(pending.status).toBe('needs_approval');
    (await store.updateTaskParams(task.id, { ...task.params, paymentPolicy: { budget: 500, cardIds: [] } } as any));
    expect(await service.reconcileTask(ctx)).toEqual([]);
    expect((await service.approve(pending.requestId!, 'user')).status).toBe('denied');
    expect((await store.paymentSpent(task.id))).toBe(0);
    (await store.close());
  });
});


it('migrates legacy card-name collisions without changing card identities', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-card-names-'));
  const filename = path.join(dir, 'store.db');
  let store = (await Store.create(filename));
  try {
    const project = (await store.createProject('Names', {}));
    const provider = new MockPaymentProvider(store);
    const first = await provider.provisionCard({ scope: 'project', scopeId: project.id, label: 'Work', cap: 100 });
    const second = await provider.provisionCard({ scope: 'organization', scopeId: project.organizationId, label: 'Work 2', cap: 100 });
    (await store.db.prepare('UPDATE cards SET label=? WHERE id=?').run(' work ', second.id));
    (await store.kvDelete('migration:unique-card-names'));
    (await store.close());
    store = (await Store.create(filename));
    expect((await store.getCard(first.id)).label.toLowerCase()).not.toBe((await store.getCard(second.id)).label.toLowerCase());
    expect((await store.getCard(first.id)).cap).toBe(100);
    expect((await store.getCard(second.id)).cap).toBe(100);
  } finally { (await store.close()); fs.rmSync(dir, { recursive: true, force: true }); }
});
