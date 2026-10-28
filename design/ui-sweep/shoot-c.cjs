// Round-2 sweep, section C: task page, task form, help, palette, queues, activity
// against a scratch tavya seeded by design/task-page/seed.cjs.
// Usage: APP=http://127.0.0.1:48963 STATE=/tmp/sweep-c/state.json OUT=design/ui-sweep/c-before node design/ui-sweep/shoot-c.cjs [filter]
// Shoots light + dark at 1440px and light at 390px (phone).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const APP = process.env.APP || 'http://127.0.0.1:48963';
const STATE = process.env.STATE || '/tmp/sweep-c/state.json';
const OUT = process.env.OUT || 'design/ui-sweep/c-before';
const ONLY = process.argv[2] ? new RegExp(process.argv[2]) : null;
const P = '/personal/video-studio';
const SHOTS = [
  ['task', `${P}/tasks/1`, { wait: '.task-page:not([aria-busy="true"])' }],
  ['task-sub', `${P}/tasks/2`, { wait: '.task-page:not([aria-busy="true"])' }],
  ['task-params', `${P}/tasks/1/parameters`, { wait: '.task-page:not([aria-busy="true"])' }],
  ['task-rail', `${P}/tasks/1`, { wait: '.task-page:not([aria-busy="true"])', click: '#tp-rail-toggle', mobileOnly: true }],
  ['task-form', P, { keys: ['Shift+N'], wait: '#tf-page' }],
  ['task-form-mid', P, { keys: ['Shift+N'], wait: '#tf-page', scroll: ['.tf-scroll', 700] }],
  ['task-form-bottom', P, { keys: ['Shift+N'], wait: '#tf-page', scroll: ['.tf-scroll', 99999] }],
  ['task-params-bottom', `${P}/tasks/1/parameters`, { wait: '.task-page:not([aria-busy="true"])', scroll: ['#tp-body', 99999] }],
  ['palette', P, { keys: ['Control+k'], wait: '.palette' }],
  ['help', P, { keys: ['Shift+Slash'], wait: '#help-scrim, .help' }],
  ['queues', `${P}/queue`],
  ['activity', `${P}/activity`],
  ['tasks', P],
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
    await page.goto(`${APP}${P}`);
    await page.evaluate((s) => { try { localStorage.setItem('karmax-theme', s); } catch {} }, scheme).catch(() => {});
    for (const [name, url, opts = {}] of SHOTS) {
      if (ONLY && !ONLY.test(name)) continue;
      if (opts.mobileOnly && viewport.width > 500) continue;
      try {
        await page.goto(`${APP}${url}`);
        await page.locator(opts.wait && !opts.keys ? opts.wait : '#main').first().waitFor();
        await page.waitForTimeout(2000);
        for (const key of opts.keys || []) { await page.locator('body').click({ position: { x: 5, y: 300 } }).catch(() => {}); await page.keyboard.press(key); }
        if (opts.keys && opts.wait) await page.locator(opts.wait).first().waitFor({ timeout: 8000 });
        if (opts.click) { await page.locator(opts.click).click(); }
        if (opts.scroll) await page.waitForTimeout(1500);
        if (opts.scroll) await page.evaluate(([sel, y]) => { const el = document.querySelector(sel); if (el) el.scrollTop = y; }, opts.scroll);
        if (opts.keys || opts.click || opts.scroll) await page.waitForTimeout(1000);
        await page.screenshot({ path: path.join(OUT, `${name}${suffix}.png`), fullPage: !!opts.full });
      } catch (e) { console.error(name, suffix, e.message.split('\n')[0]); }
    }
    await context.close();
  };
  await shootAll({ width: 1440, height: 900 }, 'light', '');
  if (!process.env.NO_DARK) await shootAll({ width: 1440, height: 900 }, 'dark', '.dark');
  await shootAll({ width: 390, height: 844 }, 'light', '.mobile');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
