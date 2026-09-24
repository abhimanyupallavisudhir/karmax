// Real DOM coverage for model reuse, including serialization and stale requests.
// Run: node web/agent-fork-model.browser.test.cjs
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.startsWith('/api/')) return route.fulfill({ json: [] });
      const file = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.abort();
      let body = fs.readFileSync(file, 'utf8');
      if (pathname === '/app.js') body = body.replace(/^boot\(\)\.catch\(.*$/m, `window.forkTest = { S, renderAgentField, wireAgentBox, readAgentSpec,
        pick: (selection) => window.forkPicker.onPick(selection),
        setup: () => { openTaskPicker = (config) => { window.forkPicker = config; }; },
        defer: () => { api = () => new Promise(resolve => { window.resolveSource = resolve; }); }
      };`);
      return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto('http://fork.test/');
    await page.waitForFunction(() => window.forkTest);
    const source = { id: 'source', num: 42, title: 'Source', projectId: 'p1', params: {} };
    const original = { provider: 'claude', model: 'claude-opus-4-6', effort: 'max' };
    const copied = { provider: 'codex', model: 'gpt-6-sol', effort: 'high' };
    await page.evaluate(({ source, original }) => {
      const t = window.forkTest;
      t.setup(); t.S.tasks = [source]; t.S.projects = [{ id: 'p1' }];
      t.S.meta = { hostLocal: true }; t.S.avatars = [];
      document.querySelector('#app').innerHTML = t.renderAgentField({ role: 'do' }, original, {});
      t.wireAgentBox(document.querySelector('.agent-field'));
      document.querySelector('.agent-field').addEventListener('change', () => { window.saved = t.readAgentSpec(document.querySelector('.agent-field')); });
    }, { source, original });
    const read = () => page.evaluate(() => window.forkTest.readAgentSpec(document.querySelector('.agent-field')));
    const pick = async (role = 'do', session = copied) => {
      await page.locator('.af-resume-pick').click();
      await page.evaluate(({ source, role, session }) => window.forkTest.pick({ task: source, role, session }), { source, role, session });
    };
    const reuse = page.locator('.af-resume-reuse-model');
    const pointer = role => ({ resumeFrom: { taskId: source.id, role } });
    await page.locator('.af-resume-enabled').check();
    await pick('merge');
    await reuse.waitFor();
    assert.equal(await reuse.isChecked(), false);
    assert.deepEqual(await read(), { ...original, ...pointer('merge') });
    await reuse.check();
    assert.deepEqual(await read(), { ...copied, ...pointer('merge') });
    assert.deepEqual(await page.evaluate(() => window.saved), await read(), 'copied fields reach autosave');
    await reuse.uncheck();
    assert.deepEqual(await read(), { ...original, ...pointer('merge') });
    await reuse.check();
    await page.locator('.af-resume-clear').click();
    assert.deepEqual(await read(), original, 'clearing restores original controls');
    await pick('confirm', { provider: 'codex', model: 'gpt-6-sol' });
    await reuse.check();
    assert.deepEqual(await read(), { provider: 'codex', model: 'gpt-6-sol', ...pointer('confirm') }, 'absent effort clears previous effort');
    await pick('do', { provider: 'opencode' });
    assert.deepEqual(await read(), { ...original, ...pointer('do') }, 'switching source withdraws copied values');
    await reuse.check();
    assert.deepEqual(await read(), { provider: 'opencode', ...pointer('do') }, 'absent model clears previous model');
    await page.locator('.af-resume-enabled').uncheck();
    assert.deepEqual(await read(), original);
    await page.locator('.af-resume-enabled').check();
    await pick();
    await reuse.check();
    await page.locator('.af-model').fill('gpt-6-astra');
    assert.equal(await reuse.isChecked(), false, 'manual edits release the reuse selection');
    await page.locator('.af-resume-clear').click();
    assert.equal((await read()).model, 'gpt-6-astra', 'clearing preserves manual edits');
    // A prefilled fork has no cached picker session; fetch the selected role.
    await page.evaluate(({ source, original }) => {
      const t = window.forkTest;
      document.querySelector('#app').innerHTML = t.renderAgentField({ role: 'do' }, { ...original, resumeFrom: { taskId: source.id, role: 'confirm' } }, {});
      t.S.tasks = []; // Archived source is absent from the current task list.
      t.wireAgentBox(document.querySelector('.agent-field')); t.defer();
    }, { source, original });
    await reuse.check();
    await page.evaluate(copied => window.resolveSource({ do: { provider: 'opencode' }, confirm: copied }), copied);
    await page.waitForFunction(() => document.querySelector('.af-provider').value === 'codex');
    assert.deepEqual(await read(), { ...copied, ...pointer('confirm') });
    await reuse.uncheck();
    await reuse.check();
    await page.locator('.af-resume-clear').click();
    await page.evaluate(copied => window.resolveSource({ confirm: copied }), copied);
    assert.deepEqual(await read(), original, 'late source fetch cannot change a cleared fork');
    await pick('confirm', null);
    await reuse.check();
    await page.evaluate(() => window.resolveSource({}));
    await page.waitForFunction(() => !document.querySelector('.af-resume-reuse-model').checked);
    assert.deepEqual(await read(), { ...original, ...pointer('confirm') }, 'missing metadata leaves the selection intact');
    assert.match(await page.locator('.toast.err').last().innerText(), /unavailable/);
    // An Avatar otherwise overrides manual model fields when serialized.
    await page.evaluate(({ original }) => {
      const t = window.forkTest;
      t.S.avatars = [{ id: 'avatar', name: 'Writer', ownerUserId: 'owner', callable: true, effectiveEnabled: true, runtime: original }];
      document.querySelector('#app').innerHTML = t.renderAgentField({ role: 'do' }, { ...original, avatarId: 'avatar' }, {});
      t.wireAgentBox(document.querySelector('.agent-field'));
    }, { original });
    await page.locator('.af-resume-enabled').check();
    await pick();
    await reuse.check();
    assert.deepEqual(await read(), { ...copied, ...pointer('do') }, 'reuse takes precedence over a destination Avatar');
    assert.equal(await page.locator('.agent-controls').isVisible(), true);
    await reuse.uncheck();
    assert.deepEqual(await read(), { ...original, avatarId: 'avatar', ...pointer('do') }, 'unchecking restores the Avatar');
    assert.deepEqual(errors, []);
    console.log('PASS: model reuse copies and serializes exact role settings; undo, missing values, manual edits, and stale responses');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
