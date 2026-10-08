// Settings say what the server said (UI-12, UI-23): a failed read offers Retry
// instead of reading as "nothing here yet", and a rejected save puts the control
// back to the value the server still holds. Full shell on fake /api + WS.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const errors = [];
    const fail = new Set();
    const project = { id: 'p', organizationId: 'o', name: 'Workspace', config: {} };
    const schema = [{ name: 'software-dev', params: [], stages: [{ key: 'do', label: 'Working' }] }];
    let sharing = false, slowPane = false;
    const invitations = [];
    await context.routeWebSocket('**/ws*', () => {});
    await context.route('http://console.test/**', async route => {
      const req = route.request(), p = new URL(req.url()).pathname;
      if (!p.startsWith('/api/')) {
        const file = /^\/[\w-]+\.js$|^\/styles\.css$/.test(p) && fs.existsSync(path.join(__dirname, p)) ? p.slice(1) : 'index.html';
        return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: fs.readFileSync(path.join(__dirname, file), 'utf8') });
      }
      const key = `${req.method()} ${p}`;
      if (fail.has(key)) return route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } });
      // An organization owner on a hosted install may not read the installation's users.
      if (p === '/api/users') return route.fulfill({ status: 403, json: { error: 'missing capability user:read' } });
      if (key === 'GET /api/organizations/o/invitations') {
        const listed = [...invitations];
        if (slowPane) await new Promise(resolve => setTimeout(resolve, 600));
        return route.fulfill({ json: listed });
      }
      if (key === 'POST /api/organizations/o/invitations') {
        const invitation = { id: 'i1', email: req.postDataJSON().email, authorization: { level: 'developer', scope: 'organization' }, createdAt: 1 };
        invitations.push(invitation);
        return route.fulfill({ json: { token: 'secret', emailed: true, invitation } });
      }
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
      else if (p.endsWith('/defaults') || p.startsWith('/api/defaults/')) data = { effective: {}, inherited: {} };
      else if (p === '/api/projects/p/search') data = { tasks: [], total: 0 };
      else if (p === '/api/organizations/o/members') data = [{ userId: 'u', user: { id: 'u', name: 'Tester' }, profileId: 'owner' }];
      else if (p === '/api/organizations/o/roles') data = { canCreate: true, profiles: [], capabilityGroups: [], creatableCapabilities: [] };
      else if (p === '/api/organizations/o/github/app') data = { configured: true, userAuthorized: true };
      else if (p === '/api/organizations/o/github/identity') data = { profile: null };
      else if (p === '/api/organizations/o/execution-policy') data = { worldProvider: 'worktree', resources: { cpu: 2, memoryMb: 2048 }, network: { unrestricted: true } };
      else if (/\/(entitlements|usage|usage-policy|identity-policy)$/.test(p)) data = null;
      else if (p.endsWith('/payments/providers')) data = { providers: [], active: null };
      else if (p === '/api/organizations/o/conversation-sharing') {
        if (req.method() === 'PUT') {
          await new Promise(resolve => setTimeout(resolve, 150));
          if (fail.has('PUT sharing')) return route.fulfill({ status: 403, json: { error: 'Only an owner can change sharing' } });
          sharing = req.postDataJSON().enabled;
        }
        data = { enabled: sharing, canManage: true };
      }
      else if (p.endsWith('/avatars')) data = { avatars: [], availability: { enabled: false } };
      else if (p.endsWith('/onboarding')) data = { display: 'hidden', steps: [] };
      return route.fulfill({ json: data });
    });
    context.setDefaultTimeout(8000);
    const page = await context.newPage();
    page.on('pageerror', error => { errors.push(error.message); console.error('page:', error.stack); });

    // UI-12: Project Access with GitHub unreadable offers Retry, not "connect GitHub".
    fail.add('GET /api/organizations/o/git-connections');
    await page.goto('http://console.test/org/workspace/settings');
    const repositories = page.locator('#project-repositories');
    await repositories.getByRole('button', { name: 'Retry' }).waitFor();
    assert.equal(await repositories.getByText('Connect GitHub').count(), 0, 'a failed GitHub read is not "no GitHub connection"');
    assert.ok(await repositories.locator('#project-repository-input:not([disabled])').count(), 'repository sources stay editable while GitHub is unreadable');
    fail.delete('GET /api/organizations/o/git-connections');
    await repositories.getByRole('button', { name: 'Retry' }).click();
    await repositories.getByText('Connect GitHub').waitFor();

    // UI-12: unreadable members are an error with Retry, not "No members."
    fail.add('GET /api/organizations/o/members');
    await page.goto('http://console.test/org/settings#settings-people');
    const members = page.locator('#org-members');
    await members.getByRole('button', { name: 'Retry' }).waitFor();
    assert.equal(await members.getByText('No members.').count(), 0, 'a failed members read is not an empty organization');
    fail.delete('GET /api/organizations/o/members');
    await members.getByRole('button', { name: 'Retry' }).click();
    await members.getByText('Tester').first().waitFor();

    // The installation's user directory is optional to the People pane, and
    // Invite works as soon as it is shown, before the pane's reads land.
    slowPane = true;
    await page.goto('http://console.test/org/settings#settings-people');
    await page.locator('#invite-email').fill('ivan@example.test');
    await page.locator('#invite-member').click();
    await page.locator('#invite-result').getByText('Invitation emailed to').waitFor();
    await members.getByText('Tester').first().waitFor();
    await page.locator('#pending-invitations [data-invitation="i1"]').waitFor();
    assert.equal(await members.getByRole('button', { name: 'Retry' }).count(), 0, 'an unreadable user directory is not a failed pane');
    await page.locator('#invite-result').getByText('Invitation emailed to').waitFor();
    slowPane = false;

    // UI-23: a rejected sharing policy returns the select to the saved value.
    fail.add('PUT sharing');
    const box = page.locator('#organization-conversation-sharing');
    const select = box.locator('select');
    await select.selectOption('enabled');
    assert.equal(await select.isDisabled(), true, 'the policy is locked while it saves');
    await page.getByText('Only an owner can change sharing').waitFor();
    await page.waitForFunction(() => !document.querySelector('#organization-conversation-sharing select').disabled);
    assert.equal(await select.inputValue(), 'disabled', 'a rejected policy change shows the saved policy');
    fail.delete('PUT sharing');
    await select.selectOption('enabled');
    await page.getByText('Public sharing policy saved').waitFor();
    assert.equal(sharing, true);
    assert.equal(await select.inputValue(), 'enabled');

    assert.deepEqual(errors, []);
    console.log('Settings truth: ok');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
