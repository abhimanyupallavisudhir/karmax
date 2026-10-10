// Real browser regression: on a running task's Parameters tab, typing in an
// agent's Tools field searches MCPs and app connectors, as in the task form —
// and background refreshes of the in-flight task (agent state changes included)
// neither drop the typed query nor discard its results. APP_SOURCE can test the baseline.
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
    const record = { id: 'fixture', projectId: 'p1', workflow: 'software-dev', params: { 'agent:do': { provider: 'claude' } } };
    const view = { taskId: 'fixture', title: 'Tools search', workflow: 'software-dev', stage: 'do', status: 'active', editableParams: ['agent:do'],
      participants: [{ key: 'do', state: 'running' }, { key: 'agent-2', state: 'running' }], agents: {}, messages: [], actions: [] };
    const searches = [], patches = [];
    let releaseDefaults;
    const defaultsLoaded = new Promise(resolve => { releaseDefaults = resolve; });
    await page.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url()), p = url.pathname;
      if (p.startsWith('/api/')) {
        let data = [];
        if (p === '/api/tasks/fixture/params') { patches.push(request.postDataJSON().params); data = { view }; }
        else if (p === '/api/tasks/fixture') data = view;
        else if (p === '/api/mcp/registry') {
          searches.push(url.searchParams.get('search'));
          data = { servers: [{ name: 'io.github.example/github', title: 'GitHub MCP' }] };
        } else if (p === '/api/connections/catalog') data = [{ slug: 'github', name: 'GitHub app' }];
        else if (p === '/api/mcp' || p === '/api/connections') data = [];
        else if (p.endsWith('/attempts')) data = null;
        else if (p.endsWith('/sessions')) data = {};
        // The project's defaults arrive after the page is open, as they do live.
        else if (p.includes('/defaults/')) { await defaultsLoaded; data = { task: { inherited: { 'agent:do': { provider: 'codex', mcpConnections: ['browser:chrome-devtools'] } } } }; }
        else if (p.endsWith('/tasks')) data = [record];
        else if (p.includes('explanation-settings')) data = { effective: { enabled: false } };
        return route.fulfill({ json: data });
      }
      const file = path.join(root, p === '/' ? 'index.html' : p);
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.abort();
      let body = fs.readFileSync(p === '/app.js' && process.env.APP_SOURCE || file, 'utf8');
      if (p === '/app.js') body = body.replace(/^boot\(\)\.catch\(.*$/m, 'window.parameterTest = { S, openTask, refreshTask, renderTaskPage };');
      return route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto('http://parameter.test/');
    await page.waitForFunction(() => window.parameterTest);
    await page.evaluate(async ({ record }) => {
      const { S, openTask } = window.parameterTest;
      document.querySelector('#app').innerHTML = '<main id="main" style="height:800px"></main>';
      S.tasks = [record]; S.projects = [{ id: 'p1', slug: 'project', name: 'Project', organizationId: 'o1', config: {} }];
      S.projectId = 'p1'; S.organizationId = 'o1'; S.organizations = [{ id: 'o1', slug: 'test' }];
      S.meta = { workflows: [] };
      S.schema = [{ name: 'software-dev', params: [{ name: 'agent:do', label: 'Agent', type: 'agent', role: 'do', scopes: ['task'], mutable: 'always' }] }];
      await openTask('fixture', 'parameters');
    }, { record });
    await page.locator('#tp-params [data-row="agent:do"] .mcp-filter').waitFor({ state: 'visible' });
    releaseDefaults();
    await page.waitForFunction(() => window.parameterTest.S.paramDefaults?.['agent:do']);
    const tools = page.locator('#tp-params [data-row="agent:do"] .mcp-filter');
    const options = page.locator('#tp-params [data-row="agent:do"] .mcp-options');

    // The form the defaults rebuilt still searches.
    await tools.click();
    await tools.pressSequentially('git');
    await options.locator('[data-registry]').filter({ hasText: 'GitHub MCP' }).waitFor({ timeout: 5000 });
    await options.locator('[data-connector-app]').filter({ hasText: 'GitHub app' }).waitFor({ timeout: 5000 });
    assert.ok(searches.includes('git'), 'the registry is searched for the typed query');
    assert.match(await page.locator('#tp-params [data-row="agent:do"] .agent-field').getAttribute('data-inherit'), /codex/, 'the block follows the loaded defaults');

    // An agent changing state is a chip, not a new form under the cursor.
    const chip = page.locator('#tp-params .pf-agent-state');
    assert.equal(await chip.textContent(), 'running');
    await tools.evaluate(el => { window.toolsNode = el; });
    view.participants = [{ key: 'do', state: 'waiting' }, { key: 'agent-2', state: 'idle' }];
    await page.evaluate(() => window.parameterTest.refreshTask());
    assert.equal(await tools.evaluate(el => el === window.toolsNode && document.activeElement === el && el.value === 'git'), true, 'the query keeps its field and focus');
    assert.equal(await chip.isHidden(), true, 'an idle agent shows no state');
    view.participants = [{ key: 'do', state: 'running' }, { key: 'agent-2', state: 'queued' }];
    await page.evaluate(() => window.parameterTest.refreshTask());
    assert.equal(await chip.textContent(), 'queued');
    assert.equal(await chip.isVisible(), true);
    await options.locator('[data-registry]').filter({ hasText: 'GitHub MCP' }).waitFor({ timeout: 5000 });

    // A tool picked there is saved.
    await tools.fill('play');
    await options.locator('[data-mcp-id="browser:playwright"]').click();
    await page.locator('#params-save:not([disabled])').click();
    await page.waitForFunction(() => document.querySelector('#params-save')?.disabled);
    assert.deepEqual(patches.at(-1)['agent:do'].mcpConnections, ['browser:chrome-devtools', 'browser:playwright']);
    assert.deepEqual(errors, []);
    console.log('Parameters Tools search passed');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
