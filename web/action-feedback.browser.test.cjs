// The immediate-feedback layer with real (trusted) input in Chromium: a click
// must mark its control busy at once, and a repeat click on a busy control must
// not send the request again. Unit tests call .click() synchronously, which
// hides how browsers dispatch real input: they run a microtask checkpoint after
// every listener, so an origin cleared by a microtask was already gone by the
// time the button's own handler started its request.
// Run: node web/action-feedback.browser.test.cjs
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

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.route('http://feedback.test/**', (route) => route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body><div id="action-progress" hidden></div>'
        + '<button id="save">Save</button><select id="mode"><option>a</option><option>b</option></select></body></html>',
    }));
    await page.goto('http://feedback.test/');
    await page.addScriptTag({ content: `
      let interactionOrigin = null;
      let interactionOriginEpoch = 0;
      let actionProgressCount = 0;
      const actionFeedbackStates = new WeakMap();
      window.requests = [];
      // A request that stays in flight until the test releases it.
      window.release = null;
      window.fetch = (url) => { requests.push(String(url)); return new Promise((resolve) => { window.release = () => resolve({ ok: true }); }); };
      ${fn('actionableControl')}
      ${fn('rememberInteractionOrigin')}
      ${fn('installInteractionTracking')}
      ${fn('actionLabel')}
      ${fn('beginActionFeedback')}
      ${fn('finishActionFeedback')}
      ${fn('feedbackFetch')}
      installInteractionTracking();
      document.getElementById('save').addEventListener('click', () => { feedbackFetch('/api/save'); });
      document.getElementById('mode').addEventListener('change', () => { feedbackFetch('/api/mode'); });
    ` });

    await page.click('#save');
    assert.equal(await page.evaluate(() => document.getElementById('save').classList.contains('action-pending')), true,
      'a real click marks its button busy immediately');
    assert.equal(await page.getAttribute('#save', 'aria-busy'), 'true');

    // force: Playwright would otherwise wait for the aria-disabled control to be enabled.
    await page.click('#save', { force: true });
    await page.dblclick('#save', { force: true });
    assert.deepEqual(await page.evaluate(() => requests), ['/api/save'], 'repeat clicks on a busy control send nothing');

    await page.evaluate(() => release());
    await page.waitForFunction(() => !document.getElementById('save').classList.contains('action-pending'));
    await page.click('#save');
    assert.deepEqual(await page.evaluate(() => requests), ['/api/save', '/api/save'], 'the control works again once its request finished');
    await page.evaluate(() => release());

    await page.selectOption('#mode', 'b');
    assert.equal(await page.evaluate(() => document.getElementById('mode').classList.contains('action-pending')), true,
      'a real change marks its select busy');
    await page.evaluate(() => release());

    // A request nobody initiated (a timer, a websocket refresh) must not borrow
    // the last clicked control.
    await page.waitForFunction(() => !document.getElementById('mode').classList.contains('action-pending'));
    await page.evaluate(() => new Promise((resolve) => setTimeout(() => { feedbackFetch('/api/background'); resolve(); }, 50)));
    assert.equal(await page.evaluate(() => document.querySelectorAll('.action-pending').length), 0,
      'background requests leave every control alone');
    await page.evaluate(() => release());
    console.log('action feedback browser: ok');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
