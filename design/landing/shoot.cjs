// Screens of the public site (landing, docs, pricing, policies, sign-in) in
// light and dark, on a computer and a phone, against `npm run preview:landing`.
// A look can be forced (`LOOK=classic`); the default is the installation's.
// Usage: OUT=/tmp/landing/after node design/landing/shoot.cjs
// Then: BEFORE=/tmp/landing/before AFTER=/tmp/landing/after OUT=design/landing/out node design/ux-round-2/compare.cjs
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const APP = process.env.PUBLIC_APP || 'http://127.0.0.1:4173';
const OUT = process.env.OUT || '/tmp/landing/after';
const LOOK = process.env.LOOK || '';
const PAGES = [['landing', '/', true], ['docs', '/docs'], ['pricing', '/pricing'], ['policies', '/legal'], ['sign-in', '/login']];
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  for (const scheme of ['light', 'dark']) {
    for (const [viewport, suffix] of [[{ width: 1440, height: 900 }, ''], [{ width: 390, height: 844 }, '-phone']]) {
      const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: 'reduce' });
      if (LOOK) await context.addInitScript((look) => localStorage.setItem('karmax-skin', look), LOOK);
      const page = await context.newPage();
      for (const [name, url, full] of PAGES) {
        try {
          await page.goto(`${APP}${url}`);
          await page.waitForTimeout(1500);
          await page.screenshot({ path: path.join(OUT, `${name}-${scheme}${suffix}.png`), fullPage: !!full && !suffix });
        } catch (e) { console.error(name, e.message.split('\n')[0]); }
      }
      await context.close();
    }
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
