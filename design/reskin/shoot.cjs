// Screens of the console's two looks (default, classic) in light and dark,
// against a scratch tavya seeded by design/task-page/seed.cjs (mock agent).
// Usage: APP=http://127.0.0.1:48950 OUT=/tmp/shots/reskin node design/reskin/shoot.cjs [page-filter] [look-filter]
// The look is forced per shot (the installation's own setting is untouched).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const APP = process.env.APP || 'http://127.0.0.1:48950';
const STATE = process.env.STATE || '/tmp/shots/state.json';
const OUT = process.env.OUT || '/tmp/shots/reskin';
const ONLY = process.argv[2] ? new RegExp(process.argv[2]) : null;
const LOOKS = process.argv[3] ? new RegExp(process.argv[3]) : null;
const seed = fs.existsSync('/tmp/shots/seed.json') ? JSON.parse(fs.readFileSync('/tmp/shots/seed.json', 'utf8')) : { slug: 'video-studio', num: 2 };
const P = `/personal/${seed.slug || 'video-studio'}`;
const PAGES = [
  ['home', '/personal'],
  ['tasks', P],
  ['task', `${P}/tasks/${seed.num}`],
  ['settings', `${P}/settings`],
  ['insights', '/personal/insights'],
  ['installation', '/installation'],
  ['profile', '/profile'],
];
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  for (const skin of ['', 'classic']) for (const scheme of ['light', 'dark']) {
    const look = `${skin || 'default'}-${scheme}`;
    if (LOOKS && !LOOKS.test(look)) continue;
    const context = await browser.newContext({ storageState: STATE, viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    await context.addInitScript((value) => { localStorage.setItem('karmax-skin', value); localStorage.removeItem('karmax-theme'); }, skin);
    await context.route('**/api/meta', async (route) => {
      const response = await route.fetch();
      route.fulfill({ response, json: { ...(await response.json()), hosted: true, skin } });
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error('pageerror', e.message));
    for (const [name, url] of PAGES) {
      if (ONLY && !ONLY.test(name)) continue;
      await page.goto(`${APP}${url}`);
      await page.locator('#main').waitFor();
      await page.waitForTimeout(2000);
      await page.screenshot({ path: path.join(OUT, `${name}--${look}.png`) });
    }
    await context.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
