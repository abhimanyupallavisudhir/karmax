import { afterAll, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

// #1001: an agent asked its owner to click in "the task's desktop view". The
// only way there was a button inside the Terminal pane, so the owner asked
// whether tavya had a desktop at all. A desktop task's rail now names it.
it('offers a desktop task\'s screen in the rail, and opens it in a new tab', async () => {
  const ui = await consolePage({ api: ({ method, path }) => method === 'POST' && path === '/api/tasks/t1/desktop'
    ? { provider: 'e2b', url: 'https://6080-sbx.e2b.app/vnc.html?autoconnect=true', expiresAt: Date.now() + 300_000 }
    : method === 'POST' && path === '/api/tasks/t2/desktop' ? { status: 409, json: { error: 'this is a headless world' } } : {} });
  await ui.run(`
    window.__opened = [];
    window.open = (url, target, features) => { const tab = { opener: 'console', closed: false, location: { href: url || '' },
      close() { this.closed = true; } }; window.__opened.push({ url, target, features, tab }); return tab; };
    document.getElementById('main').innerHTML = '<div id="tp-rail">' + railDesktop({ taskId: 't1', worldDesktop: true })
      + railDesktop({ taskId: 'none', worldDesktop: false }) + '</div>';
    document.getElementById('desktop-open').addEventListener('click', () => openTaskDesktop({ taskId: 't1', worldDesktop: true }));
  `);
  const button = ui.page.locator('#desktop-open');
  expect(await ui.page.locator('#tp-rail .ck-item').count()).toBe(1);
  expect((await button.textContent())?.trim()).toBe('Desktop');
  expect(await button.getAttribute('title')).toBe('Watch and take over this task\'s screen (d)');
  await button.click();
  await ui.page.waitForFunction(() => (window as any).__opened[0]?.tab.location.href.startsWith('https://'));
  // The tab opens at the click (no popup blocker), detached from the console.
  const opened = await ui.page.evaluate(() => (window as any).__opened.map((o: any) => ({ url: o.url, opener: o.tab.opener, href: o.tab.location.href })));
  expect(opened).toEqual([{ url: '', opener: null, href: 'https://6080-sbx.e2b.app/vnc.html?autoconnect=true' }]);
  expect(ui.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/api/tasks/t1/desktop' }));
  // A failure closes the blank tab and says why.
  await ui.run(`openTaskDesktop({ taskId: 't2', worldDesktop: true })`);
  await ui.page.waitForFunction(() => (window as any).__opened[1]?.tab.closed === true);
  expect(await ui.page.locator('.toast').last().textContent()).toContain('this is a headless world');
  expect(ui.errors).toEqual([]);
  await ui.close();
});
