// A login the provider signed out stays in Credentials with a working Sign in,
// and a Claude sign-in about to lapse offers a renewal first.
// Run: node web/credential-signin.browser.test.cjs [screenshot.png]
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const credentials = {
  credentials: [
    { key: 'login:claude:mats', label: 'claude:mats', provider: 'claude', kind: 'login', account: 'mats',
      signInExpiresAt: Date.now() + 2 * 86_400_000 - 60_000 },
    { key: 'login:codex:personal', label: 'codex:personal', provider: 'codex', kind: 'login', account: 'personal' },
    { key: 'login:claude:personal', label: 'claude:personal', provider: 'claude', kind: 'login', account: 'personal', signedOut: true },
  ],
  global: {
    own: { order: ['login:claude:personal', 'login:claude:mats'] },
    enabled: ['login:claude:mats', 'login:codex:personal'],
    modes: { 'login:claude:mats': 'on', 'login:codex:personal': 'on' },
  },
};
const accounts = { handles: [], logins: [
  { provider: 'claude', account: 'mats', loggedIn: true, key: 'login:claude:mats' },
  { provider: 'claude', account: 'personal', loggedIn: false, key: 'login:claude:personal' },
  { provider: 'codex', account: 'personal', loggedIn: true, key: 'login:codex:personal' },
] };

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 760, height: 260 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://cred.test/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/organizations/org_personal/credentials') return route.fulfill({ json: credentials });
      if (pathname === '/api/organizations/org_personal/accounts') return route.fulfill({ json: accounts });
      const file = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
      if (!fs.existsSync(file)) return route.abort();
      let body = fs.readFileSync(file, 'utf8');
      if (pathname === '/app.js') body = body.replace(/^boot\(\)\.catch\(.*$/m, `
        S.organizationId = 'org_personal';
        window.connects = [];
        document.querySelector('#app').innerHTML = '<main style="padding:16px"><div class="section-h">Credentials</div>'
          + '<div id="cred-editor-global"></div>'
          + '<div style="margin-top:14px;display:flex;gap:6px"><select id="login-provider"><option value="claude">Claude</option><option value="codex">Codex</option></select>'
          + '<input id="login-name" placeholder="account"><button class="btn sm" id="login-connect">Connect</button></div></main>';
        $('#login-connect').addEventListener('click', () => connects.push([$('#login-provider').value, $('#login-name').value]));
        renderCredentialEditor($('#cred-editor-global'), 'global', { organizationId: 'org_personal' });
      `);
      return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto('http://cred.test/');
    const signedOut = page.locator('.cred-row[data-key="login:claude:personal"]');
    await signedOut.waitFor();
    assert.equal(await page.locator('.cred-row').count(), 3, 'the signed-out login is listed, not hidden');
    assert.match(await signedOut.getAttribute('class'), /signed-out/);
    assert.equal(await signedOut.locator('.cred-toggle').count(), 0, 'a signed-out login cannot be toggled on');
    const signIn = signedOut.getByRole('button', { name: 'Sign in' });
    assert.match(await signIn.getAttribute('title'), /signed out/i);
    if (process.argv[2]) await page.screenshot({ path: process.argv[2] });

    await page.selectOption('#login-provider', 'codex');
    await signIn.click();
    assert.deepEqual(await page.evaluate(() => connects), [['claude', 'personal']],
      'Sign in starts the ordinary connect flow for that exact login');
    const renew = page.locator('.cred-row[data-key="login:claude:mats"]').getByRole('button', { name: 'Renew' });
    assert.equal(await renew.getAttribute('title'), 'Sign-in expires in 2 days — renew it to keep this login working');
    assert.equal(await page.locator('.cred-row[data-key="login:codex:personal"] .cred-signin').count(), 0);
    await renew.click();
    assert.deepEqual(await page.evaluate(() => connects), [['claude', 'personal'], ['claude', 'mats']]);
    assert.deepEqual(errors, []);
    console.log('ok  a signed-out login stays listed with a working Sign in; a lapsing one offers Renew');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
