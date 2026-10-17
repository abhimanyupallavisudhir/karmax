import fs from 'node:fs';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';

// Every kind of approval request can be ignored from the conversation: it stays
// there (dimmed, still decidable) and in the rail's pending count.
it('ignores each kind of approval request without deciding it', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const state: Record<string, any[]> = {
      approvalRequests: [{ id: 'credential', taskId: 'task', itemId: 'item', status: 'pending', mode: 'use', why: 'Sign in to GitHub' }],
      permissionRequests: [{ id: 'permission', role: 'do', status: 'pending', capabilities: ['settings:read'], audience: ['@owners'], reason: 'Read email settings' }],
      authorizationRequests: [{ id: 'authorization', status: 'pending', recipients: ['user'], target: { kind: 'task' }, audience: ['@owners'], reason: 'Deploy', authorization: { level: 'developer', scope: 'projects', projectIds: [] } }],
      connections: [{ id: 'connection', label: 'Gmail', status: 'requested', taskId: 'task', projectIds: [], why: 'Read mail' }],
    };
    const dismissed: string[] = [];
    await page.route('http://approvals.test/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="main"><div id="app"></div><aside class="tp-rail" id="rail"></aside></div>' });
      if (url.pathname.startsWith('/fonts/')) return route.fulfill({ body: fs.readFileSync(`web${url.pathname}`) });
      if (url.pathname === '/state') return route.fulfill({ json: state });
      const ignore = (rows: any[], field = 'dismissed') => {
        rows[0][field] = { by: 'user:user', at: Date.now() };
        dismissed.push(rows === state.approvalRequests ? 'credential' : rows === state.permissionRequests ? 'permission'
          : rows === state.authorizationRequests ? 'authorization' : 'connection');
        return route.fulfill({ json: rows[0] });
      };
      if (url.pathname === '/api/connections/connection/dismiss') return ignore(state.connections!);
      if (url.pathname.endsWith('/resolve')) {
        expect(route.request().postDataJSON().action).toBe('dismiss');
        return ignore(url.pathname.includes('/vault/') ? state.approvalRequests!
          : url.pathname.includes('/permission-') ? state.permissionRequests! : state.authorizationRequests!);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await page.goto('http://approvals.test/');
    await page.addStyleTag({ content: fs.readFileSync('web/styles.css', 'utf8') });
    const app = fs.readFileSync('web/app.js', 'utf8').replace(/^boot\(\)\.catch\(.*$/m, '');
    await page.addScriptTag({ content: fs.readFileSync('web/totp-qr.js', 'utf8') });
    await page.addScriptTag({ content: fs.readFileSync('web/markdown.js', 'utf8') });
    await page.addScriptTag({ content: app });
    await page.evaluate(async () => {
      await (globalThis as any).eval(`
        Object.assign(S, { user: { id: 'user' }, projects: [], organizationId: 'org',
          approvalItems: [{ id: 'item', label: 'GitHub login', type: 'login' }], taskEvents: [], sessions: {},
          meta: {}, selected: 'task', taskTab: 'checkin' });
        S.view = { taskId: 'task', stage: 'do', status: 'waiting', actions: [], transcripts: [] };
        toast = () => {};
        refreshTasks = async () => {};
        loadCollaboration = async () => {};
        loadInbox = async () => {};
        refreshTask = async () => {
          Object.assign(S, await (await fetch('/state')).json());
          const pending = ['approvalRequests', 'permissionRequests', 'authorizationRequests'].flatMap((key) => S[key])
            .filter((request) => request.status === 'pending').length + S.connections.length;
          S.view.pendingDecisions = pending;
          document.getElementById('app').innerHTML = conversationApprovalRequests();
          document.getElementById('rail').innerHTML = '<div class="rail-links">' + approvalHistoryLink(S.view) + '</div>';
          wireTaskApprovalRequests(S.view);
        };
      `);
      await (globalThis as any).eval('refreshTask()');
    });
    if (process.env.APPROVAL_SCREENSHOT) await page.screenshot({ path: process.env.APPROVAL_SCREENSHOT.replace(/\.png$/, '-before.png'), fullPage: true });
    const ignoreButtons = page.getByRole('button', { name: 'Ignore request' });
    expect(await ignoreButtons.count()).toBe(4);
    expect((await page.locator('#approval-history-open').innerText()).replace(/\s+/g, ' ')).toBe('Approval requests 4');
    for (const row of ['[data-connection="connection"]', '[data-preq="permission"]', '[data-areq="authorization"]', '[data-vreq="credential"]']) {
      await page.locator(`${row} [aria-label="Ignore request"]`).click();
      await page.locator(`${row}.approval-request-dismissed`).waitFor();
    }
    expect(dismissed.sort()).toEqual(['authorization', 'connection', 'credential', 'permission']);
    expect(await ignoreButtons.count()).toBe(0);
    // Still in the conversation, still decidable, still counted.
    expect(await page.locator('.approval-request-dismissed').count()).toBe(4);
    expect(await page.locator('.approval-request-dismissed .chip', { hasText: 'ignored' }).count()).toBe(4);
    for (const action of ['[data-vreq-act="task"]', '[data-preq-act="approve"]', '[data-areq-act="approve"]', '[data-connection-action="connect"]'])
      expect(await page.locator(action).isEnabled()).toBe(true);
    expect((await page.locator('#approval-history-open').innerText()).replace(/\s+/g, ' ')).toBe('Approval requests 4');
    if (process.env.APPROVAL_SCREENSHOT) await page.screenshot({ path: process.env.APPROVAL_SCREENSHOT, fullPage: true });
    expect(errors).toEqual([]);
  } finally { await browser.close(); }
});
