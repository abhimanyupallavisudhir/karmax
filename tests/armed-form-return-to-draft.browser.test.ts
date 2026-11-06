// Task #849 (2026-11-05): a task waiting on its dependencies offered "Save
// draft" in its form, which reads as "save my edits" although it takes the
// task out of the wait. It now says what it does: Return to draft. And a draft
// form whose task was meanwhile set running (another tab, an agent) no longer
// lets "Save draft" leave it waiting: the explicit draft button always drafts.
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

it('a waiting task\'s form returns it to draft, and Save draft always drafts', async () => {
  const { organization } = await g.owner({ name: 'Ada', email: 'ada@example.test', password: PASSWORD, organization: 'Acme' });
  const { page, errors, step, context } = await openConsole(browser, { ip: '192.0.2.67', viewport: { width: 1280, height: 860 } });
  try {
    await signIn(context, g.url, 'ada@example.test', PASSWORD);
    const project = await consoleRequest(context, g.url, 'POST', `/api/organizations/${organization.id}/projects`, { name: 'Website' });
    const release = await consoleRequest(context, g.url, 'POST', `/api/projects/${project.id}/tasks`,
      { workflow: 'software-dev', params: { prompt: 'Release' }, draft: true });
    const toasts: string[] = [];
    await page.exposeFunction('recordToast', (text: string) => toasts.push(text));
    await page.addInitScript(`new MutationObserver(() => {
      for (const toast of document.querySelectorAll('.toast:not([data-seen])')) {
        toast.dataset.seen = '1';
        window.recordToast(toast.textContent ?? '');
      }
    }).observe(document, { childList: true, subtree: true });`);

    await step('a waiting task offers Return to draft, which drafts it with the edit', async () => {
      const follow = await consoleRequest(context, g.url, 'POST', `/api/projects/${project.id}/tasks`,
        { workflow: 'software-dev', params: { prompt: 'Announce it', triggers: [{ kind: 'dependency', tasks: [release.id] }] } });
      expect((await g.store.getTask(follow.id))!.params).toMatchObject({ triggerState: 'armed' });
      await page.goto(`${g.url}/acme/website/tasks/${(await g.store.getTask(follow.id))!.num}`);
      await page.locator('#tf-draft').waitFor();
      expect(await page.locator('#tf-draft').innerText()).toBe('Return to draft');
      await page.locator('textarea[data-field="prompt"]').fill('Announce it loudly');
      await page.locator('#tf-draft').click();
      await expect.poll(() => toasts).toContain('Returned to draft');
      const params = (await g.store.getTask(follow.id))!.params;
      expect(params).toMatchObject({ draft: true, prompt: 'Announce it loudly' });
      expect(params.triggerState).toBeUndefined();
    });

    await step('a draft set waiting elsewhere while its form is open: Save draft still drafts it', async () => {
      const later = await consoleRequest(context, g.url, 'POST', `/api/projects/${project.id}/tasks`,
        { workflow: 'software-dev', params: { prompt: 'Thank everyone', triggers: [{ kind: 'dependency', tasks: [release.id] }] }, draft: true });
      toasts.length = 0;
      // A draft has no number yet: its page is addressed by id.
      await page.goto(`${g.url}/acme/website/tasks/${later.id}`);
      await page.locator('#tf-draft').waitFor();
      expect(await page.locator('#tf-draft').innerText()).toBe('Save draft');
      // Another tab runs it: its dependency is not done, so it waits.
      await consoleRequest(context, g.url, 'POST', `/api/tasks/${later.id}/queue`, {});
      expect((await g.store.getTask(later.id))!.params).toMatchObject({ triggerState: 'armed' });
      await page.locator('#tf-draft').click();
      await expect.poll(() => toasts).toContain('Draft saved');
      const params = (await g.store.getTask(later.id))!.params;
      expect(params).toMatchObject({ draft: true });
      expect(params.triggerState).toBeUndefined();
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 90_000);
