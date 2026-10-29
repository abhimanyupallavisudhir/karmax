// Phone and desktop screenshots of the task page header and the sign-in page,
// against a scratch tavya seeded by design/task-page/seed.cjs (mock agent).
// Usage: OUT=design/mobile-header/after node design/mobile-header/shoot.cjs
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const APP = process.env.APP || 'http://127.0.0.1:48950';
const STATE = process.env.STATE || '/tmp/shots/state.json';
const OUT = process.env.OUT || 'design/mobile-header/after';
const TASK = process.env.TASK || '/personal/video-studio/tasks/1';
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const open = async (viewport, signedIn = true, extra = {}) => {
    const context = await browser.newContext({ ...(signedIn ? { storageState: STATE } : {}), viewport, colorScheme: 'light', ...extra });
    await context.route('**/api/meta', async (route) => {
      const response = await route.fetch();
      route.fulfill({ response, json: { ...(await response.json()), hosted: true } });
    });
    // Two pull requests, as a multi-repository task has.
    await context.route(/\/api\/tasks\/[^/]+$/, async (route) => {
      const response = await route.fetch();
      const json = await response.json().catch(() => null);
      if (!json || !json.taskId) return route.fulfill({ response });
      route.fulfill({ response, json: { ...json, prs: [
        { repo: 'video-studio', number: 412, url: 'https://github.com/o/video-studio/pull/412', state: 'open' },
        { repo: 'video-studio-wiki', number: 37, url: 'https://github.com/o/video-studio-wiki/pull/37', state: 'open' },
      ] } });
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error('pageerror', e.message));
    return page;
  };
  const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const mobile = await open({ width: 390, height: 844 }, true, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await mobile.goto(`${APP}${TASK}`);
  await mobile.locator('.task-page:not([aria-busy="true"])').waitFor();
  await mobile.waitForTimeout(2000);
  await shot(mobile, '1-mobile-task');
  if (await mobile.locator('.tp-prs summary').count()) {
    await mobile.locator('.tp-prs summary').click(); await mobile.waitForTimeout(200);
    await shot(mobile, '2-mobile-prs-open');
    await mobile.locator('.tp-prs summary').click();
  }
  // Scroll the conversation down as a finger would, then a little back up.
  const box = await mobile.locator('#ck-thread').boundingBox();
  if (box) {
    await mobile.evaluate(() => { const t = document.getElementById('ck-thread'); t.scrollTop = 0; });
    await mobile.waitForTimeout(300);
    const cdp = await mobile.context().newCDPSession(mobile);
    const swipe = async (dy) => {
      const x = box.x + box.width / 2; let y = box.y + box.height / 2;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let i = 0; i < 10; i++) { y += dy / 10; await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] }); await mobile.waitForTimeout(16); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await swipe(-300); await mobile.waitForTimeout(600);
    await shot(mobile, '3-mobile-scrolled-down');
    await swipe(80); await mobile.waitForTimeout(600);
    await shot(mobile, '4-mobile-scrolled-up');
  }
  await mobile.goto(`${APP}${TASK}/parameters`);
  await mobile.locator('.task-page:not([aria-busy="true"])').waitFor(); await mobile.waitForTimeout(1500);
  await shot(mobile, '5-mobile-parameters');
  const desktop = await open({ width: 1440, height: 900 });
  await desktop.goto(`${APP}${TASK}`);
  await desktop.locator('.task-page:not([aria-busy="true"])').waitFor(); await desktop.waitForTimeout(2000);
  await shot(desktop, '6-desktop-task');
  for (const [name, viewport, extra] of [['mobile', { width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 }], ['desktop', { width: 1440, height: 900 }, {}]]) {
    const page = await open(viewport, false, extra);
    // Show the social buttons tavya.io offers.
    await page.route('**/api/session', async (route) => {
      const response = await route.fetch();
      route.fulfill({ response, json: { ...(await response.json()), google: true, github: true } });
    });
    for (const route of ['/login', '/signup']) {
      await page.goto(`${APP}${route}`); await page.locator('.login-card').waitFor(); await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(OUT, `7-${name}${route.replace('/', '-')}.png`), fullPage: true });
    }
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
