// Opening a task's form and closing it without an edit writes nothing
// (pramana#132). The form saved itself on close whenever a field that fills in
// after opening (the agent, the computer, PostgreSQL's reordering of stored
// JSON) differed from the stored params; the full-form save then dropped the
// task's pending approval, turning it from "Waiting for approval" into a draft.
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

it('leaves a task waiting for approval untouched when its form is only opened, and keeps the wait through an edit', async () => {
  const { organization } = await g.owner({ name: 'Ada', email: 'ada@example.test', password: PASSWORD, organization: 'Acme' });
  const { page, errors, step, context } = await openConsole(browser, { ip: '192.0.2.64', viewport: { width: 1280, height: 860 } });
  try {
    await signIn(context, g.url, 'ada@example.test', PASSWORD);
    const project = await consoleRequest(context, g.url, 'POST', `/api/organizations/${organization.id}/projects`, { name: 'Website' });
    const first = await consoleRequest(context, g.url, 'POST', `/api/projects/${project.id}/tasks`,
      { workflow: 'software-dev', params: { prompt: 'Release' }, draft: true });
    const triggers = [{ kind: 'dependency', tasks: [first.id] }];
    const held = await consoleRequest(context, g.url, 'POST', `/api/projects/${project.id}/tasks`, { workflow: 'software-dev', draft: true,
      params: { prompt: 'Check the release', computer: { cpu: 2, memoryMb: 4096 }, triggers } });
    // As an agent's task held for approval is stored on PostgreSQL: jsonb
    // keeps object keys in its own order (shorter first).
    await g.store.patchTaskParams(held.id, { _awaitingApproval: 'areq_release', paymentPolicy: { budget: 0, cardIds: [], currency: 'usd' } });
    await g.store.numberTask(held.id);
    const stored = (await g.store.getTask(held.id))!;
    const writes: string[] = [];
    page.on('request', (request) => { if (request.method() !== 'GET') writes.push(`${request.method()} ${new URL(request.url()).pathname}`); });
    const prompt = page.locator('#tf-page textarea[data-field="prompt"]');

    await step('opening and closing it writes nothing', async () => {
      await page.goto(`${g.url}/acme/website/tasks/${stored.num}`);
      await prompt.waitFor();
      await expect.poll(() => page.locator('#tf-page').innerText()).toContain('Waiting for approval');
      await page.waitForTimeout(1500); // the agent, payments and computer rows fill in
      await page.locator('#tf-close').click();
      await page.waitForTimeout(500);
      expect(writes).toEqual([]);
      expect((await g.store.getTask(held.id))!.params).toEqual(stored.params);
    });

    await step('an edit is saved on close, and the task still waits for approval', async () => {
      await page.goto(`${g.url}/acme/website/tasks/${stored.num}`);
      await prompt.fill('Check the release and the sitemap');
      await page.locator('#tf-close').click();
      await expect.poll(() => g.store.getTask(held.id).then((task) => task!.params.prompt)).toBe('Check the release and the sitemap');
      expect((await g.store.getTask(held.id))!.params).toMatchObject({ draft: true, _awaitingApproval: 'areq_release', triggers });
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 90_000);
