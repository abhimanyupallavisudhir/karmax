import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage, emptySettings, signedIn, type ApiHandler } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

type Console = Awaited<ReturnType<typeof consolePage>>;

/** A signed-in console at `path`, answering `api` first and empty settings after. */
async function open(path: string, api: ApiHandler = () => undefined, ready = '#rail') {
  const ui = await consolePage({ path, api: signedIn(async (call) => (await api(call)) ?? emptySettings(call)) });
  await ui.run('window.confirm = () => true; boot()');
  await ui.page.locator(ready).first().waitFor({ state: 'attached' });
  return ui;
}
const where = (ui: Console) => ui.run<string>('location.pathname');
const githubAccounts = { githubApp: { configured: true, oauthConfigured: true, userAuthorized: true },
  accounts: [{ id: 'a1', login: 'octo', active: true, profile: { customIdentity: { userName: 'Octo Cat' } } }] };

describe('personal Git development settings', () => {
  it('sends a newly created account to its profile before the workspace dashboard', async () => {
    const created = ({ path }: { path: string }) => path === '/api/session'
      ? { authenticated: true, user: { id: 'u', name: 'Tester' }, gitOnboarding: true } : undefined;
    const home = await open('/', created, '#profile-github');
    expect(await where(home)).toBe('/profile');
    await home.close();
    // Only the neutral home route is replaced; a deep link (an invitation, a shared task) is kept.
    const deep = await open('/org/workspace', created);
    expect(await where(deep)).toBe('/org/workspace');
    await deep.close();
    const returning = await open('/');
    expect(await where(returning)).not.toBe('/profile');
    await returning.close();
  });

  it('saves an account\'s own GitHub token behind its Token button, for pull requests on forked repositories', async () => {
    const ui = await open('/profile', ({ method, path }) => path === '/api/user/github-accounts' ? githubAccounts
      : method === 'PUT' && path === '/api/user/github-accounts/a1/token' ? { profile: { githubToken: true } } : undefined, '.github-account-row');
    const button = ui.page.locator('#profile-github .github-token');
    expect(await button.innerText()).toBe('Token');
    expect(await button.getAttribute('title')).toMatch(/pull requests on repositories you forked/);
    await button.click();
    const dialog = ui.page.getByRole('dialog', { name: 'GitHub token' });
    expect(await dialog.locator('a', { hasText: 'create' }).getAttribute('href')).toContain('scopes=public_repo');
    await dialog.locator('.github-token-value').fill('ghp_personal');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => ui.calls.filter((call) => call.method === 'PUT').map((call) => [call.path, call.body]))
      .toEqual([['/api/user/github-accounts/a1/token', { token: 'ghp_personal' }]]);
    await expect.poll(() => dialog.count()).toBe(0);
    await ui.close();
  });

  it('puts connected GitHub accounts and custom identity controls inside the main profile card', async () => {
    const ui = await open('/profile', ({ method, path }) => path === '/api/user/github-accounts' ? githubAccounts
      : method === 'PUT' && path === '/api/user/github-accounts/a1/identity' ? {} : undefined, '.github-account-row');
    const card = ui.page.locator('.profile-card');
    expect(await card.locator('#profile-github .github-account-row .github-account-label').innerText()).toContain('octo');
    expect(await card.locator('#profile-github .github-add').innerText()).toBe('Add new GitHub account');
    // Tokens, SSH keys and a commit email are not typed in here: GitHub authorization supplies them.
    expect(await ui.page.locator('input[type="password"], textarea').evaluateAll((fields) =>
      fields.filter((field) => field.closest('#profile-github')).length)).toBe(0);
    expect(await card.textContent()).not.toContain('Commit email');

    const custom = card.getByRole('button', { name: 'Custom identity' });
    await custom.click();
    const dialog = ui.page.getByRole('dialog', { name: 'Custom identity' });
    expect(await dialog.getByLabel('git config user.name').inputValue()).toBe('Octo Cat');
    await ui.page.keyboard.press('Escape');
    await expect.poll(() => dialog.count()).toBe(0);

    await custom.click();
    await dialog.getByLabel('git config user.email').fill('octo@example.com');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => ui.calls.filter((call) => call.method === 'PUT').map((call) => [call.path, call.body])).toEqual([
      ['/api/user/github-accounts/a1/identity', { userName: 'Octo Cat', userEmail: 'octo@example.com', removeSigningKey: false }]]);
    await expect.poll(() => dialog.count()).toBe(0);
    await ui.close();
  });

  it('shows organization installation cards and one automation identity control', async () => {
    let connections = [{ id: 'c/1', installationId: '42', accountLogin: 'acme', accountType: 'Organization', permissionStatus: { ready: true } }];
    const ui = await open('/org/settings', ({ method, path }) => {
      if (path.endsWith('/github/app')) return { configured: true, oauthConfigured: true };
      if (path.endsWith('/git-connections')) return connections;
      if (path.endsWith('/github/identity')) return { profile: null };
      if (method === 'DELETE') { connections = []; return {}; }
      return undefined;
    }, '#org-github .github-account-row');
    const id = await ui.page.locator('#org-github').evaluate((element) => element.closest('section.settings-pane')!.dataset.pane);
    await ui.page.locator(`.settings-nav a[href="#${id}"]`).click();
    const row = ui.page.locator('#org-github .github-account-row');
    expect(await row.getByRole('link', { name: 'Manage' }).getAttribute('href'))
      .toBe('https://github.com/organizations/acme/settings/installations/42');
    expect(await ui.page.locator('#org-github').getByRole('button').allInnerTexts())
      .toEqual(['', 'Add new GitHub account', 'Custom automation identity']);
    await ui.page.locator('#org-github-custom').click();
    await ui.page.getByRole('dialog', { name: 'Custom automation identity' }).getByRole('button', { name: 'Cancel' }).click();

    await row.getByRole('button', { name: 'Remove GitHub connection' }).click();
    await expect.poll(() => ui.calls.filter((call) => call.method === 'DELETE').map((call) => call.path))
      .toEqual(['/api/organizations/o/git-connections/c%2F1']);
    // With nothing left, connecting is the primary action and there is no identity to customise.
    await expect.poll(() => ui.page.locator('#connect-github.primary').textContent()).toBe('Connect GitHub');
    expect(await ui.page.locator('#org-github-custom').count()).toBe(0);
    await ui.close();
  });
});
