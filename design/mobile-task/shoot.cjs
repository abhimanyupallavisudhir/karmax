// Phone screenshots of a task's conversation (dark and light), against a
// scratch tavya seeded by design/task-page/seed.cjs (mock agent, port 48950).
// Usage: OUT=design/mobile-task/after node design/mobile-task/shoot.cjs
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const APP = process.env.APP || 'http://127.0.0.1:48950';
const STATE = process.env.STATE || '/tmp/shots/state.json';
const OUT = process.env.OUT || 'design/mobile-task/after';
const TASK = process.env.TASK || '/personal/video-studio/tasks/1';
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  for (const colorScheme of ['dark', 'light']) {
    const context = await browser.newContext({ storageState: STATE, viewport: { width: 390, height: 664 },
      colorScheme, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error('pageerror', e.message));
    await page.goto(`${APP}${TASK}`);
    await page.locator('.task-page:not([aria-busy="true"])').waitFor();
    await page.waitForTimeout(2000);
    const color = await page.evaluate(() => [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.content));
    console.log(colorScheme, 'theme-color', color.join(' '));
    await page.screenshot({ path: path.join(OUT, `task-${colorScheme}.png`) });
    if (colorScheme === 'dark') {
      await page.locator('.followup-input').fill('Can you also make the toggle remember the choice across devices, and add a test that covers a reload in Safari?');
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT, 'task-dark-typing.png') });
    }
    await context.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
