// The shipped Avatar editor in a real browser: creating, editing, and failing
// visibly instead of leaving the modal on "Loading…".
// Run: node web/avatars.browser.test.cjs
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://avatars.test/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      const file = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
      if (!fs.existsSync(file)) return route.abort();
      let body = fs.readFileSync(file, 'utf8');
      if (pathname === '/app.js') body = body.replace(/^boot\(\)\.catch\(.*$/m, `
        S.user = { id: 'owner' };
        S.projects = [{ id: 'p1', organizationId: 'o1', name: 'Project' }];
        window.writes = []; window.toasts = [];
        api = async (url, options) => {
          if (options) { writes.push({ url, method: options.method, body: JSON.parse(options.body) }); return { id: 'avatar_new' }; }
          return url.includes('github-accounts') ? { accounts: [] } : [];
        };
        toast = (message, error) => toasts.push({ message, error: !!error });
        loadAvatars = async () => {}; renderMain = () => {};
        window.routes = []; go = async (path) => { routes.push(path); };
        window.openEditor = (avatar) => openAvatarEditor(S.projects[0], avatar);
        window.signIn = (user) => { S.user = user; };
      `);
      return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto('http://avatars.test/');

    // New Avatar: the form renders, defaults to its owner, and creates.
    await page.evaluate(() => openEditor());
    const editor = page.locator('.avatar-editor');
    await editor.getByRole('heading', { name: 'New Avatar' }).waitFor();
    assert.equal(await editor.locator('.loading').count(), 0);
    assert.equal(await page.locator('#avatar-call-mode').inputValue(), 'me');
    assert.equal(await page.locator('#avatar-callers').isHidden(), true);
    await page.fill('#avatar-name', 'Atlas');
    await page.fill('#avatar-prompt', 'Exercise my judgment.');
    await editor.getByRole('button', { name: 'Create Avatar' }).click();
    await page.waitForFunction(() => !document.querySelector('.avatar-editor-overlay'));
    const [created] = await page.evaluate(() => writes);
    assert.equal(created.url, '/api/projects/p1/avatars');
    assert.equal(created.method, 'POST');
    assert.deepEqual(created.body.callableBy, ['user:owner']);
    assert.equal(created.body.authorityMode, 'full');
    assert.deepEqual(await page.evaluate(() => toasts), [{ message: 'Avatar created', error: false }]);
    // The new Avatar opens at its own URL.
    assert.match((await page.evaluate(() => routes))[0], /\/avatars\/avatar_new$/);

    // Single-user installations identify the signed-in user by a bare id.
    await page.evaluate(() => { signIn('me'); openEditor(); });
    await editor.getByRole('heading', { name: 'New Avatar' }).waitFor();
    await page.fill('#avatar-name', 'Local');
    await page.fill('#avatar-prompt', 'Local work.');
    await editor.getByRole('button', { name: 'Create Avatar' }).click();
    await page.waitForFunction(() => writes.length === 2);
    assert.deepEqual((await page.evaluate(() => writes))[1].body.callableBy, ['user:me']);
    await page.waitForFunction(() => !document.querySelector('.avatar-editor-overlay'));

    // Existing Avatars with specific callers keep them editable.
    await page.evaluate(() => openEditor({ id: 'avatar_x', ownerUserId: 'owner', name: 'Scout', prompt: 'Scout.',
      promptVersion: 1, enabled: true, authorityMode: 'full', callableBy: ['user:owner', '@team:eng'], roles: [],
      runtime: { provider: 'codex' } }));
    await editor.getByRole('heading', { name: 'Edit Avatar' }).waitFor();
    assert.equal(await page.locator('#avatar-call-mode').inputValue(), 'specific');
    assert.equal(await page.locator('#avatar-callers').inputValue(), 'user:owner, @team:eng');
    await editor.getByRole('button', { name: 'Close' }).click();

    // A rendering failure closes the modal and reports the error.
    await page.evaluate(() => { toasts.length = 0; });
    await page.evaluate(() => openEditor({ id: 'avatar_bad', ownerUserId: 'owner', name: 'Broken', prompt: 'x',
      authorityMode: 'restricted', callableBy: ['@project'], roles: [], runtime: { provider: 'codex' } }));
    assert.equal(await page.locator('.avatar-editor-overlay').count(), 0);
    const toasts = await page.evaluate(() => toasts);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].error, true);

    assert.deepEqual(errors, []);
    console.log('Avatar editor regressions passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
