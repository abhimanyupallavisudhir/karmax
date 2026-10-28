// Task templates in the full console shell, with trusted Chromium input:
// - `n` lists the templates, numbered: 0 is Default (the Task defaults), then the
//   organization's and the project's in the order they were added. A number picks
//   one at once (unless a longer number starts with it), words search, Enter takes
//   the highlighted one — with nothing typed, Default. `N` is Default directly;
// - a template fills the new task's form (prompt, notes, tags, priority) without
//   drafting anything until you edit it;
// - "Save as template" saves the form to the project or the organization;
// - Task defaults (project and organization settings) list, add, edit and delete
//   templates, editing them in the task form itself;
// - a task page's Template tool saves that task; ⌘K offers each template.
// Run: node web/task-templates.browser.test.cjs [screenshot-dir]
const assert = require('node:assert/strict');
const { fakeConsole, launch, taskView } = require('../tests/helpers/fake-console.cjs');

(async () => {
  const shots = process.argv[2];
  const browser = await launch();
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 860 } });
    const errors = [];
    const project = { id: 'p', organizationId: 'o', name: 'Workspace', config: {} };
    const task = { id: 't', projectId: 'p', num: 1, title: 'Ship it', workflow: 'software-dev', params: { prompt: 'Ship it' }, tags: [], lastView: { stage: 'review', status: 'active' } };
    const schema = [{ name: 'software-dev', params: [{ name: 'prompt', type: 'text', label: 'Prompt', scopes: ['task'], bind: 'prompt' }], stages: [{ key: 'review', label: 'Review' }] }];
    const tags = [{ id: 'tag_docs', projectId: 'p', name: 'docs', kind: 'topic', createdAt: 1 }];
    let templates = [
      { id: 'tmpl_org', organizationId: 'o', projectId: '', name: 'Bug triage', workflow: 'software-dev', params: { prompt: 'Triage the newest bug' }, createdAt: 1, updatedAt: 1 },
      { id: 'tmpl_notes', organizationId: 'o', projectId: 'p', name: 'Release notes', workflow: 'software-dev',
        params: { prompt: 'Write the release notes' }, notes: 'every Friday', tags: ['docs'], priority: 3, createdAt: 2, updatedAt: 2 },
    ];
    const posts = [];
    await fakeConsole(context, { project, tasks: [task], schema, async api(p, request) {
      const method = request.method();
      const body = () => request.postDataJSON();
      if (p === '/api/projects/p/tags') return tags;
      if (p === '/api/projects/p/templates' && method === 'GET') return templates;
      if (p === '/api/organizations/o/templates' && method === 'GET') return templates.filter((t) => !t.projectId);
      if (/^\/api\/(projects\/p|organizations\/o)\/templates$/.test(p) && method === 'POST') {
        const created = { id: `tmpl_${templates.length}`, organizationId: 'o', projectId: p.includes('/projects/') ? 'p' : '', createdAt: 10 + templates.length, ...body() };
        posts.push([p, body()]);
        templates = [...templates, created];
        return created;
      }
      if (p.startsWith('/api/templates/') && method === 'PATCH') {
        posts.push([`PATCH ${p}`, body()]);
        templates = templates.map((t) => (`/api/templates/${t.id}` === p ? { ...t, ...body() } : t));
        return templates.find((t) => `/api/templates/${t.id}` === p);
      }
      if (p.startsWith('/api/templates/') && method === 'DELETE') {
        posts.push([`DELETE ${p}`]);
        templates = templates.filter((t) => `/api/templates/${t.id}` !== p);
        return { ok: true };
      }
      if (p === '/api/tasks/t/template') {
        posts.push([p, body()]);
        const created = { id: 'tmpl_task', organizationId: 'o', projectId: body().scope === 'organization' ? '' : 'p', name: body().name, workflow: 'software-dev', params: { prompt: 'Ship it' }, createdAt: 50 };
        templates = [...templates, created];
        return created;
      }
      if (p === '/api/projects/p/tasks' && method === 'POST') { posts.push([p, body()]); return { id: 'draft_new', projectId: 'p' }; }
      if (p === '/api/tasks/draft_new' && method === 'DELETE') { posts.push([`DELETE ${p}`]); return { ok: true }; }
      if (p === '/api/tasks/t') return taskView(task, { transcripts: [{ role: 'do', label: 'Agent', messages: [{ id: 'm', role: 'user', text: 'Ship it' }] }] });
    } });
    context.setDefaultTimeout(8000);
    const page = await context.newPage();
    page.on('pageerror', (error) => { errors.push(error.message); console.error('page:', error.message); });
    page.on('dialog', (dialog) => dialog.accept());
    const options = () => page.locator('#tpl-list .opt').evaluateAll((rows) => rows.map((row) =>
      [row.querySelector('.tpl-num').textContent, row.querySelector('.tpl-name').textContent, row.querySelector('.pal-sub')?.textContent || ''].join(' ').trim()));
    const prompt = () => page.locator('#tf-page textarea[data-field="prompt"]').inputValue();
    const closeForm = async () => { await page.keyboard.press('Escape'); await page.locator('#tf-page').waitFor({ state: 'detached' }); };
    const tasksPosted = () => posts.filter(([p]) => p === '/api/projects/p/tasks').length;

    await page.goto('http://console.test/org/workspace');
    await page.locator('[data-id="t"]').waitFor();
    await page.evaluate(() => document.activeElement?.blur());

    // ── n lists the templates, numbered ──
    await page.keyboard.press('n');
    await page.locator('#tpl-in').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('#tpl-list .opt').length === 3);
    assert.deepEqual(await options(), ['0 Default', '1 Bug triage Organization', '2 Release notes'], 'Default is 0, then the templates oldest first');
    if (shots) await page.screenshot({ path: `${shots}/template-picker.png` });

    // A number picks at once and fills the form; nothing is drafted until an edit.
    await page.keyboard.press('2');
    await page.locator('#tf-page').waitFor();
    assert.equal(await page.locator('#tpl-in').count(), 0, 'the picker closes');
    assert.equal(await prompt(), 'Write the release notes');
    assert.equal(await page.locator('#tf-notes').inputValue(), 'every Friday');
    assert.equal(await page.locator('#tf-template').innerText(), 'Release notes');
    assert.equal(await page.locator('#tf-page .org-priority').inputValue(), '3', 'its priority');
    assert.deepEqual(await page.locator('#tf-page .org-editor .tag-chip').allInnerTexts(), ['docs'], 'its tags');
    if (shots) await page.screenshot({ path: `${shots}/template-form.png` });
    await closeForm();
    assert.equal(tasksPosted(), 0, 'an untouched form from a template is not a draft');

    // Words search the names; Enter takes the first match.
    await page.keyboard.press('n');
    await page.locator('#tpl-in').waitFor();
    await page.keyboard.type('bug');
    assert.deepEqual(await options(), ['1 Bug triage Organization']);
    await page.keyboard.press('Enter');
    await page.locator('#tf-page').waitFor();
    assert.equal(await prompt(), 'Triage the newest bug');
    // An edit drafts it, with the template's tags and priority riding the create.
    await page.locator('#tf-page textarea[data-field="prompt"]').fill('Triage bug #42');
    await page.waitForFunction(() => document.querySelector('#tf-savestate')?.dataset.state === 'saved');
    await closeForm();

    // n then Enter, or N: Default — the Task defaults alone.
    await page.keyboard.press('n');
    await page.locator('#tpl-in').waitFor();
    await page.keyboard.press('Enter');
    await page.locator('#tf-page').waitFor();
    assert.equal(await prompt(), '');
    assert.equal(await page.locator('#tf-template').innerText(), '', 'no template named');
    await closeForm();
    await page.keyboard.press('Shift+N');
    await page.locator('#tf-page').waitFor();
    assert.equal(await prompt(), '', 'N opens the form with the Task defaults');
    assert.equal(await page.locator('#tpl-in').count(), 0, 'without the picker');

    // ── Save as template, from the form ──
    await page.locator('#tf-page textarea[data-field="prompt"]').fill('Bump the dependencies\nand run the tests');
    await page.locator('#tf-save-template').click();
    const dialog = page.locator('dialog.template-save');
    await dialog.waitFor();
    assert.equal(await dialog.locator('input[name="name"]').inputValue(), 'Bump the dependencies', 'named after the prompt’s first line');
    await dialog.locator('input[name="name"]').fill('Dependencies');
    await dialog.getByRole('button', { name: 'Organization', exact: true }).click();
    if (shots) await page.screenshot({ path: `${shots}/template-save.png` });
    await dialog.getByRole('button', { name: 'Save template' }).click();
    await page.getByText('Saved as template 3').waitFor();
    const saved = posts.find(([p]) => p === '/api/organizations/o/templates');
    assert.ok(saved, 'saved to the organization');
    assert.equal(saved[1].name, 'Dependencies');
    assert.equal(saved[1].params.prompt, 'Bump the dependencies\nand run the tests');
    assert.equal(saved[1].workflow, 'software-dev');
    await closeForm();

    // ── The form's template button, beside the workflow: the same picker ──
    const templateButton = page.locator('#tf-template');
    const pickInForm = async (key) => {
      await templateButton.click();
      await page.locator('#tpl-in').waitFor();
      await page.waitForFunction(() => document.querySelectorAll('#tpl-list .opt').length === 4);
      await page.keyboard.press(key);
      await page.locator('#tpl-in').waitFor({ state: 'detached' });
    };
    await page.keyboard.press('n');
    await page.locator('#tpl-in').waitFor();
    await page.keyboard.press('2');
    await templateButton.waitFor(); // #tf-page alone may still be the loading page
    assert.equal(await page.locator('#tf-template + #tf-wf').count(), 1, 'right before the workflow');
    assert.equal(await templateButton.innerText(), 'Release notes', 'names the template the form started from');
    // Another template reloads the form from it; an untouched prompt is the new template's.
    await pickInForm('1');
    await page.locator('#tf-template', { hasText: 'Bug triage' }).waitFor();
    assert.equal(await prompt(), 'Triage the newest bug');
    assert.equal(await page.locator('#tf-notes').inputValue(), '', 'nothing of the old template stays');
    assert.equal(await page.locator('#tf-page .org-priority').inputValue(), '0');
    // What you wrote stays; the draft it made gives way to the new form.
    const draftsBeforeEdit = tasksPosted();
    await page.locator('#tf-page textarea[data-field="prompt"]').fill('Fix the login page');
    await page.waitForFunction(() => document.querySelector('#tf-savestate')?.dataset.state === 'saved');
    assert.equal(tasksPosted(), draftsBeforeEdit + 1);
    // Escape closes only the picker.
    await templateButton.click();
    await page.locator('#tpl-in').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#tpl-in').waitFor({ state: 'detached' });
    assert.equal(await page.locator('#tf-page').count(), 1, 'the form stays open');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'tf-template', 'focus returns to the button');
    await pickInForm('2');
    await page.locator('#tf-template', { hasText: 'Release notes' }).waitFor();
    assert.equal(await prompt(), 'Fix the login page', 'your prompt is kept');
    assert.equal(await page.locator('#tf-notes').inputValue(), 'every Friday');
    assert.equal(await page.locator('#tf-page .org-priority').inputValue(), '3');
    assert.ok(posts.some(([p]) => p === 'DELETE /api/tasks/draft_new'), 'the auto-saved draft is replaced, not left behind');
    if (shots) {
      await page.locator('#tf-page').evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
      await page.locator('.tf-head').screenshot({ path: `${shots}/template-form-button.png` });
      await templateButton.click();
      await page.locator('#tpl-in').waitFor();
      await page.screenshot({ path: `${shots}/template-form-picker.png` });
      await page.keyboard.press('Escape');
    }
    // Default (Enter with nothing typed): the Task defaults alone.
    await pickInForm('Enter');
    await page.locator('#tf-template', { hasText: 'Release notes' }).waitFor({ state: 'detached' });
    assert.equal(await templateButton.innerText(), '', 'just the icon');
    assert.equal(await prompt(), 'Fix the login page');
    assert.equal(await page.locator('#tf-notes').inputValue(), '');
    await closeForm();

    // Many templates: a number that starts longer ones waits for more digits.
    for (let i = 0; i < 9; i++) templates.push({ id: `tmpl_more${i}`, organizationId: 'o', projectId: 'p', name: `More ${i}`, workflow: 'software-dev', params: { prompt: `More ${i}` }, createdAt: 100 + i });
    await page.keyboard.press('n');
    await page.locator('#tpl-in').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('#tpl-list .opt').length === 13);
    await page.keyboard.press('1');
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#tf-page').count(), 0, '1 waits: 10, 11 and 12 start with it');
    assert.equal(await page.locator('#tpl-list .opt.active .tpl-num').innerText(), '1');
    await page.keyboard.press('2');
    await page.locator('#tf-page').waitFor();
    assert.equal(await prompt(), 'More 8', '12 is the twelfth template');
    await closeForm();
    templates = templates.filter((t) => !t.id.startsWith('tmpl_more'));

    // ── ⌘K offers each template ──
    await page.keyboard.press('Control+k');
    await page.locator('#pal-in').fill('release notes');
    await page.locator('#pal-list .opt', { hasText: 'New task: Release notes' }).waitFor();
    await page.keyboard.press('Escape');

    // ── Task defaults: list, edit, add, delete ──
    await page.goto('http://console.test/org/workspace/settings#project-defaults');
    const card = page.locator('[data-templates-card="project"]');
    await card.locator('[data-template-id="tmpl_notes"]').waitFor();
    assert.deepEqual(await card.locator('.tpl-row').evaluateAll((rows) => rows.map((row) => `${row.querySelector('.tpl-num').textContent} ${row.querySelector('.tpl-name').textContent}`)),
      ['0 Default', '1 Bug triage', '2 Release notes', '3 Dependencies'], 'the same numbers as n');
    assert.equal(await card.locator('[data-template-id="tmpl_org"] [data-edit-template]').count(), 0, 'an organization template is edited there');
    assert.ok((await card.locator('a', { hasText: 'Organization templates' }).getAttribute('href')).endsWith('/org/settings#settings-defaults'), 'links to the organization’s');
    if (shots) await card.screenshot({ path: `${shots}/template-settings-project.png` });

    const draftsBefore = tasksPosted();
    await card.locator('[data-template-id="tmpl_notes"] [data-edit-template]').click();
    await page.locator('#tf-template-name').waitFor();
    assert.equal(await page.locator('.tf-head h2').innerText(), 'Edit template');
    assert.equal(await page.locator('#tf-template-name').inputValue(), 'Release notes');
    assert.equal(await prompt(), 'Write the release notes');
    assert.equal(await page.locator('#tf-draft').count(), 0, 'no drafts here');
    assert.equal(await page.locator('#tf-template').count(), 0, 'nor a template to start from');
    await page.locator('#tf-page textarea[data-field="prompt"]').fill('Write the release notes and post them');
    await page.locator('#tf-template-name').fill('Release notes (weekly)');
    assert.equal(await page.locator('#tf-savestate').getAttribute('data-state'), 'dirty');
    if (shots) await page.screenshot({ path: `${shots}/template-edit.png` });
    await page.keyboard.press('Control+Enter');
    await page.locator('#tf-page').waitFor({ state: 'detached' });
    const patched = posts.find(([p]) => p === 'PATCH /api/templates/tmpl_notes');
    assert.equal(patched[1].name, 'Release notes (weekly)');
    assert.equal(patched[1].params.prompt, 'Write the release notes and post them');
    assert.equal(patched[1].notes, 'every Friday', 'the rest of its form is kept');
    assert.deepEqual(patched[1].tags, ['docs']);
    assert.equal(patched[1].priority, 3);
    assert.equal(tasksPosted(), draftsBefore, 'editing a template drafts no task');
    await card.locator('.tpl-row', { hasText: 'Release notes (weekly)' }).waitFor();

    await card.locator('[data-new-template]').click();
    await page.locator('#tf-template-name').waitFor();
    assert.equal(await page.locator('.tf-head h2').innerText(), 'New template');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'tf-template-name', 'the name comes first');
    await page.locator('#tf-page textarea[data-field="prompt"]').fill('Review the open pull requests');
    await page.locator('#tf-queue').click();
    await page.getByText('Name the template').waitFor();
    await page.locator('#tf-template-name').fill('PR review');
    await page.locator('#tf-queue').click();
    await page.locator('#tf-page').waitFor({ state: 'detached' });
    const added = posts.filter(([p]) => p === '/api/projects/p/templates').pop();
    assert.equal(added[1].name, 'PR review');
    assert.equal(added[1].params.prompt, 'Review the open pull requests');
    await card.locator('.tpl-row', { hasText: 'PR review' }).waitFor();

    await card.locator('.tpl-row', { hasText: 'PR review' }).locator('[data-delete-template]').click();
    await card.locator('.tpl-row', { hasText: 'PR review' }).waitFor({ state: 'detached' });

    // The organization's settings: its own templates, and where the projects' are.
    await page.goto('http://console.test/org/settings#settings-defaults');
    const orgCard = page.locator('[data-templates-card="global"]');
    await orgCard.locator('[data-template-id="tmpl_org"]').waitFor();
    assert.deepEqual(await orgCard.locator('[data-template-id] .tpl-name').allInnerTexts(), ['Bug triage', 'Dependencies']);
    assert.equal(await orgCard.locator('.tpl-num').count(), 0, 'numbers belong to a project, where they are offered');
    assert.match(await orgCard.locator('.section-h [title]').getAttribute('title'), /a project’s own are in its settings/,
      'where the projects’ templates are is a tip, not a line');
    if (shots) await orgCard.screenshot({ path: `${shots}/template-settings-organization.png` });

    // ── A task page's Template tool saves that task ──
    await page.goto('http://console.test/org/workspace/tasks/1');
    await page.locator('#save-task-template').waitFor();
    await page.locator('#save-task-template').click();
    await dialog.waitFor();
    assert.equal(await dialog.locator('input[name="name"]').inputValue(), 'Ship it');
    await page.keyboard.press('Control+Enter');
    await page.getByText(/Saved as template \d/).waitFor();
    assert.deepEqual(posts.find(([p]) => p === '/api/tasks/t/template')[1], { name: 'Ship it', scope: 'project' });

    // The draft an edit made carried the template's tags and priority.
    const drafted = posts.find(([p]) => p === '/api/projects/p/tasks')[1];
    assert.equal(drafted.params.prompt, 'Triage bug #42');
    assert.equal(drafted.draft, true);

    assert.deepEqual(errors, []);
    console.log('Task templates: ok');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exit(1); });
