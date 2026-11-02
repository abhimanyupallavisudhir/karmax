// Task #805 (2026-11-02): a task armed on a dependency was open in its form
// when its trigger fired (a save had met the dependency). Every later save
// failed with "Use the task payments endpoint to change cards or budget", a
// refusal about cards nobody had touched, on a task that was in fact running.
// Now the form sees that the task started and shows it running.
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

it('an armed task\'s form shows the task running once its trigger fired, instead of refusing the save', async () => {
  const { organization } = await g.owner({ name: 'Ada', email: 'ada@example.test', password: PASSWORD, organization: 'Acme' });
  const { page, errors, step, context } = await openConsole(browser, { ip: '192.0.2.66', viewport: { width: 1280, height: 860 } });
  try {
    await signIn(context, g.url, 'ada@example.test', PASSWORD);
    const project = await consoleRequest(context, g.url, 'POST', `/api/organizations/${organization.id}/projects`, { name: 'Website' });
    const release = await consoleRequest(context, g.url, 'POST', `/api/projects/${project.id}/tasks`,
      { workflow: 'software-dev', params: { prompt: 'Release' }, draft: true });
    const follow = await consoleRequest(context, g.url, 'POST', `/api/projects/${project.id}/tasks`,
      { workflow: 'software-dev', params: { prompt: 'Announce it', triggers: [{ kind: 'dependency', tasks: [release.id] }] } });
    expect((await g.store.getTask(follow.id))!.params).toMatchObject({ triggerState: 'armed' });
    const num = (await g.store.getTask(follow.id))!.num;
    const toasts: string[] = [];
    await page.exposeFunction('recordToast', (text: string) => toasts.push(text));
    // Every toast as it appears: they fade before a poll could read them.
    await page.addInitScript(`new MutationObserver(() => {
      for (const toast of document.querySelectorAll('.toast:not([data-seen])')) {
        toast.dataset.seen = '1';
        window.recordToast(toast.textContent ?? '');
      }
    }).observe(document, { childList: true, subtree: true });`);

    await step('its page is its form, with Save', async () => {
      await page.goto(`${g.url}/acme/website/tasks/${num}`);
      await page.locator('#tf-queue').waitFor();
      expect(await page.locator('#tf-queue').innerText()).toContain('Save');
    });

    await step('the trigger fires while the form is open; Save shows the task running', async () => {
      // What fireTriggeredTask records (the workflow start is the worker's).
      await g.store.patchTaskParams(follow.id, { triggerState: 'fired' });
      await page.locator('textarea[data-field="prompt"]').fill('Announce it loudly');
      await page.locator('#tf-queue').click();
      await expect.poll(() => toasts).toContain('Task started');
      await expect.poll(() => page.locator('#tf-page').count()).toBe(0);
      expect(page.url()).toBe(`${g.url}/acme/website/tasks/${num}`);
      expect(toasts.join('\n')).not.toMatch(/payments|already started|Not submitted/);
      // The running task keeps the params it started with.
      expect((await g.store.getTask(follow.id))!.params).toMatchObject({ prompt: 'Announce it', triggerState: 'fired' });
    });

    await step('so does an auto-save while typing', async () => {
      const later = await consoleRequest(context, g.url, 'POST', `/api/projects/${project.id}/tasks`,
        { workflow: 'software-dev', params: { prompt: 'Thank everyone', triggers: [{ kind: 'dependency', tasks: [release.id] }] } });
      const laterNum = (await g.store.getTask(later.id))!.num;
      toasts.length = 0;
      await page.goto(`${g.url}/acme/website/tasks/${laterNum}`);
      await page.locator('#tf-queue').waitFor();
      await g.store.patchTaskParams(later.id, { triggerState: 'fired' });
      await page.locator('textarea[data-field="prompt"]').fill('Thank everyone warmly');
      await expect.poll(() => toasts).toContain('Task started');
      await expect.poll(() => page.locator('#tf-page').count()).toBe(0);
      expect(page.url()).toBe(`${g.url}/acme/website/tasks/${laterNum}`);
      expect((await g.store.getTask(later.id))!.params).toMatchObject({ prompt: 'Thank everyone', triggerState: 'fired' });
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 90_000);
