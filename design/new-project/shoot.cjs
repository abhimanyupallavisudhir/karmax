// Screenshots of the New project form against a scratch tavya seeded by
// design/task-page/seed.cjs. /api/meta is marked hosted and the organization's
// GitHub is scripted as connected, as on tavya.io.
// Usage: APP=http://127.0.0.1:48950 OUT=design/new-project node design/new-project/shoot.cjs
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const APP = process.env.APP || 'http://127.0.0.1:48950';
const STATE = process.env.STATE || '/tmp/shots/state.json';
const OUT = process.env.OUT || 'design/new-project';
const repository = (name) => ({ id: `r-${name}`, provider: 'github', owner: 'acme', name, sshUrl: `git@github.com:acme/${name}.git`, defaultBranch: 'main', private: true });
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ storageState: STATE, viewport: { width: 1280, height: 860 }, colorScheme: 'light' });
  await context.route('**/api/meta', async (route) => {
    const response = await route.fetch();
    route.fulfill({ response, json: { ...(await response.json()), hosted: true, hostLocal: false } });
  });
  await context.route(/\/api\/organizations\/[^/]+\/repositories$/, (route) => route.fulfill({ json: ['website', 'api', 'design-system'].map(repository) }));
  await context.route(/\/api\/organizations\/[^/]+\/git-connections$/, (route) => route.fulfill({ json: [{ id: 'g', provider: 'github', accountLogin: 'acme' }] }));
  await context.route(/\/api\/organizations\/[^/]+\/github\/app$/, (route) => route.fulfill({ json: { configured: true, userAuthorized: true } }));
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.goto(`${APP}/personal/video-studio`);
  await page.locator('#new-project').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Add a repository' }).waitFor();
  await page.screenshot({ path: path.join(OUT, 'new-project-empty.png') });
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Clients/Website');
  const repo = dialog.getByRole('combobox', { name: 'Add a repository' });
  for (const name of ['acme/website', 'acme/api']) { await repo.fill(name); await repo.press('Enter'); }
  await dialog.getByRole('textbox', { name: 'Project name' }).focus();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'new-project.png') });
  await dialog.getByText('Secrets', { exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Secrets' }).fill('STRIPE_KEY=sk_test_…\nDATABASE_URL=postgres://…');
  await dialog.getByText('Environment', { exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Install in website' }).fill('npm ci');
  await dialog.getByRole('textbox', { name: 'Install in api' }).fill('uv sync');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'new-project-expanded.png') });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
