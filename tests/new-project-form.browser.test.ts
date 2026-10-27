import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage, signedIn, type ApiCall } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

// The New project form: name, the GitHub repository named after the project
// (or other repositories, from the list), the rest folded away; Create sends everything with
// the project and lands on its task list.

const site = { id: 'r1', owner: 'acme', name: 'site', sshUrl: 'git@github.com:acme/site.git', defaultBranch: 'main' };

async function form(options: { github?: boolean; hosted?: boolean; refuseCreate?: boolean; repositories?: unknown[] } = {}) {
  const github = options.github ?? true;
  const projects: Array<Record<string, unknown>> = [{ id: 'p', organizationId: 'o', name: 'Workspace', config: {} }];
  const ui = await consolePage({ path: '/org/workspace', api: signedIn(({ method, path, body }: ApiCall) => {
    if (method === 'GET' && path === '/api/organizations/o/repositories') return github ? options.repositories ?? [site] : [];
    if (method === 'GET' && path === '/api/organizations/o/git-connections') return github ? [{ id: 'g1', accountLogin: 'acme' }] : [];
    if (method === 'GET' && path === '/api/organizations/o/github/app') return { configured: true, userAuthorized: github };
    if (method === 'POST' && path === '/api/organizations/o/projects') {
      const project = { id: 'n', organizationId: 'o', name: 'Site', folder: 'Clients', config: { repos: body.repos } };
      projects.push(project);
      return project;
    }
    if (method === 'POST' && path === '/api/organizations/o/repositories/create' && options.refuseCreate)
      return { status: 422, json: { error: 'Repository creation failed: name already exists on this account' } };
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
  it('opens on the name and the GitHub repository named after it, with the rest collapsed', async () => {
    const { ui, dialog } = await form();
    const choice = dialog.getByRole('radio', { name: /GitHub repo/ });
    await choice.waitFor();
    expect(await choice.isChecked()).toBe(true);
    expect(await dialog.getByRole('radio', { name: 'Choose other repositories' }).isChecked()).toBe(false);
    expect(await dialog.locator('.np-default-label').innerText()).toBe('Create new GitHub repo acme/project-name');
    // The repository list stays out of the way until other repositories are chosen.
    expect(await dialog.getByRole('combobox', { name: 'Add a repository' }).isVisible()).toBe(false);
    await dialog.getByRole('textbox', { name: 'Project name' }).fill('Clients/Site');
    await expect.poll(() => dialog.locator('.np-default-label').innerText()).toBe('Work on existing GitHub repo acme/site');
    await dialog.getByRole('textbox', { name: 'Project name' }).fill('Clients/Fresh Ideas');
    await expect.poll(() => dialog.locator('.np-default-label').innerText()).toBe('Create new GitHub repo acme/fresh-ideas');
    const folds = dialog.locator('details');
    expect(await folds.locator('> summary').allTextContents()).toEqual(['Secrets', 'Environment']);
    expect(await folds.evaluateAll((all) => all.map((d) => (d as unknown as { open: boolean }).open))).toEqual([false, false]);
    expect(ui.errors).toEqual([]);
    await ui.close();
  });

  it('works on the existing repository named after the project, with its secrets and environment, then opens its tasks', async () => {
    const { ui, dialog } = await form();
    await dialog.getByRole('textbox', { name: 'Project name' }).fill('Clients/Site');
    await expect.poll(() => dialog.locator('.np-default-label').innerText()).toContain('existing');
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

  it('creates the GitHub repository named after a new project first, then the project on it', async () => {
    const { ui, dialog } = await form();
    await dialog.getByRole('textbox', { name: 'Project name' }).fill('Clients/Fresh Ideas');
    await expect.poll(() => dialog.locator('.np-default-label').innerText()).toContain('acme/fresh-ideas');
    await dialog.getByRole('textbox', { name: 'Project name' }).press('Enter');
    await expect.poll(() => ui.calls.filter((call) => call.method !== 'GET')).toEqual([
      { method: 'POST', path: '/api/organizations/o/repositories/create', body: { gitConnectionId: 'g1', name: 'fresh-ideas', private: true } },
      { method: 'POST', path: '/api/organizations/o/projects', body: { name: 'Clients/Fresh Ideas', config: {}, repos: ['git@github.com:acme/fresh-ideas.git'] } },
    ]);
    await ui.close();
  });

  it('keeps the form open, saying why in plain words, when GitHub refuses the repository', async () => {
    const { ui, dialog } = await form({ refuseCreate: true });
    await dialog.getByRole('textbox', { name: 'Project name' }).fill('Taken');
    await dialog.getByRole('button', { name: 'Create project' }).click();
    const error = dialog.locator('.new-project-error');
    await error.waitFor();
    expect(await error.innerText()).toBe('A GitHub repository with that name already exists. Choose another name, or add the existing one from the list.');
    expect(ui.calls.some((call) => call.path === '/api/organizations/o/projects')).toBe(false);
    await ui.close();
  });

  it('choosing other repositories shows the list, and sends only the name when nothing is added', async () => {
    const { ui, dialog } = await form();
    await dialog.getByRole('textbox', { name: 'Project name' }).fill('Site');
    await dialog.getByRole('radio', { name: 'Choose other repositories' }).check();
    const picker = dialog.getByRole('combobox', { name: 'Add a repository' });
    await expect.poll(() => picker.evaluate((element) => element === (globalThis as any).document.activeElement)).toBe(true);
    await dialog.getByRole('textbox', { name: 'Project name' }).press('Enter');
    await expect.poll(() => ui.calls.filter((call) => call.method !== 'GET'))
      .toEqual([{ method: 'POST', path: '/api/organizations/o/projects', body: { name: 'Site', config: {} } }]);
    await ui.close();
  });

  it('picks repositories from a combobox that filters as you type, by keyboard', async () => {
    const { ui, dialog } = await form({ repositories: [site, { ...site, id: 'r3', name: 'docs', sshUrl: 'git@github.com:acme/docs.git' }] });
    await dialog.getByRole('textbox', { name: 'Project name' }).fill('Site');
    await dialog.getByRole('radio', { name: 'Choose other repositories' }).check();
    const picker = dialog.getByRole('combobox', { name: 'Add a repository' });
    const options = ui.page.getByRole('listbox', { name: 'Repositories' }).getByRole('option');
    // Focused and empty: every repository, and a way to make a new one.
    await expect.poll(() => options.allInnerTexts()).toEqual(['acme/site', 'acme/docs', 'New repo…']);
    expect(await picker.getAttribute('aria-expanded')).toBe('true');
    await picker.fill('do');
    await expect.poll(() => options.allInnerTexts()).toEqual(['acme/docs', 'New repo acme/do']);
    expect(await options.first().getAttribute('aria-selected')).toBe('true');
    await picker.press('ArrowDown');
    expect(await options.nth(1).getAttribute('aria-selected')).toBe('true');
    expect(await picker.getAttribute('aria-activedescendant')).toBe(await options.nth(1).getAttribute('id'));
    await picker.press('ArrowUp');
    await picker.press('Enter'); // adds the repository; does not create the project
    await dialog.locator('.git-repo', { hasText: 'docs' }).waitFor();
    expect(await picker.inputValue()).toBe('');
    // What is in the list is no longer offered.
    await picker.fill('');
    await expect.poll(() => options.allInnerTexts()).toEqual(['acme/site', 'New repo…']);
    // Esc closes the menu, not the New project dialog.
    await picker.press('Escape');
    expect(await picker.getAttribute('aria-expanded')).toBe('false');
    expect(await dialog.isVisible()).toBe(true);
    expect(ui.calls.some((call) => call.method === 'POST')).toBe(false);
    await dialog.getByRole('button', { name: 'Create project' }).click();
    await expect.poll(() => ui.calls.find((call) => call.path === '/api/organizations/o/projects')?.body)
      .toEqual({ name: 'Site', config: {}, repos: ['git@github.com:acme/docs.git'] });
    await ui.close();
  });

  it('offers “+ New repo” for a name no repository has, opening its dialog with that name', async () => {
    const { ui, dialog } = await form();
    await dialog.getByRole('textbox', { name: 'Project name' }).fill('Fresh');
    await dialog.getByRole('radio', { name: 'Choose other repositories' }).check();
    const picker = dialog.getByRole('combobox', { name: 'Add a repository' });
    await picker.fill('brand-new');
    const options = ui.page.getByRole('listbox', { name: 'Repositories' }).getByRole('option');
    await expect.poll(() => options.allInnerTexts()).toEqual(['New repo acme/brand-new']);
    await picker.press('Enter');
    const repository = ui.page.locator('.new-repository-dialog');
    expect(await repository.getByRole('textbox', { name: 'Repository name' }).inputValue()).toBe('brand-new');
    await ui.page.keyboard.press('Escape'); // closes only the dialog on top
    await repository.waitFor({ state: 'detached' });
    expect(await dialog.isVisible()).toBe(true);
    await picker.fill('brand-new');
    await options.first().click();
    await repository.getByRole('button', { name: 'Create and attach' }).click();
    await repository.waitFor({ state: 'detached' });
    await dialog.locator('.git-repo', { hasText: 'brand-new' }).waitFor();
    await dialog.getByRole('button', { name: 'Create project' }).click();
    await expect.poll(() => ui.calls.find((call) => call.path === '/api/organizations/o/projects')?.body)
      .toEqual({ name: 'Fresh', config: {}, repos: ['git@github.com:acme/brand-new.git'] });
    await ui.close();
  });

  it('offers to connect GitHub when a hosted organization has not', async () => {
    const { ui, dialog } = await form({ github: false, hosted: true });
    await dialog.getByRole('button', { name: 'Connect GitHub' }).waitFor();
    expect(await dialog.locator('.np-default').isVisible()).toBe(false);
    expect(await dialog.getByRole('combobox', { name: 'Add a repository' }).isDisabled()).toBe(true);
    await ui.close();
  });

  it('sends only the name without GitHub', async () => {
    const { ui, dialog } = await form({ github: false });
    await dialog.getByRole('combobox', { name: 'Add a repository' }).waitFor();
    await dialog.getByRole('textbox', { name: 'Project name' }).fill('Site');
    await dialog.getByRole('textbox', { name: 'Project name' }).press('Enter');
    await expect.poll(() => ui.calls.filter((call) => call.method !== 'GET'))
      .toEqual([{ method: 'POST', path: '/api/organizations/o/projects', body: { name: 'Site', config: {} } }]);
    await ui.close();
  });
});
