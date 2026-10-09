import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage, emptySettings, signedIn, type ApiCall, type ApiHandler } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

async function settings(options: { path?: string; api?: ApiHandler; projects?: Array<Record<string, unknown>>;
  organizations?: Array<Record<string, unknown>> } = {}) {
  const ui = await consolePage({ path: options.path ?? '/org/workspace/settings', api: signedIn(async (call: ApiCall) =>
    (await options.api?.(call)) ?? emptySettings(call), { projects: options.projects, organizations: options.organizations }) });
  await ui.run('window.confirm = () => true; boot()');
  await ui.page.locator('.settings-layout').waitFor();
  return ui;
}

type Console = Awaited<ReturnType<typeof consolePage>>;
const visible = (ui: Console, selector: string) => ui.page.locator(selector).isVisible();
/** Open a settings pane the way a person does, from the section navigation. */
const pane = (ui: Console, id: string) => ui.page.locator(`.settings-nav a[href="#${id}"]`).click();

describe('Project settings', () => {
  it('uses the same name-first heading hierarchy for project and organization settings', async () => {
    const project = await settings();
    expect(await project.page.locator('h1.page-title').textContent()).toBe('Workspace');
    expect(await project.page.locator('h1.page-title + .settings-intro').textContent()).toBe('Project settings');
    await project.close();
    const organization = await settings({ path: '/org/settings' });
    expect(await organization.page.locator('h1.page-title').textContent()).toBe('Organization');
    expect(await organization.page.locator('h1.page-title + .settings-intro').textContent()).toBe('Organization settings');
    await organization.close();
  });

  it('places permission-gated rename controls in Advanced settings and saves only the name', async () => {
    const ui = await settings({ api: ({ method, path: route }) => route.startsWith('/api/settings/access')
      ? { project: true, projectDelete: false, projectTransfer: true }
      : method === 'PATCH' ? { id: 'p', organizationId: 'o', name: 'Renamed', config: {} } : undefined });
    await pane(ui, 'project-advanced');
    await expect.poll(() => visible(ui, '#rename-project')).toBe(true);
    expect(await ui.page.locator('#project-name').inputValue()).toBe('Workspace');
    expect(await ui.page.locator('#project-folder').count()).toBe(0);
    expect(await visible(ui, '#move-project')).toBe(true);
    expect(await visible(ui, '#delete-project')).toBe(false); // no projectDelete authority
    expect(await ui.run(`{
      const move = document.getElementById('move-project');
      [document.getElementById('project-advanced').compareDocumentPosition(move) & Node.DOCUMENT_POSITION_FOLLOWING,
        move.compareDocumentPosition(document.getElementById('project-experimental')) & Node.DOCUMENT_POSITION_FOLLOWING];
    }`)).toEqual([Node_FOLLOWING, Node_FOLLOWING]);
    await ui.page.locator('#project-name').fill('Renamed');
    await ui.page.locator('#rename-project').click();
    await expect.poll(() => ui.calls.filter((call) => call.method === 'PATCH'))
      .toEqual([{ method: 'PATCH', path: '/api/projects/p', body: { name: 'Renamed' } }]);
    await ui.close();

    const organization = await settings({ path: '/org/settings', api: ({ method }) => method === 'PATCH' ? {} : undefined });
    await organization.page.locator('#rename-organization').evaluate((element) =>
      element.closest('section.settings-pane')?.dataset.pane).then((id) => pane(organization, id!));
    await expect.poll(() => visible(organization, '#rename-organization')).toBe(true);
    await organization.page.locator('#organization-name').fill('Renamed organization');
    await organization.page.locator('#rename-organization').click();
    await expect.poll(() => organization.calls.find((call) => call.method === 'PATCH'))
      .toMatchObject({ path: '/api/organizations/o', body: { name: 'Renamed organization' } });
    await organization.close();
  });

  it('creates projects in a native escapable path dialog', async () => {
    const ui = await settings();
    const open = async () => { await ui.run('newProject()'); return ui.page.getByRole('dialog'); };
    let dialog = await open();
    expect(await dialog.getAttribute('aria-modal')).toBe('true');
    expect(await ui.page.locator('#modal-root .new-project-dialog').count()).toBe(1);
    expect(await dialog.locator('input').first().getAttribute('placeholder')).toBe('e.g. Work/Clients/Website');
    await ui.page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    dialog = await open();
    await ui.page.locator('.modal-overlay').click({ position: { x: 5, y: 5 } });
    await dialog.waitFor({ state: 'detached' });
    await ui.close();
  });

  it('edits project paths and folder names inline from the sidebar', async () => {
    const projects = [{ id: 'p', organizationId: 'o', name: 'Workspace', config: {} },
      { id: 'w', organizationId: 'o', name: 'Site', folder: 'Work', config: {} }];
    const ui = await settings({ projects, api: ({ method, path: route, body }) => method !== 'PATCH' ? undefined
      : route === '/api/projects/p' ? { ...projects[0], name: body.name }
        : route === '/api/projects/w/folder' ? [{ ...projects[1], folder: body.name }] : undefined });
    const edit = ui.page.locator('#rail [data-project-edit="p"]');
    // The edit affordance appears only when the row is hovered or focused.
    const opacity = () => edit.evaluate((element) => Number((globalThis as any).getComputedStyle(element).opacity));
    expect(await opacity()).toBe(0);
    await ui.page.locator('#rail .proj', { has: ui.page.locator('[data-project-edit="p"]') }).hover();
    await expect.poll(opacity).toBeGreaterThan(0);
    await edit.click();
    const input = ui.page.locator('#rail .rail-edit-input');
    expect(await input.inputValue()).toBe('Workspace');
    await ui.page.keyboard.press('Escape');
    await input.waitFor({ state: 'detached' });
    expect(ui.calls.some((call) => call.method === 'PATCH')).toBe(false);
    await ui.page.locator('#rail .proj', { has: ui.page.locator('[data-project-edit="p"]') }).hover();
    await edit.click();
    await input.fill('Clients/Website');
    await ui.page.locator('#rail .rail-edit-confirm').click();
    await expect.poll(() => ui.calls.filter((call) => call.method === 'PATCH'))
      .toEqual([{ method: 'PATCH', path: '/api/projects/p', body: { name: 'Clients/Website' } }]);

    await ui.page.locator('#rail .proj', { has: ui.page.locator('[data-folder-edit="Work"]') }).hover();
    await ui.page.locator('#rail [data-folder-edit="Work"]').click();
    expect(await input.inputValue()).toBe('Work');
    await input.fill('Clients');
    await ui.page.keyboard.press('Enter');
    await expect.poll(() => ui.calls.filter((call) => call.method === 'PATCH').at(-1))
      .toEqual({ method: 'PATCH', path: '/api/projects/w/folder', body: { folder: 'Work', name: 'Clients' } });
    await ui.close();
  });

  it('keeps the post-delete fallback inside the deleted project’s organization', async () => {
    const organizations = [{ id: 'x', name: 'Elsewhere', slug: 'elsewhere' }, { id: 'o', name: 'Organization', slug: 'org' }];
    const deleted = { id: 'p', organizationId: 'o', name: 'Workspace', config: {} };
    const foreign = { id: 'f', organizationId: 'x', name: 'First anywhere', config: {} };
    const sibling = { id: 's', organizationId: 'o', name: 'Sibling', config: {} };
    const afterDelete = async (remaining: Array<Record<string, unknown>>) => {
      let gone = false;
      const ui = await settings({ projects: [foreign, deleted, ...remaining], organizations, api: ({ method, path: route }) => {
        if (method === 'DELETE' && route === '/api/projects/p') { gone = true; return {}; }
        if (gone && method === 'GET' && route === '/api/projects') return [foreign, ...remaining];
        return undefined;
      } });
      await pane(ui, 'project-advanced');
      await expect.poll(() => visible(ui, '#delete-project')).toBe(true);
      await ui.page.locator('#delete-project').click();
      await expect.poll(() => ui.run<string>('location.pathname')).not.toBe('/org/workspace/settings');
      const landed = await ui.run<string>('location.pathname');
      await ui.close();
      return landed;
    };
    expect(await afterDelete([sibling])).toBe('/org/sibling');
    expect(await afterDelete([])).toBe('/org/insights');
  });

  it('formats discovered and revision byte sizes without a missing global', async () => {
    const ui = await consolePage();
    expect(await ui.run('[0, 1023, 1024, 5 * 1024 ** 3, undefined].map(formatBytes)'))
      .toEqual(['0 B', '1023 B', '1 KB', '5 GB', '—']);
    await ui.close();
  });

  it('keeps code, secrets, data, services, and environment in one Project pane', async () => {
    const ui = await settings();
    const nav = await ui.page.locator('.settings-layout nav a, .settings-nav a').allInnerTexts();
    expect(nav).toContain('Project');
    expect(nav).not.toContain('Data');
    for (const id of ['project-git', 'project-secrets', 'project-data', 'project-services', 'project-environment'])
      expect(await ui.page.locator(`#${id}`).count(), id).toBe(1);
    expect(await ui.page.locator('#main').innerText()).not.toContain('Agent-manageable by design');
    await ui.close();
  });

  it('shows where each secret goes and puts a suggested name in the repository that asked for it', async () => {
    const posts: any[] = [];
    const ui = await settings({ api: ({ method, path: route, body }) => {
      if (!route.split('?')[0]!.endsWith('/secrets')) return undefined;
      if (method === 'POST') { posts.push(body); return { imported: [], secrets: [] }; }
      return { repositories: ['api', 'web'], suggested: [{ name: 'DATABASE_URL', repository: 'web' }], secrets: [
        { id: 's1', name: 'api/.env:DATABASE_URL', variable: 'DATABASE_URL', dotenv: { path: '.env', repository: 'api' } },
        { id: 's2', name: 'SHARED', variable: 'SHARED' },
        { id: 's3', name: 'sa.json', file: 'config/sa.json', repository: 'web' }] };
    } });
    const box = ui.page.locator('#project-secrets-box');
    await box.locator('.project-resource-row').first().waitFor();
    const rows = await box.locator('.project-resource-row').evaluateAll((elements) =>
      elements.map((element) => [element.querySelector('b')!.textContent, element.querySelector('code')!.textContent, element.querySelector('.chip')!.textContent]));
    expect(rows).toEqual([['SHARED', 'SHARED', 'environment variable'], ['DATABASE_URL', 'api/.env', '.env line'],
      ['sa.json', 'web/config/sa.json', 'private file']]);
    await box.locator('.project-secret-suggest', { hasText: 'DATABASE_URL' }).click();
    expect(await box.locator('#project-secret-file').inputValue()).toBe('web/.env');
    await box.locator('#project-secret-value').fill('postgres://web');
    await box.locator('#project-secret-save').click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toEqual({ name: 'DATABASE_URL', value: 'postgres://web', file: 'web/.env' });
    // Each repository's .env is offered; a blank destination means every command.
    await box.locator('#project-secret-paste summary').click();
    await box.locator('#project-secret-env-file').focus();
    expect(await box.locator('#project-secret-paste .combo-opt').evaluateAll((options) => options.map((option) => (option as any).dataset.v)))
      .toEqual(['api/.env', 'web/.env']);
    expect(await box.locator('#project-secret-env-file').getAttribute('placeholder')).toBe('Every command');
    await ui.close();
  });

  it('keeps organization repository and storage controls in one Projects pane', async () => {
    const ui = await settings({ path: '/org/settings' });
    const links = await ui.page.locator('.settings-layout a[href^="#settings-"]').evaluateAll((anchors) =>
      anchors.map((anchor) => [anchor.getAttribute('href'), anchor.textContent?.trim()]));
    expect(links).toContainEqual(['#settings-code', 'Projects']);
    expect(links.map(([, label]) => label)).not.toContain('Data storage');
    const projects = ui.page.locator('section.settings-pane', { has: ui.page.locator('#settings-code') });
    expect(await projects.locator('.section-h', { hasText: 'Git & GitHub' }).count()).toBe(1);
    expect(await projects.locator('#settings-storage').count()).toBe(1);
    expect(await ui.page.locator('#settings-storage').textContent()).toMatch(/^Data storage/);
    await ui.close();
  });

  it('explains the Data/Service/S3 boundary once, in the section tips, and offers each import path', async () => {
    const ui = await settings();
    const tip = (heading: string) => ui.page.locator('h2', { hasText: heading }).first().locator('[data-tip], [title], .policy-tip').first()
      .evaluate((element) => element.getAttribute('data-tip') || element.getAttribute('title') || element.textContent || '');
    expect(await tip('Data')).toContain('Choose Data when');
    expect(await tip('Data')).toContain('Storage only decides where the encrypted revisions live');
    expect(await tip('Services')).toContain('Use an external service for an API, hosted database or S3 bucket');
    await ui.page.locator('#data-add-panel summary').click();
    const data = await ui.page.locator('#data-add-panel').innerText();
    expect(data).toContain('Mount at path (repo-relative)');
    expect(data).toContain('Import from local path');
    expect(await ui.page.locator('#service-kind option').allTextContents())
      .toContain('Connect to an existing external service');
    await ui.close();
  });

  it('keeps forms concise and offers optional base-image suggestions', async () => {
    const ui = await settings({ api: ({ method, path }) => method === 'GET' && path.split('?')[0]!.endsWith('/environment')
      ? { spec: {}, builds: [], repositories: ['app'] } : undefined });
    await ui.page.locator('#environment-image').waitFor({ state: 'attached' });
    const text = await ui.page.locator('#main').innerText();
    for (const removed of [
      'The repositories this project works on, and the identity it commits with.',
      'Sensitive values injected only when a task needs them. Values are never shown again.',
      'No versioned data yet.', 'A human-readable name in Project settings.',
      'The destination path inside every task world', 'Expensive installation commands baked into a reusable build',
      'No build yet.', 'Local repo, GitHub, or Git URL', 'Repository source', 'Save repositories',
    ]) expect(text).not.toContain(removed);
    expect(await ui.page.locator('#project-repository-input').getAttribute('placeholder')).toBe('Git URL or local path');
    expect(text).toContain('Base image (optional)');
    expect(await ui.page.locator('#environment-image').getAttribute('list')).toBe('environment-image-options');
    expect(await ui.page.locator('#environment-image-options option').evaluateAll((options) =>
      options.map((option) => (option as any).value))).toContain('python:3.13-slim');
    const placeholder = (selector: string) => ui.page.locator(selector).getAttribute('placeholder');
    // Dependency installs need the checkout, so they are suggested per repository, not as build setup.
    expect(await placeholder('#environment-setup')).toBe('sudo apt-get install -y postgresql-client');
    expect(await placeholder('[data-environment-install="app"]')).toBe('npm ci\nnpx playwright install --with-deps chromium');
    expect(await placeholder('#environment-boot')).toContain('uv run python manage.py migrate');
    await ui.close();
  });

  it('marks a build that worlds no longer use as stale, explaining why on hover', async () => {
    const build = (over: object) => ({ provider: 'e2b', digest: 'abcdef0123456789', status: 'ready', ref: 'snapshot', ...over });
    const ui = await settings({ api: ({ method, path }) => method === 'GET' && path.split('?')[0]!.endsWith('/environment')
      ? { spec: { setup: ['true'] }, digest: 'abcdef0123456789', repositories: [],
        builds: [build({ stale: true, recoveryRevision: 'r1' }), build({ provider: 'daytona', recoveryRevision: 'r2' })] } : undefined });
    const chips = ui.page.locator('.queue-item .chip', { hasText: 'abcdef01' });
    await chips.first().waitFor();
    expect(await chips.allTextContents()).toEqual(['abcdef01 · stale', 'abcdef01']);
    expect(await chips.first().getAttribute('title')).toBe('Built on an older base image. Rebuild to use it.');
    await ui.close();
  });

  it('opens GitHub repository creation from a button beside Add', async () => {
    const ui = await settings({ api: ({ method, path: route }) => method !== 'GET' ? undefined
      : route.endsWith('/github/app') ? { configured: true, userAuthorized: true }
        : route.endsWith('/git-connections') ? [{ id: 'gc', provider: 'github', accountLogin: 'octo' }] : undefined });
    const add = ui.page.getByRole('button', { name: 'Add', exact: true });
    const create = ui.page.getByRole('button', { name: 'New repository' });
    await create.waitFor();
    expect(await add.evaluate((element, other) => element.parentElement === other!.parentElement
      && !!(element.compareDocumentPosition(other!) & (globalThis as any).Node.DOCUMENT_POSITION_FOLLOWING), await create.elementHandle())).toBe(true);
    await create.click();
    const dialog = ui.page.getByRole('dialog');
    expect(await dialog.getAttribute('aria-modal')).toBe('true');
    const text = await dialog.innerText();
    for (const label of ['GitHub account', 'Repository name', 'Description', 'Private repository']) expect(text).toContain(label);
    await ui.page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    expect(await create.evaluate((element) => element === (globalThis as any).document.activeElement)).toBe(true);
    await ui.close();
  });

  it('names repositories the way people do, keeping the exact source on hover', async () => {
    const ui = await consolePage();
    expect(await ui.run(`[
      'git@github.com:acme/web.git', 'https://github.com/Acme/API', 'ssh://git@ssh.github.com:443/acme/infra.git',
      '/srv/code/tools', 'https://gitlab.com/acme/legacy.git',
    ].map((source) => { const { kind, owner, name, key } = repositorySourceView(source); return [kind, owner, name, key]; })`)).toEqual([
      ['github', 'acme', 'web', 'acme/web'], ['github', 'Acme', 'API', 'acme/api'], ['github', 'acme', 'infra', 'acme/infra'],
      ['local', undefined, '/srv/code/tools', '/srv/code/tools'], ['git', undefined, 'https://gitlab.com/acme/legacy.git', 'https://gitlab.com/acme/legacy.git'],
    ]);
    await ui.close();
  });

  it('saves each repository as it is added or removed, picking organization repositories by owner/name', async () => {
    const repositories = [{ id: 'r1', owner: 'acme', name: 'web', sshUrl: 'git@github.com:acme/web.git' },
      { id: 'r2', owner: 'acme', name: 'api', sshUrl: 'git@github.com:acme/api.git' }];
    let repos = ['git@github.com:acme/web.git', '/srv/code/tools'];
    const project = () => ({ id: 'p', organizationId: 'o', name: 'Workspace', config: { repos } });
    const ui = await consolePage({ path: '/org/workspace/settings', api: signedIn(async (call: ApiCall) => {
      const route = call.path.split('?')[0]!;
      if (call.method === 'PUT' && route === '/api/projects/p/repository-sources') { repos = call.body.repos; return project(); }
      if (call.method !== 'GET') return undefined;
      if (route === '/api/projects') return [project()];
      if (route === '/api/projects/p') return project();
      if (route === '/api/organizations/o/repositories') return repositories;
      if (route.endsWith('/github/app')) return { configured: true, oauthConfigured: true, userAuthorized: true };
      if (route.endsWith('/git-connections')) return [{ id: 'gc', provider: 'github', accountLogin: 'acme', permissionStatus: { ready: true } }];
      if (route === '/api/user/github-accounts') return { accounts: [{ id: 'a', login: 'octo', active: true }] };
      return emptySettings(call);
    }, { projects: [project()] }) });
    await ui.run('window.confirm = () => true; boot()');
    const rows = ui.page.locator('#project-repository-fields .git-repo');
    await expect.poll(() => rows.count()).toBe(2);
    expect(await rows.locator('.git-repo-name').allInnerTexts()).toEqual(['acme/web', '/srv/code/tools']);
    expect(await rows.first().locator('a').getAttribute('href')).toBe('https://github.com/acme/web');
    expect(await rows.first().locator('a').getAttribute('title')).toBe('git@github.com:acme/web.git');
    // Only repositories not yet in the project are offered.
    expect(await ui.page.locator('#project-repository-options option').evaluateAll((options) =>
      options.map((option) => (option as any).value))).toEqual(['acme/api']);
    expect(await ui.page.locator('#project-github-access').innerText()).toContain('acme');
    expect(await ui.page.locator('#project-github-identity').innerText()).toMatch(/You\s*·\s*octo/);

    await ui.page.locator('#project-repository-input').fill('Acme/API');
    await ui.page.keyboard.press('Enter');
    await expect.poll(() => rows.count()).toBe(3);
    await rows.filter({ hasText: '/srv/code/tools' }).getByRole('button', { name: 'Remove /srv/code/tools' }).click();
    await expect.poll(() => rows.count()).toBe(2);
    expect(ui.calls.filter((call) => call.method === 'PUT').map((call) => call.body.repos)).toEqual([
      ['git@github.com:acme/web.git', '/srv/code/tools', 'git@github.com:acme/api.git'],
      ['git@github.com:acme/web.git', 'git@github.com:acme/api.git'],
    ]);
    // A repository already in the project is not added twice.
    await ui.page.locator('#project-repository-input').fill('git@github.com:acme/web.git');
    await ui.page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect.poll(() => ui.toasts()).toContain('Already added');
    expect(ui.calls.filter((call) => call.method === 'PUT')).toHaveLength(2);
    await ui.close();
  });

  it('offers only the organization’s GitHub repositories on hosted', async () => {
    const hosted = (repositories: unknown[]) => settings({ api: ({ method, path: route }) => method !== 'GET' ? undefined
      : route === '/api/meta' ? { siteName: 'Fixture', hosted: true, hostLocal: false, consoleRevision: 'one', agent: { provider: 'mock' }, worldProviders: [] }
        : route.endsWith('/organizations/o/repositories') ? repositories
          : route.endsWith('/github/app') ? { configured: true } : undefined });
    const empty = await hosted([]);
    const input = empty.page.locator('#project-repository-input');
    await input.waitFor();
    expect(await input.isDisabled()).toBe(true);
    expect(await input.getAttribute('placeholder')).toBe('Connect GitHub to add repositories');
    expect(await empty.page.locator('#project-github-access').getByRole('button', { name: 'Connect GitHub' }).count()).toBe(1);
    await empty.close();

    const ui = await hosted([{ id: 'r', owner: 'acme', name: 'web', sshUrl: 'git@github.com:acme/web.git' }]);
    await ui.page.locator('#project-repository-input').fill('git@gitlab.com:acme/web.git');
    await ui.page.keyboard.press('Enter');
    await expect.poll(() => ui.toasts()).toContain('Choose one of the organization’s GitHub repositories');
    expect(ui.calls.some((call) => call.method === 'PUT')).toBe(false);
    await ui.close();
  });

  it('resets the actual scroll container when switching settings panes', async () => {
    const ui = await settings();
    const scroller = ui.page.locator('.main').first();
    await scroller.evaluate((element) => { element.scrollTop = 600; });
    expect(await scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await ui.page.locator('.settings-layout a[href="#project-people"], .settings-layout a[href^="#project-"]').last().click();
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0);
    await ui.close();
  });
});

const Node_FOLLOWING = 4; // Node.DOCUMENT_POSITION_FOLLOWING
void fs; void path;
