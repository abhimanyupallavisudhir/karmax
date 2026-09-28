import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage, emptySettings, signedIn, type ApiHandler } from './helpers/console-page.js';

// The gateway half of these journeys is tested where it lives: the profile
// return in github-personal-installation.test.ts, permission status in
// github-app.test.ts, and Confirm PR's label in github-pr-pipeline.test.ts.

afterAll(closeConsoleBrowser);

type Console = Awaited<ReturnType<typeof consolePage>>;

/** A signed-in console at `path`, answering `api` first and empty settings after. */
async function open(path: string, api: ApiHandler = () => undefined, ready = '#rail') {
  const ui = await consolePage({ path, api: signedIn(async (call) => (await api(call)) ?? emptySettings(call)) });
  await ui.run('window.confirm = () => true; boot()');
  await ui.page.locator(ready).first().waitFor({ state: 'attached' });
  return ui;
}
/** Open the settings pane holding `selector` the way a person does, from the section navigation. */
async function pane(ui: Console, selector: string) {
  const id = await ui.page.locator(selector).first().evaluate((element) =>
    (element.closest('section.settings-pane') as HTMLElement | null)?.dataset.pane);
  await ui.page.locator(`.settings-nav a[href="#${id}"]`).click();
  await ui.page.locator(selector).first().waitFor();
}
const posts = (ui: Console, prefix: string) => ui.calls.filter((call) => call.method === 'POST' && call.path.startsWith(prefix));
const connection = (permissionStatus: Record<string, unknown>) => ({ id: 'c', installationId: '42', accountLogin: 'acme',
  accountType: 'Organization', permissionStatus });

describe('GitHub re-authorization affordance', () => {
  const button = async (githubApp: unknown) => {
    const ui = await consolePage();
    const markup = await ui.run<string>(`githubAuthorizeButton(${JSON.stringify(githubApp)}, 'authorize-github')`);
    await ui.close();
    return markup;
  };

  // `userAuthorized` only reports that a credential EXISTS, not that GitHub still
  // accepts it. Gating the button on `!userAuthorized` meant a token invalidated
  // server-side left the operator with no way to reconnect: the card claimed
  // "App ready" and offered nothing to click.
  it('offers re-authorization even while a stored credential still looks authorized', async () => {
    expect(await button({ oauthConfigured: true, userAuthorized: true }))
      .toBe('<button class="btn sm" id="authorize-github">Reconnect my GitHub identity</button>');
  });

  it('asks for first-time authorization when no credential is stored', async () => {
    expect(await button({ oauthConfigured: true, userAuthorized: false }))
      .toBe('<button class="btn sm" id="authorize-github">Connect my GitHub identity</button>');
  });

  it('stays hidden when the App has no OAuth credentials to authorize against', async () => {
    expect(await button({ oauthConfigured: false, userAuthorized: false })).toBe('');
    expect(await button(undefined)).toBe('');
  });

  it('keeps the project escape hatch', async () => {
    const ui = await open('/org/workspace/settings', ({ path }) => path.endsWith('/github/app')
      ? { configured: true, oauthConfigured: true, userAuthorized: true }
      : path.endsWith('/git-connections') ? [connection({ ready: true })] : undefined, '.settings-layout');
    const reconnect = ui.page.locator('#project-authorize-github');
    expect(await reconnect.innerText()).toBe('Reconnect my GitHub identity');
    await ui.close();
  });

  it('lists profile accounts as cards and returns their authorization to the profile', async () => {
    const ui = await open('/profile', ({ method, path }) => {
      if (path === '/api/user/github-accounts') return { githubApp: { configured: true, oauthConfigured: true, userAuthorized: true },
        accounts: [{ id: 'a1', login: 'octo', active: true }, { id: 'a2', login: 'second', active: false }] };
      if (method === 'POST' && path === '/api/organizations/o/github/authorize') return { url: 'https://github.test/authorize' };
      return undefined;
    }, '.github-account-row');
    // GitHub answers 204, so the browser records the navigation but stays on the page.
    const toGithub: string[] = [];
    await ui.page.route('https://github.test/**', (route) => { toGithub.push(route.request().url()); return route.fulfill({ status: 204 }); });
    const rows = ui.page.locator('#profile-github .github-account-row');
    expect(await rows.locator('.github-account-label').allInnerTexts()).toEqual(['octo\nActive', 'second']);
    // Only an inactive account offers Use; the old single-identity button is gone.
    expect(await rows.nth(0).locator('button').allInnerTexts()).toEqual(['Reconnect', 'Custom identity', '']);
    expect(await rows.nth(1).locator('button').allInnerTexts()).toEqual(['Use', 'Reconnect', 'Custom identity', '']);
    expect(await ui.page.locator('#authorize-github, #user-authorize-github').count()).toBe(0);
    expect(await ui.page.locator('#profile-github .github-add').innerText()).toBe('Add new GitHub account');

    await rows.nth(1).getByRole('button', { name: 'Reconnect' }).click();
    await expect.poll(() => toGithub).toEqual(['https://github.test/authorize']);
    await ui.page.locator('#profile-github .github-add').click();
    await expect.poll(() => posts(ui, '/api/organizations/o/github/authorize').map((call) => call.body)).toEqual([
      { returnTo: 'profile', mode: 'reconnect', accountId: 'a2' }, { returnTo: 'profile', mode: 'add' }]);
    await ui.close();
  });

  it('shows the preserved secret-free authorization failure on the profile', async () => {
    const ui = await open('/profile', ({ path }) => path === '/api/user/github-accounts' ? { accounts: [], githubApp: {
      configured: true, oauthConfigured: true, userAuthorized: false,
      lastAuthorizationFailure: { disconnected: true, summary: 'GitHub revoked the refresh token.', code: 'bad_refresh_token',
        occurredAt: '2026-09-01T12:00:00Z' } } } : undefined, '#profile-github .card');
    const failure = await ui.page.locator('#profile-github .card').textContent();
    expect(failure).toContain('GitHub identity disconnected');
    expect(failure).toContain('GitHub revoked the refresh token. bad_refresh_token');
    expect(failure).toContain('also preserved in the audit log');
    // With no account yet, connecting is the primary action.
    expect(await ui.page.locator('#profile-github .github-add.primary').innerText()).toBe('Connect GitHub');
    await ui.close();
  });
});

describe('GitHub merge authorization UX', () => {
  const schema = [{ name: 'software-dev', params: [
    { name: 'prompt', type: 'text', label: 'Prompt', scopes: ['task'], bind: 'prompt' },
  ], stages: [{ key: 'do', label: 'Working' }] }];
  const taskForm = async (eligibility: Record<string, unknown>) => {
    const ui = await open('/org/workspace', ({ path }) => path === '/api/schema' ? schema
      : path === '/api/projects/p/github-merge-eligibility' ? eligibility : undefined);
    await ui.run(`openTaskForm('software-dev')`);
    await ui.page.locator('#tf-page').waitFor();
    return ui;
  };

  it('warns at task composition without blocking queueing', async () => {
    const ui = await taskForm({ remotePolicy: 'pr', creatorCanMerge: false, eligibleUserIds: [], repositories: ['acme/app'] });
    const warning = ui.page.locator('#tf-github-merge');
    await expect.poll(() => warning.isVisible()).toBe(true);
    const text = await warning.innerText();
    expect(text).toContain('GitHub merge reviewer recommended');
    expect(text).toContain('No connected project member currently has merge access');
    expect(text).toContain('You can still queue the task');
    expect(await ui.page.locator('#tf-queue').isEnabled()).toBe(true);
    await ui.close();
  });

  it('confirms an eligible creator, and stays out of the way when changes land without a PR', async () => {
    const eligible = await taskForm({ remotePolicy: 'pr', creatorCanMerge: true, repositories: ['acme/app'] });
    await expect.poll(() => eligible.page.locator('#tf-github-merge').innerText())
      .toContain('✓ Your connected GitHub account can request merges for acme/app.');
    await eligible.close();
    const direct = await taskForm({ remotePolicy: 'push', creatorCanMerge: false });
    await expect.poll(() => direct.calls.some((call) => call.path.endsWith('/github-merge-eligibility'))).toBe(true);
    expect(await direct.page.locator('#tf-github-merge').isHidden()).toBe(true);
    await direct.close();
  });

  it('separates PR review confirmation from later GitHub authorization', async () => {
    const ui = await consolePage();
    const render = async (view: Record<string, unknown>) => {
      await ui.run(`document.getElementById('main').innerHTML = overviewTab(${JSON.stringify(view)}) + taskActions(${JSON.stringify(view)})`);
      return {
        heading: await ui.page.locator('#main .section-h').filter({ hasText: /^(Review|Work summary)$/ }).textContent(),
        buttons: await ui.page.locator('#main .actions button').evaluateAll((buttons) => buttons.map((b) => (b as HTMLElement).dataset.label)),
      };
    };
    const confirm = { name: 'confirm', kind: 'signal', label: 'Confirm PR', enabled: true };
    expect(await render({ stage: 'review', status: 'active', actions: [confirm] })).toEqual({ heading: 'Review', buttons: ['Confirm PR'] });
    expect(await render({ stage: 'merge', status: 'active', reviewInfo: { caption: 'Done' }, waitingFor: { kind: 'human' },
      actions: [confirm] })).toEqual({ heading: 'Work summary', buttons: ['Authorize GitHub merge'] });
    await ui.close();
  });
});

describe('GitHub App permission UX', () => {
  it('asks the installation operator to widen the App itself', async () => {
    const ui = await open('/installation', ({ path }) => path === '/api/settings/installation' ? { canManage: true }
      : path.endsWith('/github/app') ? { configured: true, appSlug: 'krmax', appId: '1', oauthConfigured: true, webhookConfigured: true,
        permissionStatus: { ready: false, missingApp: ['actions: write'], appSettingsUrl: 'https://github.com/settings/apps/krmax/permissions' } }
      : undefined, '#installation-github-card .section-h');
    await pane(ui, '#installation-github-card');
    const card = ui.page.locator('#installation-github-card');
    expect(await card.locator('.section-h').textContent()).toBe('GitHub App action required');
    const text = await card.textContent();
    expect(text).toContain('GitHub App permissions need updating');
    expect(text).toContain('Add the missing permissions: actions: write.');
    expect(await card.getByRole('link', { name: 'Update permissions on GitHub' }).getAttribute('href'))
      .toBe('https://github.com/settings/apps/krmax/permissions');
    await ui.close();
  });

  it('reports each installation\'s access separately from the App envelope', async () => {
    const ui = await open('/org/settings', ({ path }) => path.endsWith('/github/app') ? { configured: true, oauthConfigured: true }
      : path.endsWith('/git-connections') ? [
        { ...connection({ ready: true }), id: 'ready', accountLogin: 'ready' },
        { ...connection({ ready: false, missingApp: ['actions: write'], appSettingsUrl: 'https://github.test/app' }), id: 'app', accountLogin: 'app' },
        { ...connection({ ready: false, missingApp: [], installationSettingsUrl: 'https://github.test/install' }), id: 'owner', accountLogin: 'owner' },
      ] : undefined, '#org-github .github-account-row');
    await pane(ui, '#org-github');
    const row = (id: string) => ui.page.locator(`#org-github .github-account-row[data-connection="${id}"]`);
    expect(await row('ready').innerText()).not.toContain('GitHub access update required');
    expect(await row('ready').getByRole('link').allInnerTexts()).toEqual(['Manage']);
    expect(await row('app').innerText()).toContain('GitHub access update required');
    expect(await row('app').getByRole('link', { name: 'Update App permissions' }).getAttribute('href')).toBe('https://github.test/app');
    // The App already has the permissions; only the installation's owner must accept them.
    expect(await row('owner').getByRole('link', { name: 'Approve permissions' }).getAttribute('href')).toBe('https://github.test/install');
    expect(await ui.page.locator('#connect-github').innerText()).toBe('Add new GitHub account');
    await ui.close();
  });
});
