import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage, type ApiCall } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

const KEY = 'key:handle:anthropic-work';
const credential = { key: KEY, kind: 'key', provider: 'anthropic', account: 'work', label: 'anthropic:work' };

/** Render the credential editor for `scope` against a scripted credentials API. */
async function editor(scope: 'global' | 'project' | 'task', policy: Record<string, unknown>) {
  const ui = await consolePage({ api: ({ method, path }: ApiCall) => {
    if (method === 'GET' && /^\/api\/organizations\/org\/credentials(\?|$)/.test(path)) return { credentials: [credential], [scope]: policy };
    if (method === 'GET' && path === '/api/organizations/org/accounts') return { logins: [] };
    return method === 'GET' ? undefined : {};
  } });
  const opts = scope === 'task' ? { organizationId: 'org', projectId: 'p', taskId: 't' }
    : scope === 'project' ? { organizationId: 'org', projectId: 'p' } : { organizationId: 'org' };
  await ui.run(`S.organizationId = 'org'; window.confirm = () => true;
    renderCredentialEditor(document.getElementById('main'), ${JSON.stringify(scope)}, ${JSON.stringify(opts)})`);
  await ui.page.locator('.cred-row').waitFor();
  const saved = () => ui.calls.filter((call) => call.method === 'POST' && call.path.includes('/credentials/policy'))
    .map((call) => call.body);
  return { ui, row: ui.page.locator(`.cred-row[data-key="${KEY}"]`), saved };
}

describe('API key settings UI', () => {
  it('offers all three API-key availability modes and persists them exclusively', async () => {
    const { ui, row, saved } = await editor('project', { own: { on: [KEY] }, enabled: [KEY], modes: { [KEY]: 'on' } });
    const mode = row.getByRole('combobox', { name: 'API key availability' });
    expect(await mode.locator('option').allTextContents()).toEqual(['On', 'Off', 'Explainer-only']);
    expect(await mode.inputValue()).toBe('on');
    await mode.selectOption('explainer-only');
    await expect.poll(saved).toHaveLength(1);
    expect(saved()[0]).toEqual({ scope: 'project', projectId: 'p',
      policy: { on: [], off: [], explainerOnly: [KEY] } });
    expect(ui.calls.find((call) => call.method === 'POST')!.path).toBe('/api/organizations/org/credentials/policy?projectId=p');
    await ui.close();
  });

  it('keeps API keys binary on Task forms and renders inherited explainer-only as Off', async () => {
    const { ui, row, saved } = await editor('task', { own: {}, enabled: [], modes: { [KEY]: 'explainer-only' } });
    expect(await row.getByRole('combobox').count()).toBe(0);
    const toggle = row.locator('.cred-toggle');
    expect(await toggle.textContent()).toBe('off');
    expect(await row.getAttribute('class')).toContain('off');
    await toggle.click();
    await expect.poll(saved).toHaveLength(1);
    expect(saved()[0]).toMatchObject({ scope: 'task', taskId: 't', policy: { on: [KEY], off: [], explainerOnly: [] } });
    await ui.close();
  });

  it('offers write-only edit and delete controls for saved API keys', async () => {
    const { ui, row } = await editor('global', { own: {}, enabled: [KEY], modes: { [KEY]: 'on' } });
    await row.getByTitle('Edit API key').click();
    const dialog = ui.page.getByRole('dialog', { name: 'Edit API key' });
    const secret = dialog.locator('.api-key-edit-secret');
    expect(await secret.getAttribute('type')).toBe('password');
    expect(await secret.getAttribute('autocomplete')).toBe('new-password');
    expect(await secret.inputValue()).toBe(''); // the saved key is never sent back to the browser
    await dialog.locator('.api-key-edit-account').fill('personal');
    await secret.fill('sk-new');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => ui.calls.filter((call) => call.method === 'PATCH')).toEqual([{ method: 'PATCH',
      path: '/api/organizations/org/accounts/keys/anthropic/work', body: { account: 'personal', apiKey: 'sk-new' } }]);
    await dialog.waitFor({ state: 'detached' });
    await row.getByTitle('Delete API key').click();
    await expect.poll(() => ui.calls.filter((call) => call.method === 'DELETE').map((call) => call.path))
      .toEqual(['/api/organizations/org/accounts/keys/anthropic/work']);
    expect(ui.errors).toEqual([]);
    await ui.close();
  });
});
