// Screenshots of the Passwords card's vault manager against fixture items (no server).
// Usage: node design/vault/shoot.cjs [outDir] — writes card.png, manager.png, selected.png,
// manager-dark.png and manager-phone.png.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const WEB = path.join(__dirname, '..', '..', 'web');
const OUT = process.argv[2] || path.join(__dirname, 'after');
const items = [
  { id: 'vi_gh', type: 'login', label: 'GitHub — alice', username: 'alice', domains: ['github.com'], fields: ['password', 'totp'], policy: { use: 'auto', reveal: 'ask' }, provenance: { source: 'connector:pass' } },
  { id: 'vi_oa', type: 'api-key', label: 'OpenAI', envVar: 'OPENAI_API_KEY', domains: ['platform.openai.com'], fields: ['secret'], policy: { use: 'auto', reveal: 'never' } },
  { id: 'vi_st', type: 'login', label: 'Stripe dashboard', username: 'ops@acme.test', domains: ['dashboard.stripe.com'], fields: ['password'], policy: { use: 'ask', reveal: 'ask' }, tags: ['billing'] },
  { id: 'vi_ssh', type: 'ssh-key', label: 'Deploy key — prod', envVar: 'DEPLOY_KEY', fields: ['privateKey'], policy: { use: 'auto', reveal: 'never' } },
  { id: 'vi_env', type: 'env', label: 'Staging .env', fields: ['env'], policy: { use: 'auto', reveal: 'ask' }, provenance: { source: 'import:bitwarden' } },
  { id: 'vi_gs', type: 'session', label: 'Google — alice@acme.test', domains: ['accounts.google.com'], fields: [], policy: { use: 'auto', reveal: 'never' }, exclusive: true, provenance: { source: 'task:t1' } },
  { id: 'vi_aws', type: 'api-key', label: 'AWS — billing read-only', envVar: 'AWS_ACCESS_KEY_ID', fields: ['secret'], policy: { use: 'auto', reveal: 'ask' } },
  { id: 'vi_note', type: 'note', label: 'Recovery codes', fields: ['note'], policy: { use: 'ask', reveal: 'never' } },
];
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  for (const [name, viewport, scheme] of [['', { width: 1280, height: 860 }, 'light'], ['-dark', { width: 1280, height: 860 }, 'dark'], ['-phone', { width: 390, height: 800 }, 'light']]) {
    const page = await browser.newPage({ viewport, colorScheme: scheme });
    page.on('pageerror', (e) => console.error('pageerror', e.message));
    await page.route('http://vault.test/**', (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === '/api/vault/items') return route.fulfill({ json: items });
      if (pathname.startsWith('/api/')) return route.fulfill({ json: [] });
      const file = path.join(WEB, pathname === '/' ? 'index.html' : pathname);
      if (!fs.existsSync(file)) return route.abort();
      let body = fs.readFileSync(file, 'utf8');
      if (pathname === '/app.js') body = body.replace(/^boot\(\)\.catch\(.*$/m, `
        S.organizationId = 'org_personal';
        document.documentElement.dataset.theme = '${scheme}';
        document.querySelector('#app').innerHTML = '<main style="padding:24px;max-width:960px;margin:auto">' + passwordsCard() + '</main>';
        wireVaultCards('org_personal'); bindKeys();`);
      return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto('http://vault.test/');
    await page.locator('#vault-manage-open:not([disabled])').waitFor();
    if (!name) await page.locator('#vault-card').screenshot({ path: path.join(OUT, 'card.png') });
    await page.locator('#vault-manage-open').click();
    await page.getByRole('dialog', { name: 'Vault credentials' }).waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, `manager${name}.png`) });
    if (!name) {
      const picks = page.locator('.vault-manage-pick');
      if (await picks.count()) {
        await picks.nth(1).check(); await picks.nth(3).check(); await picks.nth(6).check();
        await page.screenshot({ path: path.join(OUT, 'selected.png') });
      }
    }
    await page.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
