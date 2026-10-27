// The conversation reads like a page, not a chat log of boxes: the agent's
// answers are unboxed prose at body size with comfortable leading on one
// reading measure; a person's turn is a soft tinted bubble with ordinary ink
// (not reversed white-on-accent); actionable cards (input requests) stay
// boxed; and the work folded between answers reads a step smaller.
// Run: node web/conversation-reading.browser.test.cjs
const assert = require('node:assert/strict');
const { fakeConsole, launch } = require('../tests/helpers/fake-console.cjs');

const T0 = Date.now() - 3600_000;
const prose = 'The post builds a bridge between multi-agent reinforcement learning, asset pricing and Bayesian belief aggregation. '.repeat(4);
const answer = `${prose}\n\n## Why price recursion\n\n1. A betting price that admits a sure loss is incoherent.\n2. So is a reward hack.\n\n| Belief | Reward |\n| --- | --- |\n| Prices | Marginal rewards |`;
const messages = [
  { id: 'm0', role: 'user', author: 'user:u', text: 'What is the core claim?', ts: T0 },
  { id: 'a1', role: 'agent', text: answer, ts: T0 + 60_000 },
];
const events = [
  { seq: 1, type: 'agent.activity', taskId: 't', ts: T0 + 10_000, payload: { role: 'do', turnId: 't1', attempt: 1, id: 'c1', kind: 'command', phase: 'completed', title: 'npm test' } },
  { seq: 2, type: 'agent.activity', taskId: 't', ts: T0 + 20_000, payload: { role: 'do', turnId: 't1', attempt: 1, id: 'n1', kind: 'message', title: 'Reading the post first.' } },
];

(async () => {
  const browser = await launch();
  try {
    const project = { id: 'p', organizationId: 'o', name: 'Workspace', config: {} };
    const task = { id: 't', projectId: 'p', num: 1, title: 'Price recursion', workflow: 'software-dev', params: {}, tags: [], lastView: { stage: 'do', status: 'waiting' } };
    const view = { taskId: 't', stage: 'do', status: 'waiting', workflow: 'software-dev', messages, actions: [{ name: 'followUp', label: 'Send', enabled: true }],
      waitingFor: { kind: 'human', reason: 'question', detail: 'Should I also cover the second article?' } };
    for (const scheme of ['light', 'dark']) {
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, colorScheme: scheme });
      await fakeConsole(context, { project, tasks: [task], async api(p) {
        if (p === '/api/tasks/t') return view;
        if (p.endsWith('/events')) return events;
        return undefined;
      } });
      context.setDefaultTimeout(8000);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto('http://console.test/org/workspace');
      await page.locator('[data-id="t"] .row-link').click();
      await page.locator('#ck-thread .msg.agent .md-table').waitFor();
      await page.locator('details.conv-fold > summary').first().click();
      await page.locator('#ck-thread .fold-body .msg.agent').waitFor();

      const r = await page.evaluate(() => {
        const css = (el) => getComputedStyle(el);
        const px = (v) => parseFloat(v);
        const thread = document.querySelector('#ck-thread');
        const agent = [...thread.querySelectorAll(':scope > .thread > .msg.agent')].find((el) => el.querySelector('.md-table'));
        const user = thread.querySelector('.msg.user');
        const ask = thread.querySelector('.msg.input-request');
        const folded = thread.querySelector('.fold-body .msg.agent');
        const paragraph = agent.querySelector('.md-p');
        // Average characters per line of a long paragraph.
        const range = document.createRange(); range.selectNodeContents(paragraph);
        const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
        const a = css(agent), u = css(user), p = css(paragraph);
        return {
          size: px(p.fontSize), leading: px(p.lineHeight) / px(p.fontSize),
          charsPerLine: paragraph.textContent.length / lines,
          agentBox: { bg: a.backgroundColor, border: a.borderTopWidth, padding: a.paddingLeft },
          userBg: u.backgroundColor, userInk: u.color, threadBg: css(thread).backgroundColor, ink: css(document.body).color,
          userRight: Math.round(user.getBoundingClientRect().right), agentRight: Math.round(agent.getBoundingClientRect().right),
          askBorder: px(css(ask).borderTopWidth) + px(css(ask).borderLeftWidth), askBg: css(ask).backgroundColor,
          foldedSize: px(css(folded.querySelector('.msg-text')).fontSize),
          composerSize: px(css(document.querySelector('.ck-compose .followup-input')).fontSize),
        };
      });

      assert.ok(r.size >= 16, `${scheme}: answers read at body size (got ${r.size}px)`);
      assert.ok(r.leading >= 1.5 && r.leading <= 1.75, `${scheme}: leading ${r.leading}`);
      assert.ok(r.charsPerLine >= 60 && r.charsPerLine <= 90, `${scheme}: ~60–90 characters per line (got ${r.charsPerLine.toFixed(1)})`);
      assert.equal(r.agentBox.bg, 'rgba(0, 0, 0, 0)', `${scheme}: an answer is not a box`);
      assert.equal(r.agentBox.border, '0px', `${scheme}: an answer has no border`);
      assert.equal(r.agentBox.padding, '0px', `${scheme}: an answer's text aligns with the column`);
      assert.equal(r.userInk, r.ink, `${scheme}: a person's turn is ordinary ink, not reversed text`);
      assert.notEqual(r.userBg, r.threadBg, `${scheme}: a person's turn is tinted`);
      assert.equal(r.userRight, r.agentRight, `${scheme}: both sides share one reading column`);
      assert.ok(r.askBorder > 0 && r.askBg !== 'rgba(0, 0, 0, 0)', `${scheme}: an input request stays a card`);
      assert.ok(r.foldedSize < r.size, `${scheme}: folded work reads a step down (${r.foldedSize}px)`);
      assert.equal(r.composerSize, r.size, `${scheme}: one types at the size one reads`);
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('conversation reading: ok');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
