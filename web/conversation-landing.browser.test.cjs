// Coming back to a task shows the answer to the latest thing you asked, from its
// first line — not the previous round's report — even though the page draws
// before its history arrives and history replaces the answer's row with the
// provider's copy (task #704, 2026-10-19). And watching the agent work on a
// follow-up, its answer opens at its first line when it lands.
// Run: node web/conversation-landing.browser.test.cjs
const assert = require('node:assert/strict');
const { fakeConsole, launch, taskView } = require('../tests/helpers/fake-console.cjs');

const lines = (head, n) => [head, '', ...Array.from({ length: n }, (_, i) => `- Point ${i + 1} of the answer, said at some length.`)].join('\n');
const T0 = Date.now() - 3 * 3600_000;
const at = (minutes) => T0 + minutes * 60_000;
const report = lines('Managed compute is now on in production.', 40);
const answer = lines('Yes, the code supports all four as managed compute.', 40);
const question = 'BTW, managed compute is supported for all, right?';
const step = (seq, turnId, id, minutes, extra = {}) => ({ seq, type: 'agent.activity', taskId: 't', ts: at(minutes),
  payload: { role: 'do', turnId, attempt: 1, id, kind: 'command', phase: 'completed', title: `npm test ${id}`, ...extra } });
const said = (seq, turnId, id, minutes, text) => step(seq, turnId, id, minutes, { kind: 'message', title: text });
const firstRound = [step(1, 't1', 'c1', 1), step(2, 't1', 'c2', 2), step(3, 't1', 'c3', 3), said(4, 't1', 'r1', 40, report)];
const secondRound = [step(5, 't2', 'd1', 91), step(6, 't2', 'd2', 92), said(7, 't2', 'r2', 95, answer)];
const base = [
  { id: 'm0', role: 'user', text: 'Switch on managed compute.', ts: at(0) },
  { id: 'a1', role: 'agent', text: report, ts: at(40), sourceActivity: { turnId: 't1', id: 'r1', attempt: 1 } },
  { id: 'u2', role: 'user', author: 'user:u', text: question, ts: at(90) },
];
const reply = { id: 'a3', role: 'agent', text: answer, ts: at(95), sourceActivity: { turnId: 't2', id: 'r2', attempt: 1 } };

// Where a message's first line sits in the conversation's window, if it shows.
const shows = (page, text) => page.evaluate((text) => {
  const thread = document.getElementById('ck-thread');
  const box = thread.getBoundingClientRect();
  const row = [...thread.querySelectorAll('.msg')].find((el) => el.textContent.includes(text) && el.getClientRects().length);
  if (!row) return false;
  const top = row.querySelector('.msg-text')?.getBoundingClientRect().top ?? row.getBoundingClientRect().top;
  return top >= box.top && top + 16 <= box.bottom;
}, text);

(async () => {
  const browser = await launch();
  try {
    const project = { id: 'p', organizationId: 'o', name: 'Workspace', config: {} };
    const task = { id: 't', projectId: 'p', num: 1, title: 'Managed compute', workflow: 'software-dev', params: {}, tags: [], lastView: { stage: 'do', status: 'waiting' } };
    const open = async (state) => {
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 760 } });
      const fake = await fakeConsole(context, { project, tasks: [task], async api(p) {
        if (p === '/api/tasks/t') return state.view;
        // History arrives after the page has drawn, as it does on a busy task.
        if (p.endsWith('/events')) { await new Promise((r) => setTimeout(r, 700)); return state.events; }
        return undefined;
      } });
      context.setDefaultTimeout(8000);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => { errors.push(error.message); console.error('page:', error.message); });
      await page.goto('http://console.test/org/workspace');
      await page.locator('[data-id="t"] .row-link').click();
      await page.locator('#ck-thread .msg').first().waitFor();
      return { page, errors, sockets: fake.sockets, context };
    };

    // 1. Coming back: the agent has answered a follow-up after its report.
    const waiting = { view: taskView(task, { messages: [...base, reply], stage: 'do', status: 'waiting', waitingFor: { kind: 'human', detail: answer },
      actions: [{ name: 'followUp', enabled: true }] }), events: [...firstRound, ...secondRound] };
    let { page, errors, context } = await open(waiting);
    await page.locator('#ck-thread details.conv-fold').first().waitFor(); // history has arrived
    await page.waitForTimeout(300);
    assert.equal(await shows(page, 'Yes, the code supports all four'), true, 'the answer to the latest question opens at its first line');
    assert.equal(await shows(page, 'Managed compute is now on in production.'), false, 'not the previous round\'s report');
    assert.deepEqual(errors, []);
    await context.close();

    // 2. Watching: the agent works on the follow-up, then answers it.
    const watching = { view: taskView(task, { messages: base, stage: 'do', status: 'active', agentTurn: { role: 'do', state: 'running', turnId: 't2' },
      actions: [{ name: 'followUp', enabled: true }] }), events: [...firstRound, ...secondRound.slice(0, 2)] };
    let sockets;
    ({ page, errors, sockets, context } = await open(watching));
    await page.getByText('npm test d2').waitFor();
    assert.equal(await shows(page, question), true, 'while it works, your question and its live work show');
    watching.view = { ...watching.view, messages: [...base, reply], status: 'waiting', agentTurn: undefined, waitingFor: { kind: 'human', detail: answer }, updatedAt: Date.now() };
    watching.events = [...firstRound, ...secondRound];
    sockets.at(-1).send(JSON.stringify({ ...secondRound[2], projectId: 'p' }));
    sockets.at(-1).send(JSON.stringify({ seq: 8, type: 'view.updated', taskId: 't', projectId: 'p', ts: Date.now(), payload: { stage: 'do', status: 'waiting', waitingFor: 'human' } }));
    await page.locator('#ck-thread details.conv-fold:not([open])').last().waitFor(); // the work folded under its answer
    await page.waitForTimeout(300);
    assert.equal(await shows(page, 'Yes, the code supports all four'), true, 'the answer opens at its first line when it lands');
    assert.deepEqual(errors, []);
    await context.close();
    // 3. Reading back: a reader who scrolled up to the first report stays there
    // when the answer lands; nothing yanks them away.
    const reading = { view: { ...watching.view, messages: base, status: 'active', agentTurn: { role: 'do', state: 'running', turnId: 't2' }, waitingFor: undefined },
      events: [...firstRound, ...secondRound.slice(0, 2)] };
    ({ page, errors, sockets, context } = await open(reading));
    await page.getByText('npm test d2').waitFor();
    await page.evaluate(() => { const t = document.getElementById('ck-thread'); t.scrollTop = 0; });
    await page.waitForTimeout(200);
    reading.view = { ...reading.view, messages: [...base, reply], status: 'waiting', agentTurn: undefined, waitingFor: { kind: 'human', detail: answer }, updatedAt: Date.now() };
    reading.events = [...firstRound, ...secondRound];
    sockets.at(-1).send(JSON.stringify({ ...secondRound[2], projectId: 'p' }));
    sockets.at(-1).send(JSON.stringify({ seq: 8, type: 'view.updated', taskId: 't', projectId: 'p', ts: Date.now(), payload: { stage: 'do', status: 'waiting', waitingFor: 'human' } }));
    await page.locator('#ck-thread details.conv-fold:not([open])').last().waitFor();
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.getElementById('ck-thread').scrollTop), 0, 'a reader reading back is left where they are');
    // 4. Sending a follow-up shows the end, where it and its work appear.
    const box = page.locator('.followup-input');
    await box.fill('One more thing: check Fly too.');
    await page.route('**/api/tasks/t/signal', (route) => route.fulfill({ json: { message: { id: 'u9', role: 'user', author: 'user:u', text: 'One more thing: check Fly too.', ts: Date.now() } } }));
    await page.locator('.followup-send').click();
    await page.getByText('One more thing: check Fly too.').last().waitFor();
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => { const t = document.getElementById('ck-thread'); return t.scrollHeight - t.scrollTop - t.clientHeight <= 2; }), true, 'sending shows the end of the conversation');
    assert.deepEqual(errors, []);
    await context.close();
    console.log('conversation-landing: ok');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
