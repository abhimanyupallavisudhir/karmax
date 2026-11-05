import { describe, expect, it } from 'vitest';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { Store } from '../src/store/db.js';
import { MockPaymentProvider, resolvePaymentPolicy } from '../src/autonomy/payments.js';

// Task #805 (2026-11-02): an armed task's form saved it, the save re-armed it,
// its dependency had already finished, so it started — and the still-open
// form's next saves reached the running task's in-flight edit, which refused
// any patch naming `paymentPolicy` ("Use the task payments endpoint to change
// cards or budget"), although the form had not touched the cards or budget.
describe('payment policy in an in-flight params edit', () => {
  async function setup() {
    const store = (await Store.create(':memory:'));
    (await store.claimPersonalOrganization('owner'));
    const project = (await store.createProject('Running'));
    const card = await new MockPaymentProvider(store).provisionCard({ scope: 'project', scopeId: project.id, label: 'Main', cap: 1000, currency: 'USD' } as any);
    (await store.setSettings(project.id, 'payments', { cardIds: [card.id], budget: 0, currency: 'usd' }));
    const tokens = new TokenAuthority(store);
    const mint = async (caps: string[]) => (await tokens.mintPrincipal('user:owner', caps, project.id, 60_000, project.organizationId)).token;
    const updates: Record<string, unknown>[] = [];
    const client = { workflow: {
      start: async (_type: string, options: any) => ({ workflowId: options.workflowId }),
      getHandle: () => ({ executeUpdate: async (_name: string, opts: { args: Record<string, unknown>[] }) => {
        updates.push(opts.args[0]!);
        return { applied: Object.keys(opts.args[0]!) };
      }, query: async () => [], signal: async () => undefined }),
    } } as any;
    const api = new KarmaxApi({ store, tokens, client, taskQueue: 'test' });
    // Started (not a draft, not armed): its params now go through the workflow.
    const start = async (params: Record<string, unknown> = {}) =>
      api.createTask((await mint(['task:*'])), { projectId: project.id, title: 'Run', workflow: 'just-do', params: { prompt: 'run', ...params } } as any);
    return { store, project, card, mint, api, updates, start };
  }

  it('ignores an unchanged policy, whatever the order of its keys', async () => {
    const { store, card, mint, api, updates, start } = (await setup());
    try {
      const task = (await start({ paymentPolicy: { cardIds: [card.id], budget: 0, currency: 'usd' } }));
      const member = (await mint(['task:*']));
      const result = (await api.updateParams(member, task.id,
        { 'agent:do': { provider: 'mock' }, paymentPolicy: { currency: 'usd', budget: 0, cardIds: [card.id] } }));
      expect(result.applied).toEqual(['agent:do']);
      expect(updates.at(-1)).not.toHaveProperty('paymentPolicy');
    } finally { (await store.close()); }
  });

  it('ignores the defaults sent back for a task without a policy of its own', async () => {
    const { store, project, card, mint, api, start } = (await setup());
    try {
      const task = (await start());
      // A task saved before tasks kept the defaults they started with.
      const { paymentPolicy: _own, ...params } = (await store.getTask(task.id))!.params as Record<string, unknown>;
      (await store.updateTaskParams(task.id, params as any));
      (await api.updateParams((await mint(['task:*'])), task.id, { 'agent:do': { provider: 'mock' }, paymentPolicy: { cardIds: [card.id], budget: 0 } }));
      // Still inheriting: a later change to the project's defaults reaches it.
      expect((await store.getTask(task.id))?.params).not.toHaveProperty('paymentPolicy');
      expect((await resolvePaymentPolicy(store, project.id, task.id))).toMatchObject({ budget: 0, currency: 'usd' });
    } finally { (await store.close()); }
  });

  it('applies a changed policy for whoever may manage payments, and only for them', async () => {
    const { store, project, card, mint, api, updates, start } = (await setup());
    try {
      const task = (await start());
      const before = updates.length;
      await expect(api.updateParams((await mint(['task:*'])), task.id, { 'agent:do': { provider: 'mock' }, paymentPolicy: { cardIds: [card.id], budget: 500 } }))
        .rejects.toThrow(/payment:write/);
      // Refused before anything else was applied.
      expect(updates.length).toBe(before);
      const result = (await api.updateParams((await mint(['task:*', 'payment:write'])), task.id, { paymentPolicy: { cardIds: [card.id], budget: 500 } }));
      expect(result.applied).toEqual(['paymentPolicy']);
      // The workflow never sees it: payments are read from the task's params.
      expect(updates.length).toBe(before);
      expect((await resolvePaymentPolicy(store, project.id, task.id))).toMatchObject({ budget: 500, currency: 'usd', cardIds: [card.id] });
      await expect(api.updateParams((await mint(['task:*', 'payment:write'])), task.id, { paymentPolicy: { cardIds: ['card_nope'], budget: 500 } }))
        .rejects.toThrow(/available cards/);
    } finally { (await store.close()); }
  });

  it('tells a whole-form save that the task has already started', async () => {
    const { store, card, mint, api, updates, start } = (await setup());
    try {
      const task = (await start());
      const before = updates.length;
      const refusal = await api.updateParams((await mint(['task:*'])), task.id,
        { prompt: 'run', paymentPolicy: { cardIds: [card.id], budget: 0 } }, { replace: true }).catch((error) => error);
      expect(refusal).toMatchObject({ code: 'task_started', status: 409 });
      expect(String(refusal.message)).toMatch(/already started/);
      expect(updates.length).toBe(before);
    } finally { (await store.close()); }
  });

  // The other half of the race: the gateway saw the task armed, and its trigger
  // fired before the edit was written. Written anyway, "Save as draft" turned a
  // running task back into a draft and a save re-armed it.
  it('refuses an armed task\'s edit once its trigger has fired', async () => {
    const { store, project, mint, api } = (await setup());
    try {
      const member = (await mint(['task:*']));
      const dependency = (await api.createTask(member, { projectId: project.id, title: 'First', workflow: 'just-do', params: { prompt: 'first', draft: true } } as any));
      const task = (await api.createTask(member, { projectId: project.id, title: 'Then', workflow: 'just-do',
        params: { prompt: 'then', triggers: [{ kind: 'dependency', tasks: [dependency.id] }] } } as any));
      expect((await store.getTask(task.id))?.params.triggerState).toBe('armed');
      // Still armed: the form's save lands.
      (await api.updateArmedParams(member, task.id, { prompt: 'then, carefully', triggers: [{ kind: 'dependency', tasks: [dependency.id] }] }, { replace: true }));
      expect((await store.getTask(task.id))?.params).toMatchObject({ prompt: 'then, carefully', triggerState: 'armed' });
      // Its trigger fires (fireTriggeredTask), then the form saves again.
      (await api.fireTriggeredTask(member, task.id, 'self'));
      for (const keepArmed of [true, false]) {
        const refusal = await api.updateArmedParams(member, task.id, { prompt: 'edited late', triggers: [{ kind: 'dependency', tasks: [dependency.id] }] },
          { replace: true, keepArmed }).catch((error) => error);
        expect(refusal).toMatchObject({ code: 'task_started', status: 409 });
      }
      const after = (await store.getTask(task.id))!;
      expect(after.params).toMatchObject({ prompt: 'then, carefully', triggerState: 'fired' });
      expect(after.params.draft).toBeFalsy();
    } finally { (await store.close()); }
  });
});
