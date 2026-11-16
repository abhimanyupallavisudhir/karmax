// Real browser regression: a task on a phone gives its conversation the room.
// The browser's own bars take the page's colour (no indigo frame), the task
// header takes the phone's app bar's place (← out, carrying its dot), Send sits
// inside the message box so the box spans the column, the box's empty state is
// one line, and the actions have no keyboard digits where there is no keyboard.
// Run: node web/mobile-task-page.browser.test.cjs   (SCREENSHOT_DIR=<dir> also saves screenshots)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fakeConsole, launch, taskView } = require('../tests/helpers/fake-console.cjs');

(async () => {
  const browser = await launch();
  const shots = process.env.SCREENSHOT_DIR;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  try {
    // No hard-coded brand colour paints the browser's bars.
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    assert.doesNotMatch(html, /name="theme-color" content="#5b5bd6"/i, 'no indigo theme-color');
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'app.webmanifest'), 'utf8'));
    assert.notEqual(manifest.theme_color.toLowerCase(), '#5b5bd6', 'the installed app has no indigo frame');

    const project = { id: 'p', organizationId: 'o', name: 'Workspace', config: {} };
    const task = { id: 't1', projectId: 'p', num: 81, title: 'Serious formatting and page sizing issues in the PDF', workflow: 'software-dev', params: {}, tags: [],
      lastView: { stage: 'review', status: 'active' } };
    const schema = [{ name: 'software-dev', params: [], stages: [{ key: 'do', label: 'Working' }, { key: 'review', label: 'Review' }] }];
    const messages = Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'agent' : 'user', text: `Message ${i} `.repeat(30), ts: i + 1 }));
    const actions = [{ name: 'followUp', enabled: true, args: ['text'] }, { name: 'confirm', label: 'Confirm PR', enabled: true },
      { name: 'cancel', label: 'Cancel', enabled: true, danger: true }];

    const open = async (viewport, colorScheme) => {
      const context = await browser.newContext({ serviceWorkers: 'block', viewport, colorScheme, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      await fakeConsole(context, { project, tasks: [task], schema, api(p) {
        if (p === '/api/tasks/t1') return taskView(task, { messages, actions });
      } });
      context.setDefaultTimeout(8000);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto('http://console.test/org/workspace/tasks/81/checkin');
      await page.locator('.followup-input').waitFor();
      return { context, page, errors };
    };
    const themeColors = (page) => page.evaluate(() => [...document.querySelectorAll('meta[name="theme-color"]')].map((meta) => meta.content));
    const box = (page, selector) => page.locator(selector).first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right };
    });

    // A phone the size an iPhone shows a page in Safari (its bars take the rest).
    const viewport = { width: 390, height: 664 };
    const { context, page, errors } = await open(viewport, 'dark');

    // The browser's bars are the page's top bar colour, in dark and in light.
    const rail = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--rail-bg').trim());
    assert.deepEqual(new Set(await themeColors(page)), new Set([await rail()]), 'theme-color is the page colour');
    assert.equal(await rail(), '#0f0f12');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForFunction(() => [...document.querySelectorAll('meta[name="theme-color"]')].every((meta) => meta.content === '#f8f8f9'));
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => [...document.querySelectorAll('meta[name="theme-color"]')].every((meta) => meta.content === '#0f0f12'));

    // No app bar above a task: its header starts at the top, ← is the way out.
    assert.equal(await page.locator('.mobile-bar').isVisible(), false, 'no separate app bar above a task');
    assert.ok((await box(page, '.tp-head')).y < 1, 'the task header starts at the top of the screen');
    assert.ok((await box(page, '#tp-back')).bottom <= 90, 'and ← is near it');
    const dot = () => page.locator('#tp-back').evaluate((el) => getComputedStyle(el, '::after').content);
    assert.equal(await dot(), 'none', 'no dot while nothing waits');
    await page.evaluate(() => document.getElementById('mobile-menu').classList.add('has-unread'));
    assert.notEqual(await dot(), 'none', '← carries the "something waits" dot of the hidden ☰');
    await page.evaluate(() => document.getElementById('mobile-menu').classList.remove('has-unread'));

    // Send is inside the message box, which spans the composer.
    assert.equal(await page.locator('.prompt-field .followup-send').count(), 1, 'Send is inside the message box');
    const [field, compose] = [await box(page, '.ck-compose .prompt-field'), await box(page, '.ck-compose')];
    assert.ok(field.width >= compose.width - 34, `the message box takes the composer's width (${field.width} of ${compose.width})`);
    const input = await box(page, '.followup-input');
    assert.ok(input.height <= 48, `an empty message box is one line (${input.height}px)`);
    assert.equal(await page.locator('.followup-input').evaluate((el) => getComputedStyle(el).resize), 'none', 'no resize grip on a touch screen');

    // No keyboard, no keyboard digits.
    assert.equal(await page.locator('#tp-foot .kbd').evaluateAll((els) => els.filter((el) => el.getClientRects().length).length), 0, 'no digit badges on a phone');

    // The conversation has most of the screen.
    const thread = await box(page, '#ck-thread');
    assert.ok(thread.height / viewport.height >= 0.53, `the conversation has ${Math.round(100 * thread.height / viewport.height)}% of the screen`);
    if (shots) await page.screenshot({ path: path.join(shots, 'phone-task-dark.png') });

    // Scrolling the conversation down tucks the header and toolbar away: nearly all of it is conversation.
    await page.evaluate(() => {
      document.querySelector('#ck-thread .thread').insertAdjacentHTML('afterbegin', '<div style="height:3000px"></div>');
      document.getElementById('ck-thread').scrollTop = 0;
    });
    const area = await box(page, '#ck-thread');
    await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(450);
    const tucked = await box(page, '#ck-thread');
    assert.ok(tucked.height / viewport.height >= 0.7, `scrolled, the conversation has ${Math.round(100 * tucked.height / viewport.height)}% of the screen`);
    if (shots) await page.screenshot({ path: path.join(shots, 'phone-task-scrolled.png') });

    // Typing keeps Send in the box's bottom row, clear of the text.
    await page.locator('.followup-input').fill('Can you also make the toggle remember the choice across devices, and add a test that covers a reload in Safari? '.repeat(2));
    await page.waitForTimeout(100);
    const [typed, send] = [await box(page, '.followup-input'), await box(page, '.followup-send')];
    assert.ok(send.y >= typed.bottom - 1, 'Send sits below the text, not over it');
    if (shots) await page.screenshot({ path: path.join(shots, 'phone-task-typing.png') });
    assert.deepEqual(errors, []);
    await context.close();

    // A computer keeps its app shell, the digit badges and the long placeholder.
    {
      const { context, page, errors } = await open({ width: 1280, height: 800 }, 'light');
      assert.ok(await page.locator('#tp-foot .kbd').first().isVisible(), 'digit badges on a computer');
      assert.match(await page.locator('.followup-input').getAttribute('placeholder'), /\[\[ for wiki/);
      assert.equal(await page.locator('.prompt-field .followup-send').count(), 1, 'Send is inside the message box on a computer too');
      if (shots) await page.screenshot({ path: path.join(shots, 'computer-task.png') });
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('mobile task page browser regression passed');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
