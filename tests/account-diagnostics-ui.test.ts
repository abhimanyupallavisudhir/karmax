import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

describe('credential incident panel', () => {
  it('distinguishes needs-attention from quota exhaustion and renders native provenance', async () => {
    const credentials = ['claude-max', 'codex'].map((id) => ({ key: id, label: `claude:${id}`, provider: 'claude', kind: 'login', account: id }));
    const accounts = [
      { id: 'claude-max', status: 'needs-attention', inUse: 0, maxConcurrent: 2, lastTransition: {
        kind: 'needs-attention', provider: 'anthropic', at: '2026-09-20T10:00:00Z', sourceTask: { id: 't1', num: 7, title: 'Fix login' },
        diagnostic: { code: 'billing_error', status: 402, model: 'claude-opus', operation: 'messages', requestId: 'req_123',
          retryAttempt: 2, retryMax: 3, message: 'Credit balance is too low' } } },
      { id: 'codex', status: 'exhausted', window: '5-hour window', resetAt: Date.now() + 3_600_000, inUse: 1, maxConcurrent: 1,
        lastTransition: { kind: 'exhausted', provider: 'openai', sourceTaskId: 'task_raw', diagnostic: {} } },
    ];
    const ui = await consolePage({ api: ({ path }) => path.startsWith('/api/organizations/o/credentials')
      ? { credentials, global: { own: {}, enabled: ['claude-max', 'codex'] } }
      : path === '/api/organizations/o/accounts' ? { logins: [] }
      : path === '/api/organizations/o/accounts/status' ? { accounts }
      : path === '/api/organizations/o/accounts/usage' ? { usage: {}, pollable: [] } : undefined });
    await ui.run(`S.organizationId = 'o'; S.organizations = [{ id: 'o', name: 'Organization', slug: 'org' }];
      S.projects = [{ id: 'p', organizationId: 'o', name: 'Workspace', config: {} }]; S.projectId = 'p';
      document.getElementById('main').innerHTML = '<div id="cred-editor-global"></div>';
      renderCredentialEditor(document.getElementById('cred-editor-global'), 'global', { organizationId: 'o', accounts: true })`);
    const rows = ui.page.locator('.cred-row.acct');
    await rows.first().waitFor();
    expect(await rows.nth(0).locator('.acct-state').innerText()).toBe('Needs attention');
    expect(await rows.nth(1).locator('.acct-state').innerText()).toMatch(/^Out of quota · back in (59m|1h 0m)$/);
    expect(await rows.nth(1).locator('.acct-state').getAttribute('title')).toContain('5-hour window');
    // The incident is folded under its row until asked for.
    expect(await rows.nth(0).locator('.acct-incident').isVisible()).toBe(false);
    await rows.nth(0).getByRole('button', { name: 'Details of claude:claude-max' }).click();
    const attention = await rows.nth(0).locator('.acct-detail').innerText();
    expect(attention).toContain('Last issue');
    expect(attention).toContain('Needs-attention · anthropic · billing_error · HTTP 402 · model claude-opus · messages · request req_123 · retry 2/3');
    expect(attention).toContain('Credit balance is too low');
    expect(await rows.nth(0).getByRole('link', { name: 'Task #7 — Fix login' }).getAttribute('href')).toMatch(/\/tasks\/t1$/);
    await rows.nth(1).locator('.acct-expand').click();
    expect(await rows.nth(1).locator('.acct-incident').textContent()).toContain('task_raw'); // an unresolved source task still names its id
    expect(ui.errors).toEqual([]);
    await ui.close();
  });
});
