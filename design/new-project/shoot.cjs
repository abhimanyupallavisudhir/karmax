// Screenshots of the New project form, the repository picker, and plain-language
// errors, against a scratch tavya seeded by design/task-page/seed.cjs. /api/meta
// is marked hosted and the organization's GitHub is scripted as connected, as on
// tavya.io.
// Usage: APP=http://127.0.0.1:48950 OUT=/tmp/shots/new-project node design/new-project/shoot.cjs
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const APP = process.env.APP || 'http://127.0.0.1:48950';
const STATE = process.env.STATE || '/tmp/shots/state.json';
const OUT = process.env.OUT || 'design/new-project';
const SEED = JSON.parse(fs.readFileSync(process.env.SEED || '/tmp/shots/seed.json', 'utf8'));
const repository = (owner, name) => ({ id: `r-${name}`, provider: 'github', owner, name, sshUrl: `git@github.com:${owner}/${name}.git`, defaultBranch: 'main', private: true });
const REPOSITORIES = [repository('ann', 'website'), repository('ann', 'web-docs'), repository('ann', 'video-studio'), repository('acme', 'mobile-app')];
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ storageState: STATE, viewport: { width: 1280, height: 860 }, colorScheme: 'light', deviceScaleFactor: 1.5 });
  await context.route('**/api/meta', async (route) => {
    const response = await route.fetch();
    route.fulfill({ response, json: { ...(await response.json()), hosted: true, hostLocal: false } });
  });
  await context.route(/\/api\/organizations\/[^/]+\/repositories$/, (route) => route.fulfill({ json: REPOSITORIES }));
  await context.route(/\/api\/organizations\/[^/]+\/git-connections$/, (route) => route.fulfill({ json: [
    { id: 'g1', provider: 'github', accountLogin: 'ann', accountType: 'User', permissionStatus: { ready: true } },
    { id: 'g2', provider: 'github', accountLogin: 'acme', accountType: 'Organization', permissionStatus: { ready: true } }] }));
  await context.route(/\/api\/organizations\/[^/]+\/github\/app$/, (route) => route.fulfill({ json: { configured: true, userAuthorized: true, oauthConfigured: true } }));
  await context.route('**/api/user/github-accounts', (route) => route.fulfill({ json: { accounts: [{ id: 'a', login: 'ann', active: true }] } }));
  // A member without the role it takes: the refusal people now read.
  await context.route(/\/api\/projects\/[^/]+\/repository-sources$/, (route) => route.fulfill({ status: 403, json: { error:
    `missing capability repository:write in project "Video Studio" (${SEED.projectId}) of organization "Ann Author" (org_personal). Your authorization there is Developer; Project maintainer and above have it. Ask for it with request_permission (capabilities: ["repository:write"]).` } }));
  // A task that failed on its computer: the plain summary, details folded.
  await context.route(new RegExp(`/api/tasks/${SEED.taskId}(\\?.*)?$`), async (route) => {
    const response = await route.fetch();
    const view = await response.json();
    route.fulfill({ response, json: { ...view, error: 'Activity task failed → agent turn interrupted: Sandbox is probably not running anymore (envd: deadline exceeded after 60000ms; exited with code -1)' } });
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  const shot = (name, clip) => page.screenshot({ path: path.join(OUT, `${name}.png`), ...(clip ? { clip } : {}) });
  const dialogClip = { x: 340, y: 120, width: 600, height: 620 };

  await page.goto(`${APP}/personal/video-studio`);
  await page.locator('#new-project').click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('.np-default:not([hidden])').waitFor();
  const name = dialog.getByRole('textbox', { name: 'Project name' });
  await name.fill('Clients/Foo Bar');
  await page.waitForTimeout(300);
  await shot('1-new-project-creates-repo', dialogClip);
  await name.fill('Website');
  await page.waitForTimeout(300);
  await shot('2-new-project-existing-repo', dialogClip);
  await dialog.getByRole('radio', { name: 'Choose other repositories' }).check();
  await page.keyboard.type('we');
  await page.waitForTimeout(400);
  await shot('3-repository-picker', dialogClip);
  await page.keyboard.press('Control+a');
  await page.keyboard.type('landing-page');
  await page.waitForTimeout(400);
  await shot('4-repository-picker-new-repo', dialogClip);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  await shot('5-new-repo-dialog', dialogClip);

  await page.goto(`${APP}/personal/video-studio/settings#project-repositories`);
  const picker = page.getByRole('combobox', { name: 'Add a repository' });
  await picker.waitFor();
  await picker.fill('web-docs');
  await picker.press('Enter');
  await page.locator('.toast.err').waitFor();
  await page.waitForTimeout(300);
  await shot('6-plain-permission-error');

  await page.goto(`${APP}/personal/video-studio/tasks/${SEED.num}`);
  const error = page.locator('.msg.system.error');
  await error.waitFor();
  await error.getByText('Details').click();
  await error.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shot('7-plain-task-error');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
