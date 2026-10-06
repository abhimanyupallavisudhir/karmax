import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { BudgetService, MockPaymentProvider } from '../src/autonomy/payments.js';
import { VaultItems } from '../src/autonomy/vault-items.js';
import * as connectionRuntime from '../src/mcp/connections/runtime.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

/**
 * An agent with its own authority (`params._agentAuthorization[<participant>]`)
 * acts with it: its turn token, its vault policies, its cards and budget.
 */
describe('a participant’s own authority at run time', () => {
  it('mints each agent’s turn token from its own authorization, else the task’s', async () => {
    vi.spyOn(connectionRuntime, 'prepareConnections').mockResolvedValue([]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-participant-token-'));
    vi.stubEnv('KARMAX_HOME', dir);
    vi.stubEnv('KARMAX_AGENT_MIN_FREE_MB', '0');
    vi.stubEnv('KARMAX_AGENT_MAX_LOAD_FACTOR', '0');
    const store = await Store.create(':memory:');
    try {
      const project = await store.createProject('Tokens');
      const task = await store.createTask({ projectId: project.id, title: 'Turns', workflow: 'software-dev', workflowVersion: '1', params: {
        prompt: '',
        _authorization: { capabilities: ['task:read', 'task:create', 'task:edit'], principal: 'user:main' },
        _agentAuthorization: {
          responder: { capabilities: ['task:read'], principal: 'user:responder-grantor', requested: {} },
          'agent-2': { capabilities: ['task:read', 'task:conversation:read'], principal: 'user:caller', requested: {} },
        },
      } });
      const tokens = new TokenAuthority(store);
      const mint = vi.spyOn(tokens, 'mint');
      const worlds = new WorldRegistry();
      const core = makeCoreActivities({ store, worlds, tokens, profiles: new ProfileResolver(store, 'mock'),
        adapters: new Map([['mock', { provider: 'mock', runTurn: async () =>
          ({ termination: { kind: 'success', status: 'mock.completed' }, output: 'ok' }) }]]) } as any);
      const handle = await core.createWorld({ taskId: task.id, projectId: project.id, kind: 'memory', base: 'main' });
      const turn = (role: string, participant?: string) => core.runAgentTurn({ taskId: task.id, role, worldHandle: handle, messages: [],
        ...(participant ? { participant } : {}),
        task: { projectId: project.id, title: task.title, prompt: '', project: {}, workflow: 'software-dev',
          grant: ['task:read', 'task:create', 'task:edit'], grantPrincipal: 'user:main' } as any });
      await turn('responder');
      await turn('do');
      await turn('agent', 'agent-2');
      const minted = mint.mock.calls.map(([args]) => args);
      expect(minted.map((args) => args.participant)).toEqual(['responder', 'do', 'agent-2']);
      expect(minted[0]!).toMatchObject({ principal: 'user:responder-grantor' });
      expect(minted[0]!.grantorCaps).not.toContain('task:create');
      expect(minted[1]!.grantorCaps).toContain('task:create');
      expect(minted[1]!.principal).toBe('user:main');
      expect(minted[2]!.grantorCaps).toContain('task:conversation:read');
      expect(minted[2]!.grantorCaps).not.toContain('task:edit');
      const issued = await Promise.all(mint.mock.results.map(async (result) => (await result.value).record));
      expect(issued.map((record) => record.participant)).toEqual(['responder', 'do', 'agent-2']);
    } finally { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('applies an agent’s own credential policy overrides', async () => {
    const store = await Store.create(':memory:');
    try {
      const project = await store.createProject('Vault');
      const task = await store.createTask({ projectId: project.id, title: 'Vault', workflow: 'software-dev', workflowVersion: '1', params: {
        prompt: '', _agentAuthorization: { responder: { capabilities: [], requested: {}, credentialPolicies: { item_1: { use: 'ask' } } } },
      } });
      const item = { id: 'item_1', policy: { use: 'auto', reveal: 'ask' } } as any;
      await new VaultItems(store).setTaskPolicies(task.id, { item_1: { reveal: 'auto' } });
      expect(await new VaultItems(store, undefined, undefined, 'org_personal', 'responder').effectivePolicy(task.id, item))
        .toEqual({ use: 'ask', reveal: 'ask' });
      expect(await new VaultItems(store, undefined, undefined, 'org_personal', 'do').effectivePolicy(task.id, item))
        .toEqual({ use: 'auto', reveal: 'auto' });
      // An agent without its own authority keeps the task's overrides.
      expect(await new VaultItems(store, undefined, undefined, 'org_personal', 'agent-4').effectivePolicy(task.id, item))
        .toEqual({ use: 'auto', reveal: 'auto' });
    } finally { await store.close(); }
  });

  it('limits an agent to its own cards and the smaller of its own and the task’s remaining budget', async () => {
    const store = await Store.create(':memory:');
    try {
      const provider = new MockPaymentProvider(store);
      const budget = new BudgetService(store, provider);
      const project = await store.createProject('Payments', {});
      const first = await provider.provisionCard({ scope: 'project', scopeId: project.id, label: 'Shared', cap: 100000 });
      const second = await provider.provisionCard({ scope: 'project', scopeId: project.id, label: 'Main only', cap: 100000 });
      await provider.fund(first.id, 100000);
      await provider.fund(second.id, 100000);
      const task = await store.createTask({ projectId: project.id, title: 'Pay', workflow: 'just-do', workflowVersion: '1.0.0', params: {
        prompt: '', _authorization: { capabilities: ['use-card:*'] },
        paymentPolicy: { cardIds: [first.id, second.id], budget: 1000, currency: 'usd' },
        _agentAuthorization: { responder: { capabilities: ['use-card:*'], requested: {},
          paymentPolicy: { cardIds: [first.id], budget: 300 } } },
      } } as any);
      const main = { projectId: project.id, taskId: task.id, capabilities: ['use-card:*'] };
      const responder = { ...main, participant: 'responder' };
      expect((await budget.cards(main)).map((card) => card.label).sort()).toEqual(['Main only', 'Shared']);
      expect((await budget.cards(responder)).map((card) => card.label)).toEqual(['Shared']);
      expect((await budget.request(responder, { amount: 100, cardName: 'Main only' })).status).toBe('denied');
      expect((await budget.request(responder, { amount: 200, cardName: 'Shared' })).status).toBe('granted');
      const over = await budget.request(responder, { amount: 150, cardName: 'Shared' });
      expect(over).toMatchObject({ status: 'needs_approval' });
      expect(over.reason).toMatch(/Responder's budget/);
      // The main agent's spend counts against the task, not the Responder's own budget.
      expect((await budget.request(main, { amount: 650, cardName: 'Main only' })).status).toBe('granted');
      expect(await store.paymentSpent(task.id, false, 'usd', 'responder')).toBe(200);
      expect(await store.paymentSpent(task.id)).toBe(850);
      // 100 left of its own 300, but only 150 left of the task's 1000.
      expect(await budget.participantPolicy(project.id, task.id, 'responder'))
        .toMatchObject({ cardIds: [first.id], budget: 300, spent: 200, own: true });
      expect(await budget.participantPolicy(project.id, task.id))
        .toMatchObject({ budget: 1000, spent: 850 });
      // Raising the agent's budget releases its waiting payment in order.
      const params = (await store.getTask(task.id))!.params as any;
      await store.updateTaskParams(task.id, { ...params, _agentAuthorization: { responder: {
        ...params._agentAuthorization.responder, paymentPolicy: { cardIds: [first.id], budget: 400 } } } });
      expect((await budget.reconcileTask(main)).map((result) => result.requestId)).toEqual([over.requestId]);
      expect(await store.paymentSpent(task.id, false, 'usd', 'responder')).toBe(350);
      // A reservation belongs to the agent that made it.
      await expect(budget.claimFill(main, over.requestId!)).rejects.toThrow(/reservation/);
    } finally { await store.close(); }
  });
});
