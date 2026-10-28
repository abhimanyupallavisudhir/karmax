// Section B (Installation, Profile) screenshots against a scratch tavya seeded by
// design/task-page/seed.cjs: every Installation pane as a full-height element shot,
// light + dark, desktop + 390px phone, and the Profile page.
// FIX=rich overrides a few endpoints so configured states show (GitHub App with a
// missing permission, Stripe Connect from the environment, paid launch half done,
// SMTP connected, Composio set, Phone access ready, two users with an erasure case).
// OPEN=1 shoots with every fold open.
// Usage: APP=http://127.0.0.1:48962 STATE=/tmp/sweep-b/state.json OUT=design/ui-sweep/b-after [FIX=rich] node design/ui-sweep/shoot-b.cjs [filter]
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const APP = process.env.APP || 'http://127.0.0.1:48962';
const STATE = process.env.STATE || '/tmp/sweep-b/state.json';
const OUT = process.env.OUT || 'design/ui-sweep/b-after';
const ONLY = process.argv[2] ? new RegExp(process.argv[2]) : null;
const RICH = process.env.FIX === 'rich';
const now = Date.now();

function rich(pathname, json) {
  if (pathname.endsWith('/github/app')) return { configured: true, appSlug: 'tavya-io', appId: '1234567', oauthConfigured: true,
    webhookConfigured: false, syncMode: 'on-demand', permissionStatus: { ready: false, missingApp: ['actions: write', 'workflows: write'],
      appSettingsUrl: 'https://github.com/settings/apps/tavya-io/permissions' } };
  if (pathname.endsWith('/payments/stripe/platform')) return { ...json, configured: true, secretKeyConfigured: true,
    webhookConfigured: false, clientId: 'ca_PxO2k7Qy1ZbE9', source: 'environment' };
  if (pathname === '/api/connections/config') return { configured: true, canConfigure: true };
  if (pathname === '/api/remote-access') return { ...json, method: 'tailscale', state: 'ready', setupStage: 'ready', url: 'https://ann-laptop.tail1234.ts.net',
    detail: 'Private HTTPS access is on. Only devices allowed by your tailnet can connect.', canSetup: false, canEnable: false, canDisable: true, fallbackCommands: [] };
  if (pathname === '/api/email') return { ...json, configured: true, provider: 'smtp', from: 'tavya <noreply@tavya.io>' };
  if (pathname === '/api/settings/paid-launch') return { ...json, operatorName: 'Ann Author Ltd', operatorCountry: 'United Kingdom',
    contacts: { legal: 'legal@tavya.io', privacy: 'privacy@tavya.io' },
    missing: json.missing.filter((m) => !['Legal entity name', 'Country of establishment', 'Legal email', 'Privacy email'].includes(m)),
    completedTasks: ['business-structure', 'bank-accounting', 'stripe-account'] };
  if (pathname === '/api/users') return [...json, { id: 'Qm3xYv8RkPzT1aBcDeFgHiJk', email: 'bo@example.test', name: 'Bo Builder', role: 'user', createdAt: '2026-09-01T10:00:00Z', grants: [] }];
  if (pathname === '/api/users/Qm3xYv8RkPzT1aBcDeFgHiJk/erasure') return { userId: 'Qm3xYv8RkPzT1aBcDeFgHiJk', identity: null, organizations: [], relatedTaskIds: ['t1'],
    linkedGit: [], gitProfiles: [], automatic: ['sessions', 'identity'], preserved: ['shared tasks'], blockers: [], fingerprint: 'f',
    warning: 'Account closure removes sign-in and access; shared work stays.',
    case: { userId: 'Qm3xYv8RkPzT1aBcDeFgHiJk', state: 'closed', revision: 3, steps: ['identity', 'sessions'], closedAt: now - 86400_000,
      items: [{ id: 'backups', label: 'Record backup expiry and save the suppression manifest outside the restore set.', decision: { outcome: 'retained', evidence: 'Backups expire in 30 days', reviewAt: now - 1000 } },
        { id: 'response', label: 'Record the response to the requester.' }] } };
  if (pathname === '/api/users/erasure-cases') return { requests: [{ userId: 'Qm3xYv8RkPzT1aBcDeFgHiJk', requestedAt: now - 2 * 86400_000 }],
    cases: [{ userId: 'Qm3xYv8RkPzT1aBcDeFgHiJk', state: 'closed', items: [{ decision: { reviewAt: now - 1000 } }], retryRequired: false }] };
  return undefined;
}

async function shoot(browser, { theme, width, suffix }) {
  const context = await browser.newContext({ storageState: STATE, viewport: { width, height: 900 }, colorScheme: theme, deviceScaleFactor: width < 500 ? 2 : 1 });
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    let json;
    try { json = await response.json(); } catch { return route.fulfill({ response }); }
    if (url.pathname === '/api/meta') json = { ...json, hosted: true };
    const override = RICH ? rich(url.pathname, json) : undefined;
    route.fulfill(override ? { response, status: 200, json: override } : { response, json });
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  const save = (name) => path.join(OUT, `${name}.${theme}${suffix}.png`);
  if (!ONLY || !ONLY.test('profile')) {
    await page.goto(`${APP}/installation`);
    await page.locator('#main .settings-nav').waitFor();
    await page.waitForTimeout(2500);
    const links = await page.locator('.settings-nav a[href^="#"]:visible').all();
    for (let i = 0; i < links.length; i++) {
      const id = (await links[i].getAttribute('href')).slice(1);
      if (ONLY && !ONLY.test(id) && !ONLY.test('installation')) continue;
      await page.setViewportSize({ width, height: 900 });
      await links[i].click(); await page.waitForTimeout(700);
      const pane = page.locator(`.settings-pane[data-pane="${id}"]`);
      // OPEN=1 opens every fold, process group and the last user's review.
      if (process.env.OPEN) {
        await pane.evaluate((el) => { el.querySelectorAll('details').forEach((d) => { d.open = true; }); el.querySelectorAll('.proc-toggle[aria-expanded="false"]').forEach((b) => b.click()); });
        const review = pane.locator('[data-erasure-user]').last();
        if (await review.count()) { await review.click(); await page.waitForTimeout(800); }
        if (id === 'installation-appearance') await page.locator('#brand-change').click();
      }
      // The console scrolls inside #main: grow the window to the pane so the shot is whole.
      const box = await pane.evaluate((el) => { el.scrollIntoView(); const r = el.getBoundingClientRect(); return { top: r.top, height: el.scrollHeight }; });
      await page.setViewportSize({ width, height: Math.max(900, Math.ceil(box.top + box.height + 60)) });
      await page.waitForTimeout(200);
      await pane.screenshot({ path: save(id) });
    }
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: save('installation-page') });
  }
  if (!ONLY || ONLY.test('profile')) {
    await page.goto(`${APP}/profile`);
    await page.locator('#main').waitFor();
    await page.waitForTimeout(2500);
    const h = await page.evaluate(() => Math.max(...[...document.querySelectorAll('#main, #main *')].slice(0, 3).map((el) => el.scrollHeight)));
    await page.setViewportSize({ width, height: Math.max(900, h + 120) });
    await page.waitForTimeout(300);
    await page.screenshot({ path: save('profile') });
  }
  await context.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const suffix = `${RICH ? '.rich' : ''}${process.env.OPEN ? '.open' : ''}`;
    for (const theme of (process.env.THEMES || 'light,dark').split(',')) await shoot(browser, { theme, width: 1440, suffix });
    if (process.env.MOBILE !== '0') await shoot(browser, { theme: 'light', width: 390, suffix: `${suffix}.phone` });
  } finally { await browser.close(); }
  console.log(`screens in ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
