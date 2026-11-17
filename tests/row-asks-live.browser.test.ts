// Task #955 (2026-11-17): an agent asked for an app connection while it worked.
// The open list marked the row "Needs approval" at once, but its Connect button
// came only with a reload. A row offers what its task asks as soon as it asks.
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { consoleRequest, hostedGateway, launchChromium, openConsole, signIn, type HostedGateway } from './helpers/browser.js';
import type { TaskView } from '../src/domain/types.js';

let browser: Browser, g: HostedGateway;
const PASSWORD = 'correct horse battery staple 42';

beforeAll(async () => {
  browser = await launchChromium();
  g = await hostedGateway();
}, 60_000);
afterAll(async () => { await g?.close(); await browser?.close(); });

it('a connection asked for while the agent works shows its Connect button on the open list', async () => {
  const { user, organization } = await g.owner({ name: 'Ada', email: 'ada@example.test', password: PASSWORD, organization: 'Acme' });
  const { page, errors, step, context } = await openConsole(browser, { ip: '192.0.2.68', viewport: { width: 1280, height: 860 } });
  try {
    await signIn(context, g.url, 'ada@example.test', PASSWORD);
    const project = await consoleRequest(context, g.url, 'POST', `/api/organizations/${organization.id}/projects`, { name: 'Website' });
    // A task that started (as a fired trigger leaves it), with no workflow behind it.
    const release = await consoleRequest(context, g.url, 'POST', `/api/projects/${project.id}/tasks`,
      { workflow: 'software-dev', params: { prompt: 'Release' }, draft: true });
    const created = await consoleRequest(context, g.url, 'POST', `/api/projects/${project.id}/tasks`,
      { workflow: 'software-dev', params: { prompt: 'Check the sitemap', triggers: [{ kind: 'dependency', tasks: [release.id] }] } });
    const task = (await g.store.getTask(created.id))!;
    await g.store.patchTaskParams(task.id, { triggerState: 'fired' });
    const working: TaskView = { taskId: task.id, title: task.title, workflow: 'software-dev', stage: 'do', status: 'active',
      state: {}, actions: [], updatedAt: Date.now(), messages: [{ id: 'm0', role: 'user', text: 'Check the sitemap', ts: Date.now() }] } as any;
    await g.store.saveView(task.id, working);
    const row = page.locator('.task-row').filter({ hasText: `#${task.num}` });

    await step('the project list is open, the agent working', async () => {
      await page.goto(`${g.url}/acme/website`);
      await page.locator('.task-row').first().waitFor();
    });

    const ask = async (id: string, label: string, toolkit: string) => {
      const connection = { id, organizationId: organization.id, toolkit, label, projectIds: [project.id], taskId: task.id,
        status: 'requested', why: 'Needed for the task.', createdAt: Date.now(), updatedAt: Date.now() };
      await g.store.kvSet(`service-connection:${id}`, JSON.stringify(connection));
      await g.store.appendEvent({ taskId: task.id, type: 'connection.requested', ts: Date.now(),
        payload: { requestId: id, connectionId: id, toolkit } });
      return connection;
    };
    const connect = row.locator('[data-connection-action="connect"]');

    const gmail = await step('the agent asks for Gmail: its row offers Connect', async () => {
      const asked = await ask('conn_gmail', 'Gmail', 'gmail');
      await row.getByText('Needs approval').waitFor({ timeout: 10_000 });
      await row.locator('[data-connection="conn_gmail"] [data-connection-action="connect"]').waitFor({ timeout: 10_000 });
      return asked;
    });

    await step('Gmail is connected elsewhere: the row stops asking', async () => {
      await g.store.kvSet(`service-connection:${gmail.id}`, JSON.stringify({ ...gmail, status: 'active', ownerId: user.id, updatedAt: Date.now() }));
      await g.store.appendEvent({ taskId: task.id, type: 'connection.updated', ts: Date.now(),
        payload: { requestId: gmail.id, connectionId: gmail.id, status: 'active' } });
      await expect.poll(() => connect.count(), { timeout: 10_000 }).toBe(0);
    });

    await step('then it asks for Stripe: the open row offers Connect without a reload (#955)', async () => {
      await ask('conn_stripe', 'Stripe', 'mcp:com.stripe/mcp');
      await row.getByText('Needs approval').waitFor({ timeout: 10_000 });
      await row.locator('[data-connection="conn_stripe"] [data-connection-action="connect"]').waitFor({ timeout: 10_000 });
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 120_000);
