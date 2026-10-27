// Avatars in the full console shell (wiki features/avatars), with trusted
// Chromium input:
// - the task form's Avatar row, at its bottom: ticking it reveals Callable by
//   (the project by default), "Forks can be Avatars" and "Save as Avatar
//   without running";
// - saving says what an Avatar risks first, once "Don't show this again" is
//   ticked never again, and auto-save never makes one;
// - a task saved as an Avatar rests in the list as ✦ Avatar with a Fork button.
// Run: node web/avatars.browser.test.cjs [screenshot-dir]
const assert = require('node:assert/strict');
const { fakeConsole, launch } = require('../tests/helpers/fake-console.cjs');

(async () => {
  const shots = process.argv[2];
  const browser = await launch();
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
    const errors = [];
    const project = { id: 'p', organizationId: 'o', name: 'Workspace', config: {} };
    const atlas = { id: 'av', projectId: 'p', num: 2, title: 'Atlas', workflow: 'software-dev', tags: [],
      params: { prompt: 'You are Atlas, my release delegate.', draft: true, avatar: { callableBy: ['@project'] } } };
    const schema = [{ name: 'software-dev', params: [{ name: 'prompt', type: 'text', label: 'Prompt', scopes: ['task'], bind: 'prompt' }],
      stages: [{ key: 'do', label: 'Working' }] }];
    const saves = [];
    await fakeConsole(context, { project, tasks: [atlas], schema, async api(p, request) {
      const method = request.method();
      if (p === '/api/projects/p/avatars') return { availability: { organization: true, project: 'inherit', effective: true },
        avatars: [{ id: 'av', num: 2, name: 'Atlas', callable: true, callableBy: ['@project'], forksMayBeAvatars: false }] };
      if (p === '/api/projects/p/tasks' && method === 'POST') { saves.push(request.postDataJSON()); return { id: 'draft_new', projectId: 'p', params: {} }; }
      if (p === '/api/tasks/draft_new/params' && method === 'PATCH') { saves.push(request.postDataJSON()); return { id: 'draft_new' }; }
      if (p.startsWith('/api/tasks/draft_new/')) return { id: 'draft_new' };
    } });
    context.setDefaultTimeout(8000);
    const page = await context.newPage();
    page.on('pageerror', (error) => { errors.push(error.message); console.error('page:', error.message); });
    const avatarSaves = () => saves.filter((save) => (save.params || {}).avatar);

    await page.goto('http://console.test/org/workspace?q=is:avatar');
    // ── the list: a task saved as an Avatar rests as ✦ Avatar, with Fork ──
    const row = page.locator('.task-row[data-draft="av"]');
    await row.waitFor();
    assert.match(await row.innerText(), /✦ Avatar/);
    assert.equal(await row.locator('[data-fork-avatar="av"]').count(), 1);
    assert.equal(await row.locator('[data-queue]').count(), 0, 'an Avatar is forked, not run, from its row');
    if (shots) await row.screenshot({ path: `${shots}/avatar-row.png` });

    // ── the form: the Avatar row at the bottom ──
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Shift+N');
    await page.locator('#tf-page').waitFor();
    await page.locator('#tf-page textarea[data-field="prompt"]').fill('Review release notes like I would');
    const avatar = page.locator('#tf-avatar');
    assert.equal(await page.locator('.tf-avatar-options').isHidden(), true);
    assert.equal(await page.locator('#tf-save-avatar').isHidden(), true);
    assert.match(await page.locator('.tf-avatar .risk-chip').innerText(), /At your own risk/);
    await avatar.check();
    assert.equal(await page.locator('.tf-avatar-options').isVisible(), true);
    assert.equal(await page.locator('.tf-avatar-callers').inputValue(), '@project');
    assert.equal(await page.locator('#tf-save-avatar').isVisible(), true);
    await page.locator('#tf-avatar-forks').check();
    // Auto-save never makes an Avatar on its own.
    await page.waitForTimeout(1200);
    assert.equal(avatarSaves().length, 0, 'auto-save keeps the setting until it is acknowledged');
    await page.locator('.tf-avatar').scrollIntoViewIfNeeded();
    if (shots) await page.locator('.tf-avatar').screenshot({ path: `${shots}/avatar-form-row.png` });

    // ── saving it says what it risks; Cancel keeps it unsaved ──
    await page.locator('#tf-save-avatar').click();
    const notice = page.locator('.avatar-notice');
    await notice.waitFor();
    assert.match(await notice.innerText(), /Avatars automatically grant their authorizations to their future forks\./);
    assert.match(await notice.innerText(), /prompt injection/);
    if (shots) await page.screenshot({ path: `${shots}/avatar-notice.png` });
    await notice.getByRole('button', { name: 'Cancel' }).click();
    await notice.waitFor({ state: 'detached' });
    assert.equal(avatarSaves().length, 0);
    assert.equal(await page.locator('#tf-page').count(), 1, 'cancelling stays in the form');

    // ── acknowledged (and never again), it saves as an Avatar without running ──
    await page.locator('#tf-save-avatar').click();
    await notice.waitFor();
    await notice.getByLabel('Don’t show this again').check();
    await notice.getByRole('button', { name: 'Make it an Avatar' }).click();
    await page.locator('#tf-page').waitFor({ state: 'detached' });
    const saved = avatarSaves().at(-1);
    assert.deepEqual(saved.params.avatar, { callableBy: ['@project'], forksMayBeAvatars: true });
    assert.notEqual(saved.draft, false, 'saved without running');
    assert.equal(await page.evaluate(() => localStorage.getItem('tavya.avatarNoticeDismissed')), '1');
    await page.locator('.toast', { hasText: 'Saved as Avatar' }).waitFor();

    // ── a second Avatar: no dialog any more ──
    await page.keyboard.press('Shift+N');
    await page.locator('#tf-page').waitFor();
    await page.locator('#tf-page textarea[data-field="prompt"]').fill('A second delegate');
    await page.locator('#tf-avatar').check();
    const before = avatarSaves().length;
    await page.locator('#tf-save-avatar').click();
    await page.locator('#tf-page').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.avatar-notice').count(), 0);
    assert.equal(avatarSaves().length, before + 1);

    assert.deepEqual(errors, []);
    console.log('PASS: Avatar row, risk notice with Don’t show this again, Save as Avatar without running, resting ✦ Avatar rows');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
