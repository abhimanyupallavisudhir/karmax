// A Work-locally dialog taller than the screen scrolls, and its close button
// stays in view. Real app.js frame and styles.css in Chromium.
// Run: node web/work-locally.browser.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const start = src.indexOf('async function localHandoffDialog(');
assert.ok(start >= 0, 'the shared Work-locally frame exists');
const code = src.slice(start, src.indexOf('\n}\n', start) + 2);

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  try {
    for (const viewport of [{ width: 1280, height: 600 }, { width: 390, height: 640 }]) {
      const page = await browser.newPage({ viewport });
      await page.setContent('<div id="modal-root"></div>');
      await page.addStyleTag({ path: path.join(__dirname, 'styles.css') });
      await page.addScriptTag({ content: `const $ = (s, root = document) => root.querySelector(s);
        const toast = () => {}; const copyToClipboard = async () => {}; const downloadNativeConversation = () => {};
        ${code}` });
      await page.evaluate(() => localHandoffDialog({
        loading: 'Loading…', load: async () => null,
        render: () => `${'<div class="section-h">Step</div><pre class="raw">git fetch origin\ngit checkout task</pre>'.repeat(8)}<button class="btn sm primary" id="last">Last</button>`,
      }));
      const close = page.locator('.local-handoff-close');
      const last = page.locator('#last');
      await last.scrollIntoViewIfNeeded();
      const inView = async (locator) => {
        const box = await locator.boundingBox();
        return box && box.y >= 0 && box.y + box.height <= viewport.height;
      };
      assert.ok(await inView(last), `${viewport.width}×${viewport.height}: the end of the dialog scrolls into view`);
      assert.ok(await inView(close), `${viewport.width}×${viewport.height}: close stays visible while scrolled`);
      await last.click(); // clickable, not covered by anything
      if (process.env.WORK_LOCALLY_SCREENSHOT) await page.screenshot({ path: process.env.WORK_LOCALLY_SCREENSHOT.replace(/(\.png)?$/, `-${viewport.width}.png`) });
      await page.close();
    }
    console.log('Work locally: tall dialog scrolls with close in view on desktop and mobile');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exit(1); });
