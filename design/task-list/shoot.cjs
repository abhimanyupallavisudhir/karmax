// Screens of the task list (tests/helpers/task-list-console.cjs: every status, tags, priorities, a
// series with its runs open, a task waiting for its trigger): a project's
// list, For me, the organization home, grouped by stage, and For me rows that
// ask for decisions (tests/helpers/ux-console.cjs); light and dark, a laptop
// and a phone.
// TASK_LIST=status-first|ruled|cards shoots another layout (Installation → Appearance → Task list).
// Usage: OUT=/tmp/task-list/after [TASK_LIST=cards] node design/task-list/shoot.cjs [name-filter]
const fs = require('node:fs');
const path = require('node:path');
const { launch } = require('../../tests/helpers/fake-console.cjs');
const { listConsole } = require('../../tests/helpers/task-list-console.cjs');
const { uxConsole } = require('../../tests/helpers/ux-console.cjs');

const OUT = process.env.OUT || '/tmp/task-list/shots';
const ONLY = process.argv[2] ? new RegExp(process.argv[2]) : null;
const PAGES = [
  ['list', '/org/website?q=-is%3Aarchived'],
  ['for-me', '/org/website'],
  ['home', '/org?q=-is%3Aarchived'],
  ['grouped', '/org/website?q=-is%3Aarchived%20group%3Astage'],
  ['asks', '/org', uxConsole],
];
const SIZES = { desk: { width: 1280, height: 900 }, laptop: { width: 1024, height: 760 }, phone: { width: 390, height: 844 } };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  for (const [name, url, fixture = listConsole] of PAGES) for (const scheme of ['light', 'dark']) for (const [size, viewport] of Object.entries(SIZES)) {
    const shot = `${name}-${scheme}-${size}`;
    if (ONLY && !ONLY.test(shot)) continue;
    if (scheme === 'dark' && size !== 'desk') continue;
    const context = await browser.newContext({ serviceWorkers: 'block', viewport, colorScheme: scheme });
    await fixture(context, { taskList: process.env.TASK_LIST || '' });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error(shot, 'pageerror', e.message));
    await page.goto(`http://console.test${url}`);
    await page.locator('.task-row').first().waitFor();
    await page.waitForTimeout(800);
    const caret = page.locator('[data-expand]');
    if (await caret.count()) { await caret.first().click(); await page.waitForTimeout(300); }
    if (size !== 'phone') await page.locator('.task-row').nth(2).hover();
    await page.screenshot({ path: path.join(OUT, `${shot}.png`), fullPage: size === 'desk' });
    await context.close();
  }
  await browser.close();
  console.log(`shots in ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
