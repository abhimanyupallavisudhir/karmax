import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { findFreePortFrom } from '../src/util/ports.js';
import { Gateway } from '../src/gateway/server.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { KarmaxApi } from '../src/platform/api.js';
import { seedProfiles } from '../src/agent/profiles.js';

/**
 * Through the real gateway: a fork's page starts with what its agent heard in
 * the source task before the fork, marked where the fork happened, and ⌘F finds
 * a word said there.
 */
it("shows a fork's inherited conversation above its own, and finds in it", async () => {
  const priorHome = process.env.KARMAX_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-history-'));
  process.env.KARMAX_HOME = dir;
  const store = await Store.create(':memory:');
  const tokens = new TokenAuthority();
  const worlds = new WorldRegistry();
  const project = await store.createProject('Forks');
  await seedProfiles(store, 'mock');
  const client = { workflow: { getHandle: () => ({ query: async () => [] }), start: async () => ({}) } } as any;
  const api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'test', contentDir: dir });
  const T = Date.now() - 3_600_000;
  const source = await store.createTask({ projectId: project.id, title: 'Pick a codeword', workflow: 'software-dev',
    workflowVersion: '1.27.0', params: { prompt: 'Pick a codeword.' } });
  await store.saveView(source.id, { taskId: source.id, status: 'done', stage: 'done', actions: [], state: {}, messages: [
    { id: 'm0', role: 'user', text: 'Pick a codeword.', ts: T },
    { id: 'a1', role: 'agent', text: 'The codeword is heron.', ts: T + 60_000 },
    { id: 'u2', role: 'user', text: 'Said there after the fork.', ts: T + 30 * 60_000 },
  ] } as any);
  const fork = await store.createTask({ projectId: project.id, title: 'Recall it', workflow: 'software-dev', workflowVersion: '1.27.0',
    params: { prompt: 'What was the codeword?', 'agent:do': { resumeFrom: { taskId: source.id, role: 'do' } } } });
  await store.appendEvent({ type: 'session.forked', taskId: fork.id, ts: T + 10 * 60_000, payload: { from: { taskId: source.id, role: 'do' }, role: 'do', native: true } });
  await store.saveView(fork.id, { taskId: fork.id, status: 'waiting', stage: 'review', actions: [], state: {}, messages: [
    { id: 'm0', role: 'user', text: 'What was the codeword?', ts: T + 10 * 60_000 },
    { id: 'a1', role: 'agent', text: 'It was heron.', ts: T + 11 * 60_000 },
  ] } as any);
  const gateway = await Gateway.create({ store, tokens, worlds, client, api, bus: new KarmaxBus(),
    contributions: new ContributionRegistry(), overlays: new Overlays(), taskQueue: 'test', staticDir: path.resolve('web'),
    agentInfo: { provider: 'mock', reason: 'fork history test' } });
  const running = await gateway.listen(await findFreePortFrom(48955));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${running.url}/personal/forks/tasks/${fork.num}`);
    const thread = page.locator('#ck-thread');
    await thread.getByText('It was heron.').waitFor();
    await thread.locator('.fork-point').waitFor();
    const rows = await thread.locator('.msg .msg-text').allInnerTexts();
    expect(rows.map((text) => text.trim())).toEqual(['Pick a codeword.', 'The codeword is heron.', 'What was the codeword?', 'It was heron.']);
    expect((await thread.locator('.fork-point').innerText()).trim()).toBe(`Forked from #${source.num} Pick a codeword`);

    await page.keyboard.press('Control+f');
    await page.locator('#ck-find-input').fill('heron');
    await expect.poll(() => page.locator('.ck-find-count').innerText()).toBe('1/2');
    expect(await page.evaluate(() => [...(globalThis as any).CSS.highlights.get('conversation-search-current')][0].startContainer.parentElement
      .closest('[data-conversation-key]').dataset.conversationKey)).toBe(`fork:${source.id}:message:a1`);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await running.close();
    await store.close();
    if (priorHome === undefined) delete process.env.KARMAX_HOME;
    else process.env.KARMAX_HOME = priorHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
