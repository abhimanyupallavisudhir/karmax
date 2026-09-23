// Run: node web/resource-review.browser.test.cjs (after playwright install chromium)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const review = src.slice(src.indexOf('function resourceReviewPlaceholder('), src.indexOf('\nfunction setStopBtn('));
const freshness = src.slice(src.indexOf('function beginAsyncElementRender('), src.indexOf('\n}', src.indexOf('function beginAsyncElementRender(')) + 2);
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 860, height: 500 } });
    await page.setContent('<main style="width:100%;padding:16px;box-sizing:border-box"><div id="review-resources"></div></main>');
    await page.addStyleTag({ path: path.join(__dirname, 'styles.css') });
    await page.addScriptTag({ content: `
      const resourceReviewCache = new Map(), resourceInventoryCache = new Map(), resourceChoiceWrites = new Map(), asyncElementRenderEpoch = new WeakMap();
      const esc = (s) => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
      const formatBytes = String, toast = () => {};
      const view = {taskId:'task', stage:'review'};
      const items = ['Training dataset', 'Model weights', 'Application database'].map((name, i) => ({resource:{id:'r'+i,name,target:{kind:'path',path:'resources/'+i},publish:'review'},pendingInspection:true}));
      window.saves = {}; window.reads = 0;
      async function api(url, options) {
        if (options?.method === 'PUT') return new Promise((resolve) => { saves[url.split('/').at(-2)] = () => { items.find(i => i.resource.id === url.split('/').at(-2)).excluded = JSON.parse(options.body).excluded; resolve({}); }; });
        reads++; return structuredClone(items);
      }
      ${freshness}\n${review}
      wireResourceReview(view);
    ` });
    await page.getByRole('button', { name: 'Exclude Training dataset', exact: true }).click();
    await page.getByRole('button', { name: 'Exclude Model weights', exact: true }).click();
    assert.equal(await page.getByText('Saving…', { exact: true }).count(), 2);
    assert.equal(await page.getByRole('button', { name: 'Exclude Application database', exact: true }).isEnabled(), true);
    await page.evaluate(() => { window.confirmed = false; window.confirming = waitResourceChoices('task').then(() => { window.confirmed = true; }); saves.r1(); });
    await page.waitForFunction(() => document.querySelector('[data-resource-id="r1"]').textContent === 'Include');
    assert.equal(await page.evaluate(() => window.confirmed), false);
    assert.equal(await page.evaluate(() => reads), 1, 'saving must not refetch or replace the list');
    await page.evaluate(() => { saves.r0(); });
    await page.waitForFunction(() => window.confirmed);
    assert.equal(await page.getByText('Excluded', { exact: true }).count(), 2);
    for (const width of [860, 375]) {
      await page.setViewportSize({ width, height: 500 });
      const box = await page.locator('.resource-review-list').boundingBox();
      assert.ok(box.height < 180, `three rows should be compact at ${width}px`);
      assert.ok(box.x + box.width <= width, 'resource list must fit on mobile');
      await page.screenshot({ path: `/tmp/karmax-resource-review-${width}.png` });
    }
    console.log('Resource review browser regression passed (concurrent saves, confirmation, desktop and mobile layout).');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
