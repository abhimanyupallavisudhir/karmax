import fs from 'node:fs';
import { chromium, type Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';

// A For me row that asks for several decisions while its agent keeps working
// (a granted request resumes it; the others still wait). Every event of the
// working agent repaints the list and moves the task's view on, and the row's
// answers must survive that: the buttons stay put, and a click is a decision.
let browser: Awaited<ReturnType<typeof chromium.launch>>;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });

const TASK = 'task_live';
type Pending = { id: string; itemId: string; status: string; mode: string };

async function openList(page: Page, requests: Pending[], { slowLoads = 0, slowAnswer = 0 } = {}) {
  const resolved: string[] = [];
  await page.route('http://rows.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="main"></div>' });
    if (url.pathname.startsWith('/fonts/')) return route.fulfill({ body: fs.readFileSync(`web${url.pathname}`) });
    const resolve = url.pathname.match(/^\/api\/vault\/requests\/([^/]+)\/resolve$/);
    if (resolve) {
      const request = requests.find((candidate) => candidate.id === resolve[1])!;
      if (slowAnswer) await new Promise((done) => setTimeout(done, slowAnswer));
      request.status = 'granted';
      resolved.push(request.id);
      return route.fulfill({ json: { ...request, resume: { resumed: true } } });
    }
    if (slowLoads) await new Promise((done) => setTimeout(done, slowLoads));
    if (url.pathname === '/api/vault/requests') return route.fulfill({ json: requests });
    if (url.pathname === '/api/vault/items') return route.fulfill({ json: [
      { id: 'one', label: 'one.com' }, { id: 'github', label: 'GitHub' }, { id: 'r2', label: 'R2' }] });
    if (['/api/permission-requests', '/api/authorization-requests', '/api/repository-access-requests'].includes(url.pathname))
      return route.fulfill({ json: [] });
    return route.fulfill({ json: {} });
  });
  await page.goto('http://rows.test/');
  await page.addStyleTag({ content: fs.readFileSync('web/styles.css', 'utf8') });
  const app = fs.readFileSync('web/app.js', 'utf8').replace(/^boot\(\)\.catch\(.*$/m, '');
  await page.addScriptTag({ content: fs.readFileSync('web/totp-qr.js', 'utf8') });
  await page.addScriptTag({ content: fs.readFileSync('web/markdown.js', 'utf8') });
  await page.addScriptTag({ content: app });
  await page.evaluate((taskId) => (globalThis as any).eval(`
    const task = { id: ${JSON.stringify(taskId)}, num: 904, title: 'Implement this', projectId: 'p',
      lastView: { taskId: ${JSON.stringify(taskId)}, stage: 'do', status: 'active', pendingDecisions: 3, updatedAt: 1 } };
    Object.assign(S, { user: { id: 'user' }, projects: [{ id: 'p', organizationId: 'org', name: 'P' }],
      organizationId: 'org', tab: 'tasks', meta: {},
      searchResult: { tasks: [task], reasons: { [task.id]: ['approval-requested'] } } });
    toast = () => {};
    loadInbox = async () => {};
    // A press holds off repaints until its click, as in the console.
    installRepaintGuard();
    // The list as renderMain paints it: every row rebuilt, then wired.
    renderMain = () => { document.getElementById('main').innerHTML = taskRow(task); wireRowAsks(); };
    // A refresh reads the requests again, as the server would report them.
    refreshTasks = async () => {
      const pending = (await (await fetch('/api/vault/requests')).json()).filter((r) => r.status === 'pending').length;
      task.lastView = { ...task.lastView, pendingDecisions: pending, updatedAt: task.lastView.updatedAt + 1 };
      bgRenderMain();
    };
    // The working agent: each event moves its view on and repaints the list.
    window.agentWorks = () => setInterval(() => {
      task.lastView = { ...task.lastView, updatedAt: task.lastView.updatedAt + 1 };
      bgRenderMain();
    }, 60);
    renderMain();
  `), TASK);
  return resolved;
}

// Click as a person does: press where the button is. A repaint every 60 ms
// replaces the row's buttons with identical ones in the same place, so the
// press lands on whichever is there, and the press holds off repaints until
// its click (installRepaintGuard). Playwright's own click waits for one element
// to stay put and, on a loaded CI runner, a repaint replaced it every time
// (CI #2787: "element was detached from the DOM" until its timeout).
async function press(page: Page, selector: string) {
  // A repaint between finding the button and measuring it detaches it: measure again.
  let box: Awaited<ReturnType<ReturnType<Page['locator']>['boundingBox']>> = null;
  for (const deadline = Date.now() + 5000; !box && Date.now() < deadline;)
    box = await page.locator(selector).boundingBox().catch(() => null);
  if (!box) throw new Error(`${selector} is not on screen`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

const pendingRequests = (): Pending[] => [
  { id: 'vreq_one', itemId: 'one', status: 'pending', mode: 'use' },
  { id: 'vreq_github', itemId: 'github', status: 'pending', mode: 'use' },
  { id: 'vreq_r2', itemId: 'r2', status: 'pending', mode: 'reveal' },
];

it('keeps a working task’s asks on screen while its view moves on', async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openList(page, pendingRequests(), { slowLoads: 150 });
  const first = page.locator('[data-vreq="vreq_one"]');
  await first.waitFor();
  await page.evaluate(() => (globalThis as any).agentWorks());
  // Sample the row for a second: a decision must never blink out of it.
  const seen = await page.evaluate(async () => {
    const samples: boolean[] = [];
    for (let i = 0; i < 40; i++) {
      samples.push(!!(globalThis as any).document.querySelector('[data-vreq="vreq_one"] [data-vreq-act="task"]'));
      await new Promise((done) => setTimeout(done, 25));
    }
    return samples;
  });
  expect(seen.every(Boolean)).toBe(true);
  expect(errors).toEqual([]);
  await page.close();
});

it('answers each of several asks from the row while the agent works', async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const requests = pendingRequests();
  const resolved = await openList(page, requests, { slowLoads: 150 });
  await page.locator('[data-vreq="vreq_one"]').waitFor();
  await page.evaluate(() => (globalThis as any).agentWorks());
  for (const id of ['vreq_one', 'vreq_github', 'vreq_r2']) {
    await press(page, `[data-vreq="${id}"] [data-vreq-act="task"]`);
    await expect.poll(() => resolved.includes(id)).toBe(true);
    await page.locator(`[data-vreq="${id}"]`).waitFor({ state: 'detached' });
  }
  expect(resolved).toEqual(['vreq_one', 'vreq_github', 'vreq_r2']);
  expect(errors).toEqual([]);
  await page.close();
});

it('keeps an answer on its way pressed through repaints, then drops it from the row', async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const resolved = await openList(page, pendingRequests(), { slowAnswer: 800 });
  await page.locator('[data-vreq="vreq_one"]').waitFor();
  await page.evaluate(() => (globalThis as any).agentWorks());
  await press(page, '[data-vreq="vreq_one"] [data-vreq-act="task"]');
  // The list repaints many times before the server answers: the ask never offers itself again.
  const states = await page.evaluate(async () => {
    const seen: string[] = [];
    for (let i = 0; i < 24; i++) {
      const buttons: { disabled: boolean }[] = [...(globalThis as any).document.querySelectorAll('[data-vreq="vreq_one"] button')];
      seen.push(!buttons.length ? 'gone' : buttons.every((button) => button.disabled) ? 'pressed' : 'open');
      await new Promise((done) => setTimeout(done, 50));
    }
    return seen;
  });
  expect(states).not.toContain('open');
  expect(states.at(-1)).toBe('gone');
  expect(resolved).toEqual(['vreq_one']);
  // The asks left keep their answers.
  expect(await page.locator('[data-vreq="vreq_github"] [data-vreq-act="task"]').isEnabled()).toBe(true);
  expect(errors).toEqual([]);
  await page.close();
});

it('shows an ask that replaced an answered one, though the count is the same', async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const requests = pendingRequests();
  await openList(page, requests);
  await page.locator('[data-vreq="vreq_one"]').waitFor();
  // Answered elsewhere, and the agent asks for another: still three.
  requests[0]!.status = 'granted';
  requests.push({ id: 'vreq_new', itemId: 'r2', status: 'pending', mode: 'use' });
  await page.evaluate(() => (globalThis as any).eval(`
    noteRowAskEvent({ type: 'credential.approval-resolved', taskId: 'task_live' });
    noteRowAskEvent({ type: 'credential.approval-requested', taskId: 'task_live' });
    bgRenderMain();
  `));
  await page.locator('[data-vreq="vreq_one"]').waitFor({ state: 'detached' });
  expect(await page.locator('.row-ask .task-sub').innerText()).toBe('1 more — open the task');
  await page.close();
});
