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
    const ui = await settings();
    await ui.page.locator('#environment-image').waitFor({ state: 'attached' });
    const text = await ui.page.locator('#main').innerText();
    for (const removed of [
      'The repositories this project works on, and the identity it commits with.',
      'Sensitive values injected only when a task needs them. Values are never shown again.',
      'No versioned data yet.', 'A human-readable name in Project settings.',
      'The destination path inside every task world', 'Expensive installation commands baked into a reusable build',
      'No build yet.',
    ]) expect(text).not.toContain(removed);
    expect(text).toContain('Local repo, GitHub, or Git URL');
    expect(text).toContain('Base image (optional)');
    expect(await ui.page.locator('#environment-image').getAttribute('list')).toBe('environment-image-options');
    expect(await ui.page.locator('#environment-image-options option').evaluateAll((options) =>
      options.map((option) => (option as any).value))).toContain('python:3.13-slim');
    const suggestions = (await ui.page.locator('#environment-setup, #environment-boot').evaluateAll((fields) =>
      fields.map((field) => (field as any).placeholder))).join('\n');
    expect(suggestions).toContain('uv sync');
    expect(suggestions).toContain('uv run python manage.py migrate');
    await ui.close();
  });

  it('opens GitHub repository creation from a button beside Save repositories', async () => {
    const ui = await settings({ api: ({ method, path: route }) => method !== 'GET' ? undefined
      : route.endsWith('/github/app') ? { configured: true, userAuthorized: true }
        : route.endsWith('/git-connections') ? [{ id: 'gc', provider: 'github', accountLogin: 'octo' }] : undefined });
    const save = ui.page.getByRole('button', { name: 'Save repositories' });
    const create = ui.page.getByRole('button', { name: 'New repository...' });
    await create.waitFor();
    expect(await save.evaluate((element, other) => element.parentElement === other!.parentElement
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
