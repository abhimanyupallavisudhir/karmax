import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

describe('credential incident panel', () => {
  it('distinguishes needs-attention from quota exhaustion and renders native provenance', async () => {
    const accounts = [
      { id: 'claude-max', status: 'needs-attention', inUse: 0, maxConcurrent: 2, lastTransition: {
        kind: 'needs-attention', provider: 'anthropic', at: '2026-09-20T10:00:00Z', sourceTask: { id: 't1', num: 7, title: 'Fix login' },
        diagnostic: { code: 'billing_error', status: 402, model: 'claude-opus', operation: 'messages', requestId: 'req_123',
          retryAttempt: 2, retryMax: 3, message: 'Credit balance is too low' } } },
      { id: 'codex', status: 'exhausted', window: '5-hour window', inUse: 1, maxConcurrent: 1,
        lastTransition: { kind: 'exhausted', provider: 'openai', sourceTaskId: 'task_raw', diagnostic: {} } },
    ];
    const ui = await consolePage({ api: ({ path }) => path === '/api/organizations/o/accounts/status' ? { accounts }
      : path === '/api/organizations/o/accounts/usage' ? { usage: {}, pollable: [] } : undefined });
    await ui.run(`S.organizationId = 'o'; S.organizations = [{ id: 'o', name: 'Organization', slug: 'org' }];
      S.projects = [{ id: 'p', organizationId: 'o', name: 'Workspace', config: {} }]; S.projectId = 'p';
      document.getElementById('main').innerHTML = '<div id="account-status"></div>'; renderAccountStatus('o')`);
    const rows = ui.page.locator('#account-status .account-status');
    await rows.first().waitFor();
    const attention = await rows.nth(0).innerText();
    expect(attention).toContain('needs attention (funding or re-authentication)');
    expect(attention).not.toContain('exhausted');
    expect(attention).toContain('Credential incident');
    expect(attention).toContain('needs-attention · anthropic · billing_error · HTTP 402 · model claude-opus · messages · request req_123 · retry 2/3');
    expect(attention).toContain('Credit balance is too low');
    expect(await rows.nth(0).getByRole('link', { name: 'Task #7 — Fix login' }).getAttribute('href')).toMatch(/\/tasks\/t1$/);
    const exhausted = await rows.nth(1).innerText();
    expect(exhausted).toContain('5-hour window');
    expect(exhausted).not.toContain('needs attention');
    expect(await rows.nth(1).textContent()).toContain('Source: task_raw'); // an unresolved source task still names its id
    await ui.close();
  });
});
