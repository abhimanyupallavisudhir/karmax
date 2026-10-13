// Screenshots of the public pages (landing, pricing, docs, policies, sign-in)
// against `npm run preview:landing` (http://127.0.0.1:4173).
// Usage: OUT=design/ui-sweep/before node design/ui-sweep/shoot-public.cjs
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const APP = process.env.PUBLIC_APP || 'http://127.0.0.1:4173';
const OUT = process.env.OUT || 'design/ui-sweep/before';
const PAGES = [['public-landing', '/'], ['public-pricing', '/pricing'], ['public-docs', '/docs'], ['public-legal', '/legal'], ['public-login', '/login'], ['public-signup', '/signup']];
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  for (const [viewport, suffix] of [[{ width: 1440, height: 900 }, ''], [{ width: 390, height: 844 }, '.mobile']]) {
    const page = await browser.newPage({ viewport });
    for (const [name, url] of PAGES) {
      try { await page.goto(`${APP}${url}`); await page.waitForTimeout(1800); await page.screenshot({ path: path.join(OUT, `${name}${suffix}.png`) }); }
      catch (e) { console.error(name, e.message.split('\n')[0]); }
    }
    await page.close();
  }
  await browser.close();
})();
