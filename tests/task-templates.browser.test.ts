// Task templates end to end: the shipped console against a real hosted
// gateway and database. Templates saved through the API are offered by `n`
// with their numbers; one picked fills the task form and, once edited, the
// draft it makes holds the template's prompt, tags and priority; "Save as
// template" stores the form; Task defaults edits a template in the form; `N`
// is the Task defaults alone.
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { consoleRequest, hostedGateway, launchChromium, openConsole, signIn, type HostedGateway } from './helpers/browser.js';

let browser: Browser, g: HostedGateway;
const PASSWORD = 'correct horse battery staple 42';

beforeAll(async () => {
  browser = await launchChromium();
  g = await hostedGateway();
}, 60_000);
afterAll(async () => { await g?.close(); await browser?.close(); });

it('starts tasks from templates, saves the form as one and edits one in Task defaults', async () => {
  const { organization } = await g.owner({ name: 'Ada', email: 'ada@example.test', password: PASSWORD, organization: 'Acme' });
  const { page, errors, step, context } = await openConsole(browser, { ip: '192.0.2.61', viewport: { width: 1280, height: 860 } });
  try {
    await signIn(context, g.url, 'ada@example.test', PASSWORD);
    const project = await consoleRequest(context, g.url, 'POST', `/api/organizations/${organization.id}/projects`, { name: 'Website' });
    await consoleRequest(context, g.url, 'POST', `/api/projects/${project.id}/tags`, { name: 'docs' });
    const triage = await consoleRequest(context, g.url, 'POST', `/api/organizations/${organization.id}/templates`,
      { name: 'Bug triage', params: { prompt: 'Triage the newest bug report' } });
    const notes = await consoleRequest(context, g.url, 'POST', `/api/projects/${project.id}/templates`,
      { name: 'Release notes', params: { prompt: 'Write the release notes' }, notes: 'every Friday', tags: ['docs'], priority: 3 });
    const prompt = page.locator('#tf-page textarea[data-field="prompt"]');

    await step('n lists Default, then the templates in the order they were added', async () => {
      await page.goto(`${g.url}/acme/website`);
      await page.locator('#expand-task').waitFor();
      await page.evaluate('document.activeElement && document.activeElement.blur()');
      await page.keyboard.press('n');
      await expect.poll(() => page.locator('#tpl-list .opt .tpl-name').allInnerTexts()).toEqual(['Default', 'Bug triage', 'Release notes']);
    });
    await step('2 opens the form filled from Release notes', async () => {
      await page.keyboard.press('2');
      await expect.poll(() => prompt.inputValue()).toBe('Write the release notes');
      expect(await page.locator('#tf-notes').inputValue()).toBe('every Friday');
    });
    await step('an edit drafts the task with the template’s tags and priority', async () => {
      await prompt.fill('Write the release notes for 2.0');
      await page.locator('#tf-savestate[data-state="saved"]').waitFor();
      // (A new project also comes with its set-up draft.)
      const drafts = (await g.store.listTasks(project.id)).filter((task) => task.params.draft && String(task.params.prompt).includes('release notes'));
      expect(drafts).toHaveLength(1);
      const draft = drafts[0]!;
      expect(draft.params.prompt).toBe('Write the release notes for 2.0');
      expect(draft.params.priority).toBe(3);
      expect(draft.notes).toBe('every Friday');
      const tags = await g.store.listTags(project.id);
      expect((await g.store.tagsFor(draft.id)).map((id) => tags.find((tag) => tag.id === id)?.name)).toEqual(['docs']);
    });
    await step('Save as template stores the form in the organization', async () => {
      await page.locator('#tf-save-template').click();
      await page.locator('dialog.template-save input[name="name"]').fill('Release notes 2.0');
      await page.locator('dialog.template-save [data-scope="organization"]').click();
      await page.locator('dialog.template-save button[value="submit"]').click();
      await page.getByText('Saved as template 3').waitFor();
      const saved = (await g.store.listTaskTemplates(organization.id)).find((template) => template.name === 'Release notes 2.0');
      expect(saved).toMatchObject({ projectId: '', workflow: 'software-dev', params: { prompt: 'Write the release notes for 2.0' },
        notes: 'every Friday', tags: ['docs'], priority: 3 });
      // The form's own project in its Authorization means each task's own project.
      expect(saved?.authorization?.projectIds).toBeUndefined();
      await page.keyboard.press('Escape');
      await page.locator('#tf-page').waitFor({ state: 'detached' });
    });
    await step('N opens the form with the Task defaults alone', async () => {
      await page.evaluate('document.activeElement && document.activeElement.blur()');
      await page.keyboard.press('Shift+N');
      await page.locator('#tf-page textarea[data-field="prompt"]').waitFor();
      expect(await prompt.inputValue()).toBe('');
      expect(await page.locator('#tpl-in').count()).toBe(0);
      await page.keyboard.press('Escape');
      await page.locator('#tf-page').waitFor({ state: 'detached' });
    });
    await step('Task defaults edits a template in the task form', async () => {
      await page.goto(`${g.url}/acme/website/settings#project-defaults`);
      const card = page.locator('[data-templates-card="project"]');
      // The settings page loads its panes in parallel; a busy CI runner takes longer than poll's 1 s default.
      await expect.poll(() => card.locator('.tpl-row .tpl-name').allInnerTexts(), { timeout: 10_000 }).toEqual(['Default', 'Bug triage', 'Release notes', 'Release notes 2.0']);
      await card.locator(`[data-template-id="${notes.id}"] [data-edit-template]`).click();
      await page.locator('#tf-template-name').waitFor();
      await expect.poll(() => prompt.inputValue()).toBe('Write the release notes');
      await prompt.fill('Write and publish the release notes');
      await page.locator('#tf-queue').click();
      await page.locator('#tf-page').waitFor({ state: 'detached' });
      const edited = await g.store.getTaskTemplate(notes.id);
      expect(edited).toMatchObject({ name: 'Release notes', params: { prompt: 'Write and publish the release notes' }, notes: 'every Friday', priority: 3, tags: ['docs'] });
      expect(edited?.createdAt).toBe(notes.createdAt);
    });
    await step('organization settings list its own templates', async () => {
      await page.goto(`${g.url}/acme/settings#settings-defaults`);
      const card = page.locator('[data-templates-card="global"]');
      await expect.poll(() => card.locator('[data-template-id] .tpl-name').allInnerTexts()).toEqual(['Bug triage', 'Release notes 2.0']);
      expect(await card.locator(`[data-template-id="${triage.id}"] [data-edit-template]`).count()).toBe(1);
    });
    if (process.env.KARMAX_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.KARMAX_SCREENSHOT_DIR}/task-templates-org.png` });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 120_000);
