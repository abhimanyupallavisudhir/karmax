// Section D screens (home, inbox, insights, wiki, avatars, shell) in light and
// dark, desktop and 390px phone, against a scratch tavya seeded by
// design/task-page/seed.cjs. Like shoot.cjs, /api/meta is marked hosted.
// Usage: APP=http://127.0.0.1:48964 STATE=/tmp/sweep-d/state.json OUT=design/ui-sweep/d-before node design/ui-sweep/shoot-d.cjs [filter]
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const APP = process.env.APP || 'http://127.0.0.1:48964';
const STATE = process.env.STATE || '/tmp/sweep-d/state.json';
const OUT = process.env.OUT || 'design/ui-sweep/d-before';
const ONLY = process.argv[2] ? new RegExp(process.argv[2]) : null;
const P = '/personal/video-studio';
const PAGES = [
  ['home', '/personal'],
  ['home-all', '/personal?q='],
  ['tasks', P],
  ['tasks-all', `${P}?q=`],
  ['tasks-empty', `${P}?q=nothing-matches-this`],
  ['inbox', '/inbox'],
  ['insights', '/personal/insights'],
  ['wiki', `${P}/wiki`],
  ['org-wiki', '/personal/wiki'],
  ['switcher', '/personal', { click: '#org-switcher input', desktop: true }],
];
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const shootAll = async (viewport, scheme, suffix) => {
    const context = await browser.newContext({ storageState: STATE, viewport, colorScheme: scheme });
    await context.route('**/api/meta', async (route) => {
      const response = await route.fetch();
      route.fulfill({ response, json: { ...(await response.json()), hosted: true } });
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error('pageerror', e.message));
    for (const [name, url, opts = {}] of PAGES) {
      if (ONLY && !ONLY.test(name)) continue;
      if (opts.desktop && viewport.width < 700) continue;
      try {
        await page.goto(`${APP}${url}`);
        await page.locator('#main').waitFor();
        await page.waitForTimeout(2200);
        if (opts.click) { await page.locator(opts.click).first().click(); await page.waitForTimeout(600); }
        await page.screenshot({ path: path.join(OUT, `${name}${suffix}.png`), fullPage: !opts.click });
      } catch (e) { console.error(name, e.message.split('\n')[0]); }
    }
    await context.close();
  };
  const which = process.env.ONLY_SIZE || 'all';
  if (which !== 'mobile') {
    await shootAll({ width: 1440, height: 1200 }, 'light', '');
    await shootAll({ width: 1440, height: 1200 }, 'dark', '.dark');
  }
  if (which !== 'desktop') {
    await shootAll({ width: 390, height: 844 }, 'light', '.mobile');
    await shootAll({ width: 390, height: 844 }, 'dark', '.mobile.dark');
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
