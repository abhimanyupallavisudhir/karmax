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

// Bare words search a task's title, notes and prompt; its conversation is a filter
// of its own (`conversation:`), which the Filter menu must offer so it can be found.
it('the Filter menu searches inside conversations', async () => {
  const priorHome = process.env.KARMAX_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-conversation-'));
  process.env.KARMAX_HOME = dir;
  const store = await Store.create(':memory:');
  await seedProfiles(store, 'mock');
  const tokens = new TokenAuthority();
  const worlds = new WorldRegistry();
  const client = { workflow: { getHandle: () => ({ query: async () => undefined }), start: async () => ({}) } } as any;
  const api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'test', contentDir: dir });
  const project = await store.createProject('Factory');
  const make = async (title: string, reply: string) => {
    const task = await store.createTask({ projectId: project.id, title, workflow: 'software-dev', workflowVersion: '1.30.0', params: { prompt: title } });
    await store.saveView(task.id, { taskId: task.id, title, workflow: 'software-dev', stage: 'do', status: 'waiting', state: {}, updatedAt: 1, actions: [],
      messages: [{ id: 'u', role: 'user', text: title, ts: 1 }, { id: 'a', role: 'agent', text: reply, ts: 2 }] } as any);
    return task;
  };
  const hit = await make('Fix the release', 'Rebased; resolved a merge conflict in the lockfile.');
  const miss = await make('Write the docs', 'Added the pricing page.');
  const gateway = await Gateway.create({ store, tokens, worlds, client, api, bus: new KarmaxBus(),
    contributions: new ContributionRegistry(), overlays: new Overlays(), taskQueue: 'test', staticDir: path.resolve('web'),
    agentInfo: { provider: 'mock', reason: 'conversation search test' } });
  const running = await gateway.listen(await findFreePortFrom(49120));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${running.url}/personal/factory?q=-is:archived`);
    const rows = page.locator('#main .task-row[data-id]');
    await expect.poll(() => rows.count()).toBe(2);

    // Bare words do not reach into the conversation.
    const search = page.locator('#task-search');
    await search.fill('-is:archived merge conflict');
    await expect.poll(() => rows.count()).toBe(0);
    await search.fill('-is:archived');
    await expect.poll(() => rows.count()).toBe(2);

    await page.locator('#q-filter-field').selectOption('conversation');
    await page.locator('#fp-val').fill('merge conflict');
    await page.locator('#fp-val').press('Enter');
    await expect.poll(() => search.inputValue()).toBe('-is:archived conversation:"merge conflict"');
    await expect.poll(() => rows.count()).toBe(1);
    expect(await rows.first().getAttribute('data-id')).toBe(hit.id);
    expect(await page.locator(`#main .task-row[data-id="${miss.id}"]`).count()).toBe(0);
    const screenshots = process.env.KARMAX_SCREENSHOT_DIR;
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'search-conversation.png') });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await running.close();
    if (priorHome === undefined) delete process.env.KARMAX_HOME; else process.env.KARMAX_HOME = priorHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
