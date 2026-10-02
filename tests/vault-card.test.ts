import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VaultCardProvider, PaymentRegistry, BudgetService, MockPaymentProvider,
  StripeIssuingProvider, cardSecretHandle, cardCvcHandle, separateStoredCardCvcs, resolvePaymentPolicy, validatePaymentPolicy,
  type PaymentProvider } from '../src/autonomy/payments.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';
import { Store } from '../src/store/db.js';

/**
 * The universal rail (SPEC §7.6): a virtual card the human already holds, whose
 * spending limit is enforced by their own issuer. Karmax stores the PAN in the
 * vault and types it into checkout; it never issues, funds, or authorizes.
 */
describe('VaultCardProvider — the universal rail', () => {
  let dir: string;
  let store: Store;
  let broker: CredentialBroker;
  let provider: VaultCardProvider;
  let projectId: string;
  const details = { number: '4242424242424242', cvc: '123', expMonth: 12, expYear: 2031 };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-vault-card-'));
    store = (await Store.create(':memory:'));
    broker = new CredentialBroker(new Vault(dir));
    provider = new VaultCardProvider(store, broker);
    projectId = (await store.createProject('P', {})).id;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const provision = (over: Record<string, unknown> = {}) => provider.provisionCard({
    scope: 'project', scopeId: projectId, label: 'Household', cap: 50_000, details, ...over,
  } as any);

  it('needs no connection or platform setup — it is available everywhere', () => {
    expect(provider.describe()).toMatchObject({ kind: 'card', available: true, connected: true });
  });

  it('stores the PAN in the vault and only the last4 in the store', async () => {
    const card = await provision();
    const row = (await store.getCard(card.id));
    expect(row.last4).toBe('4242');
    expect(JSON.stringify(row)).not.toContain('4242424242424242');
    // NOT `JSON.stringify(row)).not.toContain('123')`. The row carries a 13-digit
    // `createdAt` (plus generated ids), so scanning the whole blob for a 3-digit
    // CVC false-positives whenever a timestamp happens to contain those digits —
    // ~0.3% of runs, i.e. a suite that fails occasionally for no reason and
    // teaches everyone to re-run it. Assert the real invariant instead: no stored
    // field carries the secret, and the secret-bearing keys are absent entirely.
    expect(Object.values(row)).not.toContain('123');
    expect(row).not.toHaveProperty('cvc');
    expect(row).not.toHaveProperty('number');
    expect(broker.hasHandle(cardSecretHandle(card.id))).toBe(true);
  });

  it('retrieves the full details back out of the vault for secure fill', async () => {
    const card = await provision();
    expect(await provider.retrieveCardDetails(card.id))
      .toMatchObject({ number: '4242424242424242', cvc: '123', expMonth: 12, expYear: 2031 });
  });

  // AU-31: the CVC is kept out of the card secret, so the PAN secret alone is
  // never a complete card-not-present credential.
  it('keeps the CVC out of the stored card secret', async () => {
    const card = await provision();
    const stored = JSON.parse(broker.resolve(cardSecretHandle(card.id), { caps: ['use-credential:*'] }));
    expect(stored).toMatchObject({ number: '4242424242424242', expMonth: 12, expYear: 2031 });
    expect(stored).not.toHaveProperty('cvc');
    expect(broker.resolve(cardCvcHandle(card.id), { caps: ['use-credential:*'] })).toBe('123');
  });

  it('separates the CVC of a card stored before AU-31, once', async () => {
    const card = await provision();
    (await broker.registerHandle(cardSecretHandle(card.id), JSON.stringify(details), broker.scopeOf(cardSecretHandle(card.id))!));
    (await broker.deleteHandle(cardCvcHandle(card.id)));
    expect(await separateStoredCardCvcs(broker)).toBe(1);
    expect(await separateStoredCardCvcs(broker)).toBe(0);
    // Every boot checks again: a vault put back from before the split (a
    // manual rollback) is split too, which a marker outside it would miss.
    const combined = JSON.stringify(details);
    (await broker.registerHandle(cardSecretHandle(card.id), combined, broker.scopeOf(cardSecretHandle(card.id))!, { history: false }));
    expect(await separateStoredCardCvcs(broker)).toBe(1);
    expect(JSON.parse(broker.resolve(cardSecretHandle(card.id), { caps: ['use-credential:*'] }))).not.toHaveProperty('cvc');
    // …nor in the card secret's history, where `put` keeps earlier revisions.
    expect(new Vault(dir).reveal(cardSecretHandle(card.id), 1)).toBeUndefined();
    expect(await provider.retrieveCardDetails(card.id)).toMatchObject({ number: '4242424242424242', cvc: '123' });
  });

  it('carries an optional billing address through to fill, dropping blanks', async () => {
    const card = await provision({ details: { ...details,
      billing: { line1: '1 High St', city: 'London', postalCode: 'SW1A 1AA', country: '' } } });
    expect((await provider.retrieveCardDetails(card.id)).billing)
      .toEqual({ line1: '1 High St', city: 'London', postalCode: 'SW1A 1AA' });
  });

  it('omits the billing address entirely when none is given', async () => {
    const card = await provision({ details: { ...details, billing: { line1: '', city: '' } } });
    expect((await provider.retrieveCardDetails(card.id)).billing).toBeUndefined();
  });

  it('rejects a card with missing, malformed, or expired details', async () => {
    await expect(provision({ details: undefined })).rejects.toThrow(/card details are required/i);
    await expect(provision({ details: { ...details, number: '4242' } })).rejects.toThrow(/card number/i);
    await expect(provision({ details: { ...details, number: '4242424242424241' } })).rejects.toThrow(/card number/i);
    await expect(provision({ details: { ...details, cvc: '12x' } })).rejects.toThrow(/cvc/i);
    await expect(provision({ details: { ...details, expMonth: 13 } })).rejects.toThrow(/expiry/i);
    await expect(provision({ details: { ...details, expYear: 2020 } })).rejects.toThrow(/expired/i);
  });

  it('treats the declared limit as advisory funds, and a top-up as raising it', async () => {
    const card = await provision({ cap: 10_000 });
    expect((await provider.getCard(card.id))!.available).toBe(10_000);
    await provider.fund(card.id, 5_000);
    const funded = (await provider.getCard(card.id))!;
    expect(funded.available).toBe(15_000);
    expect(funded.cap).toBe(15_000);
  });

  it('revoking destroys the stored secret, not just the row', async () => {
    const card = await provision();
    await provider.revoke(card.id);
    expect(broker.hasHandle(cardSecretHandle(card.id))).toBe(false);
    expect(broker.hasHandle(cardCvcHandle(card.id))).toBe(false);
    expect((await store.getCard(card.id)).status).toBe('canceled');
    await expect(provider.retrieveCardDetails(card.id)).rejects.toThrow(/not active/i);
  });

  it('reports a balance with no funding URL — topping up happens at the issuer', async () => {
    await provision({ cap: 7_000, scope: 'organization', scopeId: 'org_personal' });
    const balance = await provider.balance('org_personal');
    expect(balance.available).toBe(7_000);
    expect(balance.fundingUrl).toBeUndefined();
  });

  it('is not an issuing rail — it has no cardholder surface', () => {
    const rail: PaymentProvider = provider;
    expect(rail.createCardholder).toBeUndefined();
    expect(rail.listCardholders).toBeUndefined();
  });
});

describe('BudgetService over the vault-card rail', () => {
  let dir: string;
  let store: Store;
  let provider: VaultCardProvider;
  let budget: BudgetService;
  let projectId: string;
  const details = { number: '4242424242424242', cvc: '123', expMonth: 12, expYear: 2031 };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-vault-budget-'));
    store = (await Store.create(':memory:'));
    provider = new VaultCardProvider(store, new CredentialBroker(new Vault(dir)));
    budget = new BudgetService(store, provider);
    projectId = (await store.createProject('P', {})).id;
    (await store.setSettings(projectId, 'payments', { budget: null }));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const provision = (cap: number) => provider.provisionCard({
    scope: 'project', scopeId: projectId, label: 'Household', cap, details,
  } as any);

  it('grants autonomously within the declared limit — no approval step', async () => {
    await provision(50_000);
    const r = await budget.request({ projectId, taskId: 't1' , capabilities: ['use-card:*'] }, { amount: 2_000 });
    expect(r.status).toBe('granted');
    expect(r.transactionId).toBeTruthy();
  });

  it('asks the human to raise the limit once the declared funds run out', async () => {
    const card = await provision(1_000);
    const task_t2 = await store.createTask({ projectId: projectId, title: 't2', workflow: 'just-do', workflowVersion: '1', params: { prompt: '', _authorization: { capabilities: ['use-card:*'] } } });
    const short = await budget.request({ projectId, taskId: task_t2.id , capabilities: ['use-card:*'] }, { amount: 4_000 });
    expect(short).toMatchObject({ status: 'needs_funding', shortfall: 3_000 });
    await provider.fund(card.id, 3_000);
    const settled = await budget.settleApproved({ projectId, taskId: task_t2.id , capabilities: ['use-card:*'] }, { amount: 4_000, cardId: card.id });
    expect(settled.status).toBe('granted');
  });

  // AU-36: a budget is an amount of one currency. Spend on a card in another
  // currency cannot be compared with it, and is never summed into it.
  it('keeps budgets in their own currency', async () => {
    const dollars = await provision(50_000);
    const euros = await provider.provisionCard({ scope: 'project', scopeId: projectId, label: 'Euro card', cap: 50_000,
      currency: 'EUR', details } as any);
    (await store.setSettings(projectId, 'payments', { budget: 1_000, currency: 'eur' }));
    expect(await resolvePaymentPolicy(store, projectId)).toMatchObject({ budget: 1_000, currency: 'eur' });
    const task = await store.createTask({ projectId, title: 'buyer', workflow: 'just-do', workflowVersion: '1',
      params: { prompt: '', _authorization: { capabilities: ['use-card:*'] } } });
    const ctx = { projectId, taskId: task.id, capabilities: ['use-card:*'] };
    const unconvertible = await budget.request(ctx, { amount: 500, cardId: dollars.id });
    expect(unconvertible).toMatchObject({ status: 'needs_approval', reason: 'a USD card cannot be counted against this EUR budget' });
    (await budget.approve(unconvertible.requestId!, 'user:owner'));
    expect((await store.getPaymentSpendRequest(unconvertible.requestId!)).status).toBe('settled');
    // 500 USD settled; 900 EUR still fits the 1,000 EUR budget.
    expect(await budget.request(ctx, { amount: 900, cardId: euros.id })).toMatchObject({ status: 'granted' });
    expect(await budget.request(ctx, { amount: 200, cardId: euros.id })).toMatchObject({ status: 'needs_approval' });
    await expect(validatePaymentPolicy(store, projectId, 'org_personal', { cardIds: [], budget: 1, currency: 'dollars' } as any))
      .rejects.toThrow(/currency/i);
  });

  // AU-35: a spend waiting for a human belongs to the task that asked for it.
  it('retires pending spend when its task ends, and never approves spend for an ended task', async () => {
    const card = await provision(50_000);
    (await store.setSettings(projectId, 'payments', { budget: 1_000 }));
    const task = await store.createTask({ projectId, title: 'buyer', workflow: 'just-do', workflowVersion: '1',
      params: { prompt: '', _authorization: { capabilities: ['use-card:*'] } } });
    const ctx = { projectId, taskId: task.id, capabilities: ['use-card:*'] };
    const pending = await budget.request(ctx, { amount: 5_000, cardId: card.id });
    expect(pending.status).toBe('needs_approval');
    (await store.saveView(task.id, { taskId: task.id, stage: 'cancelled', status: 'cancelled', actions: [], state: {} } as any));
    expect((await store.getPaymentSpendRequest(pending.requestId!))).toMatchObject({ status: 'denied', resolvedBy: 'system:payments' });
    // Even a request left pending (e.g. before this retirement existed) cannot be approved.
    (await store.updatePaymentSpendRequest(pending.requestId!, { status: 'pending_approval' }));
    expect(await budget.approve(pending.requestId!, 'user:owner')).toMatchObject({ status: 'denied', reason: 'the task has ended' });
    expect((await store.getPaymentSpendRequest(pending.requestId!)).status).toBe('denied');
    expect((await store.paymentSpent(task.id))).toBe(0);
  });

  // #367 review item 13: the ended-task check and the claim are one decision.
  it('refuses approval when the task ends while the card is being checked', async () => {
    const card = await provision(50_000);
    (await store.setSettings(projectId, 'payments', { budget: 1_000 }));
    const task = await store.createTask({ projectId, title: 'buyer', workflow: 'just-do', workflowVersion: '1',
      params: { prompt: '', _authorization: { capabilities: ['use-card:*'] } } });
    const pending = await budget.request({ projectId, taskId: task.id, capabilities: ['use-card:*'] }, { amount: 5_000, cardId: card.id });
    const getCard = provider.getCard.bind(provider);
    vi.spyOn(provider, 'getCard').mockImplementation(async (id: string) => {
      // The task is cancelled while approval waits on the rail.
      (await store.saveView(task.id, { taskId: task.id, stage: 'done', status: 'done', actions: [], state: {} } as any));
      return getCard(id);
    });
    expect(await budget.approve(pending.requestId!, 'user:owner')).toMatchObject({ status: 'denied' });
    expect((await store.paymentSpent(task.id))).toBe(0);
  });

  it('never overwrites a request another approval already resolved', async () => {
    const card = await provision(50_000);
    (await store.setSettings(projectId, 'payments', { budget: 1_000 }));
    const task = await store.createTask({ projectId, title: 'buyer', workflow: 'just-do', workflowVersion: '1',
      params: { prompt: '', _authorization: { capabilities: ['use-card:*'] } } });
    const pending = await budget.request({ projectId, taskId: task.id, capabilities: ['use-card:*'] }, { amount: 5_000, cardId: card.id });
    const getTask = store.getTask.bind(store);
    vi.spyOn(store, 'getTask').mockImplementationOnce(async (id: string) => {
      // A concurrent approval settles it, and then the task ends.
      (await store.updatePaymentSpendRequest(pending.requestId!, { status: 'settled', resolvedBy: 'user:other' }));
      (await store.saveView(task.id, { taskId: task.id, stage: 'done', status: 'done', actions: [], state: {} } as any));
      return getTask(id);
    });
    await budget.approve(pending.requestId!, 'user:owner');
    expect((await store.getPaymentSpendRequest(pending.requestId!))).toMatchObject({ status: 'settled', resolvedBy: 'user:other' });
  });

  // #367 review item 14: a request that waited without a card takes the
  // currency of the card approval assigns.
  it('records the currency of the card an approval assigns', async () => {
    (await store.setSettings(projectId, 'payments', { budget: 1_000, currency: 'eur' }));
    const task = await store.createTask({ projectId, title: 'buyer', workflow: 'just-do', workflowVersion: '1',
      params: { prompt: '', _authorization: { capabilities: ['use-card:*'] } } });
    const pending = await budget.request({ projectId, taskId: task.id, capabilities: ['use-card:*'] }, { amount: 5_000 });
    expect((await store.getPaymentSpendRequest(pending.requestId!))).toMatchObject({ cardId: null });
    const euros = await provider.provisionCard({ scope: 'project', scopeId: projectId, label: 'Euro card', cap: 50_000,
      currency: 'EUR', details } as any);
    await budget.approve(pending.requestId!, 'user:owner');
    expect((await store.getPaymentSpendRequest(pending.requestId!))).toMatchObject({ cardId: euros.id, currency: 'eur' });
  });
});

describe('secure fill is provider-agnostic', () => {
  it('every rail that can be filled at checkout exposes retrieveCardDetails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-fill-'));
    try {
      const store = (await Store.create(':memory:'));
      const broker = new CredentialBroker(new Vault(dir));
      const registry = new PaymentRegistry(store);
      registry.register(new MockPaymentProvider(store));
      registry.register(new VaultCardProvider(store, broker));
      registry.register(new StripeIssuingProvider(store, fetch, {}, broker));
      // The mock rail moves no real money, so it is deliberately unfillable.
      expect(typeof registry.get('mock').retrieveCardDetails).toBe('undefined');
      expect(typeof registry.get('vault-card').retrieveCardDetails).toBe('function');
      expect(typeof registry.get('stripe').retrieveCardDetails).toBe('function');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
