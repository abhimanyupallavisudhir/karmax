// Real browser regression: "Different branches per repo" under Base/Target in
// the task form and Task defaults — drawing, live following, collecting.
// SCREENSHOT=<path> also saves an image of the expanded rows for review.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = __dirname;
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 520 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async route => {
      const p = new URL(route.request().url()).pathname;
      if (p.startsWith('/api/')) return route.fulfill({ json: {} });
      const file = path.join(root, p === '/' ? 'index.html' : p);
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.abort();
      let body = fs.readFileSync(file, 'utf8');
      if (p === '/app.js') body = body.replace(/^boot\(\)\.catch\(.*$/m,
        'window.rb = { S, renderFields, collectForm, installRepoBranchSync }; installRepoBranchSync();');
      return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto('http://repo-branches.test/');
    await page.waitForFunction(() => window.rb);

    const fields = [
      { name: 'base', type: 'branch', label: 'Base (branch-from) branch', scopes: ['task'] },
      { name: 'target', type: 'branch', label: 'Target (merge-to) branch', scopes: ['task'] },
      { name: 'repoBranches', type: 'repoBranches', label: 'Different branches per repo', help: 'Each repository its own branches.', scopes: ['task'] },
      { name: 'worldProvider', type: 'select', label: 'Agent environment', options: ['', 'e2b'], scopes: ['task'] },
    ];
    const pair = (base, target = base) => ({ base, target });
    const repos = {
      'git@github.com:acme/app.git': pair('main'),
      'git@github.com:acme/lib.git': pair('master'),
      'git@github.com:acme/docs.git': pair('main'),
      'git@github.com:acme/web.git': pair('main'),
    };
    const inherited = { base: 'main', target: 'main', worldProvider: 'e2b', repoBranches: repos };
    const render = (own, inh = inherited) => page.evaluate(({ fields, own, inh }) => {
      document.querySelector('#app').innerHTML = `<main id="main" style="padding:24px;max-width:900px"><div id="form" class="wf-form parameter-fields">${window.rb.renderFields(fields, own, inh)}</div></main>`;
    }, { fields, own, inh });
    const collect = () => page.evaluate((fields) => window.rb.collectForm(document.querySelector('#form'), fields), fields);
    const visibleRows = () => page.locator('.rb-extra:visible').count();
    const toggle = page.getByLabel('Different branches per repo');
    const input = (repo, key) => page.locator(`[data-rb-repo="git@github.com:acme/${repo}.git"][data-rb-key="${key}"]`);

    // A master repository among main ones: the list starts open and shows it.
    await render({});
    assert.equal(await toggle.isChecked(), true);
    assert.equal(await visibleRows(), 6, 'three more repositories × base and target');
    assert.equal(await input('lib', 'base').inputValue(), 'master');
    assert.equal(await page.locator('.rb-repo:visible').first().textContent(), 'app');
    assert.equal(await page.locator('[data-row="worldProvider"] select').count(), 1, 'one Agent environment');
    assert.deepEqual(await collect(), {}, 'untouched: keeps inheriting');
    if (process.env.SCREENSHOT) await page.locator('#main').screenshot({ path: process.env.SCREENSHOT });

    // A changed row base takes its untouched target along; others are untouched.
    await input('docs', 'base').fill('develop');
    assert.equal(await input('docs', 'target').inputValue(), 'develop');
    assert.deepEqual((await collect()).repoBranches, {
      'git@github.com:acme/lib.git': pair('master'), 'git@github.com:acme/docs.git': pair('develop'),
    });

    // Untouched rows follow the first repository's base; the rows are stored as shown.
    await page.locator('[data-field="base"]').fill('trunk');
    assert.equal(await input('web', 'base').inputValue(), 'trunk');
    assert.equal(await input('web', 'target').inputValue(), 'main');
    assert.equal(await input('lib', 'base').inputValue(), 'master');
    const changed = await collect();
    assert.equal(changed.base, 'trunk');
    assert.deepEqual(changed.repoBranches, {
      'git@github.com:acme/lib.git': pair('master'), 'git@github.com:acme/docs.git': pair('develop'),
    });

    // Unticking hides the rows and means the same branches everywhere.
    await toggle.uncheck();
    assert.equal(await visibleRows(), 0);
    assert.equal(await page.locator('.rb-repo:visible').count(), 0);
    assert.deepEqual((await collect()).repoBranches, {});

    // Same branches everywhere: closed; ticking without edits stores nothing.
    const same = { ...inherited, repoBranches: { ...repos, 'git@github.com:acme/lib.git': pair('main') } };
    await render({}, same);
    assert.equal(await toggle.isChecked(), false);
    assert.equal(await visibleRows(), 0);
    await toggle.check();
    assert.equal(await visibleRows(), 6);
    assert.deepEqual(await collect(), {});
    await input('web', 'target').fill('release');
    assert.deepEqual((await collect()).repoBranches, { 'git@github.com:acme/web.git': pair('main', 'release') });

    // A saved value is the whole answer: an explicit {} keeps the list closed.
    await render({ repoBranches: {} });
    assert.equal(await toggle.isChecked(), false);
    assert.deepEqual(await collect(), { repoBranches: {} }, 'kept: it overrides the inherited rows');
    await render({ repoBranches: { 'https://github.com/acme/web': { base: 'gh-pages' } } }, same);
    assert.equal(await toggle.isChecked(), true);
    assert.equal(await input('web', 'base').inputValue(), 'gh-pages');
    assert.equal(await input('web', 'target').inputValue(), 'gh-pages');

    // One repository: nothing to choose.
    await render({}, { ...inherited, repoBranches: { 'git@github.com:acme/app.git': pair('main') } });
    assert.equal(await page.locator('[data-ftype="repoBranches"]').count(), 0);
    assert.equal(await page.locator('[data-field="base"]').inputValue(), 'main');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
