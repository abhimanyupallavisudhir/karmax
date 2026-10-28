// Full-height screenshots of every organization and project settings pane against a
// scratch tavya seeded by design/task-page/seed.cjs. One PNG per pane, theme and width.
// Usage: APP=http://127.0.0.1:48961 STATE=/tmp/sweep-a/state.json OUT=design/ui-sweep/a-before \
//   node design/ui-sweep/shoot-settings.cjs [pane-filter]
// THEMES=light,dark (default both); WIDTHS=1280,390 (default both); HOSTED=0 shows the self-hosted build.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const APP = process.env.APP || 'http://127.0.0.1:48961';
const STATE = process.env.STATE || '/tmp/sweep-a/state.json';
const OUT = process.env.OUT || 'design/ui-sweep/a-before';
const ONLY = process.argv[2] ? new RegExp(process.argv[2]) : null;
const THEMES = (process.env.THEMES || 'light,dark').split(',');
const WIDTHS = (process.env.WIDTHS || '1280,390').split(',').map(Number);
const HOSTED = process.env.HOSTED !== '0';
const PAGES = [['org', '/personal/settings'], ['project', '/personal/video-studio/settings']];
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  for (const theme of THEMES) for (const width of WIDTHS) {
    const context = await browser.newContext({ storageState: STATE, viewport: { width, height: 900 }, colorScheme: theme });
    await context.addInitScript((t) => { try { localStorage.setItem('karmax-theme', t); } catch {} }, theme);
    await context.route('**/api/meta', async (route) => {
      const response = await route.fetch();
      route.fulfill({ response, json: { ...(await response.json()), hosted: HOSTED } });
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error('pageerror', e.message));
    for (const [name, url] of PAGES) {
      await page.goto(`${APP}${url}`);
      await page.locator('.settings-nav').waitFor();
      await page.waitForTimeout(2500);
      const ids = await page.locator('.settings-nav a[href^="#"]').evaluateAll((as) => as.filter((a) => !a.hidden).map((a) => a.getAttribute('href').slice(1)));
      for (const id of ids) {
        if (ONLY && !ONLY.test(`${name}-${id}`)) continue;
        await page.evaluate((h) => { location.hash = h; document.querySelector(`.settings-nav a[href="#${h}"]`)?.click(); }, id);
        await page.waitForTimeout(900);
        const file = path.join(OUT, `${name}-${id}-${theme}-${width}.png`);
        // The console scrolls inside its own panes, so grow the viewport to the tallest one.
        const tall = await page.evaluate(() => Math.max(...[...document.querySelectorAll('*')].map((el) => el.scrollHeight)));
        await page.setViewportSize({ width, height: Math.min(tall + 40, 9000) });
        await page.waitForTimeout(300);
        await page.screenshot({ path: file });
        await page.setViewportSize({ width, height: 900 });
      }
    }
    await context.close();
  }
  await browser.close();
  console.log(`screens in ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
