import { describe, expect, it } from 'vitest';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { Store } from '../src/store/db.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockPaymentProvider, VaultCardProvider, evaluateSpend, paymentPromptContext, resolvePaymentPolicy } from '../src/autonomy/payments.js';
import { spendReviewSummary } from '../src/agent/runtime.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';

// AU-36: a budget carries its currency. A policy sent without one (an older
// console, an agent) takes the currency of the budget it replaces, so an
// unchanged default is still recognized as unchanged.
describe('payment policy currency through the API', () => {
  async function setup() {
    const store = (await Store.create(':memory:'));
    (await store.claimPersonalOrganization('owner'));
    const project = (await store.createProject('Euro budget'));
    const card = await new MockPaymentProvider(store).provisionCard({ scope: 'project', scopeId: project.id, label: 'Euro', cap: 1000, currency: 'EUR' } as any);
    (await store.setSettings(project.id, 'payments', { cardIds: [card.id], budget: 500, currency: 'eur' }));
    const tokens = new TokenAuthority(store);
    const mint = async (caps: string[]) => (await tokens.mintPrincipal('user:owner', caps, project.id, 60_000, project.organizationId)).token;
    const client = { workflow: { start: async (_type: string, options: any) => ({ workflowId: options.workflowId }) } } as any;
    return { store, project, card, mint, api: new KarmaxApi({ store, tokens, client, taskQueue: 'test' }) };
  }

  it('keeps the default currency when a policy omits it', async () => {
    const { store, project, card, mint, api } = (await setup());
    try {
      // No payment:write: only an unchanged default is accepted.
      const task = await api.createTask((await mint(['task:*'])), { projectId: project.id, title: 'Buy', workflow: 'just-do',
        params: { prompt: 'buy', paymentPolicy: { cardIds: [card.id], budget: 500 } } } as any);
      expect((await resolvePaymentPolicy(store, project.id, task.id))).toMatchObject({ budget: 500, currency: 'eur' });

      const writer = (await mint(['task:*', 'payment:write']));
      (await api.setTaskPaymentPolicy(writer, task.id, { cardIds: [card.id], budget: 700 }));
      expect((await resolvePaymentPolicy(store, project.id, task.id))).toMatchObject({ budget: 700, currency: 'eur' });
      (await api.setTaskPaymentPolicy(writer, task.id, { cardIds: [card.id], budget: 700, currency: 'usd' }));
      expect((await resolvePaymentPolicy(store, project.id, task.id))).toMatchObject({ budget: 700, currency: 'usd' });
    } finally { (await store.close()); }
  });

  // #367 review item 14: before AU-36 a budget was a bare number counted
  // against whatever cards the task used. Read as USD, a budget over euro
  // cards would turn every auto-approved payment into an approval.
  it('reads a budget saved before currencies in the currency its cards share', async () => {
    const store = (await Store.create(':memory:'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-legacy-budget-'));
    try {
      const project = (await store.createProject('Legacy budget'));
      const provider = new VaultCardProvider(store, new CredentialBroker(new Vault(dir)));
      const details = { number: '4242424242424242', cvc: '123', expMonth: 12, expYear: 2031 };
      const euro = await provider.provisionCard({ scope: 'project', scopeId: project.id, label: 'Euro', cap: 1000, currency: 'EUR', details } as any);
      (await store.setSettings(project.id, 'payments', { budget: 500 }));
      expect((await resolvePaymentPolicy(store, project.id))).toMatchObject({ budget: 500, currency: 'eur' });
      const dollar = await provider.provisionCard({ scope: 'project', scopeId: project.id, label: 'Dollar', cap: 1000, details } as any);
      expect((await resolvePaymentPolicy(store, project.id))).toMatchObject({ currency: 'usd' });
      // The cards the policy selects decide, not every card in the project.
      (await store.setSettings(project.id, 'payments', { budget: 500, cardIds: [euro.id] }));
      expect((await resolvePaymentPolicy(store, project.id))).toMatchObject({ currency: 'eur' });
      expect(dollar.id).toBeTruthy();
    } finally { (await store.close()); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  // #367 review item 12: the agent read budget / 100 with two decimals, so a
  // 1,000 JPY budget read as "10.00" and its amounts came out 100x too large.
  it('tells the agent amounts in the minor units request_spend takes', () => {
    const yen = paymentPromptContext([{ label: 'Tokyo', id: 'c1', currency: 'JPY' }], { cardIds: ['c1'], budget: 1_000, currency: 'jpy' }, 250);
    expect(yen).toContain('"currency":"JPY"');
    expect(yen).toContain('Task budget: 1000 JPY (amount 1000)');
    expect(yen).toContain('Spent/reserved: 250 JPY (amount 250)');
    expect(yen).toContain('1 JPY = 1');
    expect(yen).not.toContain('10.00');
    const mixed = paymentPromptContext([{ label: 'Main', id: 'c1' }, { label: 'Euro', id: 'c2', currency: 'EUR' }],
      { cardIds: ['c1', 'c2'], budget: 1_234, currency: 'usd' }, 0);
    expect(mixed).toContain('Task budget: 12.34 USD (amount 1234)');
    expect(mixed).toContain('1 USD = 100');
    expect(mixed).toContain('1 EUR = 100');
    expect(paymentPromptContext([{ label: 'Main', id: 'c1' }], { cardIds: ['c1'], budget: null, currency: 'usd' }, 0)).toContain('Task budget: unlimited');
    expect(paymentPromptContext([], { cardIds: [], budget: 5, currency: 'usd' }, 0)).toBe('');
  });

  // Round 3, item 10: the approver read "$12.50" for a 1,250 JPY request, and
  // "$125.00" for 12.500 KWD.
  it('shows the approver each amount in its own currency', () => {
    expect(spendReviewSummary({ status: 'needs_approval', reason: 'over the task budget', currency: 'jpy' },
      { amount: 1_250, merchant: 'shop.example.jp', why: 'domain' })).toContain('Approval needed to spend 1250 JPY at shop.example.jp');
    expect(spendReviewSummary({ status: 'needs_funding', shortfall: 2_500, currency: 'kwd' }, { amount: 12_500 }))
      .toContain('add 2.500 KWD to the card to pay 12.500 KWD');
    expect(spendReviewSummary({ status: 'needs_approval', reason: 'x' }, { amount: 1_250 })).toContain('12.50 USD');
    expect(evaluateSpend({ amount: 1_250, allowance: 1_000, spent: 0, available: 50_000, hardCap: 50_000, currency: 'jpy' }))
      .toMatchObject({ status: 'needs_approval', reason: 'over the task budget (0 JPY spent + 1250 JPY > 1000 JPY)' });
  });

  it('returns the currency with a spend result', async () => {
    const store = (await Store.create(':memory:'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-spend-currency-'));
    try {
      const project = (await store.createProject('Yen'));
      const provider = new VaultCardProvider(store, new CredentialBroker(new Vault(dir)));
      const card = await provider.provisionCard({ scope: 'project', scopeId: project.id, label: 'Tokyo', cap: 100_000, currency: 'JPY',
        details: { number: '4242424242424242', cvc: '123', expMonth: 1, expYear: 2031 } } as any);
      (await store.setSettings(project.id, 'payments', { budget: 1_000, currency: 'jpy' }));
      const task = await store.createTask({ projectId: project.id, title: 'buy', workflow: 'just-do', workflowVersion: '1',
        params: { prompt: '', _authorization: { capabilities: ['use-card:*'] } } } as any);
      const { BudgetService } = await import('../src/autonomy/payments.js');
      const result = await new BudgetService(store, provider).request({ projectId: project.id, taskId: task.id, capabilities: ['use-card:*'] },
        { amount: 1_250, cardId: card.id });
      expect(result).toMatchObject({ status: 'needs_approval', currency: 'jpy' });
      expect(await new BudgetService(store, provider).request({ projectId: project.id, taskId: task.id, capabilities: ['use-card:*'] }, { amount: 0.5 } as any))
        .toMatchObject({ status: 'denied', reason: expect.not.stringContaining('cents') });
    } finally { (await store.close()); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
