import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { bootHarness, type Harness } from './helpers/harness.js';
import { consoleRequest, launchChromium, openConsole } from './helpers/browser.js';
import { git } from '../src/world/git.js';
import { MockAdapter } from '../src/agent/mock.js';
import type { AgentAdapter } from '../src/agent/types.js';
import { findFreePortFrom } from '../src/util/ports.js';

const LOGIN_SITE = 'login.example.test';

/** The mock agent, plus the one thing its directives cannot script: signing in
 *  through the vault the way a real agent does — request_credential, then, once
 *  the human's decision resumes the task, fill_credential for each field — over
 *  the turn's own scoped token. The secret never passes through the agent. */
function signInAgent(agentBrowser: () => string): AgentAdapter {
  const mock = new MockAdapter();
  return {
    provider: 'mock',
    async runTurn(input, ctx) {
      const latest = input.messages.at(-1)?.text ?? '';
      if (latest.includes(`@signin ${LOGIN_SITE}`))
        await ctx.platformRequest!('POST', '/api/vault/requests', { domain: LOGIN_SITE, mode: 'use', why: 'sign in to the staging site' });
      else if (latest.includes('credential decision') && latest.includes('approved')) {
        for (const [field, selector] of [['username', '#username'], ['password', '#password']])
          await ctx.platformRequest!('POST', '/api/vault/fill', { domain: LOGIN_SITE, field, selector, cdpUrl: agentBrowser() });
      }
      return mock.runTurn(input, ctx);
    },
  };
}

// Self-hosted journeys through the shipped console against a real gateway,
// Temporal worker, git and the mock agent. One harness serves every journey
// in this file, which is what keeps them inside the CI shard budget.
describe('self-hosted console journeys (real gateway, mock agent)', () => {
  let h: Harness;
  let url: string;
  let browser: Browser;
  let cdpUrl = '';

  beforeAll(async () => {
    h = await bootHarness('mock', signInAgent(() => cdpUrl));
    url = (await h.startGateway()).url;
    // Agent turns run in this process and reach the gateway the way a world's
    // platform tools do (file-isolation restores the environment afterwards).
    process.env.KARMAX_GATEWAY_URL = url;
    browser = await launchChromium();
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await h?.stop();
  });

  it('quick-adds a task, lets the agent work, confirms it in Review and lands it on main (CI-38s)', async () => {
    const repo = await h.makeRepo('journey');
    const { page, errors, step, context } = await openConsole(browser);
    const project = await consoleRequest(context, url, 'POST', '/api/projects', { name: 'Journey',
      config: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false } });
    try {
      await step('open the project', () => page.goto(`${url}/personal/journey`));
      await page.locator('#new-task').fill('@write journey.txt :: shipped from the console');
      await page.locator('#new-task').press('Control+Enter');
      const row = page.locator('.task-row').filter({ hasText: '@write journey.txt' });
      await step('the quick-added task is listed', () => row.waitFor());
      await row.locator('.row-link').click();
      const confirm = page.locator('#tp-foot [data-act="confirm"]:not([disabled])');
      await step('the agent reaches Review', () => confirm.waitFor({ timeout: 30_000 }));
      expect(await confirm.getAttribute('data-label')).toBe('Confirm PR');
      await confirm.click();
      const task = (await h.store.listTasks(project.id)).find((candidate) => candidate.title.includes('@write journey.txt'));
      await step('the task lands', () => expect.poll(async () => (await h.store.getTask(task!.id))?.lastView?.stage,
        { timeout: 30_000 }).toBe('done'));
      expect((await git(repo, ['show', 'main:journey.txt'])).stdout).toContain('shipped from the console');
      const landed = (await git(repo, ['rev-parse', '--short=8', 'main'])).stdout.trim();
      await step('the console reports the merge', () => page.getByText(`Merged into main at ${repo} as ${landed}.`).waitFor());
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 90_000);

  it('parks an agent’s credential request, lets the human add and grant it, then fills the login without the agent seeing it (CI-38w)', async () => {
    // The agent's own browser, which fill_credential types into over loopback CDP.
    const port = await findFreePortFrom(49400);
    const agentBrowser = await launchChromium({ args: [`--remote-debugging-port=${port}`] });
    cdpUrl = `http://127.0.0.1:${port}`;
    const { page, errors, step, context } = await openConsole(browser);
    try {
      const login: Page = await agentBrowser.newPage();
      await login.route(`https://${LOGIN_SITE}/**`, (route) => route.fulfill({ contentType: 'text/html',
        body: '<form><input id="username"><input id="password" type="password"></form>' }));
      await login.goto(`https://${LOGIN_SITE}/`);

      const repo = await h.makeRepo('credential-journey');
      const project = await consoleRequest(context, url, 'POST', '/api/projects', { name: 'Credential journey',
        config: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false } });
      await step('open the project', () => page.goto(`${url}/personal/credential-journey`));
      await page.locator('#new-task').fill(`@signin ${LOGIN_SITE}`);
      await page.locator('#new-task').press('Control+Enter');
      const quickAdded = async () => (await h.store.listTasks(project.id)).find((candidate) => candidate.title.includes('@signin'));
      await step('the quick-added task is created', () => expect.poll(quickAdded).toBeTruthy());
      const task = await quickAdded();

      await step('open Passwords & payments', () => page.goto(`${url}/personal/settings#settings-payments`));
      const request = page.locator('#vault-requests-card .approval-request').filter({ hasText: LOGIN_SITE });
      await step('the agent’s request arrives, not in the vault', () => request.getByText('not in vault').waitFor({ timeout: 30_000 }));
      await expect.poll(() => request.innerText()).toContain('sign in to the staging site');

      const add = page.locator('#vault-card');
      await add.locator('.vi-label').fill('Staging login');
      await add.locator('.vi-domains').fill(LOGIN_SITE);
      await add.locator('.vi-username').fill('agent@example.test');
      await add.locator('.vi-secret[data-field="password"]').fill('correct horse battery staple');
      await add.locator('.vi-use').selectOption('ask');
      await add.locator('.vi-add').click();
      await step('bind the new login to the request', () => request.locator('.vreq-bind').selectOption({ label: 'Staging login' }));
      await request.locator('[data-vreq-act="task"]').click();
      await step('the grant resumes the task', () => page.getByText('Granted — task resumed automatically').waitFor());

      await step('the agent fills the login page', () => expect.poll(async () =>
        [await login.locator('#username').inputValue(), await login.locator('#password').inputValue()],
      { timeout: 30_000 }).toEqual(['agent@example.test', 'correct horse battery staple']));
      await step('the task returns to Review', () => expect.poll(async () => (await h.store.getTask(task!.id))?.lastView?.stage,
        { timeout: 30_000 }).toBe('review'));
      const transcript = JSON.stringify(await h.store.eventsSince(task!.id, 0));
      expect(transcript).toContain('credential decision');
      expect(transcript).not.toContain('correct horse battery staple');
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      await agentBrowser.close();
    }
  }, 90_000);
});
