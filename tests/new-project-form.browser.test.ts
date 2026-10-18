import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage, signedIn, type ApiCall } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

// The New project form: name, Git & GitHub open, the rest folded away; Create
// sends everything with the project and lands on its task list.

const site = { id: 'r1', owner: 'acme', name: 'site', sshUrl: 'git@github.com:acme/site.git', defaultBranch: 'main' };

async function form(options: { github?: boolean; hosted?: boolean } = {}) {
  const github = options.github ?? true;
  const projects: Array<Record<string, unknown>> = [{ id: 'p', organizationId: 'o', name: 'Workspace', config: {} }];
  const ui = await consolePage({ path: '/org/workspace', api: signedIn(({ method, path, body }: ApiCall) => {
    if (method === 'GET' && path === '/api/organizations/o/repositories') return github ? [site] : [];
    if (method === 'GET' && path === '/api/organizations/o/git-connections') return github ? [{ id: 'g1', accountLogin: 'acme' }] : [];
    if (method === 'GET' && path === '/api/organizations/o/github/app') return { configured: true, userAuthorized: github };
    if (method === 'POST' && path === '/api/organizations/o/projects') {
      const project = { id: 'n', organizationId: 'o', name: 'Site', folder: 'Clients', config: { repos: body.repos } };
      projects.push(project);
      return project;
    }
    if (method === 'POST' && path === '/api/organizations/o/repositories/create')
      return { id: 'r2', owner: 'acme', name: body.name, sshUrl: `git@github.com:acme/${body.name}.git`, defaultBranch: 'main' };
    if (method === 'POST' && path === '/api/projects/n/secrets') return { imported: ['API_KEY'] };
    if (method === 'PUT' && path === '/api/projects/n/environment') return { spec: body };
    return undefined;
  }, { projects, meta: options.hosted ? { hosted: true, hostLocal: false } : {} }) });
  await ui.run('boot()');
  await ui.page.locator('#rail').waitFor();
  await ui.run('newProject()');
  const dialog = ui.page.getByRole('dialog');
  await dialog.waitFor();
  return { ui, dialog };
}

describe('New project form', () => {
  it('opens on the name and Git & GitHub, with the rest collapsed', async () => {
    const { ui, dialog } = await form();
    await dialog.getByText('Git & GitHub').waitFor();
    await dialog.getByRole('combobox', { name: 'Add a repository' }).waitFor();
    // GitHub is connected: its account shows, as in Project settings.
    await dialog.locator('.np-github').getByText('acme').waitFor();
    const folds = dialog.locator('details');
    expect(await folds.locator('> summary').allTextContents()).toEqual(['Secrets', 'Environment']);
    expect(await folds.evaluateAll((all) => all.map((d) => (d as HTMLDetailsElement).open))).toEqual([false, false]);
    expect(ui.errors).toEqual([]);
    await ui.close();
  });

  it('creates the project with its repositories, secrets and environment, then opens its tasks', async () => {
    const { ui, dialog } = await form();
    await dialog.getByRole('textbox', { name: 'Project name' }).fill('Clients/Site');
    const repo = dialog.getByRole('combobox', { name: 'Add a repository' });
    await repo.fill('acme/site');
    await repo.press('Enter'); // adds the repository; does not create the project
    await dialog.locator('.git-repo', { hasText: 'site' }).waitFor();
    expect(await repo.inputValue()).toBe('');
    expect(ui.calls.some((call) => call.method === 'POST')).toBe(false);

    await dialog.getByText('Secrets', { exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Secrets' }).fill('API_KEY=abc');
    await dialog.getByText('Environment', { exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Install in site' }).fill('npm ci');

    await dialog.getByRole('button', { name: 'Create project' }).click();
    await expect.poll(() => ui.run<string>('location.pathname')).toBe('/org/site'); // its task list, not its settings
    const writes = ui.calls.filter((call) => call.method !== 'GET');
    expect(writes[0]).toEqual({ method: 'POST', path: '/api/organizations/o/projects',
      body: { name: 'Clients/Site', config: {}, repos: ['git@github.com:acme/site.git'] } });
    expect(writes.slice(1)).toEqual(expect.arrayContaining([
      { method: 'POST', path: '/api/projects/n/secrets', body: { env: 'API_KEY=abc' } },
      { method: 'PUT', path: '/api/projects/n/environment', body: { setup: [], install: { site: ['npm ci'] }, boot: [] } },
    ]));
    expect(writes).toHaveLength(3);
    expect(ui.errors).toEqual([]);
    await ui.close();
  });

  it('sends only the name when nothing else is filled in', async () => {
    const { ui, dialog } = await form();
    await dialog.getByRole('textbox', { name: 'Project name' }).fill('Site');
    await dialog.getByRole('textbox', { name: 'Project name' }).press('Enter');
    await expect.poll(() => ui.calls.filter((call) => call.method !== 'GET'))
      .toEqual([{ method: 'POST', path: '/api/organizations/o/projects', body: { name: 'Site', config: {} } }]);
    await ui.close();
  });

  it('creates a GitHub repository for the project in a dialog of its own', async () => {
    const { ui, dialog } = await form();
    await dialog.getByRole('button', { name: 'New repository' }).click();
    const repository = ui.page.locator('.new-repository-dialog');
    await ui.page.keyboard.press('Escape'); // closes only the dialog on top
    await repository.waitFor({ state: 'detached' });
    expect(await dialog.isVisible()).toBe(true);
    await dialog.getByRole('button', { name: 'New repository' }).click();
    await repository.getByRole('textbox', { name: 'Repository name' }).fill('fresh');
    await repository.getByRole('button', { name: 'Create and attach' }).click();
    await repository.waitFor({ state: 'detached' });
    await dialog.locator('.git-repo', { hasText: 'fresh' }).waitFor();
    await dialog.getByRole('textbox', { name: 'Project name' }).fill('Fresh');
    await dialog.getByRole('button', { name: 'Create project' }).click();
    await expect.poll(() => ui.calls.find((call) => call.path === '/api/organizations/o/projects')?.body)
      .toEqual({ name: 'Fresh', config: {}, repos: ['git@github.com:acme/fresh.git'] });
    await ui.close();
  });

  it('offers to connect GitHub when a hosted organization has not', async () => {
    const { ui, dialog } = await form({ github: false, hosted: true });
    await dialog.getByRole('button', { name: 'Connect GitHub' }).waitFor();
    expect(await dialog.getByRole('combobox', { name: 'Add a repository' }).isDisabled()).toBe(true);
    await ui.close();
  });
});
