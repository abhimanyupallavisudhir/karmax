// Task #936 (2026-11-15): a task waiting on a dependency started by itself when
// its dependency landed, and asked for two app connections and a credential.
// A console loaded before the start still held it as "waiting for trigger":
// opening it from the list showed its edit form with "Save", and only that
// save (refused, "Task started") led to the conversation and its asks. The
// list row did not offer the connections at all.
// Now a task that started is shown as started, and its row offers every ask.
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { consoleRequest, hostedGateway, launchChromium, openConsole, signIn, type HostedGateway } from './helpers/browser.js';
import type { TaskView } from '../src/domain/types.js';

let browser: Browser, g: HostedGateway;
const PASSWORD = 'correct horse battery staple 42';
const shots = process.env.KARMAX_SCREENSHOT_DIR;

beforeAll(async () => {
  browser = await launchChromium();
  g = await hostedGateway();
}, 60_000);
afterAll(async () => { await g?.close(); await browser?.close(); });

it('a waiting task that started elsewhere opens as its task, and its row offers its connections', async () => {
  const { user, organization } = await g.owner({ name: 'Ada', email: 'ada@example.test', password: PASSWORD, organization: 'Acme' });
  const { page, errors, step, context } = await openConsole(browser, { ip: '192.0.2.67', viewport: { width: 1280, height: 860 } });
  try {
    await signIn(context, g.url, 'ada@example.test', PASSWORD);
    const project = await consoleRequest(context, g.url, 'POST', `/api/organizations/${organization.id}/projects`, { name: 'Website' });
    const release = await consoleRequest(context, g.url, 'POST', `/api/projects/${project.id}/tasks`,
      { workflow: 'software-dev', params: { prompt: 'Release' }, draft: true });
    const waiting = async (prompt: string) => {
      const task = await consoleRequest(context, g.url, 'POST', `/api/projects/${project.id}/tasks`,
        { workflow: 'software-dev', params: { prompt, triggers: [{ kind: 'dependency', tasks: [release.id] }] } });
      expect((await g.store.getTask(task.id))!.params).toMatchObject({ triggerState: 'armed' });
      return (await g.store.getTask(task.id))!;
    };
    const view = (task: { id: string; title: string }): TaskView => ({ taskId: task.id, title: task.title, workflow: 'software-dev',
      stage: 'do', status: 'waiting', waitingFor: { kind: 'human', detail: 'Connect Search Console, please.' } as any,
      state: {}, actions: [], updatedAt: Date.now(),
      messages: [{ id: 'a1', role: 'agent', text: 'Connect Search Console, please.', ts: Date.now() }] } as any);
    /** What fireTriggeredTask and the started workflow leave behind; `announce`: its view.updated. */
    const fire = async (task: { id: string; title: string }, announce: boolean) => {
      await g.store.patchTaskParams(task.id, { triggerState: 'fired' });
      await g.store.saveView(task.id, view(task));
      if (announce) await g.store.appendEvent({ taskId: task.id, type: 'view.updated', ts: Date.now(),
        payload: { stage: 'do', status: 'waiting', waitingFor: 'human', waitingDetail: 'Connect Search Console, please.' } });
    };
    const row = (num: number) => page.locator('.task-row').filter({ hasText: `#${num}` });

    const verify = await waiting('Verify the release');
    // The list as the page read it; waiting tasks are not in the default list.
    const listed = async () => { await page.goto(`${g.url}/acme/website`); await page.locator('.task-row').first().waitFor(); };
    await step('the page holds it as waiting for its trigger', async () => {
      await listed();
      expect(await row(verify.num!).count()).toBe(0);
    });

    await step('its trigger fires: the open list shows it, and it opens as its task', async () => {
      await fire(verify, true);
      await row(verify.num!).waitFor();
      expect(await row(verify.num!).innerText()).not.toContain('Waiting for trigger');
      await row(verify.num!).click();
      await expect.poll(() => page.url()).toBe(`${g.url}/acme/website/tasks/${verify.num}`);
      await page.getByText('Connect Search Console, please.').first().waitFor();
      expect(await page.locator('#tf-page').count()).toBe(0);
    });

    const check = await waiting('Check the sitemap');
    await step('a start the page never heard of still opens as the task, not its form', async () => {
      await listed();
      await fire(check, false);
      // The page's record still says it waits; the server says it runs.
      await page.evaluate((num) => {
        const w = globalThis as any;
        w.history.pushState({ kx: 1 }, '', `${w.location.pathname}/tasks/${num}`);
        w.dispatchEvent(new w.PopStateEvent('popstate', { state: { kx: 1 } }));
      }, check.num);
      await page.getByText('Connect Search Console, please.').first().waitFor();
      expect(await page.locator('#tf-page').count()).toBe(0);
      expect(await page.locator('#tf-queue').count()).toBe(0);
    });

    await step('the list row offers its app connection and its credential ask', async () => {
      const connection = { id: 'conn_gsc', organizationId: organization.id, toolkit: 'google_search_console',
        label: 'Google Search Console', projectIds: [project.id], taskId: check.id, status: 'requested',
        why: 'Resubmit the sitemap.', createdAt: Date.now(), updatedAt: Date.now() };
      await g.store.kvSet(`service-connection:${connection.id}`, JSON.stringify(connection));
      await g.store.appendEvent({ taskId: check.id, type: 'connection.requested', ts: Date.now(),
        payload: { requestId: connection.id, connectionId: connection.id, toolkit: connection.toolkit, recipients: [user.id] } });
      await page.goto(`${g.url}/acme/website`);
      const decisions = page.locator(`[data-row-decisions="${check.id}"]`);
      await decisions.locator('[data-connection="conn_gsc"]').waitFor();
      expect(await decisions.locator('[data-connection="conn_gsc"]').innerText()).toContain('Google Search Console');
      expect(await decisions.locator('[data-connection="conn_gsc"] [data-connection-action="connect"]').count()).toBe(1);
      if (shots) await page.screenshot({ path: path.join(shots, 'row-connection-ask.png') });
    });

    await step('Connect on the row starts the sign-in for that request', async () => {
      const asked: unknown[] = [];
      await page.route('**/api/connections/connect?*', async (route) => {
        asked.push(route.request().postDataJSON());
        await route.fulfill({ json: { url: `${g.url}/signed-in`, callback: 'composio' } });
      });
      const popup = page.waitForEvent('popup');
      await page.locator(`[data-row-decisions="${check.id}"] [data-connection="conn_gsc"] [data-connection-action="connect"]`).click();
      await expect.poll(() => asked).toEqual([{ id: 'conn_gsc', restart: false }]);
      await (await popup).close();
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 120_000);
