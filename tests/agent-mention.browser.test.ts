import { afterAll, beforeAll, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser } from 'playwright';
import { consoleRequest, launchApp, launchChromium, openConsole, stopEmbeddedTemporal, type AppProcess } from './helpers/browser.js';
import { ensureIdentity, gitOrThrow } from '../src/world/git.js';

// One conversation, several agents, in the real console (software-dev 1.27):
// @ in the follow-up box offers the task's agents by number and [+] New agent;
// the new agent is configured inline, travels with the message, answers its
// caller in the same thread, and the task stays in Review.
const shots = process.env.KARMAX_SCREENSHOT_DIR;
let browser: Browser;
let root: string;
let app: AppProcess | undefined;
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-agent-mention-'));
  browser = await launchChromium();
});
afterAll(async () => {
  await app?.stop();
  await stopEmbeddedTemporal(path.join(root, 'home'));
  await browser?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

it('calls a new agent into a task from the follow-up box with @+', async () => {
  const home = path.join(root, 'home'), repo = path.join(root, 'repo');
  fs.mkdirSync(home);
  await gitOrThrow(root, ['init', '-q', '-b', 'main', repo]);
  await ensureIdentity(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# mention\n');
  await gitOrThrow(repo, ['add', '-A']);
  await gitOrThrow(repo, ['commit', '-q', '-m', 'init']);

  app = await launchApp(home);
  const { page, step, errors, context } = await openConsole(browser);
  await page.setViewportSize({ width: 1280, height: 860 });
  await step('create the administrator', async () => {
    await page.goto(app!.url);
    await page.getByLabel('Name').fill('Ann Author');
    await page.getByLabel('Email').fill('ann@example.test');
    await page.getByLabel('Password (10+ characters)').fill('long-mention-password');
    await page.locator('#setup-btn').click();
    await page.locator('#new-project').waitFor();
  });
  const project = await consoleRequest(context, app.url, 'POST', '/api/projects', { name: 'Mentions',
    config: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false } });
  const task = await consoleRequest(context, app.url, 'POST', `/api/projects/${project.id}/tasks`, {
    workflow: 'software-dev', params: { prompt: 'Add a greeting.\n@write hello.txt :: hello\n@run git add -A && git commit -qm hello' } });
  await step('the agent reaches Review', () => expect.poll(async () =>
    (await consoleRequest(context, app!.url, 'GET', `/api/tasks/${task.id}`))?.stage, { timeout: 60_000 }).toBe('review'));

  await step('open the conversation', () => page.goto(`${app!.url}/personal/mentions/tasks/${task.num}/checkin`));
  const box = page.locator('.followup-box[data-role="do"] .followup-input');
  await box.waitFor();
  await step('the agents are listed beside the thread', () => page.locator('.ck-participant').filter({ hasText: 'Agent' }).first().waitFor());
  await box.click();
  await box.type('@');
  const menu = page.locator('.agent-mention-menu');
  await step('@ offers the agents by number, a new agent and people', async () => {
    await menu.getByText('New agent…').waitFor();
    expect(await menu.locator('.am-key').first().innerText()).toBe('[0]');
  });
  if (shots) await page.screenshot({ path: path.join(shots, 'mention-menu.png') });
  await box.type('+');
  await step('+ adds Agent 1 with an inline form', async () => {
    await page.locator('.followup-new-agent').filter({ hasText: 'Agent 1' }).waitFor();
    expect(await box.inputValue()).toBe('@Agent 1 ');
  });
  await page.locator('.followup-new-agent select').first().selectOption('mock').catch(() => {});
  await box.type('please double-check\n@heard');
  if (shots) await page.screenshot({ path: path.join(shots, 'mention-new-agent.png') });
  await page.locator('.followup-box[data-role="do"] .followup-send').click();
  await step('Agent 1 answers in the same thread', () =>
    page.locator('.msg.agent.other-agent .role').filter({ hasText: 'Agent 1' }).waitFor({ timeout: 60_000 }));
  await step('the message shows who it was for', () => page.locator('.msg-to').filter({ hasText: 'Agent 1' }).first().waitFor());
  const v = await consoleRequest(context, app.url, 'GET', `/api/tasks/${task.id}`);
  expect(v.stage).toBe('review');
  expect(v.participants.map((p: any) => p.key)).toEqual(['do', 'agent-1']);
  if (shots) await page.screenshot({ path: path.join(shots, 'conversation.png'), fullPage: false });
  expect(errors).toEqual([]);
  await context.close();
}, 240_000);
