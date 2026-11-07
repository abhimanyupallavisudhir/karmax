// Screens of the project list and sidebar (fixture.cjs), light and dark.
// Usage: OUT=/tmp/pis/after node design/project-icon-status/shoot.cjs
const fs = require('node:fs');
const path = require('node:path');
const { launch } = require('../../tests/helpers/fake-console.cjs');
const { statusConsole } = require('./fixture.cjs');

const OUT = process.env.OUT || '/tmp/pis/shots';
const PAGES = [['all', '/org/website?q=-is%3Aarchived'], ['for-me', '/org/website']];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  for (const [name, url] of PAGES) for (const scheme of ['light', 'dark']) {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 1180 }, colorScheme: scheme });
    await statusConsole(context);
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error(name, 'pageerror', e.message));
    await page.goto(`http://console.test${url}`);
    await page.locator('.task-row').first().waitFor();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, `${name}-${scheme}.png`) });
    await context.close();
  }
  await browser.close();
  console.log(`shots in ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
