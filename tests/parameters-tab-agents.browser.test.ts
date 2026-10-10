import { afterAll, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage, type ApiCall } from './helpers/console-page.js';
import { MANIFESTS } from '../src/contrib/manifests.js';

afterAll(closeConsoleBrowser);

/**
 * The Parameters tab mirrors the task form (wiki features/collaboration-model):
 * one Agent block per agent — the main agent, the Responder, each Reviewer, and
 * every agent called in with `@` — then where the task runs. Editable agents
 * save their own authority with their spec; frozen ones stay visible.
 */
const record = {
  id: 'fixture', projectId: 'p1', workflow: 'software-dev', workflowVersion: '1.27.0', title: 'Agents', params: {
    prompt: 'Agents',
    _authorization: { level: 'developer', scope: 'projects', projectIds: ['p1'], capabilities: ['task:read', 'use-credential:item:mine'] },
    paymentPolicy: { cardIds: [], budget: 0, currency: 'usd' },
    responder: { kind: 'agent', provider: 'mock', prompt: 'Answer briefly',
      authority: { authorization: { level: 'viewer', scope: 'projects', projectIds: ['p1'] } } },
    confirm: { layers: [{ kind: 'agent', provider: 'mock', prompt: 'Check tests' }, { kind: 'human', audience: ['@creator'] }] },
    'agent:agent-2': { provider: 'claude', authority: { authorization: { level: 'viewer', scope: 'projects', projectIds: ['p1'] } } },
  },
};
const participants = [
  { key: 'do', label: 'Agent', role: 'do', state: 'running', messages: 3 },
  { key: 'responder', label: 'Responder', role: 'responder', state: 'idle', messages: 0 },
  { key: 'confirm', label: 'Reviewer', role: 'confirm', state: 'idle', messages: 0 },
  { key: 'agent-2', label: 'Agent 2', role: 'agent', state: 'queued', messages: 0, spec: { provider: 'mock' } },
];
const view = (overrides: Record<string, unknown> = {}) => ({
  taskId: 'fixture', title: 'Agents', workflow: 'software-dev', stage: 'do', status: 'active', agents: {},
  messages: [], actions: [], participants,
  editableParams: ['agent:do', 'responder', 'confirm', 'target', 'agent:agent-2'], ...overrides,
});

async function openParameters(taskView: Record<string, unknown>) {
  const patches: ApiCall[] = [];
  const ui = await consolePage({ api: (call) => {
    const path = call.path.split('?')[0]!;
    if (path === '/api/tasks/fixture/params' && call.method === 'PATCH') { patches.push(call); return { applied: Object.keys(call.body.params), view: taskView }; }
    if (path === '/api/tasks/fixture') return taskView;
    if (path === '/api/tasks/fixture/attempts') return null;
    if (path === '/api/tasks/fixture/payments') return { cardIds: [], budget: 0, currency: 'usd', cards: [], canEdit: true, spent: 0, released: [] };
    if (path.endsWith('/sessions')) return {};
    if (path.includes('/defaults/')) return { task: { inherited: {} } };
    if (path === '/api/vault/items') return [{ id: 'mine', label: 'Mine', type: 'login', policy: {} }];
    if (path === '/api/cards' || path.endsWith('/payments')) return path === '/api/cards' ? [] : {};
    if (path.endsWith('/tasks')) return [record];
    if (path.includes('explanation-settings')) return { effective: { enabled: false } };
    return [];
  } });
  await ui.run(`(async () => {
    S.schema = ${JSON.stringify(MANIFESTS)};
    S.tasks = [${JSON.stringify(record)}];
    S.projects = [{ id: 'p1', slug: 'project', name: 'Project', organizationId: 'o1', config: {} }];
    S.projectId = 'p1'; S.organizationId = 'o1'; S.organizations = [{ id: 'o1', slug: 'org', name: 'Org' }];
    S.meta = { workflows: [] };
    await openTask('fixture', 'parameters');
  })()`);
  return { ui, patches };
}

it('shows one Agent block per agent, in conversation order, and saves an agent’s own authority', async () => {
  const { ui, patches } = await openParameters(view());
  const { page } = ui;

  try {
    const params = page.locator('#tp-params');
    await params.waitFor();
    expect(await params.locator(':scope > .tp-section').evaluateAll((sections) => sections.map((section) =>
      section.querySelector('[data-row]')?.getAttribute('data-row')))).toEqual(['prompt', 'agent:do', 'responder', 'confirm', 'agent:agent-2', 'computer', 'base']);
    // The task's own authority is the main agent's collapsed Authorization row.
    const main = params.locator('[data-row="agent:do"] .agent-authority');
    expect(await main.evaluate((el) => (el as unknown as { open: boolean }).open)).toBe(false);
    expect(await main.locator('.aa-summary').textContent()).toContain('Developer');
    expect(await main.locator('#tp-authorization, #tp-vault-open, #tp-payments, #tp-auth-save').count()).toBe(4);
    // Every other agent shows its own authority, or the task's.
    expect(await params.locator('[data-row="responder"] .aa-summary').textContent()).toContain('Viewer');
    expect(await params.locator('[data-row="confirm"] .cf-layer[data-kind="agent"] .aa-summary').textContent()).toBe('Same as Agent');
    const called = params.locator('[data-row="agent:agent-2"]');
    expect(await called.locator('.label-row label').textContent()).toBe('Agent 2');
    expect(await called.locator('.pf-agent-state').textContent()).toBe('queued');
    expect(await params.locator('[data-row="responder"] .ab-instructions').inputValue()).toBe('Answer briefly');

    await called.locator('.agent-authority > summary').click();
    await called.locator('.authz-level-select').selectOption('maintainer');
    await page.locator('#params-save').click();
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]!.body.params).toEqual({ 'agent:agent-2': expect.objectContaining({ provider: 'claude',
      // Changing one part makes the whole authority the agent's own: the
      // task's vault grants and payments are copied, not inherited.
      authority: { authorization: { level: 'maintainer', scope: 'projects', projectIds: ['p1'] },
        credentialGrants: ['use-credential:item:mine'], credentialPolicies: {}, paymentPolicy: { cardIds: [], budget: 0, currency: 'usd' } } }) });
    expect(ui.errors).toEqual([]);
  } finally { await ui.close(); }
});

it('lists called agents from params for a view without participants, and freezes used parameters', async () => {
  const { ui } = await openParameters(view({ participants: undefined, editableParams: [] }));
  const { page } = ui;
  try {
    const params = page.locator('#tp-params');
    await params.waitFor();
    const called = params.locator('[data-row="agent:agent-2"]');
    expect(await called.count()).toBe(1);
    expect(await called.locator('.af-ref').isDisabled()).toBe(true);
    expect(await params.locator('[data-row="responder"] .rf-kind').isDisabled()).toBe(true);
    expect(await params.locator('[data-row="agent:do"] .af-ref').isDisabled()).toBe(true);
    // The task's authority stays editable while its agent's harness is frozen.
    await params.locator('[data-row="agent:do"] .agent-authority > summary').click();
    expect(await params.locator('#tp-authorization .authz-level-select').isDisabled()).toBe(false);
    expect(await page.locator('#params-save').count()).toBe(0);
    expect(ui.errors).toEqual([]);
  } finally { await ui.close(); }
});
