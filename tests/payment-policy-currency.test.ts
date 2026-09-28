import { describe, expect, it } from 'vitest';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { Store } from '../src/store/db.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockPaymentProvider, VaultCardProvider, resolvePaymentPolicy } from '../src/autonomy/payments.js';
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
});
