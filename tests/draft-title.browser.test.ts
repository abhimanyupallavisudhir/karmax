// A draft's title in the task list is the first words of its prompt as it is
// now. Typing a prompt, backspacing it all away and typing another left the
// list showing the first one: an emptied prompt never re-titled the draft, and
// from then on its title no longer matched any prompt, so it never followed again.
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

it('the task list names a draft by what its prompt says now, after it was backspaced and retyped', async () => {
  const { organization } = await g.owner({ name: 'Ada', email: 'ada@example.test', password: PASSWORD, organization: 'Acme' });
  const { page, errors, step, context } = await openConsole(browser, { ip: '192.0.2.67', viewport: { width: 1280, height: 860 } });
  try {
    await signIn(context, g.url, 'ada@example.test', PASSWORD);
    const project = await consoleRequest(context, g.url, 'POST', `/api/organizations/${organization.id}/projects`, { name: 'Website' });
    const draft = async () => (await g.store.listTasks(project.id)).find((task) => task.params?.draft);
    const prompt = page.locator('#tf-body textarea[data-field="prompt"]');

    await step('type a prompt, wait for the draft', async () => {
      await page.goto(`${g.url}/acme/website`);
      await page.locator('#expand-task').click();
      await prompt.click();
      await page.keyboard.type('Fix the login');
      await expect.poll(async () => (await draft())?.params?.prompt, { timeout: 10_000 }).toBe('Fix the login');
    });

    await step('backspace it all away, then type another', async () => {
      for (let i = 0; i < 'Fix the login'.length; i++) await page.keyboard.press('Backspace');
      // An emptied prompt is left out of the saved form.
      await expect.poll(async () => (await draft())?.params?.prompt ?? '', { timeout: 10_000 }).toBe('');
      await expect.poll(async () => (await draft())?.title).toBe('Task');
      await page.keyboard.type('Add a dark mode');
      await expect.poll(async () => (await draft())?.params?.prompt, { timeout: 10_000 }).toBe('Add a dark mode');
      await expect.poll(async () => (await draft())?.title).toBe('Add a dark mode');
    });

    await step('the list shows the new words', async () => {
      await page.locator('#tf-close').click();
      const row = page.locator('.task-row[data-draft] .task-title');
      await expect.poll(() => row.allInnerTexts()).toEqual([expect.stringContaining('Add a dark mode')]);
      if (process.env.KARMAX_SCREENSHOT) await page.screenshot({ path: process.env.KARMAX_SCREENSHOT });
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 90_000);
