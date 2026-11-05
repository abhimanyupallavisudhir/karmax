// A forked conversation reads from its beginning: what the agent said in the
// task it was forked from comes first, then a line naming that task where the
// fork happened, then this task's own. And ⌘F finds words anywhere in it,
// folded work and the inherited part included, surviving live refreshes.
// Full console shell, Chromium, deterministic local API fakes.
// Run: node web/conversation-fork-search.browser.test.cjs
const assert = require('node:assert/strict');
const { fakeConsole, launch, taskView } = require('../tests/helpers/fake-console.cjs');

(async () => {
  const browser = await launch();
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 760 } });
    const errors = [];
    const project = { id: 'p', organizationId: 'o', name: 'Workspace', config: {} };
    const T0 = Date.now() - 3 * 3600_000;
    const at = (minutes) => T0 + minutes * 60_000;
    const source = { id: 's', projectId: 'p', num: 7, title: 'Pick a codeword', workflow: 'software-dev', params: {}, tags: [], lastView: { stage: 'done', status: 'done' } };
    const fork = { id: 'f', projectId: 'p', num: 8, title: 'Recall it', workflow: 'software-dev', tags: [], lastView: { stage: 'review', status: 'waiting' },
      params: { 'agent:do': { resumeFrom: { taskId: 's', role: 'do' } } } };
    const inherited = [{ taskId: 's', num: 7, title: 'Pick a codeword', role: 'do', until: at(20),
      messages: [
        { id: 'm0', role: 'user', text: 'Pick a codeword and note it down.', ts: at(0) },
        { id: 'a1', role: 'agent', text: 'The codeword is **heron**.', ts: at(10) },
      ],
      events: [{ seq: 3, type: 'agent.activity', taskId: 's', ts: at(5), payload: { role: 'do', turnId: 'turn-1', attempt: 1, id: 'cmd', kind: 'command', phase: 'completed', title: 'grep heron notes.md' } },
        { seq: 4, type: 'agent.activity', taskId: 's', ts: at(6), payload: { role: 'do', turnId: 'turn-1', attempt: 1, id: 'cmd-2', kind: 'command', phase: 'completed', title: 'cat notes.md' } }] }];
    const view = taskView(fork, { messages: [
      { id: 'm0', role: 'user', text: 'What was the codeword?', ts: at(30) },
      { id: 'a1', role: 'agent', text: 'It was heron.', ts: at(31) },
    ], waitingFor: { kind: 'human' }, actions: [{ name: 'followUp', enabled: true }],
    forkSourceSummaries: [{ id: 's', num: 7, title: 'Pick a codeword', workflow: 'software-dev', forkOf: [] }] });
    const asked = [];
    const { sockets } = await fakeConsole(context, { project, tasks: [fork, source], api(p, request, url) {
      if (p === '/api/tasks/f') return view;
      if (p === '/api/tasks/f/fork-history') { asked.push(url.searchParams.get('role')); return inherited; }
      if (p.endsWith('/events')) return [];
      return undefined;
    } });
    context.setDefaultTimeout(8000);
    const page = await context.newPage();
    page.on('pageerror', (error) => { errors.push(error.message); console.error('page:', error.message); });
    await page.goto('http://console.test/org/workspace');
    await page.locator('[data-id="f"] .row-link').click();
    const thread = page.locator('#ck-thread');
    await thread.getByText('It was heron.').waitFor();

    // ── the conversation before the fork, then the fork, then this task's ──
    await thread.locator('.fork-point').waitFor();
    assert.deepEqual(asked, ['do'], "the main agent's history is asked for once");
    const order = await thread.evaluate((el) => [...el.querySelectorAll(':scope > .thread > :is(.msg, .fork-point, details.conv-fold):not(#live-bubble, .review-info)')]
      .map((row) => row.matches('.fork-point') ? `fork:${row.textContent.trim()}` : row.matches('details') ? 'fold' : row.querySelector('.msg-text')?.textContent.trim()));
    assert.deepEqual(order, ['Pick a codeword and note it down.', 'fold', 'The codeword is heron.', 'fork:Forked from #7 Pick a codeword',
      'What was the codeword?', 'It was heron.'], 'the source task reads first, its work folded, the fork marked where it happened');
    assert.match(await thread.locator('.fork-point a').getAttribute('href'), /\/tasks\/7$/, 'the line links to the source task');
    assert.equal(await thread.locator('[data-land]').getAttribute('data-conversation-key'), 'message:a1', "the page still lands on this task's own answer");

    // ── ⌘F finds in the whole conversation ──
    await thread.click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+f');
    const input = page.locator('#ck-find-input');
    await input.waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'ck-find-input', '⌘F puts the cursor in the find box');
    await input.fill('HERON');
    const count = page.locator('.ck-find-count');
    const current = () => page.evaluate(() => {
      const range = [...(CSS.highlights.get('conversation-search-current') || [])][0];
      const el = range?.startContainer.parentElement;
      return range && { text: range.toString(), fold: !!el.closest('details.conv-fold'), open: !!el.closest('details.conv-fold')?.open,
        inherited: !!el.closest('[data-conversation-key^="fork:"]'), marks: CSS.highlights.get('conversation-search').size };
    });
    assert.equal(await count.innerText(), '1/3', 'every match counts, case-insensitively: a folded step, the inherited answer and this task\'s');
    assert.deepEqual(await current(), { text: 'heron', fold: true, open: true, inherited: true, marks: 3 },
      'the first match is the folded step, and its fold opens to show it');
    await input.press('Enter');
    assert.equal(await count.innerText(), '2/3');
    assert.deepEqual(await current(), { text: 'heron', fold: false, open: false, inherited: true, marks: 3 }, 'a match across bold text is found');
    await input.press('Enter');
    assert.equal(await count.innerText(), '3/3');
    assert.equal((await current()).inherited, false, "the last match is in this task's own answer");
    await input.press('Enter');
    assert.equal(await count.innerText(), '1/3', 'Enter wraps around');
    await input.press('Shift+Enter');
    assert.equal(await count.innerText(), '3/3', 'Shift+Enter goes back');

    // A live refresh keeps the box, what is typed in it and the marks; new text is found.
    sockets.at(-1).send(JSON.stringify({ seq: 50, type: 'agent.activity', taskId: 'f', projectId: 'p', ts: Date.now(),
      payload: { role: 'do', turnId: 'turn-9', attempt: 1, id: 'cmd-9', kind: 'command', phase: 'completed', title: 'echo heron again' } }));
    await page.waitForFunction(() => document.querySelector('.ck-find-count')?.textContent === '3/4');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'ck-find-input', 'the find box keeps the cursor through a refresh');
    assert.equal(await input.inputValue(), 'HERON');

    await input.fill('no such words');
    assert.equal(await count.innerText(), '0/0');
    assert.equal(await page.locator('#ck-find.empty').count(), 1, 'nothing found reads so');

    // Esc closes it and wipes the marks; the toolbar's Find opens it again.
    await input.press('Escape');
    await page.locator('#ck-find').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => CSS.highlights.has('conversation-search')), false, 'no marks stay behind');
    await page.locator('#find-in-conversation').click();
    await input.waitFor();
    assert.equal(await page.locator('#find-in-conversation').getAttribute('aria-pressed'), 'true');

    assert.deepEqual(errors, []);
    console.log('conversation-fork-search: ok');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
