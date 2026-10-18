// Real browser regression: on a phone the conversation's Send stays on screen
// however long the draft grows — with the on-screen keyboard open, in
// landscape, and in full screen. Phones hide the bottom of a page under the
// keyboard unless the page asks to be resized (interactive-widget) or, where
// that is ignored (iOS Safari), fits itself to the visual viewport; and iOS
// zooms into any text field under 16px, panning Send out of view.
// Run: node web/mobile-composer.browser.test.cjs   (SCREENSHOT_DIR=<dir> also saves screenshots)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fakeConsole, launch, taskView } = require('../tests/helpers/fake-console.cjs');

(async () => {
  const browser = await launch();
  const shots = process.env.SCREENSHOT_DIR;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  try {
    const project = { id: 'p', organizationId: 'o', name: 'Workspace', config: {} };
    const task = { id: 't1', projectId: 'p', num: 1, title: 'Tidy the landing page', workflow: 'software-dev', params: {}, tags: [],
      lastView: { stage: 'do', status: 'active' } };
    const schema = [{ name: 'software-dev', params: [], stages: [{ key: 'do', label: 'Working' }, { key: 'review', label: 'Review' }] }];
    const messages = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'agent' : 'user', text: `Message ${i} `.repeat(30), ts: i + 1 }));
    const draft = 'A long message that wraps across the phone screen. '.repeat(30);

    // `keyboard` stands in for iOS Safari: the layout keeps its size and only
    // the visual viewport shrinks above the keyboard.
    const open = async (viewport, { keyboard } = {}) => {
      const context = await browser.newContext({ serviceWorkers: 'block', viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      await fakeConsole(context, { project, tasks: [task], schema, api(p) {
        if (p === '/api/tasks/t1') return taskView(task, { messages, actions: [{ name: 'followUp', enabled: true, args: ['text'] }] });
      } });
      if (keyboard) await context.addInitScript(() => {
        const viewport = new EventTarget();
        Object.assign(viewport, { width: innerWidth, height: innerHeight, scale: 1, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0 });
        Object.defineProperty(window, 'visualViewport', { value: viewport });
        window.showKeyboard = (height) => {
          viewport.height = height ?? innerHeight;
          viewport.dispatchEvent(new Event('resize'));
        };
      });
      context.setDefaultTimeout(8000);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto('http://console.test/org/workspace/tasks/1/checkin');
      await page.locator('.followup-input').waitFor();
      return { context, page, errors };
    };
    const sendInView = async (page, visible, label) => {
      const send = await page.locator('.followup-send').boundingBox();
      const width = page.viewportSize().width;
      assert.ok(send, `${label}: Send is laid out`);
      assert.ok(send.y >= 0 && send.y + send.height <= visible + 0.5 && send.x >= 0 && send.x + send.width <= width + 0.5,
        `${label}: Send is on screen (${JSON.stringify(send)} in ${width}×${visible})`);
      assert.ok(await page.locator('.followup-send').evaluate((button) => {
        const box = button.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return button.contains(hit);
      }), `${label}: nothing covers Send`);
    };
    const shot = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, name) }); };

    // The viewport asks phones to resize the page above the keyboard.
    const meta = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').match(/<meta name="viewport" content="([^"]*)"/)[1];
    assert.match(meta, /interactive-widget=resizes-content/, 'the page is resized above the on-screen keyboard');

    // A phone, upright; then with the keyboard resizing the page; then sideways.
    for (const [viewport, label] of [[{ width: 390, height: 844 }, 'portrait'], [{ width: 390, height: 420 }, 'keyboard open'],
      [{ width: 844, height: 390 }, 'landscape'], [{ width: 320, height: 360 }, 'small phone, keyboard open']]) {
      const { context, page, errors } = await open(viewport);
      const input = page.locator('.followup-input');
      // iOS zooms into text fields set below 16px and pans with the caret.
      assert.ok(parseFloat(await input.evaluate((el) => getComputedStyle(el).fontSize)) >= 16, `${label}: the message box is not zoomed into`);
      await sendInView(page, viewport.height, `${label}, empty`);
      await input.fill(draft);
      await page.waitForTimeout(100);
      await sendInView(page, viewport.height, `${label}, long draft`);
      assert.ok(await input.evaluate((el) => el.clientHeight >= 38), `${label}: the draft keeps at least a line`);
      assert.ok(await input.evaluate((el) => el.scrollHeight > el.clientHeight), `${label}: a long draft scrolls inside its box`);
      assert.ok(await page.locator('#ck-thread').evaluate((el) => el.clientHeight > 0), `${label}: the conversation stays in view`);
      assert.equal(await page.locator('.attach-file-button').evaluate((el) => el.getClientRects().length === 1 && el.getBoundingClientRect().height < 24), true,
        `${label}: "Attach files" stays on one line`);
      await shot(page, `${viewport.width}x${viewport.height}-long.png`);
      await page.locator('#conversation-fullscreen').click();
      await page.locator('.ck-pane.ck-fullscreen').waitFor();
      await sendInView(page, viewport.height, `${label}, full screen`);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // iOS Safari: the keyboard shrinks only the visual viewport; the console fits itself into it.
    {
      const { context, page, errors } = await open({ width: 390, height: 844 }, { keyboard: true });
      await page.locator('.followup-input').fill(draft);
      await page.evaluate(() => window.showKeyboard(420));
      await sendInView(page, 420, 'iOS keyboard open');
      assert.equal(Math.round(await page.locator('#app').evaluate((el) => el.getBoundingClientRect().height)), 420, 'the console fits above the keyboard');
      await shot(page, 'ios-keyboard.png');
      await page.locator('#conversation-fullscreen').click();
      await page.locator('.ck-pane.ck-fullscreen').waitFor();
      await sendInView(page, 420, 'iOS keyboard open, full screen');
      await page.evaluate(() => window.showKeyboard());
      assert.equal(Math.round(await page.locator('#app').evaluate((el) => el.getBoundingClientRect().height)), 844, 'and fills the screen again once it closes');
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('mobile composer browser regression passed');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
