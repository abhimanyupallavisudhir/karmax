// Render the organization storage page's over-limit note and "What's using
// space" list, and the storage inbox notice, from the real app.js functions
// in Chromium. Run: node web/storage.browser.test.cjs
// STORAGE_SCREENSHOT=<file> also saves a screenshot.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
function fn(name) {
  const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  if (start < 0) throw new Error(`Missing function: ${name}`);
  let parens = 0, open = -1;
  for (let i = src.indexOf('(', start); i < src.length; i++) {
    if (src[i] === '(') parens++;
    else if (src[i] === ')') parens--;
    else if (src[i] === '{' && parens === 0) { open = i; break; }
  }
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`Unterminated function: ${name}`);
}

const NOW = Date.parse('2026-10-01T12:00:00Z');
const GB = 1024 ** 3;
const MB = 1024 ** 2;
const CONTENTS = {
  retainedBytes: 6.2 * GB, quotaBytes: 5 * GB,
  overQuota: { since: NOW - 10 * 86_400_000, deleteAt: Date.parse('2027-09-21T12:00:00Z') },
  policy: { finishedTaskCheckpointDays: 30, overQuotaDeletionDays: 365 },
  projects: [
    { projectId: 'p-ml', name: 'Model training', bytes: 5.1 * GB,
      resources: [{ id: 'r-weights', name: 'weights', currentBytes: 2 * GB, olderVersions: 3, olderBytes: 2.9 * GB, taskCopies: 1, taskCopyBytes: 120 * MB }],
      artifacts: { count: 0, bytes: 0 }, checkpoints: { count: 4, bytes: 80 * MB, finishedCount: 3, finishedBytes: 60 * MB } },
    { projectId: 'p-web', name: 'Storefront', bytes: 1.1 * GB,
      resources: [{ id: 'r-fixtures', name: 'fixtures', currentBytes: 900 * MB, olderVersions: 0, olderBytes: 0, taskCopies: 0, taskCopyBytes: 0 }],
      artifacts: { count: 2, bytes: 200 * MB }, checkpoints: { count: 0, bytes: 0, finishedCount: 0, finishedBytes: 0 } },
    { projectId: 'p-empty', name: 'Empty', bytes: 0, resources: [], artifacts: { count: 0, bytes: 0 }, checkpoints: { count: 0, bytes: 0, finishedCount: 0, finishedBytes: 0 } },
  ],
};

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 760, height: 620 }, locale: 'en-US', timezoneId: 'UTC' });
    await page.route('http://storage.test/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.startsWith('/fonts/')) return route.fulfill({ body: fs.readFileSync(path.join(__dirname, pathname)), contentType: 'font/woff2' });
      return route.fulfill({ body: '<!doctype html><html data-theme="light"><body><main class="main"><div class="main-inner" style="padding:16px"><div class="card"><div class="section-h" id="settings-storage">Data storage</div><div id="org-storage"></div></div></div></main></body></html>', contentType: 'text/html' });
    });
    await page.goto('http://storage.test/');
    await page.clock.setFixedTime(new Date(NOW));
    await page.addStyleTag({ path: path.join(__dirname, 'styles.css') });
    await page.evaluate(() => {
      window.esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    });
    await page.addScriptTag({ content: ['formatBytes', 'policyTip', 'storageOverQuotaMarkup', 'storageContentsMarkup', 'inboxRowLabel', 'inboxTitle'].map(fn).join('\n') });

    // Nothing to show without contents (a member without organization:edit).
    assert.equal(await page.evaluate(() => storageContentsMarkup(null) + storageOverQuotaMarkup(null)), '');
    assert.equal(await page.evaluate(() => storageOverQuotaMarkup({ projects: [] })), '');

    await page.evaluate((contents) => {
      const usage = `<div class="team-block storage-location"><div class="member-row"><span><b>Managed storage</b> <span class="chip">managed</span> <span class="chip">default</span></span><span>${formatBytes(contents.retainedBytes)} / ${formatBytes(contents.quotaBytes)}</span></div><div class="progress over"><i style="width:100%"></i></div>${storageOverQuotaMarkup(contents)}</div>`;
      document.querySelector('#org-storage').innerHTML = usage + storageContentsMarkup(contents);
      document.querySelector('details').open = true;
    }, CONTENTS);

    const over = await page.locator('.storage-over').textContent();
    assert.match(over, /Over the limit: adding data is paused/);
    assert.match(await page.locator('.storage-over .info-dot').getAttribute('title'), /by 9\/21\/2027.*older versions first/);
    const projects = await page.locator('.storage-project > .member-row b').allTextContents();
    assert.deepEqual(projects, ['Model training', 'Storefront'], 'largest first; empty projects hidden');
    assert.equal(await page.locator('[data-older-versions]').count(), 1);
    assert.equal(await page.locator('[data-older-versions]').getAttribute('data-older-versions'), 'r-weights');
    assert.match(await page.locator('.storage-project').first().textContent(), /3 older versions 2\.9 GB · task copies 120 MB/);
    assert.equal(await page.locator('[data-finished-workspaces]').getAttribute('data-finished-workspaces'), 'p-ml');
    assert.match(await page.locator('[data-finished-workspaces]').textContent(), /Delete finished \(60 MB\)/);
    assert.match(await page.locator('.storage-project').nth(1).textContent(), /Review files.*200 MB/);
    const bar = await page.locator('.storage-location .progress > i').boundingBox();
    assert.ok(bar && bar.height >= 3 && bar.width > 100, 'the usage bar is visible');
    // Row text stays on one line at this width.
    for (const text of await page.locator('.storage-item > span').all()) {
      const box = await text.boundingBox();
      assert.ok(box.height < 24, `storage row text wraps: ${await text.textContent()}`);
    }
    if (process.env.STORAGE_SCREENSHOT) await page.screenshot({ path: process.env.STORAGE_SCREENSHOT, fullPage: true });

    const notice = (stage) => ({ kind: 'escalated', subject: { kind: 'storage', stage, retainedBytes: 6 * GB, quotaBytes: 5 * GB, deleteAt: Date.parse('2027-09-21T12:00:00Z') } });
    assert.equal(await page.evaluate((item) => inboxRowLabel(item), notice('over')), 'Over the storage limit — free space by 9/21/2027');
    assert.equal(await page.evaluate((item) => inboxRowLabel(item), notice('deleted')), 'Stored data deleted to fit the limit');
    assert.equal(await page.evaluate((item) => inboxTitle(item), notice('7d')), 'Storage · 6 GB of 5 GB');
    console.log('storage browser test: ok');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
