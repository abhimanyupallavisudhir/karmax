// The console bits this round changed: the sidebar's New task with its template
// tip, the list's New task bar with its template tip, and rows' stage bars with
// no label above them. Fake gateway (tests/helpers/fake-console.cjs).
// Usage: OUT=/tmp/shots/console node design/landing-v2/console-shot.cjs
const fs = require('node:fs');
const path = require('node:path');
const { fakeConsole, launch } = require('../../tests/helpers/fake-console.cjs');
const OUT = process.env.OUT || '/tmp/shots/console';
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const project = { id: 'p', organizationId: 'o', name: 'Website', config: {} };
  const task = (n, title, stage, status) => ({ id: `t${n}`, projectId: 'p', num: n, title, workflow: 'software-dev', params: {}, tags: [],
    createdAt: Date.now() - n * 60_000, updatedAt: Date.now() - n * 60_000, lastView: { stage, status } });
  const tasks = [task(1, 'Redesign the pricing page', 'do', 'active'), task(2, 'Fix the signup email', 'review', 'waiting'), task(3, 'Add a dark mode', 'do', 'waiting')];
  for (const scheme of ['light', 'dark']) {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 640 }, colorScheme: scheme });
    await fakeConsole(context, { project, tasks });
    const page = await context.newPage();
    await page.goto('http://console.test/org/website?q=');
    await page.locator('#rail .project-link').first().waitFor();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, `console-${scheme}.png`) });
    await context.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
