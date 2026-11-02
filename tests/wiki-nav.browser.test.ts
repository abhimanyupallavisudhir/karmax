import fs from 'node:fs';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';

// A wiki with more entries than fit beside the page once squeezed every row of
// its sidebar to a sliver (the nav is a height-capped flex column, and its rows
// shrank instead of scrolling), clipped the active entry's accent bar, and,
// once the page scrolled, slid the nav's top under the project's sticky tabs.
const cases = [
  { name: 'project wiki', width: 1206, tabs: true },
  { name: 'organization wiki', width: 1206, tabs: false },
  { name: 'project wiki on a phone', width: 390, tabs: true },
];

it.each(cases)('keeps the $name sidebar whole and in view', async ({ width, tabs }) => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height: 688 }, colorScheme: 'dark' });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://wiki.test/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/fonts/')) return route.fulfill({ body: fs.readFileSync(`web${url.pathname}`) });
      // The console's shell: top bar, then a scrolling main column.
      return route.fulfill({ contentType: 'text/html', body: `<div id="app"><div class="topbar"></div><div class="body">
        <div class="rail"></div><div class="main"><div class="main-inner" id="main"></div></div></div></div>` });
    });
    await page.goto('http://wiki.test/');
    await page.addStyleTag({ content: fs.readFileSync('web/styles.css', 'utf8') });
    const app = fs.readFileSync('web/app.js', 'utf8').replace(/^boot\(\)\.catch\(.*$/m, '');
    await page.addScriptTag({ content: fs.readFileSync('web/totp-qr.js', 'utf8') });
    await page.addScriptTag({ content: fs.readFileSync('web/markdown.js', 'utf8') });
    await page.addScriptTag({ content: app });
    await page.evaluate((tabs) => (globalThis as any).eval(`
      const proj = { id: 'proj', name: 'pramana', organizationId: 'org' };
      Object.assign(S, { user: { id: 'user' }, organizationId: 'org', organizations: [{ id: 'org', name: 'Org' }], projects: [proj] });
      document.getElementById('main').innerHTML = (${tabs} ? '<div class="tabs"><a class="tab">Tasks</a><a class="tab active">Wiki</a></div>' : '')
        + wikiView(${tabs} ? proj : null);
      const memories = Array.from({ length: 40 }, (_, i) => ({ kind: 'memory', name: 'memory-entry-with-a-long-name-' + i, path: 'memories/m' + i }));
      const toc = [{ kind: 'skill', name: 'SPEC', path: 'SPEC', labels: ['default'] }, { kind: 'section', name: 'memories', path: 'memories', children: memories }];
      document.getElementById('wiki-nav').innerHTML = '<button class="btn sm wiki-new">+ New entry</button><a href="#" class="active" data-wiki-home>Index</a>' + wikiTreeHtml(toc, '');
      document.getElementById('wiki-pane').innerHTML = '<div style="height:3000px"></div>';
    `), tabs);
    const nav = page.locator('#wiki-nav');
    const rows = await nav.evaluate(node => [...node.children].map(child => ({
      text: (child as any).innerText, height: child.getBoundingClientRect().height, needs: child.scrollHeight,
    })));
    expect(rows.length).toBe(44);
    for (const row of rows) expect(row.height, row.text).toBeGreaterThan(row.needs - 1);

    // Scrolled down the page, the nav stays wholly visible: below the tabs, above the window's edge.
    const stuck = await page.evaluate(() => {
      const { document, innerHeight } = globalThis as any;
      document.querySelector('.main').scrollTop = 600;
      const navBox = document.getElementById('wiki-nav').getBoundingClientRect();
      const tabsBox = document.querySelector('.tabs')?.getBoundingClientRect();
      return { top: navBox.top, bottom: navBox.bottom, tabsBottom: tabsBox?.bottom ?? 52, height: innerHeight };
    });
    expect(stuck.top).toBeGreaterThanOrEqual(stuck.tabsBottom);
    expect(stuck.bottom).toBeLessThanOrEqual(stuck.height);
    if (width < 850) return; // a phone's nav is one scrolling row

    // The nav scrolls instead of squeezing: its last entry is reachable.
    const last = await nav.evaluate(node => {
      node.scrollTop = node.scrollHeight;
      const box = node.lastElementChild!.getBoundingClientRect();
      const frame = node.getBoundingClientRect();
      return box.top >= frame.top && box.bottom <= frame.bottom + 1;
    });
    expect(last).toBe(true);
    await nav.evaluate(node => { node.scrollTop = 0; });
    // The active entry's accent bar is drawn, not cut off by the scrolling box.
    const bar = await nav.locator('a.active').evaluate(link => {
      const { document, getComputedStyle } = globalThis as any;
      const box = link.getBoundingClientRect();
      const x = box.left + parseFloat(getComputedStyle(link, '::before').left) + 1;
      return document.elementFromPoint(x, box.top + box.height / 2) === link;
    });
    expect(bar).toBe(true);
    if (process.env.KARMAX_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.KARMAX_SCREENSHOT_DIR}/wiki-nav-${tabs ? 'project' : 'org'}.png` });
    expect(errors.join('\n')).toBe('');
  } finally { await browser.close(); }
});
