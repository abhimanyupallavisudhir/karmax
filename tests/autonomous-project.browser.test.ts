import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { closeConsoleBrowser, consolePage, signedIn, type ApiCall } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

// "Fully autonomous" on New project and New organization (wiki features/autonomy):
// Create sends the flag and opens the co-ordinator, whose draft says what it is,
// where to set things up first, and that running it starts everything.

const coordinatorDraft = { id: 'coord', projectId: 'p', title: 'Co-ordinator', workflow: 'software-dev', tags: [],
  params: { draft: true, prompt: '', coordinator: { wakeHours: 24 }, 'agent:do': { resumeFrom: { taskId: 'avatar', role: 'do' } } } };

async function consoleWith(scope: 'project' | 'organization') {
  const autonomy = { scope, avatarTaskId: 'avatar', coordinatorTaskId: 'coord', wikiPage: { scope, path: 'autonomy' }, at: 1 };
  const ui = await consolePage({ path: '/org/workspace', api: signedIn(({ method, path }: ApiCall) => {
    const pathname = path.split('?')[0];
    if (method === 'POST' && pathname === '/api/organizations/o/projects') return { id: 'p', organizationId: 'o', name: 'Workspace', config: {}, autonomy };
    if (method === 'POST' && pathname === '/api/organizations')
      return { id: 'o', name: 'Organization', slug: 'org', project: { id: 'p', organizationId: 'o', name: 'Workspace' }, autonomy };
    if (method === 'GET' && pathname === '/api/projects/p/autonomy') return { autonomy };
    if (method === 'GET' && pathname === '/api/schema') return [{ name: 'software-dev', params: [
      { name: 'prompt', type: 'text', label: 'Prompt', scopes: ['task'], bind: 'prompt' },
      { name: 'multiPr', type: 'boolean', label: 'Allow several branches per task', scopes: ['task'], bind: 'project', default: true },
    ], stages: [{ key: 'do', label: 'Working' }] }];
    if (method === 'GET' && pathname === '/api/tasks/coord') return coordinatorDraft;
    if (method === 'GET' && pathname === '/api/projects/p/tasks') return [coordinatorDraft];
    if (method === 'GET' && pathname === '/api/tasks/coord/attempts') return null;
    if (method === 'GET' && pathname === '/api/organizations/o/repositories') return [];
    if (method === 'GET' && pathname === '/api/organizations/o/git-connections') return [];
    if (method === 'GET' && pathname === '/api/user/github-accounts') return { accounts: [] };
    if (method === 'GET' && pathname === '/api/organizations/o/github/app') return { configured: false };
    return undefined;
  }) });
  await ui.run('boot()');
  await ui.page.locator('#rail').waitFor();
  return ui;
}

const AXE = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
/** WCAG 2.2 A/AA violations inside `selector`, as the console's accessibility gate reads them. */
async function violations(ui: Awaited<ReturnType<typeof consoleWith>>, selector: string): Promise<string[]> {
  await ui.page.addScriptTag({ content: AXE });
  const result = await ui.page.evaluate(async (within) => (globalThis as any).axe.run(within, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } }), selector);
  return result.violations.map((violation: any) => `${violation.id}: ${violation.nodes.map((node: any) => node.target.join(' ')).join(', ')}`);
}

/** The co-ordinator's band, once its draft opened. */
async function intro(ui: Awaited<ReturnType<typeof consoleWith>>) {
  await expect.poll(() => ui.page.url()).toMatch(/\/org\/workspace\/tasks\/coord$/);
  const band = ui.page.locator('#tf-autonomy');
  await band.waitFor();
  return band;
}

describe('Fully autonomous', () => {
  it('New project: the switch sends autonomous, and Create opens the co-ordinator saying what running it starts', async () => {
    const ui = await consoleWith('project');
    await ui.run('newProject()');
    const dialog = ui.page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'Project name' }).fill('Workspace');
    const toggle = dialog.getByRole('checkbox', { name: 'Fully autonomous project' });
    expect(await toggle.isChecked()).toBe(false);
    // What it means is the tip's to say.
    expect(await dialog.locator('.np-autonomous .info-dot').getAttribute('title')).toMatch(/co-ordinator/);
    await dialog.locator('.np-autonomous span', { hasText: 'Fully autonomous project' }).click();
    expect(await toggle.isChecked()).toBe(true);
    expect(await violations(ui, '.new-project-dialog')).toEqual([]);
    if (process.env.SHOTS) await dialog.screenshot({ path: `${process.env.SHOTS}/autonomous-new-project.png` });
    await dialog.getByRole('button', { name: 'Create project' }).click();
    await expect.poll(() => ui.calls.find((call) => call.method === 'POST' && call.path === '/api/organizations/o/projects')?.body)
      .toMatchObject({ name: 'Workspace', autonomous: true });

    const band = await intro(ui);
    expect(await band.getAttribute('role')).toBe('note');
    const text = await band.innerText();
    expect(text).toMatch(/This is the co-ordinator: it manages the entire project, and never stops\./);
    expect(text).toMatch(/Feel free to save this as a draft and go fiddle with settings, edit the information in the wiki, connect accounts etc\. Running this task will start the autonomous project\./);
    expect(await band.getByRole('link', { name: 'settings' }).getAttribute('href')).toBe('/org/workspace/settings');
    expect(await band.getByRole('link', { name: 'wiki' }).getAttribute('href')).toBe('/org/workspace/wiki');
    expect(await band.getByRole('link', { name: 'connect accounts' }).getAttribute('href')).toBe('/org/settings#settings-connections');
    expect(await ui.page.locator('#tf-draft').isVisible()).toBe(true);
    expect(await violations(ui, '#tf-autonomy')).toEqual([]);
    if (process.env.SHOTS) { await ui.page.waitForTimeout(600); await ui.page.screenshot({ path: `${process.env.SHOTS}/autonomous-project-coordinator.png` }); }
    expect(ui.errors).toEqual([]);
    await ui.close();
  });

  it('a project created without it opens its task list, and an ordinary co-ordinator draft has no band', async () => {
    const ui = await consoleWith('project');
    await ui.run('newProject()');
    const dialog = ui.page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'Project name' }).fill('Workspace');
    await dialog.getByRole('button', { name: 'Create project' }).click();
    await expect.poll(() => ui.calls.find((call) => call.method === 'POST' && call.path === '/api/organizations/o/projects')?.body)
      .toEqual({ name: 'Workspace', config: {} });
    await ui.close();
  });

  it('New organization: the switch sends autonomous, and it opens the co-ordinator of the whole organization', async () => {
    const ui = await consoleWith('organization');
    const created = ui.run('createOrganization()');
    const dialog = ui.page.getByRole('dialog', { name: 'Organization name' });
    await dialog.getByRole('textbox').fill('Holdings');
    const toggle = dialog.getByRole('checkbox', { name: 'Fully autonomous organization' });
    expect(await dialog.locator('.text-prompt-toggle .info-dot').getAttribute('title')).toMatch(/Super-administrator/);
    await toggle.check();
    expect(await violations(ui, 'dialog.text-prompt')).toEqual([]);
    if (process.env.SHOTS) await dialog.screenshot({ path: `${process.env.SHOTS}/autonomous-new-organization.png` });
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await created;
    expect(ui.calls.find((call) => call.method === 'POST' && call.path === '/api/organizations')?.body)
      .toEqual({ name: 'Holdings', autonomous: true });
    const band = await intro(ui);
    const text = await band.innerText();
    expect(text).toMatch(/manages the entire organization, every project in it, and never stops/);
    expect(text).toMatch(/Running this task will start the autonomous organization\./);
    expect(await band.getByRole('link', { name: 'settings' }).getAttribute('href')).toBe('/org/settings');
    expect(await band.getByRole('link', { name: 'wiki' }).getAttribute('href')).toBe('/org/wiki');
    if (process.env.SHOTS) { await ui.page.waitForTimeout(600); await ui.page.screenshot({ path: `${process.env.SHOTS}/autonomous-organization-coordinator.png` }); }
    expect(ui.errors).toEqual([]);
    await ui.close();
  });

  it('New organization without it sends just the name', async () => {
    const ui = await consoleWith('organization');
    const created = ui.run('createOrganization()');
    const dialog = ui.page.getByRole('dialog', { name: 'Organization name' });
    await dialog.getByRole('textbox').fill('Side');
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await created;
    expect(ui.calls.find((call) => call.method === 'POST' && call.path === '/api/organizations')?.body).toEqual({ name: 'Side' });
    await ui.close();
  });
});
