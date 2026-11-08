// A task's Parameters say who created it: a person (and the app or token they
// used, when not the console), or a task's agent with a link to its task. A
// draft — which opens as its form — says it too.
// Screens: KARMAX_SHOTS=design/task-creator npx vitest run tests/task-creator.browser.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { consoleRequest, hostedGateway, launchChromium, openConsole, signIn, type HostedGateway } from './helpers/browser.js';

let browser: Browser, g: HostedGateway;
const PASSWORD = 'correct horse battery staple 42';
const shots = process.env.KARMAX_SHOTS;
const shoot = async (page: Page, name: string) => {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
};

beforeAll(async () => {
  browser = await launchChromium();
  g = await hostedGateway();
}, 60_000);
afterAll(async () => { await g?.close(); await browser?.close(); });

/** As if it had started (no Temporal here): numbered, and its workflow published a view. */
async function start(taskId: string, title: string): Promise<number> {
  await g.store.clearDraft(taskId);
  await g.store.db.prepare('UPDATE tasks SET lastView=? WHERE id=?').run(JSON.stringify({ taskId, title, workflow: 'software-dev',
    stage: 'do', status: 'active', actions: [], state: {}, messages: [{ id: 'm0', role: 'user', text: title, ts: Date.now() }] }), taskId);
  return (await g.store.getTask(taskId))!.num!;
}

it('Parameters name the person or the agent (linked to its task) that created a task, and the token used', async () => {
  const { user, organization } = await g.owner({ name: 'Ada Lovelace', email: 'ada@example.test', password: PASSWORD, organization: 'Acme' });
  const { page, errors, step, context } = await openConsole(browser, { ip: '192.0.2.71', viewport: { width: 1280, height: 860 } });
  try {
    await signIn(context, g.url, 'ada@example.test', PASSWORD);
    const project = await consoleRequest(context, g.url, 'POST', `/api/organizations/${organization.id}/projects`, { name: 'Website' });
    const create = (title: string, auth?: string) => auth
      ? fetch(`${g.url}/api/projects/${project.id}/tasks`, { method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
        body: JSON.stringify({ workflow: 'software-dev', title, params: { prompt: title }, draft: true }) }).then(async (r) => {
        if (!r.ok) throw new Error(`create: ${r.status} ${await r.text()}`);
        return r.json() as Promise<{ id: string }>;
      })
      : consoleRequest(context, g.url, 'POST', `/api/projects/${project.id}/tasks`, { workflow: 'software-dev', title, params: { prompt: title }, draft: true });

    const planner = await create('Plan the launch');
    const plannerNum = await start(planner.id, 'Plan the launch');
    const agent = (await g.tokens.mint({ taskId: planner.id, profileId: 'claude', role: 'do', principal: `user:${user.id}`,
      projectId: project.id, organizationId: organization.id, ceiling: ['*'], grantorCaps: ['*'] })).token;
    const child = await create('Write the announcement', agent);
    const childNum = await start(child.id, 'Write the announcement');

    await step("an agent's task: linked to the task whose agent created it", async () => {
      await page.goto(`${g.url}/acme/website/tasks/${childNum}/parameters`);
      const line = page.locator('#tp-body .tp-creator');
      await line.waitFor();
      expect((await line.innerText()).replace(/\s+/g, ' ')).toMatch(new RegExp(`^Created by Agent of #${plannerNum} Plan the launch (just now|\\d+m ago)$`));
      await shoot(page, 'agent-created');
      await line.locator('a').click();
      await page.waitForURL(new RegExp(`/tasks/${plannerNum}(/|$)`));
    });

    await step('a person through a personal token: their name and the token', async () => {
      const minted = await consoleRequest(context, g.url, 'POST', '/api/user/tokens', { name: 'Release CI', expiresInDays: 7 });
      const byToken = await create('Tag the release', minted.token);
      const num = await start(byToken.id, 'Tag the release');
      await page.goto(`${g.url}/acme/website/tasks/${num}/parameters`);
      const line = page.locator('#tp-body .tp-creator');
      await line.waitFor();
      expect((await line.innerText()).replace(/\s+/g, ' ')).toMatch(/^Created by You via Release CI /);
      expect(await line.locator('.tp-creator-via').getAttribute('title')).toBe('Personal access token');
      await shoot(page, 'token-created');
    });

    await step("a draft an agent planned: its form says so", async () => {
      const draft = await create('Translate the announcement', agent);
      await page.goto(`${g.url}/acme/website/tasks/${draft.id}`);
      const line = page.locator('#tf-page .tp-creator');
      await line.waitFor();
      expect((await line.innerText()).replace(/\s+/g, ' ')).toMatch(new RegExp(`^Created by Agent of #${plannerNum} Plan the launch `));
      if (shots) await page.waitForFunction(() => (globalThis as unknown as { document: { getAnimations(): Array<{ playState: string }> } })
        .document.getAnimations().every((animation) => animation.playState !== 'running'));
      await shoot(page, 'agent-draft');
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 90_000);
