// Opening a task shows the message the agent wrote for you, not the landing
// repairs that came after it: those fold into one line that says where things
// stand. Full console shell, Chromium, deterministic local API fakes.
// Run: node web/conversation-folds.browser.test.cjs
const assert = require('node:assert/strict');
const { fakeConsole, launch, taskView } = require('../tests/helpers/fake-console.cjs');

(async () => {
  const browser = await launch();
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 760 } });
    const errors = [];
    const project = { id: 'p', organizationId: 'o', name: 'Workspace', config: {} };
    const task = { id: 't', projectId: 'p', num: 1, title: 'Task templates', workflow: 'software-dev', params: {}, tags: [], lastView: { stage: 'review', status: 'waiting' } };
    const T0 = Date.now() - 3 * 3600_000;
    const at = (minutes) => T0 + minutes * 60_000;
    // A report long enough not to fit: it must open at its first line.
    const report = ['Task templates are built and the PR is open.', '', ...Array.from({ length: 40 }, (_, i) => `- Detail ${i + 1} of what changed and how it was tested.`)].join('\n');
    const messages = [
      { id: 'm0', role: 'user', text: 'Let there be task templates.', ts: at(0) },
      { id: 'a1', role: 'agent', text: 'Moving to a larger machine.', ts: at(5) },
      { id: 'wait-2', role: 'user', text: '(Resumed: your 3-minute pause is over.)', ts: at(9) },
      { id: 'a3', role: 'agent', text: 'Waiting for the regression run.', ts: at(30) },
      { id: 'wait-4', role: 'user', text: '(Resumed: your job has finished.)', ts: at(36) },
      { id: 'a5', role: 'agent', text: report, ts: at(40) },
      { id: 'merge-revise-6', role: 'user', text: 'Pull request #669 conflicts with the latest target or landing candidate.', ts: at(120) },
      { id: 'a7', role: 'agent', text: 'Merged master; the tests on the merged code are still running.', ts: at(122) },
      { id: 'wait-8', role: 'user', text: '(Resumed: your job has finished.)', ts: at(130) },
      { id: 'a9', role: 'agent', text: '**The branch now merges cleanly** with the newest master, and I\'ve requested landing again.', ts: at(131) },
    ];
    const view = taskView(task, { messages, waitingFor: { kind: 'human' }, actions: [{ name: 'followUp', enabled: true }] });
    const { sockets } = await fakeConsole(context, { project, tasks: [task], api(p) {
      if (p === '/api/tasks/t') return view;
      if (p.endsWith('/events')) return [];
      return undefined;
    } });
    context.setDefaultTimeout(8000);
    const page = await context.newPage();
    page.on('pageerror', (error) => { errors.push(error.message); console.error('page:', error.message); });
    await page.goto('http://console.test/org/workspace');
    await page.locator('[data-id="t"] .row-link').click();
    const thread = page.locator('#ck-thread');
    await thread.getByText('Task templates are built and the PR is open.').waitFor();

    // The report opens at its first line, though the thread ends below it.
    const landed = await page.evaluate(() => {
      const thread = document.getElementById('ck-thread');
      const report = thread.querySelector('[data-land]');
      const top = report.getBoundingClientRect().top - thread.getBoundingClientRect().top;
      return { top, scrolled: thread.scrollTop > 0, key: report.dataset.conversationKey };
    });
    assert.equal(landed.key, 'message:a5', 'the report is what the page lands on');
    assert.ok(landed.top >= 0 && landed.top < 40 && landed.scrolled, `the report's first line is at the top of the view (${landed.top}px)`);

    // The work before it and the repairs after it are one line each.
    const folds = thread.locator('details.conv-fold');
    assert.equal(await folds.count(), 2, 'the work and the repairs fold');
    const repairs = folds.nth(1);
    assert.match(await repairs.locator('summary').innerText(), /1 automatic follow-up.*The branch now merges cleanly with the newest master/s,
      'the repairs line says how many and where things stand, without Markdown');
    assert.equal(await thread.getByText('Merged master; the tests').isVisible(), false, 'the repair chatter is folded away');
    assert.equal(await thread.getByText('Moving to a larger machine.').isVisible(), false, 'progress notes are folded away');

    // Opened, tavya's prompt is labelled as tavya's, not as yours.
    // What the reader opened must not depend on when the browser delivers the
    // toggle event: a refresh can replace the fold before it arrives (CI #2141).
    await page.evaluate(() => window.addEventListener('toggle', (event) => event.stopImmediatePropagation(), true));
    await repairs.locator('summary').click();
    const prompt = repairs.locator('.msg.platform', { hasText: 'conflicts with the latest target' });
    await prompt.waitFor();
    assert.equal((await prompt.locator('.role').innerText()).toLowerCase(), 'fixture', 'tavya\'s prompt carries the site\'s name');
    assert.equal(await thread.locator('.msg.user .role', { hasText: /^you$/i }).count(), 1, 'only the opening prompt says You');

    // New work arriving in it keeps the fold the reader opened.
    sockets.at(-1).send(JSON.stringify({ seq: 50, type: 'agent.activity', taskId: 't', projectId: 'p', ts: Date.now(),
      payload: { role: 'do', turnId: 'turn-9', attempt: 1, id: 'cmd', kind: 'command', phase: 'completed', title: 'gh pr checks 669' } }));
    await thread.getByText('gh pr checks 669').waitFor();
    assert.equal(await thread.locator('details.conv-fold').nth(1).evaluate((d) => d.open), true, 'an opened fold stays open as it grows');
    assert.equal(await thread.locator('details.conv-fold').count(), 2, 'the new step joins the repairs fold');
    assert.deepEqual(errors, []);
    console.log('conversation-folds: ok');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
