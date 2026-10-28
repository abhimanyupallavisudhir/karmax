// Edits that wait for a Save button say so: "Unsaved changes" appears beside
// the button while what is on screen differs from what was saved, and goes
// once it is saved or put back. The task form, which saves itself, never
// shows a check mark beside unsaved work. Full shell on fake /api + WS.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const errors = [];
    const saves = [];
    let releaseSave = null;
    const project = { id: 'p', organizationId: 'o', name: 'Workspace', config: {} };
    const field = (name, label) => ({ name, label, type: 'string', scopes: ['task', 'project', 'global'] });
    const schema = [{ name: 'software-dev', params: [field('prompt', 'Prompt'), field('base', 'Base'), field('testCommand', 'Test command')],
      stages: [{ key: 'do', label: 'Working' }] }];
    await context.routeWebSocket('**/ws*', () => {});
    await context.route('http://console.test/**', async route => {
      const req = route.request(), p = new URL(req.url()).pathname;
      if (!p.startsWith('/api/')) {
        const file = /^\/[\w-]+\.js$|^\/styles\.css$/.test(p) && fs.existsSync(path.join(__dirname, p)) ? p.slice(1) : 'index.html';
        return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: fs.readFileSync(path.join(__dirname, file), 'utf8') });
      }
      if (req.method() === 'PUT' || req.method() === 'POST' || req.method() === 'PATCH') {
        saves.push(`${req.method()} ${p}`);
        if (releaseSave === false) await new Promise(resolve => { releaseSave = resolve; });
        if (req.method() === 'POST' && p === '/api/projects/p/tasks') return route.fulfill({ json: { id: 'draft-1' } });
        if (p.endsWith('/explanation-settings')) return route.fulfill({ json: { effective: { model: 'm' } } });
        return route.fulfill({ json: {} });
      }
      let data = [];
      if (p === '/api/meta') data = { siteName: 'Fixture', hostLocal: true, consoleRevision: 'one', agent: { provider: 'mock' }, worldProviders: [], explanationsEnabled: true };
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
      else if (p.startsWith('/api/defaults/')) data = { project: { own: {}, inherited: {} }, global: { own: {}, inherited: {} } };
      else if (p.endsWith('/defaults')) data = { effective: {}, inherited: {} };
      else if (p.endsWith('/explanation-settings')) data = { own: {}, inherited: { endpoint: 'e', model: 'm', prompt: 'x' }, effective: { model: 'm' } };
      else if (p === '/api/projects/p/search') data = { tasks: [], total: 0 };
      else if (p === '/api/organizations/o/members') data = [{ userId: 'u', user: { id: 'u', name: 'Tester' }, profileId: 'owner' }];
      else if (p === '/api/organizations/o/roles') data = { canCreate: true, profiles: [], capabilityGroups: [], creatableCapabilities: [] };
      else if (p === '/api/organizations/o/github/app') data = { configured: true, userAuthorized: true };
      else if (p === '/api/organizations/o/github/identity') data = { profile: null };
      else if (p === '/api/organizations/o/execution-policy') data = { worldProvider: 'worktree', resources: { cpu: 2, memoryMb: 2048 }, network: { unrestricted: true } };
      else if (/\/(entitlements|usage|usage-policy|identity-policy)$/.test(p)) data = null;
      else if (p.endsWith('/payments/providers')) data = { providers: [], active: null };
      else if (p.endsWith('/conversation-sharing')) data = { enabled: false, canManage: true };
      else if (p.endsWith('/avatars')) data = { avatars: [], availability: { enabled: false } };
      else if (p.endsWith('/onboarding')) data = { display: 'hidden', steps: [] };
      else if (/\/settings(\/project\/p)?\/(authorization|vault|payments|__common__)$/.test(p)) data = {};
      return route.fulfill({ json: data });
    });
    context.setDefaultTimeout(8000);
    const page = await context.newPage();
    page.on('pageerror', error => { errors.push(error.message); console.error('page:', error.stack); });
    const note = (region) => region.locator('.save-state');
    const noteText = async (region) => (await note(region).count()) ? (await note(region).textContent()) : '';

    // Organization Task defaults: its heading's tip is a tip, not source text.
    await page.goto('http://console.test/org/settings#settings-defaults');
    const heading = page.locator('#settings-defaults');
    await heading.waitFor();
    assert.equal((await heading.textContent()).trim(), 'Task defaults ⓘ');
    assert.equal(await heading.locator('[title]').getAttribute('title'), 'How new tasks begin, unless a project or task says otherwise');
    assert.equal(await page.getByText('${policyTip').count(), 0, 'no placeholder is shown as text');

    // Project settings: a workflow's defaults wait for their Save button.
    await page.goto('http://console.test/org/workspace/settings#project-defaults');
    const workflow = page.locator('details[data-wf="software-dev"]');
    const testCommand = workflow.locator('[data-field="testCommand"]');
    await testCommand.waitFor();
    assert.equal(await noteText(workflow), '', 'an untouched form says nothing');
    await testCommand.fill('npm test');
    assert.equal(await noteText(workflow), 'Unsaved changes');
    assert.equal(await note(workflow).getAttribute('data-state'), 'dirty');
    const button = workflow.getByRole('button', { name: 'Save', exact: true });
    assert.equal(await note(workflow).evaluate((el) => el.nextElementSibling?.textContent), 'Save', 'the note sits beside its Save');
    await testCommand.fill('');
    assert.equal(await noteText(workflow), '', 'putting the value back clears it');
    await testCommand.fill('npm test');
    // An edit made while the save is in flight is still unsaved afterwards.
    releaseSave = false;
    await button.click();
    while (typeof releaseSave !== 'function') await page.waitForTimeout(20);
    await testCommand.fill('npm test -- --run');
    releaseSave(); releaseSave = null;
    await page.waitForFunction(() => document.querySelector('details[data-wf="software-dev"] .btn.saved'));
    assert.equal(await noteText(workflow), 'Unsaved changes', 'an edit during the save stays unsaved');
    await button.click();
    await page.waitForFunction(() => !document.querySelector('details[data-wf="software-dev"] .save-state')?.textContent);
    assert.ok(saves.includes('PUT /api/settings/project/p/software-dev'));

    // The Task defaults card: the note is prominent and its row stays in view.
    const defaults = page.locator('#task-defaults-project');
    const base = defaults.locator('[data-field="base"]');
    await base.waitFor();
    await base.fill('develop');
    assert.equal(await noteText(defaults), 'Unsaved changes');
    const styles = await note(defaults).evaluate((el) => ({ color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor, actions: getComputedStyle(el.parentElement).position }));
    assert.notEqual(styles.background, 'rgba(0, 0, 0, 0)', 'the unsaved note is a filled pill');
    assert.equal(styles.actions, 'sticky', 'the Save row stays in view while something is unsaved');
    await defaults.getByRole('button', { name: 'Save task defaults' }).click();
    await page.waitForFunction(() => !document.querySelector('#task-defaults-project .save-state')?.textContent);
    assert.equal(await defaults.locator('.td-actions').evaluate((el) => getComputedStyle(el).position), 'static');

    // A card saved through flashSaved clears too.
    const explanation = page.locator('#project-explanation');
    await explanation.locator('.explanation-setting-model').fill('other-model');
    assert.equal(await noteText(explanation), 'Unsaved changes');
    await explanation.getByRole('button', { name: 'Save explanation defaults' }).click();
    await page.waitForFunction(() => !document.querySelector('#project-explanation .save-state')?.textContent);

    // The task form saves itself: unsaved work never wears a check mark.
    await page.goto('http://console.test/org/workspace');
    await page.locator('#expand-task').click();
    const head = page.locator('#tf-savestate');
    await page.locator('#tf-body textarea').first().fill('Write the release notes');
    assert.equal(await head.textContent(), 'Unsaved changes');
    assert.equal(await head.getAttribute('data-state'), 'dirty');
    const mark = () => head.evaluate((el) => getComputedStyle(el, '::before').content);
    assert.ok(!(await mark()).includes('✓'), 'no check mark beside unsaved changes');
    await page.waitForFunction(() => document.querySelector('#tf-savestate')?.dataset.state === 'saved');
    assert.equal(await head.textContent(), 'Draft saved');
    assert.ok((await mark()).includes('✓'), 'a saved draft keeps its check mark');

    assert.deepEqual(errors, []);
    console.log('ok  unsaved settings say so beside their Save; the task form shows no check for unsaved work');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
