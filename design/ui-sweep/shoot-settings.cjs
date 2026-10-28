// Full-height screenshots of every organization and project settings pane against a
// scratch tavya seeded by design/task-page/seed.cjs. One PNG per pane, theme and width.
// Usage: APP=http://127.0.0.1:48961 STATE=/tmp/sweep-a/state.json OUT=design/ui-sweep/a-before \
//   node design/ui-sweep/shoot-settings.cjs [pane-filter]
// THEMES=light,dark (default both); WIDTHS=1280,390 (default both); HOSTED=0 shows the self-hosted build.
// FIXTURES=1 answers a few reads with filled-in data (computers, password managers, payments, events)
// and OPEN=1 also opens every fold in the pane, so the states an empty scratch app lacks are seen too.
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
const FIXTURES = !!process.env.FIXTURES;
const OPEN = !!process.env.OPEN;
const now = Date.now();
const fixtures = {
  '/world-providers': [{ provider: 'e2b', status: 'ready', enabled: true, credentialConfigured: true, config: {}, limits: { cpu: 8, memoryMb: 8192, diskGb: 29 } },
    { provider: 'hetzner', managed: true, status: 'ready', enabled: true, credentialConfigured: true, config: {} },
    { provider: 'daytona', status: 'error', enabled: true, credentialConfigured: true, lastError: 'Daytona connection failed: 401', config: {} }],
  '/api/vault/connectors': [{ name: 'onepassword', label: '1Password', available: true, canPush: false, canUpdate: true, detail: 'ready', config: { lastSync: { count: 42 } } },
    { name: 'bitwarden', label: 'Bitwarden', available: false, canPush: true, detail: 'Needs the Bitwarden bw CLI on the server.' },
    { name: 'pass-git', label: 'unix pass (Git)', setup: 'git-pass', available: true, canPush: true, detail: 'connected to github.com/me/store', config: { autoSync: { enabled: true, importNew: true } } }],
  '/payments/requests': [{ id: 'r1', amount: 1999, currency: 'usd', merchant: 'aws.amazon.com', status: 'pending_approval', why: 'Buy a domain for the staging site' }],
  '/payments/transactions': Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, amount: 500 + i * 100, currency: 'usd', merchant: 'stripe.com', status: i ? 'succeeded' : 'failed', provider: 'vault-card', createdAt: now - i * 3600_000 })),
  '/webhooks': { urlBase: 'http://127.0.0.1/api/hooks/', webhooks: [{ id: 'hook_1', name: 'Sentry', type: 'sentry.alert', deliveries: 3, lastDeliveryAt: now - 600_000 }] },
  '/events': Array.from({ length: 4 }, (_, i) => ({ id: `e${i}`, type: i % 2 ? 'github.pull_request.opened' : 'sentry.alert', source: i % 2 ? 'github' : 'webhook:hook_1',
    subject: i % 2 ? 'https://github.com/acme/web/pull/12' : 'TypeError in checkout', receivedAt: now - i * 900_000, payload: { level: 'error' } })),
};
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
    if (FIXTURES) await context.route('**/api/**', async (route) => {
      const { pathname } = new URL(route.request().url());
      const key = route.request().method() === 'GET' && Object.keys(fixtures).find((suffix) => pathname.endsWith(suffix));
      return key ? route.fulfill({ json: fixtures[key] }) : route.fallback();
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
        if (OPEN) await page.evaluate(() => document.querySelectorAll('.settings-pane.active details:not(.computer-add)').forEach((d) => { d.open = true; }));
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
