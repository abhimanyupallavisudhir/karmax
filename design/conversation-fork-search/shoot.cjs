// Screens of a forked conversation (the source task's part above, the fork
// marked) and of finding in it, on the full console shell with API fakes.
// Run: node design/conversation-fork-search/shoot.cjs [outDir]
const path = require('node:path');
const fs = require('node:fs');
const { fakeConsole, launch, taskView } = require('../../tests/helpers/fake-console.cjs');

(async () => {
  const out = path.resolve(process.argv[2] || path.join(__dirname));
  fs.mkdirSync(out, { recursive: true });
  const browser = await launch();
  try {
    for (const [name, viewport] of [['desktop', { width: 1280, height: 860 }], ['phone', { width: 390, height: 780 }]]) {
      const context = await browser.newContext({ serviceWorkers: 'block', viewport, deviceScaleFactor: 2 });
      const project = { id: 'p', organizationId: 'o', name: 'Workspace', config: {} };
      const T0 = Date.now() - 5 * 3600_000;
      const at = (minutes) => T0 + minutes * 60_000;
      const source = { id: 's', projectId: 'p', num: 412, title: 'Add CSV export to Insights', workflow: 'software-dev', params: {}, tags: [], lastView: { stage: 'done', status: 'done' } };
      const fork = { id: 'f', projectId: 'p', num: 431, title: 'Export: include compute costs', workflow: 'software-dev', tags: [], lastView: { stage: 'do', status: 'waiting' },
        params: { 'agent:do': { resumeFrom: { taskId: 's', role: 'do' } } } };
      const step = (seq, minutes, id, title) => ({ seq, type: 'agent.activity', taskId: 's', ts: at(minutes),
        payload: { role: 'do', turnId: 'turn-1', attempt: 1, id, kind: 'command', phase: 'completed', title } });
      const inherited = [{ taskId: 's', num: 412, title: source.title, role: 'do', until: at(60),
        messages: [
          { id: 'm0', role: 'user', text: 'Add a CSV export to the Insights page: tokens and tasks per day.', ts: at(0) },
          { id: 'a1', role: 'agent', text: 'The Insights page now has an **Export CSV** button. It writes one row per day with `tasks`, `tokens_in` and `tokens_out`, using the range the chart shows.\n\nTested with `web/insights.browser.test.cjs` and a 90-day fixture.', ts: at(24) },
        ],
        events: [step(3, 4, 'c1', 'grep -n "insights" web/app.js'), step(4, 9, 'c2', 'npx vitest run tests/insights.test.ts'), step(5, 20, 'c3', 'node web/insights.browser.test.cjs')] }];
      const view = taskView(fork, { messages: [
        { id: 'm0', role: 'user', text: 'Also include compute costs in the export.', ts: at(70) },
        { id: 'a1', role: 'agent', text: 'Done: the CSV export has a `compute_usd` column next to the token columns, from the same daily totals the compute chart uses.', ts: at(82) },
      ], waitingFor: { kind: 'human' }, actions: [{ name: 'followUp', enabled: true }],
      forkSourceSummaries: [{ id: 's', num: 412, title: source.title, workflow: 'software-dev', forkOf: [] }] });
      await fakeConsole(context, { project, tasks: [fork, source], api(p) {
        if (p === '/api/tasks/f') return view;
        if (p === '/api/tasks/f/fork-history') return inherited;
        if (p.endsWith('/events')) return [];
        return undefined;
      } });
      const page = await context.newPage();
      await page.goto('http://console.test/org/workspace/tasks/431');
      const thread = page.locator('#ck-thread');
      await thread.locator('.fork-point').waitFor();
      await page.evaluate(() => { document.getElementById('ck-thread').scrollTop = 0; });
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(out, `fork-${name}.png`) });
      await page.locator('#find-in-conversation').click();
      await page.locator('#ck-find-input').fill('csv');
      await page.locator('#ck-find-input').press('Enter');
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(out, `find-${name}.png`) });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`screens in ${out}`);
})().catch((error) => { console.error(error); process.exit(1); });
