// Screens for the second usability round, against the fake gateway
// (tests/helpers/fake-console.cjs) with realistic fixtures: For me rows that
// ask for approvals and answers, a credential request on a task, settings,
// Insights, the profile, and phones. `targets` shots outline every control
// smaller than 24×24px (WCAG 2.2 target size) in red.
// Usage: OUT=/tmp/ux2/after node design/ux-round-2/shoot.cjs [name-filter]
const fs = require('node:fs');
const path = require('node:path');
const { launch } = require('../../tests/helpers/fake-console.cjs');
const { uxConsole } = require('../../tests/helpers/ux-console.cjs');

const OUT = process.env.OUT || '/tmp/ux2/shots';
const ONLY = process.argv[2] ? new RegExp(process.argv[2]) : null;
const PAGES = [
  ['home', '/org'],
  ['home-active', '/org?q=-is%3Aarchived'],
  ['inbox', '/inbox'],
  ['request', '/org/website/tasks/2'],
  ['task', '/org/mobile-app/tasks/3'],
  ['org-settings', '/org/settings'],
  ['project-settings', '/org/website/settings'],
  ['insights', '/org/insights'],
  ['profile', '/profile'],
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const shoot = async (name, url, viewport, { targets = false, scheme = 'light' } = {}) => {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport, colorScheme: scheme });
    await uxConsole(context);
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error(name, 'pageerror', e.message));
    await page.goto(`http://console.test${url}`);
    await page.locator('#main').waitFor();
    await page.waitForTimeout(1800);
    if (targets) await page.evaluate(() => {
      for (const el of document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [tabindex="0"]')) {
        const box = el.getBoundingClientRect();
        if (!box.width || !box.height || getComputedStyle(el).visibility === 'hidden') continue;
        if (el.matches('.md a, .msg-text a, p a, .task-sub a')) continue; // inline links in text are exempt
        if (box.width >= 24 && box.height >= 24) continue;
        const mark = document.createElement('div');
        Object.assign(mark.style, { position: 'fixed', left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`,
          outline: '2px solid #e5484d', background: 'rgba(229,72,77,.18)', zIndex: 9999, pointerEvents: 'none' });
        document.body.appendChild(mark);
      }
    });
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    await context.close();
  };
  for (const [name, url] of PAGES) {
    if (ONLY && !ONLY.test(name)) continue;
    await shoot(name, url, { width: 1280, height: 820 });
    if (['home', 'request', 'task', 'project-settings'].includes(name)) await shoot(`${name}-dark`, url, { width: 1280, height: 820 }, { scheme: 'dark' });
    if (['home', 'task', 'request', 'project-settings', 'inbox'].includes(name)) await shoot(`${name}-phone`, url, { width: 390, height: 844 });
    if (['home', 'task', 'project-settings'].includes(name)) await shoot(`${name}-targets`, url, { width: 1280, height: 820 }, { targets: true });
  }
  await browser.close();
  console.log(`shots in ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
