import fs from 'node:fs';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

/** SCREENSHOT_DIR=<dir> also writes screenshots of the dialogs. */
const shot = async (page: import('playwright').Page, name: string) => {
  if (!process.env.SCREENSHOT_DIR) return;
  fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
  await page.locator('.local-handoff-scrim .palette').screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `${name}.png`) });
};

it('Work locally is one tavya command; the Git-only steps load only when asked for', async () => {
  const ui = await consolePage({ api: ({ path: requested }) => {
    if (requested === '/api/tasks/task-1/checkout') return { workspace: 'tavya-12', repositories: [{ name: 'site' }],
      cloneScript: "git clone --branch 'task' 'git@github.com:acme/site.git' 'site'", updateScript: 'git -C site fetch', pushScript: 'git -C site push' };
    if (requested === '/api/tasks/task-1/sessions') return {};
    if (requested === '/api/projects/p1/checkout') return { workspace: 'tavya-site', repositories: [], cloneScript: 'git clone x', updateScript: 'git fetch' };
    return undefined;
  } });
  await ui.run(`S.organizations = [{ id: 'o1', name: 'Acme', slug: 'acme' }];
    S.projects = [{ id: 'p1', organizationId: 'o1', name: 'Site Builder', config: {} }];
    S.projectId = 'p1'; S.organizationId = 'o1'; S.meta = { hosted: true, hostLocal: false };
    S.tasks = [{ id: 'task-1', projectId: 'p1', num: 12, title: 'Fix the login page', params: {} }];
    openLocalCheckout({ taskId: 'task-1', status: 'waiting', waitingFor: { kind: 'human' } })`);
  const dialog = ui.page.locator('.local-handoff-scrim');
  // On another origin than tavya.io the command names its server through the task's URL.
  await expect.poll(() => dialog.locator('pre').first().textContent()).toBe('npx @tavya/cli clone http://console.test/acme/site-builder/tasks/12');
  expect(ui.calls.filter((call) => call.path.startsWith('/api/tasks/'))).toEqual([]);
  await shot(ui.page, 'work-locally-task');
  await dialog.getByText('Git only').click();
  await expect.poll(() => dialog.textContent()).toContain("git clone --branch 'task'");
  expect(ui.calls.map((call) => call.path)).toEqual(expect.arrayContaining(['/api/tasks/task-1/checkout', '/api/tasks/task-1/sessions']));
  await shot(ui.page, 'work-locally-task-git-only');
  await dialog.getByRole('button', { name: 'Close' }).click();

  await ui.run(`openProjectCheckout(S.projects[0])`);
  await expect.poll(() => ui.page.locator('.local-handoff-scrim pre').first().textContent()).toBe('npx @tavya/cli clone http://console.test/acme/site-builder');
  await shot(ui.page, 'work-locally-project');
  expect(ui.errors).toEqual([]);
  await ui.close();
});
