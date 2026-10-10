// The console's navigation layout: the top bar holds only the person (profile,
// inbox). The sidebar reads top to bottom as
//   [ Organization ▾ ]   ⌂ ⟋ 📖 ⚙    (organization: home, insights, wiki, settings)
//   Projects +  /  search  /  the project list
//   ? ⌘ ⌨ ▤                          (installation-wide: docs, palette, shortcuts, installation)
// with every organization and installation-wide entry an icon with a label for
// assistive technology and a tooltip, and no "Installation" heading.
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
    const open = async ({ operator, viewport = { width: 1280, height: 760 } }) => {
      const context = await browser.newContext({ serviceWorkers: 'block', viewport });
      await fakeConsole(context, { project, async api(p) {
        if (p === '/api/settings/installation') return { canManage: operator };
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

    // The top bar: the sidebar toggle and logo on the left, the person on the right — nothing else.
    const topbar = await page.locator('.topbar').evaluate((bar) => [...bar.querySelectorAll('a, button, input')]
      .filter((el) => el.offsetParent !== null).map((el) => el.id));
    assert.deepEqual(topbar, ['mobile-menu', 'brand-home', 'topbar-user', 'bell'], 'the top bar holds only the toggle, logo, profile and inbox');

    // The sidebar, in order.
    const order = await page.locator('#rail').evaluate((rail) => [...rail.querySelectorAll(
      '#org-switcher, .rail-org-nav a, .rail-heading, #project-search, .project-link, .rail-foot a, .rail-foot button')]
      .map((el) => el.id || el.className.split(' ')[0]));
    assert.deepEqual(order, ['org-switcher', 'rail-home', 'rail-insights', 'rail-wiki', 'rail-organization',
      'label', 'project-search', 'project-link',
      'rail-docs', 'rail-palette', 'rail-help', 'rail-installation'], `sidebar order: ${order.join(', ')}`);

    // Icons only: no visible words, but a name for assistive technology and a tooltip.
    const icons = await page.locator('.rail-org-nav a, .rail-foot a, .rail-foot button').evaluateAll((els) => els.map((el) => ({
      id: el.id, text: el.textContent.trim(), label: el.getAttribute('aria-label'), title: el.getAttribute('title'),
      svg: el.querySelector('svg')?.innerHTML || '' })));
    for (const icon of icons) {
      assert.equal(icon.text, '', `${icon.id} shows no text`);
      assert.ok(icon.label && icon.title, `${icon.id} is named and has a tooltip`);
      assert.ok(icon.svg, `${icon.id} draws an icon`);
    }
    const svgs = icons.map((icon) => icon.svg);
    assert.equal(new Set(svgs).size, svgs.length, 'every entry has its own icon (installation no longer shares the palette mark)');
    assert.deepEqual(icons.map((icon) => icon.label), ['Home', 'Insights', 'Wiki', 'Settings', 'Docs', 'Command palette', 'Keyboard shortcuts', 'Installation settings']);
    assert.ok(!(await page.locator('#rail').innerText()).match(/Installation|Organization\n/), 'no Installation or Organization heading');

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

    // The installation-wide buttons still do their jobs.
    await page.locator('#rail-palette').click();
    await page.locator('#pal-in').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#rail-help').click();
    await page.locator('#help-scrim b', { hasText: 'Keyboard shortcuts' }).waitFor();
    await page.keyboard.press('Escape');

    // The bottom group stays put at the foot of a tall rail while the project list scrolls.
    const geometry = await page.evaluate(() => {
      const rail = document.querySelector('#rail').getBoundingClientRect();
      const foot = document.querySelector('.rail-foot').getBoundingClientRect();
      return { railBottom: rail.bottom, footBottom: foot.bottom };
    });
    assert.ok(Math.abs(geometry.railBottom - geometry.footBottom) < 16, `the installation icons sit at the bottom (${JSON.stringify(geometry)})`);
    if (shots) await page.screenshot({ path: path.join(shots, 'sidebar-operator.png') });
    assert.deepEqual(errors, []);
    await context.close();

    // ── a member who does not run the installation: no installation entry ──
    const member = await open({ operator: false });
    assert.equal(await member.page.locator('#rail-installation').count(), 0, 'no installation entry without installation access');
    assert.equal(await member.page.locator('#rail-docs').count(), 1);

    // ── a phone: the sidebar slides over, the picker inside it opens without closing it ──
    await member.context.close();
    const phone = await open({ operator: false, viewport: { width: 390, height: 780 } });
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
