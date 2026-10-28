// The organization's Roles card: folded, then one role and one category open.
// Usage: APP=http://127.0.0.1:48961 STATE=/tmp/sweep-a/state.json OUT=design/ui-sweep/a-after node design/ui-sweep/shoot-roles.cjs
const { chromium } = require('playwright');
const path = require('node:path');
const APP = process.env.APP || 'http://127.0.0.1:48961';
const OUT = process.env.OUT || 'design/ui-sweep/a-after';
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  for (const [theme, width] of [['light', 1280], ['dark', 390]]) {
    const page = await browser.newPage({ storageState: process.env.STATE || '/tmp/sweep-a/state.json', viewport: { width, height: 1400 }, colorScheme: theme });
    await page.addInitScript((t) => localStorage.setItem('karmax-theme', t), theme);
    await page.goto(`${APP}/personal/settings#settings-people`);
    await page.locator('#organization-roles details').first().waitFor();
    await page.waitForTimeout(1200);
    const card = page.locator('#organization-roles');
    await card.screenshot({ path: path.join(OUT, `roles-folded-${theme}-${width}.png`) });
    await card.evaluate((el) => { el.querySelector('details').open = true; const role = el.querySelectorAll('.authorization-role')[1]; role.open = true; role.querySelector('.role-capability-group').open = true; });
    await card.screenshot({ path: path.join(OUT, `roles-open-${theme}-${width}.png`) });
    await page.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
