// Full console shell, trusted Chromium input, and deterministic local API/WS fakes.
const assert = require('node:assert/strict');
const { fakeConsole, launch, reply } = require('../tests/helpers/fake-console.cjs');

(async () => {
  const browser = await launch();
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const errors = [];
    const project = { id: 'p', organizationId: 'o', name: 'Workspace', config: {} };
    const task = { id: 't', projectId: 'p', num: 1, title: 'Review <script>世界</script>', workflow: 'software-dev', params: {}, tags: ['tag'], lastView: { stage: 'do', status: 'active' } };
    const tags = [{ id: 'tag', projectId: 'p', name: 'Topic', kind: 'topic' }];
    const schema = [{ name: 'software-dev', params: [{ name: 'prompt', type: 'text', label: 'Prompt', scopes: ['task'], bind: 'prompt' }], stages: [{ key: 'do', label: 'Working' }] }];
    let failSearch = false, searchDelay = 0, failTagSave = true;
    const { requests, sockets } = await fakeConsole(context, { project, tasks: [task], schema, async api(p, req) {
      if (p === '/api/projects/p/tags') {
        if (req.method() !== 'POST') return tags;
        await new Promise(resolve => setTimeout(resolve, 150));
        if (failTagSave) return reply(503, { error: 'Could not save tag' });
        const tag = { ...req.postDataJSON(), id: 'created', projectId: 'p' };
        tags.push(tag);
        return tag;
      }
      if (p === '/api/projects/p/search') {
        if (searchDelay) await new Promise(resolve => setTimeout(resolve, searchDelay));
        if (failSearch) return reply(503, { error: 'Search temporarily unavailable' });
      }
    } });
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
    await page.locator('#tagm-edit-name').fill('Unsaved tag edit');
    await page.locator('#tagm-add').dblclick();
    await page.getByText('Could not save tag', { exact: true }).waitFor();
    assert.equal(requests.filter(r => r === 'POST /api/projects/p/tags').length, 1, 'busy double click sends once');
    assert.equal(await page.locator('#tagm-name').inputValue(), '未保存 <b>draft</b>');
    failTagSave = false;
    await page.locator('#tagm-add').click();
    await page.waitForFunction(() => document.querySelector('#tagm-name').value === '');
    assert.equal(await page.locator('#tagm-edit-name').inputValue(), 'Unsaved tag edit');
    await page.locator('#tagm-close').click();
    assert.equal(await page.locator('#topbar-search').count(), 0, 'lists are the search; the topbar has none');
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
    await page.locator('#rail-palette').click();
    await page.locator('#pal-in').waitFor();
    assert.equal(await page.locator('#tf-page textarea').first().inputValue(), draft);
    await page.locator('#pal-in').press('Escape');
    assert.equal(await page.locator('#tf-page textarea').first().inputValue(), draft);
    assert.deepEqual(errors, []);
    console.log('Full console journeys: ok');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
