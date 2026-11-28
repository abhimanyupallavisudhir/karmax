import fs from 'node:fs';
import { chromium, type Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { permissionAsk } from '../src/domain/permission-ask.js';

// preq_mx07uw7p312057c6ae (#1060) asked only to work in admin_docs, and its owner
// was asked "Give the agent 0 permissions?". Every place the console shows a
// permission request says what it grants, in the gateway's words.
let browser: Awaited<ReturnType<typeof chromium.launch>>;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });

const TASK = 'task_mwztpleze6552c35fa';
// What GET /api/permission-requests lists (KarmaxApi.listPermissionRequests).
const projectOnly = {
  id: 'preq_mx07uw7p312057c6ae', type: 'permission', taskId: TASK, status: 'pending', role: 'do',
  capabilities: [], projectIds: ['proj_mu2toqh78fe22543eb'], audience: ['@owners'], reason: 'Publish the admin docs.',
  baseAuthorization: { level: 'developer', scope: 'projects', projectIds: ['tavya'] },
  ask: permissionAsk({ agent: '#1060\'s agent', capabilities: [], projects: ['admin_docs'], level: 'Developer' }),
};
const both = { ...projectOnly, id: 'preq_both', capabilities: ['settings:write'],
  ask: permissionAsk({ agent: '#1060\'s agent', capabilities: ['settings:write'], projects: ['admin_docs'], level: 'Developer' }) };
// A capability request reads as what it lets the agent do, never as ids.
const capabilities = { ...projectOnly, id: 'preq_caps', capabilities: ['settings:read', 'settings:write'], projectIds: undefined,
  baseAuthorization: undefined, ask: permissionAsk({ agent: '#1060\'s agent', capabilities: ['settings:read', 'settings:write'] }) };

async function openConsole(page: Page, requests: unknown[]) {
  await page.route('http://perm.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="main"></div><div id="app"></div>' });
    if (url.pathname.startsWith('/fonts/')) return route.fulfill({ body: fs.readFileSync(`web${url.pathname}`) });
    if (url.pathname === '/api/permission-requests') return route.fulfill({ json: requests });
    if (['/api/vault/requests', '/api/authorization-requests', '/api/repository-access-requests', '/api/connections'].includes(url.pathname))
      return route.fulfill({ json: [] });
    return route.fulfill({ json: {} });
  });
  await page.goto('http://perm.test/');
  await page.addStyleTag({ content: fs.readFileSync('web/styles.css', 'utf8') });
  const app = fs.readFileSync('web/app.js', 'utf8').replace(/^boot\(\)\.catch\(.*$/m, '');
  await page.addScriptTag({ content: fs.readFileSync('web/totp-qr.js', 'utf8') });
  await page.addScriptTag({ content: fs.readFileSync('web/markdown.js', 'utf8') });
  await page.addScriptTag({ content: app });
}

it('a For me row names the project a request adds, with details in its tooltip', async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openConsole(page, [projectOnly]);
  await page.evaluate((taskId) => (globalThis as any).eval(`
    const task = { id: ${JSON.stringify(taskId)}, num: 1060, title: 'Write the admin docs', projectId: 'p',
      lastView: { taskId: ${JSON.stringify(taskId)}, stage: 'do', status: 'waiting', pendingDecisions: 1, updatedAt: 1 } };
    Object.assign(S, { user: { id: 'user' }, projects: [{ id: 'p', organizationId: 'org', name: 'tavya' }],
      organizationId: 'org', tab: 'tasks', meta: {},
      searchResult: { tasks: [task], mine: { [task.id]: ['approval-requested'] }, reasons: { [task.id]: ['approval-requested'] } } });
    toast = () => {};
    loadInbox = async () => {};
    renderMain = () => { document.getElementById('main').innerHTML = taskRow(task); wireRowAsks(); };
    bgRenderMain = renderMain;
    renderMain();
  `), TASK);
  const question = page.locator('[data-preq="preq_mx07uw7p312057c6ae"] .row-ask-q');
  await expect.poll(() => question.innerText().catch(() => '')).toBe('Let #1060\'s agent work in admin_docs too (as Developer)?');
  expect(await question.getAttribute('title')).toBe('Projects: admin_docs (as Developer)');
  expect(await page.locator('#main').innerText()).not.toMatch(/\b0 permissions?\b/);
  expect(errors).toEqual([]);
  await page.close();
});

it('the approval card says both what it adds and, on hover, every detail', async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openConsole(page, []);
  await page.evaluate((requests) => (globalThis as any).eval(`
    S.projects = [];
    document.getElementById('app').innerHTML = permissionRequestRows(${JSON.stringify(requests)}, { inTask: true });
  `), [projectOnly, both, capabilities]);
  const titles = page.locator('.approval-request-title .approval-request-ask');
  expect(await titles.allInnerTexts()).toEqual([
    'Let #1060\'s agent work in admin_docs too (as Developer)?',
    'Let #1060\'s agent work in admin_docs too (as Developer) and edit global settings?',
    'Let #1060\'s agent view and edit global settings?',
  ]);
  expect(await titles.nth(1).getAttribute('title')).toBe('Projects: admin_docs (as Developer)\nPermissions: settings:write');
  // The ids a person need not decode are in the tooltip, not the text.
  expect(await titles.nth(2).getAttribute('title')).toBe('Permissions: settings:read, settings:write');
  expect(await page.locator('#app .approval-request-title').allInnerTexts()).not.toContainEqual(expect.stringMatching(/settings:/));
  // Compact: the question is the card's title; no empty or repeated chip rows.
  expect(await page.locator('.approval-request-caps, .approval-request-projects').count()).toBe(0);
  expect(await page.locator('#app').innerText()).not.toMatch(/\b0 permissions?\b/);
  expect(errors).toEqual([]);
  await page.close();
});

it('a notification says what the approval grants', async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await openConsole(page, []);
  // What GET /api/inbox returns for it (Store.inboxAsks).
  const text = await page.evaluate(() => (globalThis as any).eval(`
    S.inbox = [];
    showVisualNotification({ id: 'inbox_1', kind: 'approval-requested', urgency: 'high', unread: true, taskId: 'task',
      task: { id: 'task', num: 1060, title: 'Write the admin docs' }, ask: 'Let its agent work in admin_docs too (as Developer)?' });
    document.querySelector('#notification-alerts .notification-open').textContent;
  `));
  expect(text).toContain('Write the admin docs');
  expect(text).toContain('Let its agent work in admin_docs too (as Developer)?');
  await page.close();
});
