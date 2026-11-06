// Screens of the landing: the first screen and the whole page, on a computer and a
// phone, in the light and the dark look. Usage: APP=http://localhost:4173 OUT=/tmp/shots/landing node design/landing-v2/shoot.cjs
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const APP = process.env.APP || 'http://localhost:4173';
const OUT = process.env.OUT || '/tmp/shots/landing';
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  for (const scheme of ['light', 'dark']) for (const [device, viewport, mobile] of [['desktop', { width: 1440, height: 900 }, false], ['phone', { width: 390, height: 844 }, true]]) {
    const name = `${device}-${scheme}`;
    const context = await browser.newContext({ viewport, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce', colorScheme: scheme });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error('pageerror', e.message));
    await page.goto(APP);
    await page.locator('#landing-main').waitFor();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, `${name}-top.png`) });
    // Lazy stills load as they scroll into view.
    for (let y = 0; y < 12000; y += 700) { await page.evaluate((top) => window.scrollTo(0, top), y); await page.waitForTimeout(120); }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, `${name}-full.png`), fullPage: true });
    await context.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
