// A task list is one surface ruled between its rows, and a row reads across
// in columns that line up down the whole list (each row a subgrid of it):
//   [glyph] #41 Title  #tag ▲high        Needs input        ▬▬▬◆▬  13h  [⌫]
// The glyph says whose move it is down the left edge; the status column says
// it in words; stage bar and age line up; a row's Archive/Delete show on the
// row you point at. Labels follow the title and wrap beneath it, never
// clipped; a narrow list drops the stage bar, a phone wraps the title.
// That is the default; an operator can choose another layout for everyone
// (Installation → Appearance → Task list): Status first (two lines led by the
// glyph), Ruled (two lines, the glyph beside the status's words) or Cards (a
// card per task) — the same rows, laid out by `html[data-task-list]`.
// Run: node web/task-list-layout.browser.test.cjs
const assert = require('node:assert/strict');
const { launch } = require('../tests/helpers/fake-console.cjs');
const { listConsole } = require('../tests/helpers/task-list-console.cjs');

(async () => {
  const browser = await launch();
  const open = async (url, viewport = { width: 1440, height: 900 }, taskList = '') => {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport });
    await listConsole(context, { taskList });
    context.setDefaultTimeout(8000);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => { errors.push(error.message); if (process.env.DEBUG) console.error(error.stack); });
    await page.goto(`http://console.test${url}`);
    await page.locator('.task-row[data-id="t41"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    return { page, context, errors };
  };
  // Columns line up when their edges agree to the pixel (sub-pixel layout rounds either way).
  const aligned = (xs) => Math.max(...xs) - Math.min(...xs) <= 1;
  const box = (page, selector) => page.locator(selector).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width) };
  });
  try {
    {
      const { page, context, errors } = await open('/org/website?q=-is%3Aarchived');
      // One surface: every row is in the list, borderless, flush with the next.
      assert.equal(await page.locator('#main .task-list').count(), 1, 'one list');
      const rows = page.locator('#main .task-list > .task-row');
      assert.equal(await rows.count(), await page.locator('#main .task-row').count(), 'every row is in it');
      const style = await rows.first().evaluate((el) => ({ border: getComputedStyle(el).borderTopWidth, margin: getComputedStyle(el).marginBottom }));
      assert.deepEqual(style, { border: '0px', margin: '0px' }, 'rows are ruled by the list, not boxed');
      const [a, b] = [await box(page, '[data-id="t41"]'), await box(page, '[data-id="t40"]')];
      assert.equal(b.top - a.bottom, 1, 'a hairline between rows');

      // The glyph leads, in whose-move tone; the status column has the words.
      assert.ok(await page.locator('[data-id="t41"] > .task-lead').evaluate((el) => el === el.parentElement.firstElementChild), 'the glyph comes first');
      for (const [id, tone, words] of [['t41', 'human', 'Needs input'], ['t39', 'human', 'Needs approval'], ['t38', 'working', 'Working'],
        ['t36', 'waiting', 'Waiting for render'], ['t33', 'failed', 'Failed'], ['t32', 'done', 'Done'], ['t30', 'draft', 'Draft']]) {
        const row = `[data-${id === 't30' ? 'draft' : 'id'}="${id}"]`;
        assert.ok(await page.locator(`${row} > .task-lead`).evaluate((el, t) => el.classList.contains(t), tone), `${id} leads with a ${tone} glyph`);
        assert.match(await page.locator(`${row} > .task-state`).innerText(), new RegExp(`^${words}`), `${id} says ${words}`);
        assert.equal(await page.locator(`${row} > .task-state svg`).evaluateAll((els) => els.filter((el) => el.getBoundingClientRect().width).length), 0,
          'the status column has no second glyph');
      }

      // Columns line up down the list, whatever a row holds.
      const edges = (selector, edge = 'left') => page.locator(selector).evaluateAll((els, e) => els.map((el) => el.getBoundingClientRect()[e]), edge);
      const centres = await page.locator('#main .task-row > .task-lead').evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return Math.round(r.left + r.width / 2); }));
      assert.ok(aligned(centres), 'glyphs (and a series’ caret) share a column');
      assert.ok(aligned(await edges('#main .task-row > .task-main')), 'titles share a column');
      assert.ok(aligned(await edges('#main .task-row > .task-state')), 'statuses share a column');
      assert.ok(aligned(await edges('#main .task-row[data-id] > .task-right > .pipeline', 'right')), 'stage bars end together');
      assert.ok(aligned(await edges('#main .task-row[data-id] > .task-right > .row-when', 'right')), 'ages end together');
      // One line per row: the title, its labels and the row's buttons share it.
      const height = (await box(page, '[data-id="t37"]')).bottom - (await box(page, '[data-id="t37"]')).top;
      assert.ok(height <= 46, `a row with labels is one line (${height}px)`);
      const [title37, labels37] = [await box(page, '[data-id="t37"] .task-title'), await box(page, '[data-id="t37"] .task-sub')];
      assert.ok(labels37.top < title37.bottom && labels37.left >= title37.right, 'labels follow the title on its line');
      const draft = await box(page, '[data-draft="t30"]');
      assert.ok(draft.bottom - draft.top <= 46, 'a draft with Run task is one line too');

      // Archive shows on the row you point at.
      const archive = page.locator('[data-id="t38"] [data-archive]');
      assert.equal(await archive.evaluate((el) => getComputedStyle(el).opacity), '0', 'hidden at rest');
      await page.locator('[data-id="t38"]').hover();
      await page.waitForTimeout(200);
      assert.equal(await archive.evaluate((el) => getComputedStyle(el).opacity), '1', 'shown on hover');
      assert.equal(await page.locator('[data-draft="t30"] [data-deldraft]').getAttribute('aria-label'), 'Delete', 'a draft’s Delete is a named icon');

      // A series' runs open beneath it on the same columns; a trigger's wait says what for.
      await page.locator('[data-expand="t29"]').click();
      await page.locator('.run-row[data-id="r1"]').waitFor();
      assert.ok(aligned(await edges('#main .task-row > .task-state')), 'runs share the status column');
      assert.ok(aligned(await edges('#main .task-row[data-id] > .task-right > .row-when', 'right')), 'and the age column');
      assert.match(await page.locator('[data-armed="t28"] > .task-state').innerText(), /Waiting for trigger\s*after 1 task/);
      assert.deepEqual(errors, []);
      await context.close();
    }
    {
      // Grouped, the groups head bands inside the one list: columns line up across groups.
      const { page, context, errors } = await open('/org/website?q=-is%3Aarchived%20group%3Astage');
      assert.equal(await page.locator('#main .task-list').count(), 1);
      assert.ok(await page.locator('#main .task-list > .task-group-heading').count() >= 4, 'groups head inside the list');
      const states = await page.locator('#main .task-row > .task-state').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().left));
      assert.ok(aligned(states), 'statuses share a column across groups');
      assert.deepEqual(errors, []);
      await context.close();
    }
    {
      // A laptop: the stage bar goes, labels wrap beneath the title, never clipped.
      const { page, context, errors } = await open('/org/website?q=-is%3Aarchived', { width: 1024, height: 760 });
      assert.equal(await page.locator('[data-id="t38"] .pipeline').evaluate((el) => getComputedStyle(el).display), 'none', 'no stage bar');
      const clipped = await page.locator('#main .task-row .task-sub').evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1).length);
      assert.equal(clipped, 0, 'no label is clipped');
      const title = await page.locator('[data-id="t41"] .task-title').evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
      assert.ok(title, 'titles wrap rather than end in …');
      assert.deepEqual(errors, []);
      await context.close();
    }
    {
      // A phone: the title takes the row; its status and age follow beneath.
      const { page, context, errors } = await open('/org/website?q=-is%3Aarchived', { width: 390, height: 844 });
      const [title, state, when] = [await box(page, '[data-id="t41"] .task-title'), await box(page, '[data-id="t41"] > .task-state'), await box(page, '[data-id="t41"] .row-when')];
      assert.ok(state.top >= title.bottom, 'status beneath the title');
      assert.ok(Math.abs(state.top - when.top) <= 6, 'status and age on one line');
      assert.ok((await box(page, '[data-id="t41"]')).right <= 390, 'nothing runs off the screen');
      assert.deepEqual(errors, []);
      await context.close();
    }
    {
      // The two-line layouts: the title, then the status (and its labels) beneath it.
      for (const layout of ['status-first', 'ruled', 'cards']) {
        const { page, context, errors } = await open('/org/website?q=-is%3Aarchived', undefined, layout);
        assert.equal(await page.evaluate(() => document.documentElement.dataset.taskList), layout, `${layout}: applied from the installation`);
        const [title, state, labels] = [await box(page, '[data-id="t37"] .task-title'), await box(page, '[data-id="t37"] > .task-state'), await box(page, '[data-id="t37"] .task-sub')];
        assert.ok(state.top >= title.bottom - 1, `${layout}: the status is beneath the title`);
        assert.ok(Math.abs(labels.top - state.top) <= 6 && labels.left > state.left, `${layout}: its labels follow the status`);
        const lead = await page.locator('[data-id="t37"] > .task-lead').evaluate((el) => getComputedStyle(el).display);
        const wordsGlyph = await page.locator('[data-id="t37"] > .task-state svg').first().evaluate((el) => getComputedStyle(el).display);
        if (layout === 'status-first') {
          assert.notEqual(lead, 'none', 'status first leads with the glyph');
          assert.equal(wordsGlyph, 'none', 'and says it once');
        } else {
          assert.equal(lead, 'none', `${layout}: no glyph column`);
          assert.notEqual(wordsGlyph, 'none', `${layout}: the glyph is beside the status's words`);
          assert.notEqual(await page.locator('[data-expand="t29"]').evaluate((el) => getComputedStyle(el).display), 'none', `${layout}: a series keeps its caret`);
        }
        const [a, b] = [await box(page, '[data-id="t41"]'), await box(page, '[data-id="t40"]')];
        const border = await page.locator('[data-id="t41"]').evaluate((el) => getComputedStyle(el).borderTopWidth);
        if (layout === 'cards') {
          assert.ok(b.top - a.bottom >= 8 && border === '1px', 'cards stand apart, each with its border');
          assert.equal(await page.locator('[data-id="t38"] [data-archive]').evaluate((el) => getComputedStyle(el).opacity), '1', 'a card shows its buttons');
        } else {
          assert.ok(b.top - a.bottom === 1 && border === '0px', `${layout}: one ruled surface`);
        }
        assert.deepEqual(errors, []);
        await context.close();
      }
      // On a phone: the title takes the row, status and age share the next line.
      const { page, context } = await open('/org/website?q=-is%3Aarchived', { width: 390, height: 844 }, 'cards');
      const [title, state, when] = [await box(page, '[data-id="t41"] .task-title'), await box(page, '[data-id="t41"] > .task-state'), await box(page, '[data-id="t41"] .row-when')];
      assert.ok(state.top >= title.bottom - 1 && Math.abs(state.top - when.top) <= 6, 'status and age on one line beneath the title');
      assert.ok((await box(page, '[data-id="t41"]')).right <= 390, 'nothing runs off the screen');
      await context.close();
    }
    {
      // The operator picks the layout in Installation → Appearance; it applies at once, for everyone.
      const { page, context, errors } = await open('/org/website?q=-is%3Aarchived');
      const saved = [];
      await page.route('**/api/settings/global/appearance', (route) => {
        if (route.request().method() === 'PUT') { saved.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); }
        return route.fulfill({ json: { icon: 'diamond' } });
      });
      await page.route('**/api/settings/installation', (route) => route.fulfill({ json: { canManage: true, siteName: 'Fixture' } }));
      await page.route('**/api/settings/service-limits', (route) => route.fulfill({ json: { services: [], canManage: true } }));
      await page.goto('http://console.test/installation');
      const choice = page.locator('#appearance-card .task-list-choice');
      await choice.waitFor();
      assert.deepEqual(await choice.locator('[data-choice]').allInnerTexts(), ['One line', 'Status first', 'Ruled', 'Cards']);
      assert.equal(await choice.locator('[aria-pressed="true"]').innerText(), 'One line', 'one line is the default');
      await choice.locator('[data-choice="cards"]').click();
      await page.waitForFunction(() => document.documentElement.dataset.taskList === 'cards');
      assert.deepEqual(saved, [{ values: { taskList: 'cards' } }]);
      await choice.locator('[data-choice=""]').click();
      await page.waitForFunction(() => !document.documentElement.hasAttribute('data-task-list'));
      assert.deepEqual(saved.at(-1), { values: { taskList: '' } });
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('task list layout: ok');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
