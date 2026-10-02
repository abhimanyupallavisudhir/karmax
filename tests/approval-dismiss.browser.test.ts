import fs from 'node:fs';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';

// Every approval kind offers × in the real check-in DOM; it silences the request
// (no agent message) and the Approval Requests tab keeps it answerable.
it('dismisses every approval kind from check-in and keeps it on the Approval Requests tab', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const state = {
      approvalRequests: [{ id: 'credential', itemId: 'item', status: 'pending', mode: 'use', taskId: 'task' }] as any[],
      permissionRequests: [{ id: 'permission', role: 'do', status: 'pending', capabilities: ['task:read'], audience: ['@owners'], reason: 'Read tasks' }] as any[],
      authorizationRequests: [{ id: 'authorization', status: 'pending', recipients: ['user'], target: { kind: 'task' }, audience: ['@owners'], reason: 'Developer access' }] as any[],
      connections: [{ id: 'connection', label: 'gmail', status: 'requested', taskId: 'task', projectIds: [], why: 'Read mail' }] as any[],
    };
    const dismissals: string[] = [];
    await page.route('http://approvals.test/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="main"><div id="app"></div></div>' });
      if (url.pathname.startsWith('/fonts/')) return route.fulfill({ body: fs.readFileSync(`web${url.pathname}`) });
      if (url.pathname === '/state') return route.fulfill({ json: state });
      const body = route.request().postDataJSON() ?? {};
      const dismissed = { by: 'user:user', at: 1 };
      if (url.pathname === '/api/connections/connection/dismiss') {
        dismissals.push('connection'); state.connections[0].dismissed = dismissed;
        return route.fulfill({ json: state.connections[0] });
      }
      if (url.pathname.endsWith('/resolve')) {
        expect(body.action).toBe('dismiss');
        const rows = url.pathname.includes('/vault/') ? state.approvalRequests
          : url.pathname.includes('/permission-') ? state.permissionRequests : state.authorizationRequests;
        dismissals.push(rows[0].id); rows[0].dismissed = dismissed;
        return route.fulfill({ json: { ...rows[0], resume: { resumed: false, reason: 'Dismissed without notifying the agent' } } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await page.goto('http://approvals.test/');
    await page.addStyleTag({ content: fs.readFileSync('web/styles.css', 'utf8') });
    const app = fs.readFileSync('web/app.js', 'utf8').replace(/^boot\(\)\.catch\(.*$/m, '');
    await page.addScriptTag({ content: fs.readFileSync('web/totp-qr.js', 'utf8') });
    await page.addScriptTag({ content: fs.readFileSync('web/markdown.js', 'utf8') });
    await page.addScriptTag({ content: app });
    await page.evaluate(async () => (globalThis as any).eval(`
      Object.assign(S, { user: { id: 'user' }, projects: [], organizationId: 'org',
        approvalItems: [{ id: 'item', label: 'GitHub login' }], taskEvents: [], sessions: {},
        meta: {}, selected: 'task', taskTab: 'checkin', taskApprovalsFor: 'task' });
      S.view = { taskId: 'task', stage: 'do', status: 'waiting', actions: [],
        transcripts: [{ role: 'do', messages: [{ role: 'assistant', text: 'I need a few approvals.' }] }] };
      toast = () => {}; refreshTasks = async () => {}; loadCollaboration = async () => {}; loadInbox = async () => {};
      refreshTask = async () => {
        Object.assign(S, await (await fetch('/state')).json());
        document.getElementById('app').innerHTML = S.taskTab === 'checkin' ? checkinTab(S.view) : approvalRequestsTab(S.view);
        wireTaskApprovalRequests(S.view);
      };
      refreshTask();
    `));
    const rows = ['[data-vreq]', '[data-preq]', '[data-areq]', '[data-connection]'];
    for (const row of rows) await page.locator(row).waitFor();
    const shots = process.env.KARMAX_SCREENSHOT_DIR;
    if (shots) await page.locator('#task-approval-requests').screenshot({ path: `${shots}/approval-dismiss-checkin.png` });
    for (const row of rows) {
      await page.locator(`${row} [aria-label="Dismiss request"]`).click();
      await page.locator(row).waitFor({ state: 'detached' });
    }
    expect(dismissals.sort()).toEqual(['authorization', 'connection', 'credential', 'permission']);
    expect(await page.locator('#task-approval-requests').count()).toBe(0);

    await page.evaluate(() => (globalThis as any).eval(`S.taskTab = 'approvals'; refreshTask();`));
    for (const row of rows) {
      const dismissed = page.locator(`${row}.approval-request-dismissed`);
      await dismissed.waitFor();
      expect(await dismissed.locator('[aria-label="Dismiss request"]').count()).toBe(0);
    }
    expect(await page.locator('.approval-needed:has-text("pending")').count()).toBe(0);
    if (shots) await page.locator('#task-approval-requests').screenshot({ path: `${shots}/approval-dismiss-tab.png` });
    expect(errors).toEqual([]);
  } finally { await browser.close(); }
});
