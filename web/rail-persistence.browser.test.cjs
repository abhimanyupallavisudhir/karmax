// Real browser interaction and reload coverage for the shipped sidebar functions.
// Run: node web/rail-persistence.browser.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
function fn(name) {
  const start = src.indexOf(`function ${name}(`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`Missing function ${name}`);
}
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.route('http://rail.test/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="rail"></div>' }));
    const boot = async () => {
      await page.goto('http://rail.test/');
      await page.addStyleTag({ content: '#rail { height: 220px; overflow: auto; } .proj { height: 40px; }' });
      await page.evaluate(() => {
        window.$ = s => document.querySelector(s);
        window.S = { organizationId: 'o1', projectId: 'loose', tab: 'tasks', projects: [
          { id: 'nested', name: 'Nested', folder: 'work/clients', organizationId: 'o1' },
          ...Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, name: `Project ${i}`, folder: 'work', organizationId: 'o1' })),
          { id: 'other', name: 'Other', folder: 'work', organizationId: 'o2' },
        ] };
        window.PROJECT_SCOPED_TABS = ['tasks'];
        window.ICON = {};
        window.draggingProject = window.editingRailItem = null;
        window.esc = s => String(s ?? '');
        window.projectPath = p => [p.folder, p.name].filter(Boolean).join('/');
        window.projectRoute = id => `/projects/${id}`;
        window.globalRoute = tab => `/${tab}`;
        window.commandHint = s => s;
        window.wireProjectDrag = () => {};
      });
      await page.addScriptTag({ content: ['railCollapsedFolders', 'saveRailCollapsedFolders', 'toggleRailFolder', 'renameCollapsedRailFolder', 'railProjectRows', 'renderRail'].map(fn).join('\n') });
      await page.evaluate(() => renderRail());
    };
    const folder = p => page.locator(`.folder-toggle[data-folder="${p}"]`);
    await boot();
    await folder('work/clients').click();
    await folder('work').click();
    await boot(); // New document and JS state, same browser storage.
    assert.equal(await folder('work').getAttribute('aria-expanded'), 'false');
    await folder('work').click();
    await boot(); // Explicit expansion also survives reload.
    assert.equal(await folder('work').getAttribute('aria-expanded'), 'true');
    assert.equal(await folder('work/clients').getAttribute('aria-expanded'), 'false');
    await page.evaluate(() => { S.organizationId = 'o2'; renderRail(); });
    assert.equal(await folder('work').getAttribute('aria-expanded'), 'true');
    await page.evaluate(() => { S.organizationId = 'o1'; S.tab = 'dashboard'; renderRail(); });
    assert.equal(await folder('work/clients').getAttribute('aria-expanded'), 'false');
    await page.locator('#project-search').fill('Project');
    await folder('work').click();
    assert.equal(await folder('work').getAttribute('aria-expanded'), 'false', 'search must respect a folder collapse');
    await page.locator('#project-search').fill('');
    assert.equal(await folder('work').getAttribute('aria-expanded'), 'false');
    await folder('work').click();
    await page.evaluate(() => { $('#rail').scrollTop = 500; renderRail(); });
    assert.equal(await page.evaluate(() => $('#rail').scrollTop), 500, 'refresh retains sidebar scroll');
    await page.evaluate(() => {
      localStorage.setItem('karmax-rail-folders:o1', '[null,4,"work/clients"]');
      renameCollapsedRailFolder('work', 'renamed');
    });
    assert.deepEqual(await page.evaluate(() => [...railCollapsedFolders()]), ['renamed/clients']);
    await page.evaluate(() => {
      Storage.prototype.setItem = () => { throw new Error('Storage unavailable'); };
      toggleRailFolder('work');
      renderRail();
    });
    assert.equal(await folder('work').getAttribute('aria-expanded'), 'false', 'storage failure must not discard the current choice');
    await page.evaluate(() => { S.organizationId = 'o2'; renderRail(); });
    assert.equal(await folder('work').getAttribute('aria-expanded'), 'true');
    await page.evaluate(() => { S.organizationId = 'o1'; renderRail(); });
    assert.equal(await folder('work').getAttribute('aria-expanded'), 'false');
    await folder('work').click();
    assert.equal(await folder('work').getAttribute('aria-expanded'), 'true', 'fallback supports expanding again');
    await boot();
    for (const invalid of ['null', '{}', '"work"', '{bad json']) {
      await page.evaluate(value => { localStorage.setItem('karmax-rail-folders:o1', value); renderRail(); }, invalid);
      assert.equal(await folder('work').getAttribute('aria-expanded'), 'true');
    }
    console.log('Sidebar persistence browser checks passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
