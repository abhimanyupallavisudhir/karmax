// The task form's head bar holds still while its save note comes and goes:
// the template button and the workflow select sit at the end of the bar
// whether the note is empty, "Unsaved changes" or "Draft saved".
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

it('keeps the template and workflow controls in place when the save note appears', async () => {
  const { organization } = await g.owner({ name: 'Ada', email: 'ada@example.test', password: PASSWORD, organization: 'Acme' });
  const { page, errors, step, context } = await openConsole(browser, { ip: '192.0.2.62', viewport: { width: 1280, height: 860 } });
  try {
    await signIn(context, g.url, 'ada@example.test', PASSWORD);
    await consoleRequest(context, g.url, 'POST', `/api/organizations/${organization.id}/projects`, { name: 'Website' });
    const note = page.locator('#tf-savestate');
    const controls = () => page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const bar = document.querySelector('.tf-head-inner')!;
      const inner = bar.getBoundingClientRect().right - parseFloat(getComputedStyle(bar).paddingRight);
      return { template: Math.round(box('#tf-template').left), workflow: Math.round(box('#tf-wf').left), endGap: Math.round(inner - box('#tf-wf').right) };
    });

    let before: Awaited<ReturnType<typeof controls>>;
    await step('the new task form opens with the controls at the end of the bar', async () => {
      await page.goto(`${g.url}/acme/website`);
      await page.locator('#expand-task').click();
      await page.locator('#tf-page textarea[data-field="prompt"]').waitFor();
      expect(await note.textContent()).toBe('');
      before = await controls();
      expect(before.endGap).toBe(0);
    });
    await step('an edit shows the save note without moving them', async () => {
      await page.locator('#tf-page textarea[data-field="prompt"]').fill('Fix the footer links');
      await expect.poll(() => note.textContent()).not.toBe('');
      expect(await controls()).toEqual(before);
      await page.locator('#tf-savestate[data-state="saved"]').waitFor();
      expect(await controls()).toEqual(before);
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 90_000);
