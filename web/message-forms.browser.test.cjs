// An agent's form, end to end in the console: every unanswered one is live,
// however far the conversation has moved on; what a person submits is sent as their ordinary reply; a quick
// question answers in one click; a form that saves writes the setting from the
// person's browser and tells the agent only that it was saved — the secret
// never enters the conversation; a form that would leak a secret or write
// outside settings is not shown; an answered form is read-only.
// Run: node web/message-forms.browser.test.cjs   (FORMS_SCREENSHOTS=<dir> also saves screenshots)
const assert = require('node:assert/strict');
const shots = process.env.FORMS_SCREENSHOTS;
if (shots) require('node:fs').mkdirSync(shots, { recursive: true });
const { fakeConsole, launch } = require('../tests/helpers/fake-console.cjs');

const T0 = Date.now() - 3600_000;
const fence = (spec) => `\`\`\`form\n${JSON.stringify(spec, null, 2)}\n\`\`\``;
const deploy = `Before I deploy, two choices:\n\n${fence({ title: 'Deploy', fields: [
  { name: 'region', label: 'Region', options: [{ value: 'eu-west-1', label: 'Europe' }, { value: 'us-east-1', label: 'US East' }] },
  { name: 'domain', label: 'Domain', placeholder: 'example.com', optional: true },
  { name: 'features', label: 'Features', multiple: true, options: ['Sign-in', 'Payments'] },
  { name: 'now', label: 'Deploy right away', type: 'toggle' },
] })}`;
const quick = `Which database?\n\n${fence({ options: ['Postgres', 'SQLite'] })}`;
const secure = `I need an OpenAI key.\n\n${fence({ fields: [{ name: 'key', label: 'OpenAI API key', type: 'secret' }],
  save: { method: 'POST', path: '/api/projects/p/secrets', body: { name: 'OPENAI_API_KEY', value: '{{key}}' } } })}`;
const leaky = `${fence({ fields: [{ name: 'key', type: 'secret' }], save: { method: 'PATCH', path: '/api/projects/p', body: { name: '{{key}}' } } })}`;
const outside = `${fence({ fields: [{ name: 'who' }], save: { method: 'POST', path: '/api/organizations/o/members', body: { userId: '{{who}}', role: 'owner' } } })}`;

(async () => {
  const browser = await launch();
  try {
    const project = { id: 'p', organizationId: 'o', name: 'Workspace', config: {} };
    const task = { id: 't', projectId: 'p', num: 1, title: 'Ship it', workflow: 'software-dev', params: {}, tags: [], lastView: { stage: 'do', status: 'waiting' } };
    const open = async (messages, colorScheme = 'light') => {
      const view = { taskId: 't', stage: 'do', status: 'waiting', workflow: 'software-dev', messages,
        actions: [{ name: 'followUp', label: 'Send', enabled: true }], waitingFor: { kind: 'human', reason: 'question' } };
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 }, colorScheme });
      const sent = [];
      const { sockets } = await fakeConsole(context, { project, tasks: [task], async api(p, request) {
        if (request.method() === 'POST') {
          const body = request.postDataJSON();
          sent.push({ path: p, body });
          if (p === '/api/tasks/t/signal') {
            const message = { id: `u${sent.length}`, role: 'user', author: 'user:u', text: body.text, ts: Date.now() };
            messages.push(message);
            return { message, role: 'do' };
          }
          return { ok: true };
        }
        if (p === '/api/tasks/t') return view;
        if (p.endsWith('/events')) return [];
        return undefined;
      } });
      context.setDefaultTimeout(8000);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto('http://console.test/org/workspace/tasks/1');
      await page.locator('#ck-thread .msg.agent').first().waitFor();
      // A live update repaints the conversation under whatever is being typed.
      const repaint = async () => {
        sockets.at(-1).send(JSON.stringify({ type: 'view.updated', taskId: 't', projectId: 'p', payload: { stage: 'do', status: 'waiting' } }));
        await page.waitForTimeout(600);
      };
      return { context, page, errors, sent, repaint };
    };
    const signals = (sent) => sent.filter((s) => s.path === '/api/tasks/t/signal').map((s) => s.body);

    // ── a general form: filled in, sent as an ordinary reply ──
    {
      const { context, page, errors, sent, repaint } = await open([
        { id: 'm0', role: 'user', author: 'user:u', text: 'Deploy the site', ts: T0 },
        { id: 'a1', role: 'agent', text: quick, ts: T0 + 1000 },
        { id: 'm1', role: 'user', author: 'user:u', text: 'Postgres', ts: T0 + 2000 },
        { id: 'a2', role: 'agent', text: deploy, ts: T0 + 3000 },
      ]);
      // The earlier, answered question is read-only; the latest form is live.
      const forms = page.locator('#ck-thread form.ask-form');
      assert.equal(await forms.count(), 2);
      assert.equal(await page.locator('#ck-thread form.ask-form.live').count(), 1);
      assert.ok(await forms.first().locator('button.ask-choice').first().isDisabled(), 'an answered form cannot be sent again');
      const live = page.locator('#ck-thread form.ask-form.live');
      assert.equal(await live.locator('.ask-title').innerText(), 'Deploy');
      // Required fields are asked for before anything is sent.
      await live.locator('.ask-submit').click();
      assert.equal(signals(sent).length, 0, 'nothing is sent while a required answer is missing');
      await live.locator('label.ask-option', { hasText: 'US East' }).click();
      await live.getByLabel('Domain').fill('shop.example');
      await live.locator('label.ask-option', { hasText: 'Payments' }).click();
      await live.locator('label.ask-toggle').click();
      // A draft survives the conversation repainting under it.
      await repaint();
      assert.equal(await page.locator('#ck-thread form.ask-form.live').getByLabel('Domain').inputValue(), 'shop.example');
      await page.locator('#ck-thread form.ask-form.live .ask-submit').click();
      await page.waitForFunction(() => !document.querySelector('#ck-thread form.ask-form.live'));
      assert.deepEqual(signals(sent), [{ signal: 'followUp', role: 'do',
        text: '- Region: US East (us-east-1)\n- Domain: shop.example\n- Features: Payments\n- Deploy right away: Yes' }]);
      // The answer shows as the person's message, and the form is now read-only.
      await page.locator('#ck-thread .msg.user', { hasText: 'shop.example' }).waitFor();
      assert.equal(await page.locator('#ck-thread form.ask-form:not(.live)').count(), 2);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ── a quick question: one click answers ──
    {
      const { context, page, errors, sent } = await open([{ id: 'a1', role: 'agent', text: quick, ts: T0 }]);
      const buttons = page.locator('#ck-thread form.ask-form.live.quick button.ask-choice');
      assert.deepEqual(await buttons.allInnerTexts(), ['Postgres', 'SQLite']);
      await buttons.nth(1).click();
      await page.waitForFunction(() => !document.querySelector('#ck-thread form.ask-form.live'));
      assert.deepEqual(signals(sent).map((s) => s.text), ['SQLite']);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ── a secure form: the setting is written, the secret never sent ──
    {
      const { context, page, errors, sent } = await open([{ id: 'a1', role: 'agent', text: secure, ts: T0 }]);
      const form = page.locator('#ck-thread form.ask-form.live');
      assert.match(await form.locator('.ask-note').innerText(), /Saved to OPENAI_API_KEY · Workspace secrets, not into the conversation/);
      assert.equal(await form.locator('input[data-secret]').getAttribute('type'), 'password');
      await form.getByLabel('OpenAI API key').fill('sk-live-123');
      await page.locator('#ck-thread form.ask-form.live .ask-submit').click();
      await page.waitForFunction(() => !document.querySelector('#ck-thread form.ask-form.live'));
      assert.deepEqual(sent.map((s) => s.path), ['/api/projects/p/secrets', '/api/tasks/t/signal'], 'saved first, then the reply');
      assert.deepEqual(sent[0].body, { name: 'OPENAI_API_KEY', value: 'sk-live-123' });
      assert.equal(signals(sent)[0].text, '- OpenAI API key: saved\n\nSaved to OPENAI_API_KEY · Workspace secrets.');
      assert.ok(!JSON.stringify(signals(sent)).includes('sk-live'), 'the secret is not in the reply');
      assert.ok(!(await page.locator('#ck-thread').innerText()).includes('sk-live'), 'nor on the page');
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ── a refused save says why, keeps the form, and sends nothing ──
    {
      const { context, page, sent } = await open([{ id: 'a1', role: 'agent', text: secure, ts: T0 }]);
      await context.route('http://console.test/api/projects/p/secrets', (route) => route.fulfill({ status: 403, json: { error: 'denied: project:secret:write' } }));
      const form = page.locator('#ck-thread form.ask-form.live');
      await form.getByLabel('OpenAI API key').fill('sk-live-123');
      await form.locator('.ask-submit').click();
      await form.locator('.ask-error').waitFor();
      assert.match(await form.locator('.ask-error').innerText(), /^Not saved: You don’t have permission/);
      assert.equal(signals(sent).length, 0);
      await form.locator('.ask-submit:enabled:not([aria-disabled="true"])').waitFor(); // it can be tried again
      await context.close();
    }

    // ── forms that could leak a secret, or write outside settings, are not shown ──
    {
      const { context, page, errors, sent } = await open([
        { id: 'a1', role: 'agent', text: leaky, ts: T0 },
        { id: 'a2', role: 'agent', text: outside, ts: T0 + 1 },
      ]);
      assert.equal(await page.locator('#ck-thread form.ask-form').count(), 0);
      const problems = await page.locator('#ck-thread details.ask-form-problem > summary').allInnerTexts();
      assert.deepEqual(problems, ['This form would save a secret where it can be read back, so it was not shown.',
        'This form would change something outside settings, so it was not shown.']);
      assert.equal(sent.length, 0);
      assert.deepEqual(errors, []);
      await context.close();
    }
    // ── a form stays answerable after the conversation moves on ──
    {
      const pace = `${fence({ label: 'First forecast', options: ['All at once', 'Gradually'] })}`;
      const history = () => [
        { id: 'a1', role: 'agent', text: `${secure}\n\n${pace}`, ts: T0 },
        { id: 'm1', role: 'user', author: 'user:u', text: 'Aren’t you going to use my Claude subscription?', ts: T0 + 1000 },
        { id: 'a2', role: 'agent', text: 'Yes — the key is only for the fallback.', ts: T0 + 2000 },
      ];
      const messages = history();
      const { context, page, errors, sent } = await open(messages);
      // A person spoke and the agent answered, yet neither form was answered: both stay live.
      assert.equal(await page.locator('#ck-thread form.ask-form.live').count(), 2, 'unanswered forms stay live');
      await page.locator('#ck-thread form.ask-form.live.quick button.ask-choice', { hasText: 'Gradually' }).click();
      await page.locator('#ck-thread .msg.user', { hasText: 'Gradually' }).waitFor();
      // The answer says which question it answers, since the conversation has moved on.
      assert.deepEqual(signals(sent).map((s) => s.text), ['> First forecast\n\nGradually']);
      assert.equal(await page.locator('#ck-thread form.ask-form.live').count(), 1, 'only the answered form is read-only');
      assert.ok(await page.locator('#ck-thread form.ask-form.live input[data-secret]').isEnabled());
      if (shots) await page.screenshot({ path: `${shots}/form-after-conversation-moved-on.png` });
      assert.deepEqual(errors, []);
      await context.close();
      // Opened afresh, the conversation itself says which forms were answered: a
      // form answered in an earlier visit (or typed out) stays read-only.
      const again = await open([...history(),
        { id: 'm2', role: 'user', author: 'user:u', text: '> First forecast\n\nGradually', ts: T0 + 3000 },
        { id: 'a3', role: 'agent', text: deploy, ts: T0 + 4000 },
        { id: 'm3', role: 'user', author: 'user:u', text: '- Region: US East (us-east-1)\n- Deploy right away: No', ts: T0 + 5000 }]);
      assert.equal(await again.page.locator('#ck-thread form.ask-form').count(), 3);
      assert.deepEqual(await again.page.locator('#ck-thread form.ask-form.live').evaluateAll((forms) => forms.map((f) => f.querySelector('input[data-secret]') ? 'secret' : 'other')),
        ['secret'], 'the secure form is still open; the quick and deploy forms were answered');
      assert.deepEqual(again.errors, []);
      await again.context.close();
    }

    if (shots) for (const scheme of ['light', 'dark']) {
      const { context, page } = await open([{ id: 'm0', role: 'user', author: 'user:u', text: 'Deploy the site', ts: T0 },
        { id: 'a1', role: 'agent', text: deploy, ts: T0 + 1 }], scheme);
      await page.locator('#ck-thread form.ask-form.live').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${shots}/form-${scheme}.png` });
      await context.close();
      for (const [name, text] of [['quick', quick], ['secret', secure]]) {
        const shot = await open([{ id: 'a1', role: 'agent', text, ts: T0 }], scheme);
        await shot.page.screenshot({ path: `${shots}/form-${name}-${scheme}.png` });
        await shot.context.close();
      }
    }
    console.log('Message forms in the console: ok');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exit(1); });
