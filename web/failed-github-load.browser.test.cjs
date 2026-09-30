// UI-12: a failed GitHub read shows the failure and a Retry, never the
// "Connect GitHub" setup a missing connection gets.
// Run: node web/failed-github-load.browser.test.cjs
const assert = require('node:assert/strict');
const { fakeConsole, launch, reply } = require('../tests/helpers/fake-console.cjs');

(async () => {
  const browser = await launch();
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const project = { id: 'p', organizationId: 'o', name: 'Workspace', config: {} };
    let failing = true;
    const { requests } = await fakeConsole(context, { project, api(p) {
      if (p === '/api/organizations/o/github/app') return failing ? reply(503, { error: 'GitHub is unavailable' }) : { configured: true };
      return undefined;
    } });
    context.setDefaultTimeout(8000);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => { errors.push(error.message); console.error('page:', error.message); });
    await page.goto('http://console.test/org/settings#settings-code');
    const pane = page.locator('#org-github');
    await pane.getByText('Couldn’t load this section.').waitFor();
    assert.equal(await pane.locator('#connect-github').count(), 0, 'a failed read is not mistaken for a missing connection');

    failing = false;
    const reads = () => requests.filter((request) => request === 'GET /api/organizations/o/github/app').length;
    const before = reads();
    await pane.getByRole('button', { name: 'Retry' }).click();
    await pane.locator('#connect-github').waitFor();
    assert.ok(reads() > before, 'Retry reads GitHub again');
    assert.deepEqual(errors, []);
    console.log('Failed GitHub load: ok');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exit(1); });
