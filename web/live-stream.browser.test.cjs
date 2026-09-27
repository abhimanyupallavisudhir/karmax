// LT-5: agent text streams into the open conversation as it is generated.
// Full console shell, trusted Chromium, deterministic local API/WS fakes.
// Run: node web/live-stream.browser.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const requests = [], errors = [], sockets = [];
    const project = { id: 'p', organizationId: 'o', name: 'Workspace', config: {} };
    const task = { id: 't', projectId: 'p', num: 1, title: 'Stream the reply', workflow: 'software-dev', params: {}, tags: [], lastView: { stage: 'do', status: 'active' } };
    const schema = [{ name: 'software-dev', params: [{ name: 'prompt', type: 'text', label: 'Prompt', scopes: ['task'], bind: 'prompt' }], stages: [{ key: 'do', label: 'Working' }] }];
    let view = { taskId: 't', projectId: 'p', title: task.title, workflow: 'software-dev', stage: 'do', status: 'active', actions: [], state: {},
      messages: [{ id: 'm1', role: 'user', text: 'Fix the parser', ts: 1 }], agentTurn: { turnId: 'turn-1', role: 'do', state: 'running' } };
    const turn = { role: 'do', turnId: 'turn-1', attempt: 1 };
    const events = [{ seq: 1, type: 'agent.activity', taskId: 't', ts: 2, payload: { ...turn, id: 'msg-0', kind: 'message', phase: 'completed', title: 'Reading the parser first.' } }];
    await context.routeWebSocket('**/ws*', ws => { sockets.push(ws); });
    await context.route('http://console.test/**', async route => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname;
      if (!p.startsWith('/api/')) {
        const file = ['/app.js', '/styles.css', '/markdown.js', '/totp-qr.js', '/register-service-worker.js'].includes(p) ? p.slice(1) : 'index.html';
        return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: fs.readFileSync(path.join(__dirname, file), 'utf8') });
      }
      requests.push(`${req.method()} ${p}`);
      let data = [];
      if (p === '/api/meta') data = { siteName: 'Fixture', hostLocal: true, consoleRevision: 'one', agent: { provider: 'mock' }, worldProviders: [] };
      else if (p === '/api/launch') data = {};
      else if (p === '/api/session') data = { authenticated: true, user: { id: 'u', name: 'Tester' } };
      else if (p === '/api/settings/installation') data = { canManage: false };
      else if (p === '/api/organizations') data = [{ id: 'o', name: 'Organization', slug: 'org' }];
      else if (p === '/api/user/default-organization') data = { organizationId: 'o' };
      else if (p === '/api/projects') data = [project];
      else if (p === '/api/projects/p') data = project;
      else if (p === '/api/schema') data = schema;
      else if (p === '/api/contributions') data = { slots: [], commands: [], events: [] };
      else if (p === '/api/models') data = { providers: [] };
      else if (p.endsWith('/defaults')) data = { effective: {}, inherited: {} };
      else if (p === '/api/projects/p/tasks') data = [task];
      else if (p === '/api/projects/p/search' || p === '/api/search') data = p === '/api/search' ? [{ projectId: 'p', tasks: [task], total: 1 }] : { tasks: [task], total: 1 };
      else if (p === '/api/tasks/t') data = view;
      else if (p.endsWith('/sessions')) data = {};
      else if (p.endsWith('/attempts')) data = { principalAttemptId: 't', attempts: [task] };
      else if (p.endsWith('/events')) data = events;
      return route.fulfill({ json: data });
    });
    context.setDefaultTimeout(8000);
    const page = await context.newPage();
    page.on('pageerror', error => { errors.push(error.message); console.error('page:', error.message); });
    await page.goto('http://console.test/org/workspace');
    await page.locator('[data-id="t"] .row-link').click();
    await page.getByRole('tab', { name: 'Check-in' }).or(page.getByText('Check-in', { exact: true })).first().click();
    await page.locator('#ck-thread').getByText('Reading the parser first.').waitFor();
    await page.waitForTimeout(300); // let the task page settle before measuring reads

    let seq = 10;
    // The newest socket: the console reconnects after a drop.
    const send = (type, payload) => { const event = { seq: seq++, type, taskId: 't', projectId: 'p', ts: Date.now(), payload }; sockets.at(-1).send(JSON.stringify(event)); return event; };
    const hidden = (value) => page.evaluate((value) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value ? 'hidden' : 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    }, value);
    const bubbleGone = () => page.waitForFunction(() => !document.getElementById('live-bubble') || document.getElementById('live-bubble').classList.contains('hidden'));
    const bubble = () => page.evaluate(() => {
      const b = document.getElementById('live-bubble');
      return b && !b.classList.contains('hidden') && b.getClientRects().length ? b.textContent.replace(/^agent · live/, '') : null;
    });
    const occurrences = (text) => page.evaluate((t) => document.getElementById('ck-thread').textContent.split(t).length - 1, text);
    // Mark an existing row: streaming must patch the bubble, never repaint the thread.
    await page.evaluate(() => { document.querySelector('#ck-thread [data-conversation-key^="activity:"]').dataset.sentinel = 'kept'; });
    const readsBefore = requests.length;

    // 1. The first coalesced chunk appears at once, then the text grows in place.
    const reply = 'The parser drops the last token when a line ends without a newline; I am fixing the loop bound now.';
    const chunks = reply.match(/.{1,12}/g).map((_, i, all) => all.slice(0, i + 1).join(''));
    const delays = [];
    for (const text of chunks) {
      const sent = Date.now();
      send('agent.output', { ...turn, text, source: 'assistant' });
      await page.waitForFunction((t) => document.getElementById('live-bubble')?.textContent.endsWith(t), text);
      delays.push(Date.now() - sent);
      await page.waitForTimeout(150);
    }
    assert.equal(await bubble(), reply, 'the live bubble shows the whole text so far');
    assert.equal(await page.locator('[data-sentinel="kept"]').count(), 1, 'streaming does not repaint existing rows');
    assert.equal(requests.length, readsBefore, 'streamed chunks perform no API reads');

    // 2. Tool lines are timeline rows of their own; they never replace the text.
    send('agent.output', { ...turn, text: '$ npm test' });
    await page.waitForTimeout(100);
    assert.equal(await bubble(), reply, 'a tool line does not replace the streamed text');

    // 3. The completed message replaces the bubble: the final text appears exactly once.
    send('agent.activity', { ...turn, id: 'msg-1', kind: 'message', phase: 'completed', title: reply });
    await page.waitForFunction(() => document.getElementById('live-bubble')?.classList.contains('hidden') !== false);
    await page.locator('#ck-thread [data-conversation-key]').getByText('I am fixing the loop bound now.').waitFor();
    assert.equal(await occurrences('I am fixing the loop bound now.'), 1, 'the final message is shown once, not duplicated by the bubble');

    // 4. The next message streams again after structured messages exist.
    send('agent.output', { ...turn, text: 'Running', source: 'assistant' });
    await page.waitForFunction(() => document.getElementById('live-bubble')?.textContent.endsWith('Running'));
    assert.equal(await bubble(), 'Running');

    // 5. Another agent streaming at the same time (the Review gate's confirmer)
    // keeps its own text: it never lands in this conversation, and neither its
    // chunks nor its finished message clear or flicker this agent's text.
    send('agent.output', { role: 'confirm', turnId: 'confirm-1', attempt: 1, text: 'Reviewing the diff', source: 'assistant' });
    await page.waitForTimeout(100);
    assert.equal(await bubble(), 'Running', "another agent's chunk leaves this agent's text in place");
    send('agent.activity', { role: 'confirm', turnId: 'confirm-1', attempt: 1, id: 'confirm-msg', kind: 'message', phase: 'completed', title: 'Reviewing the diff now' });
    send('agent.activity', { ...turn, id: 'cmd-1', kind: 'command', phase: 'started', title: 'npm test' });
    await page.locator('#ck-thread').getByText('npm test').first().waitFor();
    assert.equal(await bubble(), 'Running', "another agent's finished message does not clear this agent's text");
    assert.equal(await occurrences('Reviewing the diff'), 0, "the confirmer's text never lands in the Do conversation");
    send('agent.output', { ...turn, text: 'Running the suite', source: 'assistant' });
    await page.waitForFunction(() => document.getElementById('live-bubble')?.textContent.endsWith('Running the suite'));

    // 6. A failed attempt voids its partial text; the retry streams afresh.
    send('agent.activity', { ...turn, id: 'turn', kind: 'turn', phase: 'failed', title: 'Agent turn failed' });
    await page.waitForFunction(() => document.getElementById('live-bubble')?.classList.contains('hidden') !== false);
    assert.equal(await occurrences('Running the suite'), 0, 'a failed attempt leaves no half message behind');
    const retry = { ...turn, attempt: 2 };
    const retrying = send('agent.output', { ...retry, text: 'Retrying the fix', source: 'assistant' });
    await page.waitForFunction(() => document.getElementById('live-bubble')?.textContent.endsWith('Retrying the fix'));

    // #396 review item 5. A message that completes while the tab is hidden (its
    // events are dropped) is gone from the bubble once the tab is shown again.
    await hidden(true);
    const done = send('agent.activity', { ...retry, id: 'msg-2', kind: 'message', phase: 'completed', title: 'Retrying the fix worked.' });
    events.push(retrying, done);
    await hidden(false);
    await page.locator('#ck-thread [data-conversation-key]').getByText('Retrying the fix worked.').waitFor();
    await bubbleGone();
    assert.equal(await occurrences('Retrying the fix worked.'), 1, 'the completed message is shown once, with no half message beside it');

    // A message that completes while the socket is down is gone once it reconnects.
    const checking = send('agent.output', { ...retry, text: 'Checking the tests', source: 'assistant' });
    await page.waitForFunction(() => document.getElementById('live-bubble')?.textContent.endsWith('Checking the tests'));
    const socketsBefore = sockets.length;
    await sockets.at(-1).close();
    events.push(checking, { seq: seq++, type: 'agent.activity', taskId: 't', ts: Date.now(), payload: { ...retry, id: 'msg-3', kind: 'message', phase: 'completed', title: 'Checking the tests passed.' } });
    while (sockets.length === socketsBefore) await page.waitForTimeout(50); // the console reconnects by itself
    await page.locator('#ck-thread [data-conversation-key]').getByText('Checking the tests passed.').waitFor();
    await bubbleGone();

    // A page opened mid-stream shows the text so far, from history alone.
    events.push({ seq: seq++, type: 'agent.output', taskId: 't', ts: Date.now(), payload: { ...retry, text: 'Now updating the docs', source: 'assistant' } });
    await page.reload();
    await page.locator('#ck-thread').getByText('Checking the tests passed.').waitFor();
    await page.waitForFunction(() => document.getElementById('live-bubble')?.textContent.endsWith('Now updating the docs'));

    // 8. Cancelling the task clears the half message; it never renders as final.
    view = { ...view, status: 'cancelled', stage: 'cancelled', agentTurn: undefined };
    send('view.updated', { stage: 'cancelled', status: 'cancelled' });
    await page.waitForFunction(() => !document.getElementById('live-bubble') || document.getElementById('live-bubble').classList.contains('hidden'));
    assert.equal(await occurrences('Now updating the docs'), 0, 'a cancelled turn leaves no half message looking final');

    assert.deepEqual(errors, []);
    delays.sort((a, b) => a - b);
    console.log(`Live streaming: ok (${chunks.length} chunks; socket→bubble median ${delays[delays.length >> 1]} ms, max ${delays.at(-1)} ms)`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
