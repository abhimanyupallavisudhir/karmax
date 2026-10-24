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
 * A fork lands where its source lands. With the organization defaulting to
 * master and the source having landed on a main-only repository, the form
 * must not keep the inherited master target — provisioning refuses a target
 * the repository lacks (notyet_research #2).
 */
it('fills a fork’s target with where its source lands, not the default', async () => {
  const priorHome = process.env.KARMAX_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-target-branch-'));
  process.env.KARMAX_HOME = dir;
  const store = await Store.create(':memory:');
  const tokens = new TokenAuthority();
  const worlds = new WorldRegistry();
  const project = await store.createProject('Forks');
  await store.setSettings('organization:org_personal', '__common__', { base: 'master', target: 'master' });
  await seedProfiles(store, 'mock');
  const client = { workflow: { getHandle: () => ({ query: async () => [] }), start: async () => ({}) } } as any;
  const api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'test', contentDir: dir });
  const source = await store.createTask({ projectId: project.id, title: 'Landed source', workflow: 'software-dev',
    workflowVersion: '1.0.0', params: { prompt: 'source', base: 'main', target: 'main' } });
  await store.saveView(source.id, { taskId: source.id, status: 'done', stage: 'done', branch: 'tavya/source',
    targetBranch: 'main', actions: [], messages: [], state: {} } as any);
  await store.kvSet(`session:${source.id}:do`, 'source-session');
  const gateway = await Gateway.create({ store, tokens, worlds, client, api, bus: new KarmaxBus(),
    contributions: new ContributionRegistry(), overlays: new Overlays(), taskQueue: 'test', staticDir: path.resolve('web'),
    agentInfo: { provider: 'mock', reason: 'fork target test' } });
  const running = await gateway.listen(await findFreePortFrom(48945));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${running.url}/personal/forks`);
    await page.locator('#expand-task').click();
    const base = page.locator('#tf-body [data-field="base"]');
    const target = page.locator('#tf-body [data-field="target"]');
    await expect.poll(() => target.inputValue()).toBe('master');
    await page.locator('#tf-body .agent-field[data-agent="do"] .af-resume-enabled').check();
    await page.locator('#tf-body .agent-field[data-agent="do"] .af-resume-pick').click();
    await page.locator(`.pick-row[data-task="${source.id}"]`).click();
    await expect.poll(() => base.inputValue()).toBe('main');
    expect(await target.inputValue()).toBe('main');
    await page.locator('#tf-body textarea[data-field="prompt"]').fill('follow up');
    await expect.poll(async () => (await store.listTasks(project.id)).find((t) => t.id !== source.id)?.params, { timeout: 10_000 })
      .toMatchObject({ base: 'main', target: 'main' });
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
