// Everything that navigates is a real link: a Ctrl/⌘- or middle-click opens it
// in a new tab and leaves this page alone, while a plain click still navigates
// in place — no document reload, same as before it was a link. Beyond the lists:
// settings, the task page, the palette, the organization switcher, public pages.
// Run: node web/new-tab-links-pages.browser.test.cjs
const assert = require('node:assert/strict');
const { runNewTabChecks } = require('../tests/helpers/new-tab-links.cjs');

runNewTabChecks(async ({ check, open, opensInNewTab, sameDocument, ORIGIN }) => {
  await check('project settings link to organization settings', async (t) => {
    const { page } = t;
    await open(page, '/org/workspace/settings#project-agents', '.organization-settings-link');
    await opensInNewTab(t, '.organization-settings-link', '/org/settings#settings-agents');
    await page.locator('.organization-settings-link').click();
    await page.waitForURL(`${ORIGIN}/org/settings#settings-agents`);
    assert.ok(await sameDocument(page), 'no reload');
  });

  await check('settings sections open in a new tab', async (t) => {
    const { page } = t;
    await open(page, '/org/workspace/settings', '.settings-nav a[href="#project-agents"]');
    await opensInNewTab(t, '.settings-nav a[href="#project-agents"]', '/org/workspace/settings#project-agents');
    await page.locator('.settings-nav a[href="#project-agents"]').click();
    await page.waitForURL(`${ORIGIN}/org/workspace/settings#project-agents`);
    assert.ok(await sameDocument(page), 'no reload');
  });

  await check('the task page: back, sub-tasks and the parent are links', async (t) => {
    const { page } = t;
    await open(page, '/org/workspace?q=', '.task-row[data-id="t1"]');
    await page.locator('.task-row[data-id="t1"] a.row-link').click();
    await page.locator('.subtask-row').first().waitFor();
    await opensInNewTab(t, '#tp-back', '/org/workspace?q=');
    await opensInNewTab(t, '.subtask-row[data-open="t4"]', '/org/workspace/tasks/4');
    await page.locator('.subtask-row[data-open="t4"]').click();
    await page.locator('.tp-parent').waitFor();
    await opensInNewTab(t, '.tp-parent', '/org/workspace/tasks/1', { button: 'middle' });
    // ← returns to the list the task was opened from, in place.
    await page.locator('#tp-back').click();
    await page.waitForURL(`${ORIGIN}/org/workspace?q=`);
    await page.locator('.task-row[data-id="t1"]').waitFor();
    assert.ok(await sameDocument(page), 'no reload');
  });

  await check('palette commands that go somewhere are links', async (t) => {
    const { page } = t;
    await open(page, '/org/workspace', '.view-chip[data-view]');
    await page.keyboard.press('Control+k');
    await page.locator('#pal-in').fill('go to queues');
    await opensInNewTab(t, '#pal-list .opt', '/org/workspace/queue');
    await page.locator('#pal-list a.opt').first().click();
    await page.waitForURL(`${ORIGIN}/org/workspace/queue`);
    assert.equal(await page.locator('#pal-in').count(), 0, 'the palette closes');
    assert.ok(await sameDocument(page), 'no reload');
  });

  await check('organizations in the switcher are links', async (t) => {
    const { page } = t;
    await open(page, '/org/workspace/settings', '#org-switcher input');
    await page.locator('#org-switcher input').focus();
    await page.locator('#org-switcher .combo-opt').first().waitFor();
    await opensInNewTab(t, '#org-switcher .combo-opt[aria-selected="true"]', '/org');
    assert.equal(await page.locator('#org-switcher .combo-opt[data-index]:not([href])').count(), 1, '“New organization” is an action, not a link');
  });

  await check('the public pages link to sign-in and sign-up', async (t) => {
    const { page } = t;
    await open(page, '/', '#landing-start');
    await opensInNewTab(t, '#landing-start', '/signup');
    await opensInNewTab(t, '#landing-sign-in', '/login');
    await page.locator('#landing-sign-in').click();
    await page.waitForURL(`${ORIGIN}/login`);
    await opensInNewTab(t, '#signup-open', '/signup');
    await page.locator('#signup-open').click();
    await page.waitForURL(`${ORIGIN}/signup`);
    await opensInNewTab(t, '#signup-back', '/login');
    assert.ok(await sameDocument(page), 'no reload');
  }, { signedOut: true });

});
