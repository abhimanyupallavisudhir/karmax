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
  retainedBytes: 6.2 * GB, quotaBytes: 5 * GB, otherBytes: 0.1 * GB,
  overQuota: { since: NOW - 10 * 86_400_000, deleteAt: Date.parse('2027-09-21T12:00:00Z') },
  pendingDeletion: { bytes: 25.7 * GB, until: Date.parse('2026-11-09T00:00:00Z'), measuredAt: NOW },
  policy: { finishedTaskCheckpointDays: 30, overQuotaDeletionDays: 365, olderVersionDays: 30 },
  projects: [
    // Four versions of 2 GB weights that share most files: 2.9 GB stored, not 8 GB.
    { projectId: 'p-ml', name: 'Model training', bytes: 4.9 * GB,
      resources: [{ id: 'r-weights', name: 'weights', bytes: 2.9 * GB, currentBytes: 2 * GB, olderVersions: 3, taskCopies: 1 }],
      artifacts: { count: 0, bytes: 0 }, checkpoints: { count: 4, bytes: 2 * GB, finishedCount: 3, finishedBytes: 60 * MB } },
    { projectId: 'p-web', name: 'Storefront', bytes: 1.2 * GB,
      resources: [{ id: 'r-fixtures', name: 'fixtures', bytes: 1 * GB, currentBytes: 1 * GB, olderVersions: 0, taskCopies: 0 }],
      artifacts: { count: 2, bytes: 200 * MB }, checkpoints: { count: 0, bytes: 0, finishedCount: 0, finishedBytes: 0 } },
    { projectId: 'p-empty', name: 'Empty', bytes: 0, resources: [], artifacts: { count: 0, bytes: 0 }, checkpoints: { count: 0, bytes: 0, finishedCount: 0, finishedBytes: 0 } },
  ],
};
const LOCATIONS = [
  { id: 'managed', kind: 'managed', name: 'Managed storage', isDefault: true, status: 'ready', usage: { retainedBytes: 6.2 * GB, quotaBytes: 5 * GB } },
  { id: 's3', kind: 's3', name: 'Archive', isDefault: false, status: 'ready', config: { endpoint: 'https://s3.example', bucket: 'acme-data', prefix: 'tavya/org' } },
];

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
    await page.evaluate(() => { window.siteName = () => 'tavya'; window.trashIcon = () => '🗑'; });
    await page.addScriptTag({ content: ['formatBytes', 'policyTip', 'storageOverQuotaMarkup', 'storagePendingDeletionMarkup', 'storageContentsMarkup', 'storageSectionMarkup', 'inboxRowLabel', 'inboxTitle'].map(fn).join('\n') });

    // Nothing to show without contents (a member without organization:edit).
    assert.equal(await page.evaluate(() => storageContentsMarkup(null) + storageOverQuotaMarkup(null)), '');
    assert.equal(await page.evaluate(() => storageOverQuotaMarkup({ projects: [] })), '');
    assert.equal(await page.evaluate(() => storagePendingDeletionMarkup(null) + storagePendingDeletionMarkup({ projects: [] })), '');

    await page.evaluate(({ locations, contents }) => {
      document.querySelector('#org-storage').innerHTML = storageSectionMarkup(locations, contents, 'org_1');
      document.querySelector('.storage-project').open = true;
    }, { locations: LOCATIONS, contents: CONTENTS });

    const over = await page.locator('.storage-over').textContent();
    assert.match(over, /Over the limit: adding data is paused/);
    assert.match(await page.locator('.storage-over .info-dot').getAttribute('title'), /by 9\/21\/2027.*older versions first/);
    // The way out is one click: Plan & billing, where 100 GB packs are added.
    assert.equal(await page.locator('.storage-over a').getAttribute('href'), '#settings-plan');
    // The total, and deleted data still in the bucket, explained in a tooltip and not part of the total.
    assert.match(await page.locator('.storage-location').first().textContent(), /6\.2 GB\s*stored/);
    assert.equal((await page.locator('.storage-pending').textContent()).replace('ⓘ', '').trim(), '+ 25.7 GB being deleted');
    assert.match(await page.locator('.storage-pending .info-dot').getAttribute('title'), /until 11\/9\/2026.*doesn’t count toward your limit/);
    const projects = await page.locator('.storage-project > summary .storage-item-name').allTextContents();
    assert.deepEqual(projects, ['Model training', 'Storefront'], 'largest first; empty projects hidden');
    // The parts add up to the total: projects plus Other.
    const sizes = await page.locator('.storage-project > summary .storage-size').allTextContents();
    assert.deepEqual(sizes, ['4.9 GB', '1.2 GB']);
    assert.match(await page.locator('.storage-other').textContent(), /Other\s*ⓘ\s*102 MB/);
    // A resource: its versions and what they store together; the current size and retention in the tooltip.
    const weights = page.locator('.storage-project').first().locator('.storage-item').first();
    assert.match(await weights.textContent(), /weights · 4 versions\s*ⓘ\s*2\.9 GB\s*Delete older/);
    assert.match(await weights.locator('.info-dot').getAttribute('title'), /^Current version 2 GB\. Versions share unchanged files.*1 unsaved task copy\. Older versions are deleted 30 days after/);
    assert.equal(await page.locator('[data-older-versions]').count(), 1);
    assert.equal(await page.locator('[data-older-versions]').getAttribute('data-older-versions'), 'r-weights');
    assert.doesNotMatch(await page.evaluate((contents) => storageContentsMarkup({ ...contents, policy: { finishedTaskCheckpointDays: 30, overQuotaDeletionDays: 365 } }), CONTENTS),
      /newer one replaces/);
    assert.equal(await page.locator('[data-finished-workspaces]').getAttribute('data-finished-workspaces'), 'p-ml');
    assert.match(await page.locator('[data-finished-workspaces]').getAttribute('title'), /\(60 MB\)/);
    // The organization's own bucket, with its actions.
    const bucket = page.locator('.storage-location[data-storage="s3"]');
    assert.match(await bucket.textContent(), /Archive\s+acme-data\/tavya\/org/);
    assert.equal(await bucket.locator('.storage-test, .storage-default, .storage-delete').count(), 3);
    // Sizes line up in one column and rows stay on one line at this width.
    const boxes = await page.locator('.storage-size').evaluateAll((nodes) => nodes.filter((n) => n.offsetParent).map((n) => Math.round(n.getBoundingClientRect().right)));
    assert.equal(new Set(boxes).size, 1, `sizes are aligned: ${boxes}`);
    for (const row of await page.locator('.storage-item').all()) {
      if (!(await row.isVisible())) continue;
      const box = await row.boundingBox();
      assert.ok(box.height < 44, `storage row wraps: ${await row.textContent()}`);
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
