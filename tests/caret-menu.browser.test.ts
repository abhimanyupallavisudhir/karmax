import fs from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { expect, it } from 'vitest';

const evaluate = (page: Page, source: string) => page.evaluate(source => (globalThis as any).eval(source), source);

async function openFixture(browser: Browser): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.route('http://caret.test/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/fonts/')) return route.fulfill({ body: fs.readFileSync(`web${pathname}`) });
    if (pathname.startsWith('/api/')) return route.fulfill({ json: {} });
    return route.fulfill({ contentType: 'text/html', body: '<main id="main" style="height:min(700px, 100dvh)"></main>' });
  });
  await page.goto('http://caret.test/');
  await page.addStyleTag({ content: fs.readFileSync('web/styles.css', 'utf8') });
  await page.addScriptTag({ content: fs.readFileSync('web/totp-qr.js', 'utf8') });
  await page.addScriptTag({ content: fs.readFileSync('web/markdown.js', 'utf8') });
  await page.addScriptTag({ content: fs.readFileSync('web/app.js', 'utf8').replace(/^boot\(\)\.catch\(.*$/m, '') });
  await evaluate(page, `
    Object.assign(S, { projects: [{ id: 'project', organizationId: 'org' }], projectId: 'project',
      taskEvents: [], sessions: {}, meta: {}, selected: 'task', taskTab: 'checkin' });
    S.view = { taskId: 'task', stage: 'do', status: 'active',
      actions: [{ name: 'followUp', enabled: true }],
      participants: [{ key: 'do', label: 'Agent', state: 'idle' }],
      transcripts: [{ role: 'do', messages: [{ role: 'assistant', text: 'Working.' }] }] };
    toast = () => {}; refreshTask = async () => {}; refreshTasks = async () => {};
    renderTaskPage = () => {
      const focus = captureFollowupFocus(document.getElementById('main'));
      patchTaskPage(document.getElementById('main'), checkinTab(S.view));
      wireFollowups(S.view); wireCheckinSidebar(S.view);
      restoreFollowupFocus(document.getElementById('main'), focus);
    };
    renderTaskPage();
  `);
  return page;
}

// The @ and [[ menus live on <body>, outside the follow-up box. A view update
// that re-renders the box while one is open must not leave it behind: the next
// @ then opened a second menu (CI #2022, agent-mention.browser: "People"
// resolved to two options), and the orphan's options wrote into a box that was
// no longer on the page.
it('keeps one caret menu across a re-render, and an orphaned one never acts', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openFixture(browser);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const box = page.locator('.followup-input').first();
    const menus = page.locator('.wiki-mention-menu');
    await box.click();
    await box.pressSequentially('@');
    await expect.poll(() => menus.count()).toBe(1);
    const first = await box.elementHandle();

    // A view update arrives while the box is not focused, and it is rebuilt.
    await evaluate(page, `S.view.participants = [...S.view.participants, { key: 'agent-1', label: 'Agent 1', state: 'idle' }];
      document.querySelector('.followup-input').closest('.followup-box').replaceWith(document.createElement('div'));
      patchTaskPage(document.getElementById('main'), checkinTab(S.view)); wireFollowups(S.view); wireCheckinSidebar(S.view);`);
    expect(await first!.evaluate(el => el.isConnected)).toBe(false);
    // The orphan's options do nothing to the box that is gone, and it closes.
    await page.locator('.agent-mention-menu .am-opt').first().dispatchEvent('mousedown');
    expect(await first!.evaluate(el => (el as unknown as { value: string }).value)).toBe('@');
    await expect.poll(() => menus.count()).toBe(0);

    await box.click();
    await box.fill('');
    await box.pressSequentially('@');
    await expect.poll(() => menus.count()).toBe(1);
    await page.locator('.agent-mention-menu .am-opt').filter({ hasText: 'Agent 1' }).dispatchEvent('mousedown');
    expect(await box.inputValue()).toBe('@Agent 1 ');

    // Reopened after a rebuild that leaves the orphan in place, there is still one menu.
    await box.fill('');
    await box.pressSequentially('@');
    await evaluate(page, `document.querySelector('.followup-input').closest('.followup-box').replaceWith(document.createElement('div')); renderTaskPage()`);
    await box.click();
    await box.fill('');
    await box.pressSequentially('@');
    await expect.poll(() => menus.count()).toBe(1);
    await page.locator('.agent-mention-menu .am-opt').filter({ hasText: 'People' }).dispatchEvent('mousedown');
    await expect.poll(() => menus.count()).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

// The usual case: the box being typed in is rebuilt and refocused by the same
// render (CI #2055, agent-mention.browser: the menu vanished between two looks
// as an update landed). The menu carries over to the new box as it was.
it('keeps an open @ menu, its People list and highlight, across a re-render of the focused box', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openFixture(browser);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const box = page.locator('.followup-input').first();
    const menu = page.locator('.agent-mention-menu');
    await box.click();
    await box.pressSequentially('@');
    await menu.locator('.am-opt').filter({ hasText: 'People' }).dispatchEvent('mousedown');
    await menu.getByText('@maintainers').waitFor();
    await box.press('ArrowDown');
    const highlighted = await menu.locator('.am-opt.active').innerText();
    const first = await box.elementHandle();

    // A view update rebuilds the box being typed in, and refocuses the new one.
    const rebuild = `{ const main = document.getElementById('main'), focus = captureFollowupFocus(main);
      main.querySelector('.followup-box').replaceWith(document.createElement('div'));
      patchTaskPage(main, checkinTab(S.view)); wireFollowups(S.view); wireCheckinSidebar(S.view);
      restoreFollowupFocus(main, focus); }`;
    await evaluate(page, rebuild);
    expect(await first!.evaluate(el => el.isConnected)).toBe(false);
    await expect.poll(() => menu.count()).toBe(1);
    expect(await menu.locator('.am-opt.active').innerText()).toBe(highlighted);
    await menu.getByText('@maintainers').waitFor();
    // The keyboard drives the carried-over menu, and a pick lands in the new box.
    await box.press('ArrowUp');
    expect(await menu.locator('.am-opt.active').innerText()).not.toBe(highlighted);
    await box.press('Enter');
    await expect.poll(() => menu.count()).toBe(0);
    expect(await box.inputValue()).toMatch(/^@\S+ $/);
    // Closed on purpose, it stays closed through the next render.
    await box.fill('');
    await box.pressSequentially('@');
    await box.press('Escape');
    await evaluate(page, rebuild);
    await page.waitForTimeout(50);
    expect(await menu.count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
