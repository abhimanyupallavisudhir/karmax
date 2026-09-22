import fs from 'node:fs';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';

it('resolves approvals and resource decisions inside the real check-in DOM', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const state = {
      approvalRequests: [{ id: 'credential', itemId: 'item', status: 'pending', mode: 'use' }],
      permissionRequests: [{ id: 'permission', status: 'pending', capabilities: ['task:read'], audience: ['@owners'] }],
      authorizationRequests: [{ id: 'authorization', status: 'pending', recipients: ['user'], target: { kind: 'task' }, audience: ['@owners'] }],
      connections: [{ id: 'connection', status: 'connecting', ownerId: 'user' }],
    };
    let resources: any[] = [{ resource: { id: 'resource', name: 'Dataset' }, candidate: { id: 'candidate', state: 'pending', sourceKind: 'path' } }];
    const decisions: string[] = [];
    await page.route('http://checkin.test/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="app"></div>' });
      if (url.pathname.startsWith('/fonts/')) return route.fulfill({ body: fs.readFileSync(`web${url.pathname}`) });
      if (url.pathname === '/state') return route.fulfill({ json: state });
      if (url.pathname.endsWith('/resources')) return route.fulfill({ json: resources });
      if (url.pathname.endsWith('/adopt')) {
        resources[0].candidate.state = 'adopted';
        return route.fulfill({ json: {} });
      }
      if (url.pathname.endsWith('/refresh')) {
        state.connections[0]!.status = 'active';
        return route.fulfill({ json: {} });
      }
      if (url.pathname.endsWith('/resolve')) {
        const action = route.request().postDataJSON().action;
        decisions.push(action);
        const rows = url.pathname.includes('/vault/') ? state.approvalRequests
          : url.pathname.includes('/permission-') ? state.permissionRequests : state.authorizationRequests;
        rows[0]!.status = action === 'deny' ? 'denied' : 'approved';
        return route.fulfill({ json: { resume: { resumed: true } } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await page.goto('http://checkin.test/');
    await page.addStyleTag({ content: fs.readFileSync('web/styles.css', 'utf8') });
    // Load the actual console, suppressing only its application bootstrap.
    const app = fs.readFileSync('web/app.js', 'utf8').replace(/^boot\(\)\.catch\(.*$/m, '');
    await page.addScriptTag({ content: fs.readFileSync('web/totp-qr.js', 'utf8') });
    await page.addScriptTag({ content: app });
    await page.evaluate(async () => {
      const w = globalThis as any;
      await w.eval(`
        Object.assign(S, { user: { id: 'user' }, projects: [], organizationId: 'org',
          approvalItems: [{ id: 'item', label: 'Login' }], taskEvents: [], sessions: {},
          meta: {}, selected: 'task', taskTab: 'checkin' });
        S.view = { taskId: 'task', stage: 'review', status: 'waiting', actions: [],
          transcripts: [{ role: 'do', messages: [{ role: 'assistant', text: 'Ready for review.' }] }] };
        toast = () => {};
        refreshTasks = async () => {};
        loadCollaboration = async () => {};
        refreshTask = async () => {
          Object.assign(S, await (await fetch('/state')).json());
          patchTaskPage(document.getElementById('app'), checkinTab(S.view));
          wireTaskApprovalRequests(S.view);
        };
      `);
      await w.eval('refreshTask()');
    });
    for (const selector of ['[data-vreq-act="once"]', '[data-preq-act="deny"]', '[data-areq-act="approve"]']) {
      await page.locator(selector).click();
      await page.locator(selector).waitFor({ state: 'detached' });
    }
    await page.locator('[data-connection-action="refresh"]').click();
    await page.locator('#task-approval-requests').waitFor({ state: 'detached' });
    expect(decisions).toEqual(['once', 'deny', 'approve']);
    expect(await page.locator('#ck-thread').count()).toBe(1);
    await page.evaluate(() => (globalThis as any).eval(`
      document.querySelector('.thread').insertAdjacentHTML('beforeend', resourceReviewPlaceholder());
      wireResourceReview(S.view);
    `));
    page.on('dialog', dialog => dialog.accept());
    await page.locator('.candidate-adopt').click();
    await page.locator('#review-resources.hidden').waitFor({ state: 'attached' });
    expect(await page.locator('#review-resources').innerText()).toBe('');
    // A decision made elsewhere must also clear after a normal refreshed render.
    state.permissionRequests[0]!.status = 'pending';
    await page.evaluate(() => (globalThis as any).eval('refreshTask()'));
    await page.locator('[data-preq]').waitFor();
    state.permissionRequests[0]!.status = 'approved';
    await page.evaluate(() => (globalThis as any).eval('refreshTask()'));
    expect(await page.locator('#task-approval-requests').count()).toBe(0);
    expect(errors).toEqual([]);
  } finally { await browser.close(); }
});
