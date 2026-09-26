import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VaultCardProvider, PaymentRegistry, BudgetService, MockPaymentProvider,
  StripeIssuingProvider, cardSecretHandle, type PaymentProvider } from '../src/autonomy/payments.js';
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
    const task_t2 = await store.createTask({ projectId: projectId, title: 't2', workflow: 'just-do', workflowVersion: '1', params: { _authorization: { capabilities: ['use-card:*'] } } });
    const short = await budget.request({ projectId, taskId: task_t2.id , capabilities: ['use-card:*'] }, { amount: 4_000 });
    expect(short).toMatchObject({ status: 'needs_funding', shortfall: 3_000 });
    await provider.fund(card.id, 3_000);
    const settled = await budget.settleApproved({ projectId, taskId: task_t2.id , capabilities: ['use-card:*'] }, { amount: 4_000, cardId: card.id });
    expect(settled.status).toBe('granted');
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
