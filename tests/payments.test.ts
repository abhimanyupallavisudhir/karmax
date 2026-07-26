import { describe, it, expect, beforeEach } from 'vitest';
import { evaluateSpend, MockPaymentProvider, StripeIssuingProvider, PaymentRegistry, BudgetService } from '../src/autonomy/payments.js';
import { Store } from '../src/store/db.js';

describe('payment providers — the connect surface (SPEC §7.6, task 1g)', () => {
  it('lists local (connected) + Stripe (oauth, needs connecting)', () => {
    const reg = new PaymentRegistry();
    reg.register(new MockPaymentProvider(new Store(':memory:')));
    reg.register(new StripeIssuingProvider());
    const list = reg.list();
    const mock = list.find((p) => p.name === 'mock')!;
    const stripe = list.find((p) => p.name === 'stripe')!;
    expect(mock).toMatchObject({ kind: 'local', available: true, connected: true });
    expect(stripe).toMatchObject({ kind: 'oauth', available: false, connected: false });
  });
  it('mock connects trivially; Stripe stays unavailable until the real rail exists', async () => {
    const prevId = process.env.STRIPE_CLIENT_ID;
    expect((await new MockPaymentProvider(new Store(':memory:')).connect()).status).toBe('connected');
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
  it('needs_approval over the review threshold (even within allowance)', () => {
    expect(evaluateSpend({ ...base, amount: 600, allowance: 100000, threshold: 500 }).status).toBe('needs_approval');
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
    store = new Store(':memory:');
    provider = new MockPaymentProvider(store);
    budget = new BudgetService(store, provider);
    projectId = store.createProject('P', {}).id;
  });

  it('needs_funding when no card is configured', async () => {
    const r = await budget.request({ projectId, taskId: 't1' }, { amount: 100 });
    expect(r.status).toBe('needs_funding');
  });

  it('grants within funds, decrements available, and records spend', async () => {
    const card = await provider.provisionCard({ scope: 'project', scopeId: projectId, label: 'Ops', cap: 100000 });
    await provider.fund(card.id, 5000);
    const r = await budget.request({ projectId, taskId: 't1' }, { amount: 2000 });
    expect(r.status).toBe('granted');
    expect(r.transactionId).toBeTruthy();
    expect((await provider.getCard(card.id))!.available).toBe(3000);
    expect(Number(store.kvGet('spent:t1'))).toBe(2000);
  });

  it('needs_funding when the card is short, then grants after funding', async () => {
    const card = await provider.provisionCard({ scope: 'project', scopeId: projectId, label: 'Ops', cap: 100000 });
    await provider.fund(card.id, 1000);
    let r = await budget.request({ projectId, taskId: 't2' }, { amount: 4000 });
    expect(r.status).toBe('needs_funding');
    expect(r.shortfall).toBe(3000);
    // human funds the shortfall, then the held request settles
    await provider.fund(card.id, 3000);
    r = await budget.settleApproved({ projectId, taskId: 't2' }, { amount: 4000, cardId: card.id });
    expect(r.status).toBe('granted');
    expect((await provider.getCard(card.id))!.available).toBe(0);
  });

  it('needs_approval over the configured allowance', async () => {
    const card = await provider.provisionCard({ scope: 'project', scopeId: projectId, label: 'Ops', cap: 100000 });
    await provider.fund(card.id, 100000);
    store.setSettings(projectId, 'payments', { allowance: 1000 });
    const r = await budget.request({ projectId, taskId: 't3' }, { amount: 5000 });
    expect(r.status).toBe('needs_approval');
  });

  it('does not let an explicit card id escape the project organization', async () => {
    const other = store.createOrganization({ name: 'Other' });
    const otherProject = store.createProject('Other project', {}, other.id);
    const card = await provider.provisionCard({ scope: 'project', scopeId: otherProject.id, label: 'Other card', cap: 100000 });
    await provider.fund(card.id, 100000);
    const r = await budget.request({ projectId, taskId: 't4' }, { amount: 100, cardId: card.id });
    expect(r.status).toBe('needs_funding');
    expect(r.reason).toContain('not available');
    expect((await provider.getCard(card.id))!.available).toBe(100000);
  });

  it('uses the owning organization payment policy, not installation-global policy', async () => {
    const other = store.createOrganization({ name: 'Other' });
    const otherProject = store.createProject('Other project', {}, other.id);
    const card = await provider.provisionCard({ scope: 'project', scopeId: otherProject.id, label: 'Other card', cap: 100000 });
    await provider.fund(card.id, 100000);
    store.setSettings('global', 'payments', { allowance: 1 });
    store.setSettings(`organization:${other.id}`, 'payments', { allowance: 1000 });
    const r = await budget.request({ projectId: otherProject.id, organizationId: other.id, taskId: 't5' }, { amount: 100 });
    expect(r.status).toBe('granted');
  });

  it('exports and deletes both organization and project cards with their tenant', async () => {
    const other = store.createOrganization({ name: 'Other' });
    const otherProject = store.createProject('Other project', {}, other.id);
    const organizationCard = await provider.provisionCard({ scope: 'organization', scopeId: other.id, label: 'Shared', cap: 1000 });
    const projectCard = await provider.provisionCard({ scope: 'project', scopeId: otherProject.id, label: 'Project', cap: 1000 });
    const exported = store.exportOrganization(other.id) as any;
    expect(exported.tables.cards.map((card: any) => card.id).sort()).toEqual([organizationCard.id, projectCard.id].sort());
    store.deleteOrganization(other.id);
    expect(store.getCard(organizationCard.id)).toBeUndefined();
    expect(store.getCard(projectCard.id)).toBeUndefined();
  });

  it('rejects zero, fractional, and negative local funding', async () => {
    const card = await provider.provisionCard({ scope: 'project', scopeId: projectId, label: 'Ops', cap: 1000 });
    await expect(provider.fund(card.id, 0)).rejects.toThrow(/positive/);
    await expect(provider.fund(card.id, -1)).rejects.toThrow(/positive/);
    await expect(provider.fund(card.id, 1.5)).rejects.toThrow(/positive/);
  });
});
