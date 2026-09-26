// Full console shell, trusted Chromium input, and deterministic local API/WS fakes.
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
    const task = { id: 't', projectId: 'p', num: 1, title: 'Review <script>世界</script>', workflow: 'software-dev', params: {}, tags: ['tag'], lastView: { stage: 'do', status: 'active' } };
    const tags = [{ id: 'tag', projectId: 'p', name: 'Topic', kind: 'topic' }];
    const schema = [{ name: 'software-dev', params: [{ name: 'prompt', type: 'text', label: 'Prompt', scopes: ['task'], bind: 'prompt' }], stages: [{ key: 'do', label: 'Working' }] }];
    let failSearch = false, searchDelay = 0, failTagSave = true;
    await context.routeWebSocket('**/ws*', ws => { sockets.push(ws); });
    await context.route('http://console.test/**', async route => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname;
      if (!p.startsWith('/api/')) {
        const file = p === '/app.js' || p === '/styles.css' || p === '/markdown.js' || p === '/totp-qr.js' || p === '/register-service-worker.js' ? p.slice(1) : 'index.html';
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
      else if (p === '/api/projects/p/tags') {
        if (req.method() === 'POST') {
          await new Promise(resolve => setTimeout(resolve, 150));
          if (failTagSave) return route.fulfill({ status: 503, json: { error: 'Could not save tag' } });
          const tag = { ...req.postDataJSON(), id: 'created', projectId: 'p' };
          tags.push(tag); data = tag;
        } else data = tags;
      }
      else if (p === '/api/projects/p/search') {
        if (searchDelay) await new Promise(resolve => setTimeout(resolve, searchDelay));
        if (failSearch) return route.fulfill({ status: 503, json: { error: 'Search temporarily unavailable' } });
        data = { tasks: [task], total: 1 };
      }
      else if (p === '/api/tasks/t') data = { taskId: 't', projectId: 'p', title: task.title, workflow: 'software-dev', stage: 'do', status: 'active', messages: [], actions: [], state: {} };
      else if (p.endsWith('/sessions')) data = {};
      else if (p.endsWith('/attempts')) data = { principalAttemptId: 't', attempts: [task] };
      else if (p.endsWith('/events')) data = [];
      return route.fulfill({ json: data });
    });
    context.setDefaultTimeout(8000);
    const page = await context.newPage();
    page.on('pageerror', error => { errors.push(error.message); console.error('page:', error.message); });
    await page.goto('http://console.test/org/workspace');
    await page.locator('[data-id="t"]').waitFor();
    assert.equal(await page.locator('[data-id="t"] .task-title').textContent(), '#1 Review <script>世界</script>');
    assert.equal(await page.locator('#main script').count(), 0);
    await page.getByRole('button', { name: '🏷 Tags', exact: true }).click();
    await page.locator('#tagm-name').fill('未保存 <b>draft</b>');
    await page.locator('[data-edittag="tag"]').click();
    assert.equal(await page.locator('#tagm-name').inputValue(), '未保存 <b>draft</b>');
    await page.locator('#tagm-add').dblclick();
    await page.getByText('Could not save tag', { exact: true }).waitFor();
    assert.equal(requests.filter(r => r === 'POST /api/projects/p/tags').length, 1, 'busy double click sends once');
    assert.equal(await page.locator('#tagm-name').inputValue(), '未保存 <b>draft</b>');
    failTagSave = false;
    await page.locator('#tagm-add').click();
    await page.waitForFunction(() => document.querySelector('#tagm-name').value === '');
    await page.locator('#tagm-close').click();
    await page.getByRole('button', { name: /Search everything/ }).click();
    searchDelay = 150;
    await page.locator('#gs-in').fill('Review');
    await page.locator('.global-search-result').waitFor();
    await page.locator('#gs-close').click();
    await page.locator('[data-id="t"] .row-link').click();
    await page.locator('#tp-body').waitFor();
    const before = requests.length;
    for (let i = 0; i < 30; i++) sockets[0].send(JSON.stringify({ type: 'agent.output', taskId: 't', projectId: 'p', payload: { text: `stream ${i}` } }));
    await page.waitForTimeout(100);
    assert.equal(requests.length, before, 'output chunks perform no API reads');
    await page.goBack();
    await page.locator('[data-id="t"]').waitFor();
    const other = await context.newPage();
    await other.goto('http://console.test/org/workspace');
    await other.locator('[data-id="t"]').waitFor();
    assert.equal(sockets.length, 2, 'tabs own independent sockets');
    failSearch = true;
    await page.locator('#task-search').fill('failure');
    await page.getByText(/Search didn.t run/).first().waitFor();
    failSearch = false;
    await page.getByRole('button', { name: 'Open full task form', exact: true }).click();
    const draft = '世界 <img src=x onerror=alert(1)> ' + 'long draft '.repeat(200);
    await page.locator('#tf-page textarea').first().fill(draft);
    await page.locator('#topbar-palette').click();
    await page.locator('#pal-in').waitFor();
    assert.equal(await page.locator('#tf-page textarea').first().inputValue(), draft);
    await page.locator('#pal-in').press('Escape');
    assert.equal(await page.locator('#tf-page textarea').first().inputValue(), draft);
    assert.deepEqual(errors, []);
    console.log('Full console journeys: ok');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
