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
  // In a short window the expanded People list still fits on screen.
  await page.setViewportSize({ width: 1280, height: 420 });
  await box.fill('');
  await box.type('@');
  await menu.locator('.am-opt').filter({ hasText: 'People' }).dispatchEvent('mousedown');
  await step('People stays inside the window', async () => {
    await menu.getByText('@maintainers').waitFor();
    const r = (await menu.boundingBox())!;
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.y + r.height).toBeLessThanOrEqual(420);
  });
  if (shots) await page.screenshot({ path: path.join(shots, 'mention-people.png') });
  await step('the last person is reachable by keyboard', async () => {
    for (let i = (await menu.locator('.am-opt').count()) - 1; i > 0; i--) await box.press('ArrowDown');
    const active = (await menu.locator('.am-opt.active').boundingBox())!, r = (await menu.boundingBox())!;
    expect(active.y + active.height).toBeLessThanOrEqual(r.y + r.height + 1);
  });
  // The box is a transparent textarea over a painted copy of its text: a pick
  // must repaint that copy, or the picked name is invisible until the next key.
  const painted = page.locator('.followup-box[data-role="do"] .wiki-ref-backdrop');
  await box.fill('');
  await box.type('@maint');
  await box.press('Enter');
  await step('a group is written as its identifier', () => expect.poll(() => box.inputValue()).toBe('@maintainers '));
  await step('the picked group is visible at once', () => expect.poll(() => painted.textContent()).toBe('@maintainers '));
  await box.fill('');
  await box.type('@');
  await menu.locator('.am-opt').first().dispatchEvent('mousedown');
  await step('an agent picked with the mouse is visible at once', () => expect.poll(() => painted.textContent()).toBe('@Agent '));
  await page.setViewportSize({ width: 1280, height: 860 });
  await box.fill('');
  await box.type('@');
  await menu.getByText('New agent…').waitFor();
  await box.type('+');
  await step('+ adds Agent 1 with an inline form', async () => {
    await page.locator('.followup-new-agent').filter({ hasText: 'Agent 1' }).waitFor();
    expect(await box.inputValue()).toBe('@Agent 1 ');
    expect(await painted.textContent()).toBe('@Agent 1 ');
  });
  if (shots) await page.locator('.followup-box[data-role="do"]').screenshot({ path: path.join(shots, 'mention-picked.png') });
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

  // Stop, like Ctrl+C: the working agent's turn ends and the task goes on.
  // Unaddressed text still goes to the main agent after Agent 1 answered you;
  // Agent 1 is reached with @.
  await step('Agent 1 is done', () => expect.poll(async () => (await consoleRequest(context, app!.url, 'GET', `/api/tasks/${task.id}`))
    ?.participants?.find((p: any) => p.key === 'agent-1')?.state, { timeout: 30_000 }).toBe('idle'));
  expect(await box.getAttribute('placeholder')).toMatch(/^Message the agent /);
  await box.fill('');
  await box.type('@1');
  await step('@1 picks Agent 1', () => expect.poll(() => box.inputValue()).toBe('@Agent 1 '));
  await box.type('Take your time.\n@sleep 120000');
  await page.locator('.followup-box[data-role="do"] .followup-send').click();
  const stop = page.locator('.followup-box[data-role="do"] .followup-stop');
  await step('Stop appears while the agent works', () => stop.waitFor({ timeout: 60_000 }));
  expect(await stop.getAttribute('title')).toBe('Stop Agent 1');
  if (shots) await page.screenshot({ path: path.join(shots, 'stop-button.png'), fullPage: false });
  await stop.click();
  await step('the thread says who stopped it', () => page.locator('.msg.system').filter({ hasText: 'Ann Author stopped Agent 1.' }).waitFor({ timeout: 30_000 }));
  await step('Stop is gone', () => stop.waitFor({ state: 'detached' }));
  const after = await consoleRequest(context, app.url, 'GET', `/api/tasks/${task.id}`);
  expect(after.stage).toBe('review');
  expect(after.participants.map((p: any) => p.state)).toEqual(['idle', 'idle']);
  if (shots) await page.screenshot({ path: path.join(shots, 'stopped.png'), fullPage: false });

  // A group typed by hand addresses its people, as picking it does.
  await box.fill('@maintainers have a look');
  await page.locator('.followup-box[data-role="do"] .followup-send').click();
  await step('a typed identifier addresses that group', () => expect.poll(async () => {
    const events = await consoleRequest(context, app!.url, 'GET', `/api/tasks/${task.id}/events?since=0&limit=300`);
    return (events.events ?? events).map((e: any) => e.payload?.message).find((m: any) => m?.text === '@maintainers have a look')?.to;
  }, { timeout: 15_000 }).toEqual(['@maintainers']));
  expect(errors).toEqual([]);
  await context.close();
}, 240_000);
