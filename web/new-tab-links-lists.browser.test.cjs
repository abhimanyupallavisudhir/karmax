// Everything that navigates is a real link: a Ctrl/⌘- or middle-click opens it
// in a new tab and leaves this page alone, while a plain click still navigates
// in place — no document reload, same as before it was a link. The task lists:
// view chips, rows, tag chips and inbox notices.
// Run: node web/new-tab-links-lists.browser.test.cjs
const assert = require('node:assert/strict');
const { runNewTabChecks } = require('../tests/helpers/new-tab-links.cjs');

runNewTabChecks(async ({ check, open, opensInNewTab, sameDocument, ORIGIN }) => {
  await check('view chips are links to their query', async (t) => {
    const { page } = t;
    await open(page, '/org/workspace', '.view-chip[data-view]');
    await opensInNewTab(t, '.view-chip[data-view="builtin:archived"]', '/org/workspace?q=is:archived');
    await opensInNewTab(t, '.view-chip[data-view="__active__"]', '/org/workspace?q=-is:archived', { button: 'middle' });
    // A plain click switches the query in place, replacing the entry as typing does.
    const history = await page.evaluate(() => history.length);
    await page.locator('.view-chip[data-view="builtin:archived"]').click();
    await page.waitForURL(`${ORIGIN}/org/workspace?q=is:archived`);
    await page.locator('.view-chip.active[data-view="builtin:archived"]').waitFor();
    assert.equal(await page.evaluate(() => history.length), history);
    assert.ok(await sameDocument(page), 'no reload');
    await opensInNewTab(t, '.view-chip[data-view="__for_me__"]', '/org/workspace');
  });

  await check('task rows open in a new tab; a plain click opens in place', async (t) => {
    const { page } = t;
    await open(page, '/org/workspace?q=', '.task-row[data-id="t1"]');
    await opensInNewTab(t, '.task-row[data-id="t1"] a.row-link', '/org/workspace/tasks/1');
    await opensInNewTab(t, '.task-row[data-id="t1"] a.row-link', '/org/workspace/tasks/1', { button: 'middle' });
    await page.locator('.task-row[data-id="t1"] a.row-link').click();
    await page.waitForURL(`${ORIGIN}/org/workspace/tasks/1`);
    assert.ok(await sameDocument(page), 'no reload');
    // The organization home lists every project's tasks the same way.
    await open(page, '/org?q=', '.task-row[data-id="t1"]');
    await opensInNewTab(t, '.task-row[data-id="t1"] a.row-link', '/org/workspace/tasks/1');
    await opensInNewTab(t, '.task-row[data-draft="t2"] a.row-link', '/org/workspace/tasks/2');
  });

  await check('draft and scheduled rows open in a new tab; a plain click edits in place', async (t) => {
    const { page } = t;
    await open(page, '/org/workspace?q=', '.task-row[data-draft="t2"]');
    await opensInNewTab(t, '.task-row[data-draft="t2"] a.row-link', '/org/workspace/tasks/2');
    await opensInNewTab(t, '.task-row[data-armed="t3"] a.row-link', '/org/workspace/tasks/3');
    await page.locator('.task-row[data-draft="t2"] a.row-link').click();
    await page.locator('#tf-page').waitFor();
    assert.equal(page.url(), `${ORIGIN}/org/workspace?q=`, 'the form opens over the list');
    assert.ok(await sameDocument(page), 'no reload');
  });

  await check('tag chips open their section in a new tab', async (t) => {
    const { page } = t;
    await open(page, '/org/workspace?q=', '.task-row[data-id="t1"] .tag-link');
    await opensInNewTab(t, '.task-row[data-id="t1"] .tag-link', '/org/workspace?q=group:tag-topic#tag-section-tag_ui');
    await page.locator('.task-row[data-id="t1"] .tag-link').click();
    await page.locator('#tag-section-tag_ui').waitFor();
    // Once the section is on screen the hash has done its job.
    await page.waitForURL(`${ORIGIN}/org/workspace?q=group:tag-topic`);
    assert.ok(await sameDocument(page), 'no reload');
  });

  await check('inbox notices open in a new tab and count as read', async (t) => {
    const { page, patched } = t;
    await open(page, '/inbox', '.inbox-row[data-inbox="n1"]');
    await opensInNewTab(t, '.inbox-row[data-inbox="n1"] a.row-link', '/org/settings#settings-agents', { button: 'middle' });
    await page.waitForFunction(() => !document.querySelector('.inbox-row[data-inbox="n1"]')?.classList.contains('unread'));
    assert.deepEqual(patched, ['/api/inbox/n1']);
  });

});
