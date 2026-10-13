// Screenshots of every console page against a scratch tavya seeded by
// design/task-page/seed.cjs (mock agent). Settings pages are shot per section.
// Usage: APP=http://127.0.0.1:48950 OUT=design/ui-sweep/before node design/ui-sweep/shoot.cjs [filter]
// MOBILE=1 also shoots a 390px phone (MOBILE=only: just the phone). /api/meta is marked hosted so hosted-only
// controls show, as on tavya.io.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const APP = process.env.APP || 'http://127.0.0.1:48950';
const STATE = process.env.STATE || '/tmp/shots/state.json';
const OUT = process.env.OUT || 'design/ui-sweep/before';
const ONLY = process.argv[2] ? new RegExp(process.argv[2]) : null;
const P = '/personal/video-studio';
const PAGES = [
  ['home', '/personal'],
  ['tasks', P],
  ['tasks-all', `${P}?q=`],
  ['queues', `${P}/queue`],
  ['activity', `${P}/activity`],
  ['wiki', `${P}/wiki`],
  ['avatars', `${P}/avatars`],
  ['project-settings', `${P}/settings`, { sections: true }],
  ['insights', '/personal/insights'],
  ['inbox', '/inbox'],
  ['org-wiki', '/personal/wiki'],
  ['org-settings', '/personal/settings', { sections: true }],
  ['installation', '/installation', { sections: true }],
  ['profile', '/profile', { full: true }],
  ['task-form', `${P}`, { keys: ['Shift+N'], wait: '#tf-page' }],
  ['palette', `${P}`, { keys: ['Control+k'], wait: '.palette' }],
  ['help', `${P}`, { keys: ['Shift+Slash'], wait: '#help-scrim, .help' }],
  ['task', `${P}/tasks/1`],
];
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const shootAll = async (viewport, suffix) => {
    const context = await browser.newContext({ storageState: STATE, viewport, colorScheme: 'light' });
    await context.route('**/api/meta', async (route) => {
      const response = await route.fetch();
      route.fulfill({ response, json: { ...(await response.json()), hosted: true } });
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error('pageerror', e.message));
    for (const [name, url, opts = {}] of PAGES) {
      if (ONLY && !ONLY.test(name)) continue;
      try {
        await page.goto(`${APP}${url}`);
        await page.locator('#main').waitFor();
        await page.waitForTimeout(2200);
        for (const key of opts.keys || []) { await page.locator('body').click({ position: { x: 5, y: 300 } }).catch(() => {}); await page.keyboard.press(key); }
        if (opts.wait) await page.locator(opts.wait).first().waitFor({ timeout: 8000 });
        if (opts.keys) await page.waitForTimeout(1200);
        await page.screenshot({ path: path.join(OUT, `${name}${suffix}.png`), fullPage: !!opts.full });
        if (opts.sections) {
          const links = await page.locator('.settings-nav a[href^="#"]:visible').all();
          for (let i = 0; i < links.length; i++) {
            const label = (await links[i].innerText()).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
            await links[i].click(); await page.waitForTimeout(1200);
            await page.screenshot({ path: path.join(OUT, `${name}--${String(i + 1).padStart(2, '0')}-${label}${suffix}.png`) });
          }
        }
      } catch (e) { console.error(name, e.message.split('\n')[0]); }
    }
    await context.close();
  };
  if (process.env.MOBILE !== 'only') await shootAll({ width: 1440, height: 900 }, '');
  if (process.env.MOBILE) await shootAll({ width: 390, height: 844 }, '.mobile');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
