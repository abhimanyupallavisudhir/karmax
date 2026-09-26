const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const start = src.indexOf('function promptText(');
assert.ok(start >= 0, 'UI-31: in-page text prompt exists');
const code = src.slice(start, src.indexOf('\n}', start) + 2);
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent('<button id="open">Open</button><textarea id="draft">Keep 世界</textarea>');
    await page.addScriptTag({ content: `const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); ${code}` });
    await page.evaluate(() => { window.answer = 'pending'; promptText('<b>Name 世界</b>', 'Initial').then(value => { window.answer = value; }); });
    assert.equal(await page.locator('dialog b').count(), 0);
    assert.equal(await page.locator('dialog input').inputValue(), 'Initial');
    await page.locator('dialog input').fill('New 世界 <script>');
    await page.locator('dialog input').press('Enter');
    await page.waitForFunction(() => window.answer !== 'pending');
    assert.equal(await page.evaluate(() => window.answer), 'New 世界 <script>');
    await page.evaluate(() => { promptText('Cancel').then(value => { window.answer = value; }); });
    await page.locator('dialog input').press('Escape');
    await page.waitForFunction(() => window.answer === null);
    assert.equal(await page.evaluate(() => window.answer), null);
    assert.equal(await page.locator('dialog').count(), 0);
    assert.equal(await page.locator('#draft').inputValue(), 'Keep 世界');
    console.log('Text prompts: escaped labels, Unicode, submit, cancel, and draft preservation pass');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
