// A login the provider signed out stays in Credentials, flagged with a `!` that
// signs it back in; a Claude sign-in about to lapse is flagged the same way.
// Run: node web/credential-signin.browser.test.cjs [screenshot.png]
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

let signedIn = false;
const credentials = () => ({
  credentials: [
    { key: 'login:claude:mats', label: 'claude:mats', provider: 'claude', kind: 'login', account: 'mats',
      signInExpiresAt: Date.now() + 2 * 86_400_000 - 60_000 },
    { key: 'login:codex:personal', label: 'codex:personal', provider: 'codex', kind: 'login', account: 'personal' },
    { key: 'login:claude:personal', label: 'claude:personal', provider: 'claude', kind: 'login', account: 'personal',
      ...(signedIn ? {} : { signedOut: true }) },
  ],
  global: {
    own: { order: ['login:claude:personal', 'login:claude:mats'] },
    enabled: ['login:claude:mats', 'login:codex:personal', ...(signedIn ? ['login:claude:personal'] : [])],
    modes: { 'login:claude:mats': 'on', 'login:codex:personal': 'on' },
  },
});
const accounts = { handles: [], logins: [] };

async function run(scope, local, screenshot) {
  signedIn = false;
  const requests = [];
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 760, height: 260 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://cred.test/**', route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      const base = '/api/organizations/org_personal';
      if (pathname === `${base}/credentials`) return route.fulfill({ json: credentials() });
      if (pathname === `${base}/accounts`) return route.fulfill({ json: accounts });
      if (pathname === `${base}/accounts/connect`) {
        requests.push(['connect', JSON.parse(request.postData())]);
        return route.fulfill({ json: { provider: 'claude', account: 'personal', status: 'awaiting_oauth',
          loginUrl: 'https://claude.ai/oauth/authorize?x=1', requiresCode: true } });
      }
      if (pathname === `${base}/accounts/connect/code`) {
        requests.push(['code', JSON.parse(request.postData())]);
        signedIn = true;
        return route.fulfill({ json: { provider: 'claude', account: 'personal', status: 'logged_in' } });
      }
      const file = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
      if (!fs.existsSync(file)) return route.abort();
      let body = fs.readFileSync(file, 'utf8');
      if (pathname === '/app.js') body = body.replace(/^boot\(\)\.catch\(.*$/m, `
        S.organizationId = 'org_personal';
        document.querySelector('#app').innerHTML = '<main style="padding:16px"><div class="section-h">Credentials</div>'
          + '<div id="cred-editor"></div></main>';
        renderCredentialEditor($('#cred-editor'), ${JSON.stringify(scope)}, { organizationId: 'org_personal'${local ? ", local: true, projectId: 'p1'" : ''} });
      `);
      return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto('http://cred.test/');
    const signedOut = page.locator('.cred-row[data-key="login:claude:personal"]');
    await signedOut.waitFor();
    assert.equal(await page.locator('.cred-row').count(), 3, `${scope}: the signed-out login is listed, not hidden`);
    assert.match(await signedOut.getAttribute('class'), /signed-out/);
    assert.equal(await signedOut.locator('.cred-toggle').count(), 0, 'a signed-out login cannot be toggled on');
    const alert = signedOut.getByRole('button', { name: 'Signed out — click to sign in again' });
    assert.equal(await alert.textContent(), '!');
    const renew = page.locator('.cred-row[data-key="login:claude:mats"]')
      .getByRole('button', { name: 'Sign-in expires in 2 days — click to renew' });
    assert.equal(await renew.textContent(), '!');
    assert.equal(await page.locator('.cred-row[data-key="login:codex:personal"] .cred-signin').count(), 0);
    if (screenshot) await page.screenshot({ path: screenshot });

    await alert.click();
    const flow = page.locator('.cred-login-flow');
    await flow.getByRole('link', { name: 'https://claude.ai/oauth/authorize?x=1' }).waitFor();
    assert.deepEqual(requests[0], ['connect', { provider: 'claude', account: 'personal', browserMcp: 'none', force: true }]);
    await flow.locator('.login-authorization-code').fill('code-123');
    await flow.getByRole('button', { name: 'Submit code' }).click();
    await page.locator('.cred-row[data-key="login:claude:personal"]:not(.signed-out)').waitFor();
    assert.deepEqual(requests[1], ['code', { provider: 'claude', account: 'personal', code: 'code-123' }]);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}

(async () => {
  await run('global', false, process.argv[2]);
  await run('task', true);
  console.log('ok  a signed-out login stays listed with a `!` that signs it back in, in Settings and task forms');
})().catch((error) => { console.error(error); process.exit(1); });
