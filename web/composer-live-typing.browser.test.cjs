// Real browser regression: typing in a task's message box on a phone while
// its agent works. Every event of a working agent repaints the task page; the
// box's text field must survive those repaints as the same element — a phone
// keyboard composes the word being typed (autocorrect, swipe, dictation) in
// that element, and replacing it, even with focus and caret given back, drops
// the word and (on iOS) the keyboard: the page "glitched" with every event.
// The composition is Chromium's own IME (CDP Input.imeSetComposition).
// Run: node web/composer-live-typing.browser.test.cjs
const assert = require('node:assert/strict');
const { fakeConsole, launch } = require('../tests/helpers/fake-console.cjs');

(async () => {
  const browser = await launch();
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const errors = [];
    const project = { id: 'p', organizationId: 'o', name: 'Workspace', config: {} };
    const task = { id: 't', projectId: 'p', num: 1, title: 'Tidy the header', workflow: 'software-dev', params: {}, tags: [], lastView: { stage: 'do', status: 'active' } };
    const schema = [{ name: 'software-dev', params: [], stages: [{ key: 'do', label: 'Working' }] }];
    const followUp = { name: 'followUp', label: 'Send', enabled: true, args: ['text'] };
    const view = { taskId: 't', projectId: 'p', title: task.title, workflow: 'software-dev', stage: 'do', status: 'active', state: {},
      actions: [followUp], messages: [{ id: 'm1', role: 'user', text: 'Tidy the header', ts: 1 }], agentTurn: { turnId: 'turn-1', role: 'do', state: 'running' } };
    const turn = { role: 'do', turnId: 'turn-1', attempt: 1 };
    const sent = [];
    const { sockets } = await fakeConsole(context, { project, tasks: [task], schema, api(p, request) {
      if (p === '/api/tasks/t') return view;
      if (p === '/api/tasks/t/signal' && request.method() === 'POST') { sent.push(request.postDataJSON()); return {}; }
      return undefined;
    } });
    context.setDefaultTimeout(8000);
    const page = await context.newPage();
    page.on('pageerror', (error) => { errors.push(error.message); console.error('page:', error.message); });
    await page.goto('http://console.test/org/workspace/tasks/1/checkin');
    const box = page.locator('.followup-box[data-role="do"] .followup-input');
    await box.waitFor();
    await page.waitForTimeout(300);

    let seq = 10, rows = 0;
    const send = (type, payload) => sockets.at(-1).send(JSON.stringify({ seq: seq++, type, taskId: 't', projectId: 'p', ts: Date.now(), payload }));
    // Each completed step of the agent adds a row to the conversation: a repaint.
    const agentWorks = async (count) => {
      for (let i = 0; i < count; i++) {
        const title = `Step ${++rows} of the work.`;
        send('agent.activity', { ...turn, id: `step-${rows}`, kind: 'message', phase: 'completed', title });
        await page.locator('#ck-thread').getByText(title).waitFor();
      }
      await page.waitForTimeout(100);
    };
    const field = () => page.evaluate(() => {
      const el = document.querySelector('.followup-box[data-role="do"] .followup-input');
      return { kept: el?.marked === true, focused: document.activeElement === el, value: el?.value, caret: el?.selectionStart,
        placeholder: el?.placeholder, disabled: el?.disabled };
    });

    await box.tap();
    await page.keyboard.type('Make the header');
    await page.evaluate(() => { document.querySelector('.followup-box[data-role="do"] .followup-input').marked = true; });

    // 1. Plain typing between events: the same field, focused, its text and caret as they were.
    await agentWorks(3);
    assert.deepEqual(await field(), { kept: true, focused: true, value: 'Make the header', caret: 15, placeholder: 'Message the agent', disabled: false },
      'the agent working does not replace the field being typed in');
    await page.keyboard.type(' sticky');
    assert.equal((await field()).value, 'Make the header sticky', 'typing continues where it was');

    // 2. A word the keyboard is still composing survives the agent's events.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'an', selectionStart: 2, selectionEnd: 2 });
    await agentWorks(2);
    await cdp.send('Input.imeSetComposition', { text: 'and', selectionStart: 3, selectionEnd: 3 });
    await cdp.send('Input.insertText', { text: 'and' });
    assert.equal((await field()).value, 'Make the header stickyand',
      'the composed word lands once, in the field it was composed in');
    const state = await field();
    assert.ok(state.kept && state.focused, 'still the same, focused field after composing');

    // 3. What the conversation says about the box still reaches it: the agent stops, Send is offered as before.
    view.agentTurn = undefined;
    view.status = 'waiting';
    send('view.updated', view);
    await page.waitForTimeout(400);
    assert.ok((await field()).kept, 'kept across a view update too');

    // 4. Send still sends what the box shows, and the box empties.
    await page.locator('.followup-send').tap();
    await page.waitForFunction(() => document.querySelector('.followup-input')?.value === '');
    assert.equal(sent.at(-1)?.text, 'Make the header stickyand');
    assert.deepEqual(errors, []);
    console.log('composer-live-typing: ok');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
