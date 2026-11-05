// The console's navigation layout: there is no top bar on a computer — the
// sidebar holds everything, top to bottom:
//   [mark] tavya                      [⇤]   (the logo goes home; ⇤ folds the sidebar)
//   [ Organization ▾ ]
//   ⌂ Home / ⟋ Insights / 📖 Wiki / ⚙ Settings   (rows with their names)
//   Projects +  /  search  /  the project list, each with its For me count
//   ? ⌘ ⌨ ▤                                  (docs, palette, shortcuts, installation — icons sharing one row)
//   (A) Your name                       🔔   (profile and inbox)
// A phone keeps a slim bar with ☰ to slide the sidebar over the page.
// Run: node web/sidebar-layout.browser.test.cjs   (SIDEBAR_SCREENSHOTS=<dir> also saves screenshots)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fakeConsole, launch } = require('../tests/helpers/fake-console.cjs');

(async () => {
  const browser = await launch();
  const shots = process.env.SIDEBAR_SCREENSHOTS;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  try {
    const project = { id: 'p', organizationId: 'o', name: 'Website', config: {} };
    const quiet = { id: 'q', organizationId: 'o', name: 'Quiet project', config: {} };
    const countQueries = [];
    const open = async ({ operator, viewport = { width: 1280, height: 760 } }) => {
      const context = await browser.newContext({ serviceWorkers: 'block', viewport });
      await fakeConsole(context, { project, async api(p, request, url) {
        if (p === '/api/projects') return [project, quiet];
        if (p === '/api/settings/installation') return { canManage: operator };
        if (p === '/api/user/app-grants') return { grants: [], levels: [] };
        if (p === '/api/organizations/o/search' && url.searchParams.get('countBy') === 'project') {
          countQueries.push(url.searchParams.get('q'));
          return { total: 3, counts: { p: 3 } };
        }
        if (p === '/api/organizations/o/search') return { tasks: [], total: 0, offset: 0, limit: 200, projects: [], tags: [] };
        if (p === '/api/organizations/o/insights') return { totals: {}, previous: {}, pipeline: { drafts: 0, stages: {} } };
      } });
      context.setDefaultTimeout(8000);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => { errors.push(error.message); console.error('page:', error.stack); });
      await page.goto('http://console.test/org');
      await page.locator('#rail .project-link').first().waitFor();
      return { context, page, errors };
    };

    // ── an operator's console ──
    const { context, page, errors } = await open({ operator: true });

    // No top bar on a computer: the page starts at the top of the window.
    assert.equal(await page.locator('.mobile-bar').isVisible(), false, 'no top bar on a computer');
    const railTop = await page.locator('#rail').evaluate((rail) => rail.getBoundingClientRect().top);
    assert.equal(railTop, 0, 'the sidebar starts at the top of the window');

    // The sidebar, in order.
    const order = await page.locator('#rail').evaluate((rail) => [...rail.querySelectorAll(
      '#brand-home, #rail-collapse, #org-switcher, .rail-org-nav a, .rail-heading, #project-search, .project-link, .rail-tools a, .rail-tools button, .rail-person a')]
      .map((el) => el.id || el.className.split(' ')[0]));
    assert.deepEqual(order, ['brand-home', 'rail-collapse', 'org-switcher', 'rail-home', 'rail-insights', 'rail-wiki', 'rail-organization',
      'label', 'project-search', 'project-link', 'project-link',
      'rail-docs', 'rail-palette', 'rail-help', 'rail-installation', 'rail-profile', 'bell'], `sidebar order: ${order.join(', ')}`);

    // The logo is the brand mark and the site's name, and goes home.
    assert.equal((await page.locator('#brand-home').innerText()).trim(), 'Fixture');
    assert.equal(await page.locator('#brand-home .mark').count(), 1);
    assert.equal(await page.locator('#brand-home').getAttribute('href'), '/org');

    // The organization's places are rows with their names.
    const nav = await page.locator('.rail-org-nav a').evaluateAll((els) => els.map((el) => ({
      text: el.innerText.trim(), svg: !!el.querySelector('svg'), height: el.getBoundingClientRect().height })));
    assert.deepEqual(nav.map((row) => row.text), ['Home', 'Insights', 'Wiki', 'Settings']);
    for (const row of nav) {
      assert.ok(row.svg, `${row.text} keeps its icon`);
      assert.ok(row.height >= 32, `${row.text} is a comfortable row (${row.height}px)`);
    }

    // The tools are icons sharing one row, each named and with a tooltip.
    const tools = await page.locator('.rail-tools a, .rail-tools button').evaluateAll((els) => els.map((el) => {
      const box = el.getBoundingClientRect();
      return { id: el.id, text: el.textContent.trim(), label: el.getAttribute('aria-label'), title: el.getAttribute('title'),
        svg: el.querySelector('svg')?.innerHTML || '', top: Math.round(box.top), left: box.left, right: box.right };
    }));
    for (const tool of tools) {
      assert.equal(tool.text, '', `${tool.id} shows no text`);
      assert.ok(tool.label && tool.title, `${tool.id} is named and has a tooltip`);
      assert.ok(tool.svg, `${tool.id} draws an icon`);
    }
    assert.equal(new Set(tools.map((tool) => tool.svg)).size, tools.length, 'every tool has its own icon');
    assert.deepEqual(tools.map((tool) => tool.label), ['Docs', 'Command palette', 'Keyboard shortcuts', 'Installation settings']);
    assert.equal(new Set(tools.map((tool) => tool.top)).size, 1, 'the tools share one row, the operator\'s extra one included');

    // You and your inbox: the avatar with your name opens your profile; the bell the inbox.
    assert.equal((await page.locator('#rail-profile .rail-person-name').innerText()).trim(), 'Tester');
    assert.equal(await page.locator('#rail-profile').getAttribute('href'), '/profile');
    assert.equal(await page.locator('#bell').getAttribute('href'), '/inbox');
    assert.equal(await page.locator('#bell').getAttribute('aria-label'), 'Inbox');

    // Everything fits inside the sidebar: nothing spills past its edge or wraps.
    const fit = await page.evaluate(() => {
      const rail = document.querySelector('#rail').getBoundingClientRect();
      const spill = [...document.querySelectorAll('#rail .rail-head *, #rail .rail-foot *')].filter((el) => {
        const box = el.getBoundingClientRect();
        return box.width && (box.right > rail.right - 4 || box.left < rail.left);
      }).map((el) => el.id || el.className);
      return { spill, footBottom: document.querySelector('.rail-foot').getBoundingClientRect().bottom, railBottom: rail.bottom };
    });
    assert.deepEqual(fit.spill, [], 'nothing in the head or foot spills out of the sidebar');
    assert.ok(Math.abs(fit.railBottom - fit.footBottom) < 16, `the foot sits at the bottom (${JSON.stringify(fit)})`);

    // A project's number is how many tasks its For me list holds; none, no number.
    await page.locator('.project-row[data-id="p"] .count').waitFor();
    assert.equal((await page.locator('.project-row[data-id="p"] .count').innerText()).trim(), '3');
    assert.equal(await page.locator('.project-row[data-id="q"] .count').count(), 0, 'no number when nothing is for you');
    assert.match(await page.locator('.project-row[data-id="p"] .count').getAttribute('title'), /3 tasks? for you/);
    assert.ok(countQueries.includes('for:me -is:archived'), `counts the For me query (${countQueries.join(' | ')})`);

    // Docs opens in its own tab; the others route in place.
    assert.equal(await page.locator('#rail-docs').getAttribute('href'), '/docs');
    assert.equal(await page.locator('#rail-docs').getAttribute('target'), '_blank');
    assert.equal(await page.locator('#rail-home').getAttribute('href'), '/org');
    assert.equal(await page.locator('#rail-installation').getAttribute('href'), '/installation');

    // The current place is marked, and a route change moves the mark without
    // rebuilding the organization picker (an open menu or typed query survives).
    assert.equal(await page.locator('#rail-home').getAttribute('aria-current'), 'page');
    await page.locator('#org-switcher input').evaluate((input) => { input.dataset.kept = '1'; });
    await page.locator('#rail-insights').click();
    await page.waitForFunction(() => location.pathname === '/org/insights');
    assert.equal(await page.locator('#rail-insights').getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('#rail-home').getAttribute('aria-current'), null);
    assert.equal(await page.locator('#org-switcher input').getAttribute('data-kept'), '1', 'the picker is not repainted with the rail');
    await page.locator('#rail-organization').click();
    await page.waitForFunction(() => location.pathname === '/org/settings');
    assert.equal(await page.locator('#rail-organization').getAttribute('aria-current'), 'page');
    await page.locator('#rail-profile').click();
    await page.waitForFunction(() => location.pathname === '/profile');
    assert.equal(await page.locator('#rail-profile').getAttribute('aria-current'), 'page');

    // The installation-wide buttons still do their jobs.
    await page.locator('#rail-palette').click();
    await page.locator('#pal-in').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#rail-help').click();
    await page.locator('#help-scrim b', { hasText: 'Keyboard shortcuts' }).waitFor();
    await page.keyboard.press('Escape');
    if (shots) await page.screenshot({ path: path.join(shots, 'sidebar-operator.png') });

    // ⇤ folds the sidebar away; a button at the window's edge brings it back.
    await page.locator('#rail-collapse').click();
    await page.waitForFunction(() => document.documentElement.classList.contains('rail-collapsed'));
    await page.locator('#rail-expand').waitFor({ state: 'visible' });
    if (shots) { await page.waitForTimeout(250); await page.screenshot({ path: path.join(shots, 'sidebar-folded.png') }); }
    await page.locator('#rail-expand').click();
    await page.waitForFunction(() => !document.documentElement.classList.contains('rail-collapsed'));
    assert.equal(await page.locator('#rail-expand').isVisible(), false);
    assert.deepEqual(errors, []);
    await context.close();

    // ── a member who does not run the installation: no installation entry, the rest unchanged ──
    const member = await open({ operator: false });
    assert.equal(await member.page.locator('#rail-installation').count(), 0, 'no installation entry without installation access');
    assert.equal(await member.page.locator('#rail-docs').count(), 1);
    const memberTools = await member.page.locator('.rail-tools a, .rail-tools button').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
    assert.equal(new Set(memberTools).size, 1);

    // ── a phone: a slim bar with ☰; the sidebar slides over, the picker inside it opens without closing it ──
    await member.context.close();
    const phone = await open({ operator: false, viewport: { width: 390, height: 780 } });
    assert.ok(await phone.page.locator('.mobile-bar').isVisible(), 'a phone has a bar to open the sidebar');
    await phone.page.locator('#mobile-menu').click();
    await phone.page.waitForFunction(() => document.querySelector('#rail').classList.contains('mobile-open'));
    await phone.page.locator('#org-switcher .combo-caret').click();
    assert.ok(await phone.page.locator('#rail').evaluate((rail) => rail.classList.contains('mobile-open')), 'opening the organization menu keeps the sidebar open');
    if (shots) await phone.page.screenshot({ path: path.join(shots, 'sidebar-phone.png') });
    assert.deepEqual(phone.errors, []);
    await phone.context.close();
    console.log('Sidebar layout: ok');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exit(1); });
