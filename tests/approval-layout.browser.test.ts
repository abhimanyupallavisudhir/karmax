import fs from 'node:fs';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';

// The conversation column is narrower than the viewport (the details rail sits
// beside it), so a request's buttons once claimed its whole width and squeezed
// the request's own text into a one-letter column.
it.each([560, 980])('lays out approval requests in a %ipx conversation without crushing their text', async (width) => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, colorScheme: 'dark' });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://approvals.test/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/fonts/')) return route.fulfill({ body: fs.readFileSync(`web${url.pathname}`) });
      return route.fulfill({ contentType: 'text/html', body: `<div id="main"><div id="app" class="ck-thread" style="width:${width}px;display:flex;flex-direction:column"></div></div>` });
    });
    await page.goto('http://approvals.test/');
    await page.addStyleTag({ content: fs.readFileSync('web/styles.css', 'utf8') });
    const app = fs.readFileSync('web/app.js', 'utf8').replace(/^boot\(\)\.catch\(.*$/m, '');
    await page.addScriptTag({ content: fs.readFileSync('web/totp-qr.js', 'utf8') });
    await page.addScriptTag({ content: fs.readFileSync('web/markdown.js', 'utf8') });
    await page.addScriptTag({ content: app });
    await page.evaluate(() => (globalThis as any).eval(`
      Object.assign(S, { user: { id: 'user' }, organizationId: 'org',
        projects: [{ id: 'proj', name: 'karmax', organizationId: 'org' }],
        tasks: [{ id: 'task', num: 2, projectId: 'proj', title: 'Remove the unused GitHub workflow and its secrets' }],
        approvalItems: [{ id: 'item', label: 'GitHub', type: 'login' }],
        approvalRequests: [
          { id: 'unbound', taskId: 'task', status: 'pending', mode: 'use', domain: 'github.com', why: 'Sign in to delete the workflow' },
          { id: 'bound', taskId: 'task', itemId: 'item', status: 'pending', mode: 'use' },
        ],
        permissionRequests: [{ id: 'permission', taskId: 'task', status: 'pending', role: 'do', capabilities: ['task:read'], audience: ['@owners'], reason: 'Read the parent task' }],
        authorizationRequests: [], repositoryAccessRequests: [], connections: [] });
      S.view = { taskId: 'task' };
      document.getElementById('app').innerHTML = conversationApprovalRequests();
    `));
    const rows = await page.locator('.approval-request').evaluateAll(nodes => nodes.map(node => {
      const box = node.getBoundingClientRect();
      const main = node.querySelector('.approval-request-main')!.getBoundingClientRect();
      const title = node.querySelector('.approval-request-title')!.getBoundingClientRect();
      return { width: box.width, main: main.width, title: title.height };
    }));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      // The text gets at least half of the card; its title is one line.
      expect(row.main).toBeGreaterThan(row.width / 2);
      expect(row.title).toBeLessThan(32);
    }
    // In its own conversation a request does not name the task it belongs to.
    expect(await page.locator('#task-approval-requests').innerText()).not.toContain('Remove the unused');
    expect(await page.locator('#task-approval-requests').innerText()).toContain('Sign in to delete the workflow');
    if (process.env.KARMAX_SCREENSHOT_DIR) {
      await page.locator('#task-approval-requests').screenshot({ path: `${process.env.KARMAX_SCREENSHOT_DIR}/approval-requests-${width}.png` });
    }
    expect(errors.join('\n')).toBe('');
  } finally { await browser.close(); }
});
