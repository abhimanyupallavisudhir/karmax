import { afterAll, beforeAll, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser } from 'playwright';
import { consoleRequest, launchApp, launchChromium, openConsole, stopEmbeddedTemporal, type AppProcess } from './helpers/browser.js';
import { ensureIdentity, gitOrThrow } from '../src/world/git.js';

const PASSWORD = 'long-home-password';

// The organization home on the installed app (src/main.ts, embedded Temporal,
// mock agent): a real workflow's Review ask and a draft are "for me" across two
// projects, an agent's paused task is not, and "All" shows everything. An agent
// token sees the same list through the same route. Home creates a task in the
// project you pick, and the bell lists what waits on you in every organization. Home creates a task in the
// project you pick, and the bell lists what waits on you in every organization.
let browser: Browser;
let root: string;
let app: AppProcess | undefined;
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-home-journey-'));
  browser = await launchChromium();
});
afterAll(async () => {
  await app?.stop();
  await stopEmbeddedTemporal(path.join(root, 'home'));
  await browser?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function repository(name: string): Promise<string> {
  const repo = path.join(root, name);
  await gitOrThrow(root, ['init', '-q', '-b', 'main', repo]);
  await ensureIdentity(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), `# ${name}\n`);
  await gitOrThrow(repo, ['add', '-A']);
  await gitOrThrow(repo, ['commit', '-q', '-m', 'init']);
  return repo;
}

it('lands on the organization home, For me across projects, All one click away', async () => {
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const [webRepo, appRepo] = [await repository('website'), await repository('mobile')];
  app = await launchApp(home);
  const { page, context, step, errors } = await openConsole(browser, { viewport: { width: 1280, height: 760 } });
  try {
    await step('create the administrator on the fresh install', async () => {
      await page.goto(app!.url);
      await page.getByLabel('Name').fill('Hana Home');
      await page.getByLabel('Email').fill('hana@example.test');
      await page.getByLabel('Password (10+ characters)').fill(PASSWORD);
      await page.locator('#setup-btn').click();
      await page.locator('#new-project').waitFor();
    });
    const config = (repo: string) => ({ repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false });
    const web = await consoleRequest(context, app.url, 'POST', '/api/projects', { name: 'Website', config: config(webRepo) });
    const mobile = await consoleRequest(context, app.url, 'POST', '/api/projects', { name: 'Mobile App', config: config(appRepo) });
    const create = (projectId: string, title: string, prompt: string, draft = false) => consoleRequest(context, app!.url, 'POST',
      `/api/projects/${projectId}/tasks`, { title, prompt, workflow: 'software-dev', quick: true, ...(draft ? { draft: true } : {}) });
    const review = await create(web.id, 'Keep the cart when signing in', '@write cart.txt :: kept');
    const paused = await create(mobile.id, 'Index the reading list overnight', '@pause 120');
    const draft = await create(mobile.id, 'Offline mode for the reading list', 'later', true);
    const stage = async (id: string) => (await consoleRequest(context, app!.url, 'GET', `/api/tasks/${id}`))?.stage;
    await step('the agent reaches Review', () => expect.poll(() => stage(review.id), { timeout: 60_000 }).toBe('review'));
    await step('the other agent pauses', () => expect.poll(async () => (await consoleRequest(context, app!.url, 'GET', `/api/tasks/${paused.id}`))?.waitingFor?.kind,
      { timeout: 60_000 }).toBe('timer'));

    const rows = async () => await page.evaluate<string[]>(
      "[...document.querySelectorAll('#main .task-row')].map((el) => el.dataset.id || el.dataset.draft).sort()");
    await step('the root lands on the organization home, For me', async () => {
      await page.goto(app!.url);
      await page.waitForURL(/\/personal$/);
      await page.locator(`[data-id="${review.id}"] .chip.attention`).waitFor();
    });
    // A new project seeds its own setup draft for whoever created it: also theirs.
    const listed = await rows();
    expect(listed).toEqual(expect.arrayContaining([review.id, draft.id]));
    expect(listed).not.toContain(paused.id);
    expect(await page.locator('#main .task-row[data-draft]').count()).toBe(listed.length - 1);
    expect(await page.locator(`[data-id="${review.id}"] .chip.attention`).innerText()).toBe('Review');
    expect(await page.locator(`[data-id="${review.id}"] .task-project`).innerText()).toBe('website');
    if (process.env.HOME_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.HOME_SCREENSHOTS, 'app-home-for-me.png') });

    // An agent (here: the same person's API token) reads the same list.
    const forMe = await consoleRequest(context, app.url, 'GET', `/api/organizations/${web.organizationId}/search?q=${encodeURIComponent('for:me -is:archived')}`);
    expect(forMe.tasks.map((task: any) => task.id).sort()).toEqual(listed);
    expect(forMe.reasons[review.id]).toContain('review-requested');

    await step('All shows the agent\'s own work too', async () => {
      await page.locator('.view-chip[data-view="__all__"]').click();
      await page.waitForURL(/\/personal\?q=$/);
      await page.locator(`[data-id="${paused.id}"]`).waitFor();
    });
    if (process.env.HOME_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.HOME_SCREENSHOTS, 'app-home-all.png') });
    await step('the project filter narrows to one project', async () => {
      await page.locator('#q-project').selectOption('mobile-app');
      await page.waitForURL(/q=project:mobile-app$/);
      await expect.poll(async () => (await rows()).filter((id) => [paused.id, draft.id, review.id].includes(id))).toEqual([paused.id, draft.id].sort());
    });
    await step('a row opens the task in its project', async () => {
      await page.locator(`[data-id="${paused.id}"] .row-link`).click();
      await page.waitForURL(/\/personal\/mobile-app\/tasks\/\d+$/);
    });
    await step('the logo goes home', async () => {
      await page.locator('#brand-home').click();
      await page.waitForURL(/\/personal$/);
      await page.locator(`[data-id="${review.id}"]`).waitFor();
    });
    await step('the composer creates a draft in the project picked for it', async () => {
      // It starts in the project last visited, Mobile App; choose Website.
      expect(await page.locator('#new-task-project').innerText()).toBe('mobile-app');
      await page.locator('#new-task-project').click();
      await page.locator('.project-pick-menu:not([hidden]) [data-project="' + web.id + '"]').click();
      await page.locator('#new-task').fill('Sync reading positions');
      await page.locator('#new-task').press('Alt+Enter');
      await expect.poll(() => page.locator('#new-task').inputValue()).toBe('');
    });
    const drafts = await consoleRequest(context, app.url, 'GET', `/api/projects/${web.id}/tasks`);
    expect(drafts.some((task: any) => task.title === 'Sync reading positions' && task.params?.draft)).toBe(true);

    // A second organization, with something waiting on Hana there too.
    const side = await consoleRequest(context, app.url, 'POST', '/api/organizations', { name: 'Side Gig' });
    const landing = await consoleRequest(context, app.url, 'POST', `/api/organizations/${side.id}/projects`, { name: 'Landing', config: config(await repository('landing')) });
    const elsewhere = await create(landing.id, 'Pricing page copy', 'later', true);
    await step('the bell lists what waits on you in every organization', async () => {
      await page.reload();
      await page.locator('#bell').click();
      await page.waitForURL(/\/inbox$/);
      await page.locator(`[data-draft="${elsewhere.id}"]`).waitFor();
    });
    expect(await rows()).toEqual(expect.arrayContaining([review.id, draft.id, elsewhere.id]));
    expect(await rows()).not.toContain(paused.id);
    expect(await page.locator(`[data-id="${review.id}"] .task-project`).innerText()).toBe('personal/website');
    expect(await page.locator(`[data-draft="${elsewhere.id}"] .task-project`).innerText()).toBe(`${side.slug}/landing`);
    expect(await page.locator('#topbar-search').count()).toBe(0);
    if (process.env.HOME_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.HOME_SCREENSHOTS, 'app-for-you.png') });
    // The same list for an API caller.
    const everywhere = await consoleRequest(context, app.url, 'GET', `/api/search?q=${encodeURIComponent('for:me -is:archived')}`);
    expect(everywhere.tasks.map((task: any) => task.id)).toEqual(expect.arrayContaining([review.id, elsewhere.id]));
    expect(everywhere.projects.find((project: any) => project.id === landing.id)).toMatchObject({ organizationId: side.id });

    await page.goto(`${app.url}/personal`);
    await page.locator(`[data-id="${review.id}"]`).waitFor();
    expect(await page.locator('#new-task-project').innerText()).toBe('website'); // the choice is remembered
    const shots = process.env.HOME_SCREENSHOTS;
    if (shots) {
      await page.locator('#mobile-menu').click();
      await expect.poll(async () => (await page.locator('#rail').boundingBox())?.width ?? 0).toBeLessThan(1);
      await page.screenshot({ path: path.join(shots, 'app-home-collapsed.png') });
      await page.setViewportSize({ width: 390, height: 780 });
      await page.reload();
      await page.locator(`[data-id="${review.id}"]`).waitFor();
      await page.screenshot({ path: path.join(shots, 'app-home-mobile.png') });
    }
    expect(errors).toEqual([]);
  } finally { await context.close(); }
}, 180_000);
