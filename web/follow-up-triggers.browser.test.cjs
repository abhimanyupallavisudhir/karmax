// Real browser regression: a person sets a task's follow-up triggers on its
// Parameters page, including on a task that has finished, and they save whole.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = __dirname;
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const running = { id: 'run', projectId: 'p1', workflow: 'software-dev', params: { prompt: 'p', followUpTriggers: [
      { id: 'sub', kind: 'event', type: '*', subject: 's', recurring: true, whileRunning: true },
      { id: 'dep', kind: 'event', type: 'deploy.finished', where: { env: 'prod' } },
    ] } };
    const done = { id: 'done', projectId: 'p1', workflow: 'software-dev', params: { prompt: 'p' } };
    const view = (t) => ({ taskId: t.id, title: t.id, workflow: 'software-dev', stage: t.id === 'run' ? 'do' : 'done', status: t.id === 'run' ? 'active' : 'done', editableParams: [], agents: {}, messages: [], actions: [] });
    const patches = [];
    await page.route('**/*', async route => {
      const p = new URL(route.request().url()).pathname;
      if (p.startsWith('/api/')) {
        let data = [];
        const params = p.match(/^\/api\/tasks\/(run|done)\/params$/);
        const list = p.match(/^\/api\/tasks\/(run|done)\/follow-up-triggers$/);
        const task = p.match(/^\/api\/tasks\/(run|done)$/);
        const t = { run: running, done }[(params || list || task)?.[1]];
        if (params) {
          const patch = route.request().postDataJSON().params;
          patches.push({ task: params[1], patch });
          t.params.followUpTriggers = patch.followUpTriggers.map((x, i) => ({ id: x.id || `new${i}`, ...x }));
          data = { applied: ['followUpTriggers'] };
        } else if (list) data = { triggers: t.params.followUpTriggers || [] };
        else if (task) data = view(t);
        else if (p.endsWith('/attempts')) data = null;
        else if (p.endsWith('/sessions')) data = {};
        else if (p.includes('/defaults/')) data = { task: { inherited: {} } };
        else if (p.endsWith('/tasks')) data = [running, done];
        else if (p.includes('explanation-settings')) data = { effective: { enabled: false } };
        return route.fulfill({ json: data });
      }
      const file = path.join(root, p === '/' ? 'index.html' : p);
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.abort();
      let body = fs.readFileSync(file, 'utf8');
      if (p === '/app.js') body = body.replace(/^boot\(\)\.catch\(.*$/m, 'bindKeys(); window.parameterTest = { S, openTask, refreshTask, renderTaskPage, setTaskTab };');
      return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto('http://parameter.test/');
    await page.waitForFunction(() => window.parameterTest);
    const open = (id) => page.evaluate(async ({ id, running, done }) => {
      const { S, openTask } = window.parameterTest;
      document.querySelector('#app').innerHTML = '<main id="main" style="height:800px"></main>';
      S.tasks = [running, done]; S.projects = [{ id: 'p1', slug: 'project', name: 'Project', organizationId: 'o1', config: {} }];
      S.projectId = 'p1'; S.organizationId = 'o1'; S.organizations = [{ id: 'o1', slug: 'test' }];
      S.meta = { workflows: [] };
      S.schema = [{ name: 'software-dev', params: [] }];
      await openTask(id, 'parameters');
    }, { id, running, done });

    // A running task: its own trigger is editable, the internal one stays out of the form.
    await open('run');
    await page.locator('#tp-follow-ups').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#tp-follow-ups').getAttribute('open'), '', 'a task with triggers opens the panel');
    assert.equal(await page.locator('#ev-type').inputValue(), 'deploy.finished', 'the form edits the trigger it shows');
    await page.locator('#ev-type').fill('deploy.*');
    await page.locator('#ev-type').dispatchEvent('change');
    await page.locator('#fu-save').click();
    await page.waitForFunction(() => document.querySelector('#fu-status')?.dataset.state === 'saved');
    const first = patches.at(-1);
    assert.equal(first.task, 'run');
    assert.equal(first.patch.followUpTriggers.length, 2, 'the internal trigger is kept');
    assert.ok(first.patch.followUpTriggers.some((t) => t.whileRunning && t.subject === 's'));
    assert.deepEqual(first.patch.followUpTriggers[0].where, { env: 'prod' }, 'its conditions are kept');
    assert.equal(first.patch.followUpTriggers[0].id, 'dep');

    // A finished task still offers them: this is when firing forks it.
    await open('done');
    await page.locator('#tp-follow-ups').waitFor({ state: 'attached' });
    assert.equal(await page.locator('#tp-follow-ups').evaluate((el) => el.open), false, 'empty panel starts closed');
    await page.locator('#tp-follow-ups > summary').click();
    await page.locator('#ev-type').fill('orders.created');
    await page.locator('#ev-type').dispatchEvent('change');
    assert.equal(await page.locator('#fu-save').isDisabled(), false);
    assert.equal(await page.locator('#trig-repeatable').isChecked(), false, 'a follow-up is one-shot unless asked');
    await page.locator('#trig-repeatable').check();
    await page.locator('#fu-save').click();
    await page.waitForFunction(() => document.querySelector('#fu-status')?.dataset.state === 'saved');
    assert.deepEqual(patches.at(-1), { task: 'done', patch: { followUpTriggers: [{ kind: 'event', type: 'orders.created', recurring: true }] } });
    assert.deepEqual(errors, []);
    console.log('follow-up triggers browser ok');
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
