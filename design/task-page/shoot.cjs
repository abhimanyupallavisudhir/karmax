// Screenshots of the task page against a running tavya seeded by seed.cjs.
// Usage: OUT=design/task-page/after node design/task-page/shoot.cjs
// /api/meta is marked hosted so Work locally (a hosted-only action) shows.
// (BEFORE=1 shoots the old tabs: Chat, Overview, Approval Requests, Parameters.)
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const APP = process.env.APP || 'http://127.0.0.1:48950';
const STATE = process.env.STATE || '/tmp/shots/state.json';
const OUT = process.env.OUT || 'design/task-page/after';
const TASK = (n) => `/personal/video-studio/tasks/${n}`;
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const open = async (viewport) => {
    const context = await browser.newContext({ storageState: STATE, viewport, colorScheme: 'light' });
    await context.route('**/api/meta', async (route) => {
      const response = await route.fetch();
      route.fulfill({ response, json: { ...(await response.json()), hosted: true } });
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error('pageerror', e.message));
    return page;
  };
  const go = async (page, url) => { await page.goto(`${APP}${url}`); await page.locator('.task-page:not([aria-busy="true"])').waitFor(); await page.waitForTimeout(2000); };
  const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const desktop = await open({ width: 1440, height: 900 });
  if (process.env.BEFORE) {
    for (const tab of ['checkin', 'overview', 'approvals', 'parameters']) { await go(desktop, `${TASK(1)}/${tab}`); await shot(desktop, `desktop-${tab}`); }
  } else {
    await go(desktop, TASK(1)); await shot(desktop, '1-desktop-chat');
    await go(desktop, TASK(2)); await shot(desktop, '2-desktop-review');
    await go(desktop, `${TASK(1)}/parameters`); await shot(desktop, '3-desktop-parameters');
    await go(desktop, TASK(1));
    await desktop.locator('#approval-history-open').click();
    await desktop.locator('#task-approval-history .approval-list').waitFor();
    await desktop.waitForTimeout(500);
    await shot(desktop, '4-desktop-approval-history');
    await desktop.keyboard.press('Escape');
    await desktop.locator('.tp-head h2').click();
    await desktop.keyboard.press('t'); await desktop.locator('#term-open').waitFor(); await shot(desktop, '5-desktop-terminal');
    if (process.env.ATTEMPTS_TASK) { await go(desktop, TASK(process.env.ATTEMPTS_TASK)); await shot(desktop, '6-desktop-attempts'); }
    if (process.env.WAITING_TASK) {
      await desktop.goto(`${APP}${TASK(process.env.WAITING_TASK)}`); await desktop.locator('#tf-page').waitFor(); await desktop.waitForTimeout(1500);
      await shot(desktop, '7-desktop-waiting-task');
    }
    await desktop.goto(`${APP}/personal/video-studio`); await desktop.locator('.task-row').first().waitFor();
    await desktop.locator('.view-chip', { hasText: 'All' }).first().click(); await desktop.waitForTimeout(1500);
    await shot(desktop, '8-desktop-task-list');
    const mobile = await open({ width: 390, height: 844 });
    await mobile.evaluate(() => localStorage.removeItem('karmax-task-rail')).catch(() => {});
    await go(mobile, TASK(1)); await shot(mobile, '9-mobile-chat');
    await mobile.locator('#tp-rail-toggle').click(); await mobile.waitForTimeout(300); await shot(mobile, '10-mobile-details');
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
