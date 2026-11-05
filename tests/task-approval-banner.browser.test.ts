// A task an agent created that waits for someone to approve its authority opens
// as its form. The form used to say only "waiting for approval": its approver
// could not see what was asked nor decide there, and running it left the
// request asking in its conversation (indike.org #19). Now the request is a
// band on the form with Approve and Deny, and running the task settles it.
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { consoleRequest, hostedGateway, launchChromium, openConsole, signIn, type HostedGateway } from './helpers/browser.js';
import { AuthorizationRequests } from '../src/platform/authorization-requests.js';

let browser: Browser, g: HostedGateway;
const PASSWORD = 'correct horse battery staple 42';
const shots = process.env.KARMAX_SCREENSHOT_DIR;

beforeAll(async () => {
  browser = await launchChromium();
  g = await hostedGateway();
}, 60_000);
afterAll(async () => { await g?.close(); await browser?.close(); });

it('shows what a task waiting for approval asks for on its form, and Approve or Run task settle it', async () => {
  const { user, organization } = await g.owner({ name: 'Ada', email: 'ada@example.test', password: PASSWORD, organization: 'Acme' });
  const { page, errors, step, context } = await openConsole(browser, { ip: '192.0.2.65', viewport: { width: 1280, height: 860 } });
  try {
    await signIn(context, g.url, 'ada@example.test', PASSWORD);
    const project = await consoleRequest(context, g.url, 'POST', `/api/organizations/${organization.id}/projects`, { name: 'Website' });
    const release = await consoleRequest(context, g.url, 'POST', `/api/projects/${project.id}/tasks`,
      { workflow: 'software-dev', params: { prompt: 'Release' }, draft: true });
    await g.store.numberTask(release.id);
    const releaseNum = (await g.store.getTask(release.id))!.num;
    const requests = new AuthorizationRequests(g.store, organization.id);
    /** What `create_task` + `request_permission` leave behind for an agent's follow-up. */
    const held = async (prompt: string) => {
      const task = await g.store.createTask({ projectId: project.id, title: prompt, workflow: 'software-dev', workflowVersion: '1.4.0',
        createdBy: { kind: 'task-agent', taskId: release.id, role: 'do' } as any,
        params: { draft: true, prompt, triggers: [{ kind: 'dependency', tasks: [release.id] }] } });
      const request = await requests.request({ projectId: project.id, target: { kind: 'task', taskId: task.id, queueAfterApproval: true },
        authorization: { level: 'developer', scope: 'projects', projectIds: [project.id] },
        capabilities: ['task:conversation:message'], missingCapabilities: ['task:conversation:message'],
        audience: ['@superadmins'], recipients: [user.id], reason: 'Message the release task when the deploy is verified.',
        requestedBy: `task-agent:${release.id}:do` });
      await g.store.patchTaskParams(task.id, { _awaitingApproval: request.id });
      await g.store.numberTask(task.id);
      return { task: (await g.store.getTask(task.id))!, request };
    };
    const band = page.locator('#tf-approval');

    const verify = await held('Verify the deploy');
    await step('its form shows what it asks for, who asks and why', async () => {
      await page.goto(`${g.url}/acme/website/tasks/${verify.task.num}`);
      await band.waitFor();
      expect(await band.locator('.tf-approval-what').innerText()).toMatch(new RegExp(`^#${releaseNum}\\s+asks for\\s+Developer · Website$`));
      expect(await band.locator('.tf-approval-reason').innerText()).toBe('Message the release task when the deploy is verified.');
      expect(await band.locator('.chip').first().getAttribute('title')).toBe('Adds task:conversation:message');
      if (shots) await page.screenshot({ path: path.join(shots, 'task-approval-banner.png') });
    });

    await step('Approve grants it and arms it on what it waits for', async () => {
      await band.getByRole('button', { name: 'Approve' }).click();
      await expect.poll(async () => (await requests.requests({ taskId: verify.task.id }))[0]?.status).toBe('granted');
      const task = (await g.store.getTask(verify.task.id))!;
      expect(task.params).toMatchObject({ triggerState: 'armed', _awaitingApproval: null });
      expect(task.params.draft).toBeFalsy();
      // Its page is its armed form now, without the band.
      await expect.poll(() => page.locator('#tf-page h2').innerText()).not.toContain('waiting for approval');
      expect(await band.count()).toBe(0);
    });

    const announce = await held('Announce the release');
    await step('Run task settles the request: it no longer asks anyone', async () => {
      await page.goto(`${g.url}/acme/website/tasks/${announce.task.num}`);
      await band.waitFor();
      await page.locator('#tf-queue').click();
      await expect.poll(async () => (await requests.requests({ taskId: announce.task.id }))[0]?.status).toBe('withdrawn');
      expect((await requests.requests({ taskId: announce.task.id }))[0]?.withdrawn).toMatchObject({ by: `user:${user.id}`, reason: 'Ada ran the task' });
      expect((await g.store.getTask(announce.task.id))!.params).toMatchObject({ triggerState: 'armed' });
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 120_000);
