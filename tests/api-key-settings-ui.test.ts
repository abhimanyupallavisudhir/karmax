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
  it('is the same on/off switch as the organization list, in every scope', async () => {
    const { ui, row, saved } = await editor('project', { own: { on: [KEY] }, enabled: [KEY] });
    expect(await row.getByRole('combobox').count()).toBe(0);
    const toggle = row.locator('input.toggle.cred-toggle');
    expect(await toggle.isChecked()).toBe(true);
    await toggle.click();
    await expect.poll(saved).toHaveLength(1);
    expect(saved()[0]).toEqual({ scope: 'project', projectId: 'p', policy: { on: [], off: [KEY] } });
    expect(ui.calls.find((call) => call.method === 'POST')!.path).toBe('/api/organizations/org/credentials/policy?projectId=p');
    await ui.close();
  });

  it('turns an inherited Off key on for a task', async () => {
    const { ui, row, saved } = await editor('task', { own: {}, enabled: [] });
    const toggle = row.locator('input.toggle.cred-toggle');
    expect(await toggle.isChecked()).toBe(false);
    expect(await row.getAttribute('class')).toContain('off');
    await toggle.click();
    await expect.poll(saved).toHaveLength(1);
    expect(saved()[0]).toMatchObject({ scope: 'task', taskId: 't', policy: { on: [KEY], off: [] } });
    await ui.close();
  });

  it('offers write-only edit and delete controls for saved API keys', async () => {
    const { ui, row } = await editor('global', { own: {}, enabled: [KEY] });
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
