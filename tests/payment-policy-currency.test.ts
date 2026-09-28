import { describe, expect, it } from 'vitest';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { Store } from '../src/store/db.js';
import { MockPaymentProvider, resolvePaymentPolicy } from '../src/autonomy/payments.js';

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
});
