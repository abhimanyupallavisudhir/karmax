// A long task's page reads the newest messages of its conversation and earlier
// ones as the reader asks: the Earlier control, scrolling up to it, or Find,
// which reads all of them. A refresh re-reads the messages only when they
// changed, and keeps the earlier ones the page already read. Nothing from
// before the first message read is drawn (wiki ops/performance-history,
// pramana#137).
// Run: node web/conversation-window.browser.test.cjs
const assert = require('node:assert/strict');
const { conversationWindowApi, fakeConsole, launch, taskView } = require('../tests/helpers/fake-console.cjs');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const browser = await launch();
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
    const errors = [];
    const project = { id: 'p', organizationId: 'o', name: 'Workspace', config: {} };
    const task = { id: 't', projectId: 'p', num: 1, title: 'A month of work', workflow: 'software-dev', params: {}, tags: [], lastView: { stage: 'do', status: 'waiting' } };
    const T0 = Date.now() - 30 * 86400_000;
    const message = (i) => i % 2
      ? { id: `a${i}`, role: 'agent', text: `Answer ${i}: done with step ${i}.`, ts: T0 + i * 60_000 }
      : { id: `m${i}`, role: 'user', text: `Question ${i}: please do step ${i + 1}.`, author: 'u', ts: T0 + i * 60_000 };
    const messages = Array.from({ length: 450 }, (_, i) => message(i));
    const view = () => taskView(task, { status: 'waiting', messages, transcripts: [{ role: 'do', label: 'Do agent', messages }],
      waitingFor: { kind: 'human' }, actions: [{ name: 'followUp', enabled: true }], updatedAt: messages.length });
    const windowed = conversationWindowApi('t', view);
    const reads = [];
    // An event from before the window: a tool step of an early turn.
    const events = [{ seq: 1, type: 'agent.activity', taskId: 't', ts: T0 + 5 * 60_000,
      payload: { role: 'do', turnId: 'early', id: 'tool-1', kind: 'tool', phase: 'completed', title: 'Ran the early migration' } }];
    const { sockets } = await fakeConsole(context, { project, tasks: [task], api(p, _request, url) {
      if (p === '/api/tasks/t' || p === '/api/tasks/t/transcript') reads.push(`${p}${url.search}`);
      if (p === '/api/tasks/t/events') return events;
      return windowed(p, url);
    } });
    context.setDefaultTimeout(8000);
    const page = await context.newPage();
    page.on('pageerror', (error) => { errors.push(error.message); console.error('page:', error.message); });
    const rows = () => page.locator('#ck-thread [data-conversation-key^="message:"]').count();
    const shown = (id) => page.locator(`#ck-thread [data-conversation-key="message:${id}"]`).count();

    await page.goto('http://console.test/org/workspace/tasks/1/checkin');
    const earlier = page.locator('#ck-thread [data-earlier-messages]');
    await earlier.waitFor();
    assert.equal(reads[0], '/api/tasks/t?messages=100', 'the page reads the newest 100 messages');
    assert.equal(await rows(), 100);
    assert.equal(await shown('a449'), 1, 'the newest message is there');
    assert.equal(await shown('a349'), 0, 'one before the window is not');
    assert.equal((await earlier.innerText()).trim(), '350 earlier messages');
    assert.equal(await page.locator('#ck-thread').getByText('Ran the early migration').count(), 0, 'an event from before the window waits for its messages');

    // A refresh whose conversation did not change re-reads none of it.
    reads.length = 0;
    sockets.at(-1).send(JSON.stringify({ type: 'view.updated', taskId: 't', projectId: 'p', ts: Date.now(), payload: { stage: 'do', status: 'waiting' } }));
    await page.waitForFunction(() => true);
    await wait(400);
    assert.match(reads[0] || '', /^\/api\/tasks\/t\?messages=100&known=/, 'the refresh names the revision it holds');
    assert.equal(await rows(), 100, 'and keeps what it shows');

    // Earlier: the next 200, the reader's place kept.
    const before = await page.evaluate(() => {
      const thread = document.getElementById('ck-thread');
      thread.scrollTop = 0;
      const row = thread.querySelector('[data-conversation-key="message:m350"]');
      return row.getBoundingClientRect().top;
    });
    await earlier.click();
    await page.waitForFunction(() => document.querySelectorAll('#ck-thread [data-conversation-key^="message:"]').length === 300);
    assert.equal(reads.at(-1), '/api/tasks/t/transcript?role=do&before=350&limit=200');
    const after = await page.evaluate(() => document.querySelector('#ck-thread [data-conversation-key="message:m350"]').getBoundingClientRect().top);
    assert.ok(Math.abs(after - before) < 2, `the row the reader was at stays put (${before} → ${after})`);
    assert.equal((await earlier.innerText()).trim(), '150 earlier messages');

    // A new message: the window moves, and the earlier messages read stay.
    messages.push(message(450));
    sockets.at(-1).send(JSON.stringify({ type: 'view.updated', taskId: 't', projectId: 'p', ts: Date.now(), payload: { stage: 'do', status: 'waiting' } }));
    await page.waitForFunction(() => !!document.querySelector('#ck-thread [data-conversation-key="message:m450"]'));
    assert.equal(await rows(), 301, 'the new message joins what was read');
    assert.equal(await shown('m150'), 1);

    // Scrolling up to the top reads the next page, as in a chat.
    await page.locator('#ck-thread').hover();
    await page.mouse.wheel(0, -100000);
    await page.waitForFunction(() => !document.querySelector('#ck-thread [data-earlier-messages]'));
    assert.equal(await rows(), 451, 'every message read');
    assert.equal(await page.locator('#ck-thread').getByText('Ran the early migration').count(), 1, 'with the early event, now that its messages are here');

    // Find reads the whole conversation of a task opened afresh.
    await page.goto('http://console.test/org/workspace/tasks/1/checkin');
    await earlier.waitFor();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
    await page.locator('#ck-find-input').fill('Question 2:');
    await page.waitForFunction(() => !document.querySelector('#ck-thread [data-earlier-messages]'));
    await page.waitForFunction(() => /^1\/1$/.test(document.querySelector('.ck-find-count')?.textContent || ''));
    assert.equal(await rows(), 451);

    assert.deepEqual(errors, []);
    console.log('Conversation window: ok');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exit(1); });
