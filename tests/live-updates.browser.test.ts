import { afterAll, beforeAll, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'playwright';
import { consoleRequest, launchApp, launchChromium, openConsole, stopEmbeddedTemporal, type AppProcess } from './helpers/browser.js';
import { ensureIdentity, gitOrThrow } from '../src/world/git.js';

// One person with the console open twice (two tabs, or a laptop and a phone) on
// the installed app (src/main.ts, embedded Temporal, mock agent). What one tab
// does, and what an agent does through the API, shows in both without a reload:
//
// - pramana#184: a task that mentioned its owner stayed on For me as
//   "Mentioned" after they had opened it. A mention is read by opening its
//   task, or by its arriving while the task is in front of you, and a read
//   mention is no longer for you — in the list, the bell and the sidebar
//   counts, here and in every other tab.
// - Writes that record no task event (priority, archive) reached no page at
//   all until it was reloaded.
const PASSWORD = 'long-home-password';
let browser: Browser;
let root: string;
let app: AppProcess | undefined;
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-live-updates-'));
  browser = await launchChromium();
});
afterAll(async () => {
  await app?.stop();
  await stopEmbeddedTemporal(path.join(root, 'home'));
  await browser?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

it('two tabs of one person stay in step, and a read mention leaves For me', async () => {
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const repo = path.join(root, 'website');
  await gitOrThrow(root, ['init', '-q', '-b', 'main', repo]);
  await ensureIdentity(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# website\n');
  await gitOrThrow(repo, ['add', '-A']);
  await gitOrThrow(repo, ['commit', '-q', '-m', 'init']);
  app = await launchApp(home);
  const A = await openConsole(browser, { viewport: { width: 1280, height: 760 } });
  const { context, step } = A;
  await step('create the administrator on the fresh install', async () => {
    await A.page.goto(app!.url);
    await A.page.getByLabel('Name').fill('Hana Home');
    await A.page.getByLabel('Email').fill('hana@example.test');
    await A.page.getByLabel('Password (10+ characters)').fill(PASSWORD);
    await A.page.locator('#setup-btn').click();
    await A.page.locator('#new-project').waitFor();
  });
  const request = (method: string, route: string, body?: unknown) => consoleRequest(context, app!.url, method, route, body);
  const project = await request('POST', '/api/projects', { name: 'Website',
    config: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false } });
  const create = (title: string, prompt: string) => request('POST', `/api/projects/${project.id}/tasks`, { title, prompt, workflow: 'software-dev' });
  const B: Page = await context.newPage();
  const errorsB: string[] = [];
  B.on('pageerror', (error) => errorsB.push(error.message));
  await A.page.goto(app.url); await A.page.waitForURL(/\/personal$/);
  await B.goto(app.url); await B.waitForURL(/\/personal$/);

  const row = (page: Page, id: string) => page.locator(`#main .task-row[data-id="${id}"]`);
  const chip = (page: Page, id: string) => row(page, id).locator('.status.attention').innerText({ timeout: 500 }).catch(() => '');
  // The bell's count ('' when it shows none) and the sidebar's count beside the project.
  const bell = (page: Page) => page.evaluate<string>("document.querySelector('#bell-badge').classList.contains('hidden') ? '' : document.querySelector('#bell-badge').textContent");
  const counts = async (page: Page) => (await page.locator('#rail .count').allInnerTexts()).join(',');
  // The For me list on screen, once its search has answered.
  const forMe = (page: Page) => page.evaluate<string[] | null>(`location.pathname === '/personal' && document.querySelector('#main .search-count')
    ? [...document.querySelectorAll('#main .task-row[data-id]')].map((el) => el.dataset.id) : null`);
  const inbox = async (taskId: string) => (await request('GET', `/api/inbox?organizationId=${project.organizationId}`))
    .filter((item: any) => item.taskId === taskId).map((item: any) => `${item.kind}:${item.unread ? 'unread' : 'read'}`);
  const within = { timeout: 8_000 };

  // ── a mention, read in one tab ────────────────────────────────────────────
  const mention = await create('Deploy at three', '@tool notify {"to":["@creator"],"message":"Heads up: deploy at 3pm"}\n@pause 120');
  await step('both tabs list the mention as it arrives', async () => {
    await expect.poll(() => chip(A.page, mention.id), { timeout: 60_000 }).toBe('Mentioned');
    await expect.poll(() => chip(B, mention.id), within).toBe('Mentioned');
    await expect.poll(async () => [await bell(A.page), await bell(B), await counts(A.page), await counts(B)], within).toEqual(['1', '1', '1', '1']);
  });
  await step('opening it in one tab reads it', async () => {
    await row(A.page, mention.id).locator('.row-link').click();
    await A.page.waitForURL(/\/tasks\/\d+$/);
    await expect.poll(() => inbox(mention.id), within).toEqual(['mentioned:read']);
  });
  await step('the other tab follows without a reload: list, bell and sidebar count', async () => {
    await expect.poll(() => forMe(B), within).toEqual([]);
    await expect.poll(async () => [await bell(B), await counts(B)], within).toEqual(['', '']);
  });
  await step('back on the list, the tab that read it no longer lists it either', async () => {
    await A.page.locator('#brand-home').click();
    await A.page.waitForURL(/\/personal$/);
    await expect.poll(() => forMe(A.page), within).toEqual([]);
    await expect.poll(async () => [await bell(A.page), await counts(A.page)], within).toEqual(['', '']);
  });
  // The API (what an agent's search reads) agrees.
  const search = await request('GET', `/api/organizations/${project.organizationId}/search?q=${encodeURIComponent('for:me -is:archived')}`);
  expect(search.tasks.map((task: any) => task.id)).toEqual([]);

  // ── a mention that arrives while its task is on screen ────────────────────
  const watched = await create('Second heads up', '@sleep 4000\n@tool notify {"to":["@creator"],"message":"Second heads up"}\n@pause 120');
  await step('a mention arriving for the task being looked at is read as it arrives', async () => {
    await A.page.goto(`${app!.url}/personal/website/tasks/${watched.num}`);
    await expect.poll(() => inbox(watched.id), { timeout: 60_000 }).toEqual(['mentioned:read']);
    await expect.poll(() => forMe(B), within).toEqual([]);
    await expect.poll(async () => [await bell(A.page), await bell(B), await counts(B)], within).toEqual(['', '', '']);
    await A.page.locator('#brand-home').click();
    await A.page.waitForURL(/\/personal$/);
    await expect.poll(() => forMe(A.page), within).toEqual([]);
  });

  // ── writes that record no event: priority and archive, made through the API ─
  const quiet = await create('Index the reading list', '@pause 120');
  await step('Active lists the paused task in both tabs', async () => {
    await A.page.locator('.view-chip[data-view="__active__"]').click();
    await B.locator('.view-chip[data-view="__active__"]').click();
    await expect.poll(() => row(A.page, quiet.id).innerText({ timeout: 500 }).catch(() => ''), { timeout: 60_000 }).toMatch(/Waiting/);
    await expect.poll(() => row(B, quiet.id).count(), within).toBe(1);
  });
  await step('a priority set elsewhere shows on both rows', async () => {
    await request('PUT', `/api/tasks/${quiet.id}/priority`, { priority: 4 });
    await expect.poll(() => row(A.page, quiet.id).locator('.prio').innerText({ timeout: 500 }).catch(() => ''), within).toMatch(/urgent/i);
    await expect.poll(() => row(B, quiet.id).locator('.prio').innerText({ timeout: 500 }).catch(() => ''), within).toMatch(/urgent/i);
  });
  await step('and on the task page, when the task is open', async () => {
    await A.page.goto(`${app!.url}/personal/website/tasks/${quiet.num}`);
    await expect.poll(() => A.page.locator('select.org-priority').inputValue(), within).toBe('4');
    await request('PUT', `/api/tasks/${quiet.id}/priority`, { priority: 1 });
    await expect.poll(() => A.page.locator('select.org-priority').inputValue(), within).toBe('1');
  });
  await step('a task archived elsewhere leaves the list', async () => {
    await request('POST', `/api/tasks/${quiet.id}/archive`, { archived: true });
    await expect.poll(() => row(B, quiet.id).count(), within).toBe(0);
  });

  // ── a draft, a tag and a project made elsewhere ───────────────────────────
  const rail = async (page: Page) => (await page.locator('#rail').innerText({ timeout: 800 }).catch(() => '')).replace(/\s+/g, ' ');
  await A.page.goto(`${app.url}/personal/website`);
  await B.locator('#brand-home').click();
  await B.waitForURL(/\/personal$/);
  const kept = await request('POST', `/api/projects/${project.id}/tasks`, { title: 'Offline mode', prompt: 'later', workflow: 'software-dev', draft: true });
  const draftRow = (page: Page) => page.locator(`#main .task-row[data-draft="${kept.id}"], #main .task-row[data-id="${kept.id}"]`);
  await step('a draft made elsewhere is for me in both tabs, and the sidebar counts it', async () => {
    await expect.poll(() => draftRow(A.page).count(), within).toBe(1);
    await expect.poll(() => draftRow(B).count(), within).toBe(1);
    await expect.poll(async () => [await counts(A.page), await counts(B)], within).toEqual(['1', '1']);
  });
  await step('deleting it elsewhere takes it away again', async () => {
    await request('DELETE', `/api/tasks/${kept.id}`);
    await expect.poll(async () => [await draftRow(A.page).count(),
      await draftRow(B).count(), await counts(A.page), await counts(B)], within).toEqual([0, 0, '', '']);
  });
  await step('a project renamed and one made elsewhere show in the sidebar', async () => {
    await request('PATCH', `/api/projects/${project.id}`, { name: 'Storefront' });
    await request('POST', `/api/organizations/${project.organizationId}/projects`, { name: 'Mobile App', config: {} });
    for (const page of [A.page, B]) await expect.poll(() => rail(page), within).toMatch(/Storefront.*Mobile App|Mobile App.*Storefront/);
  });
  expect([...A.errors, ...errorsB]).toEqual([]);
}, 420_000);
