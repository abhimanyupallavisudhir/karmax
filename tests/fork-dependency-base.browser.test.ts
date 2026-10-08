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
 * A fork of an unlanded task starts from the source's branch. Once the source
 * is also a dependency, the fork only starts after the source has landed, so
 * the task form moves the base branch back to the default — unless the user
 * picked a base branch themselves.
 */
it('resets a fork’s base branch when its source becomes a dependency', async () => {
  const priorHome = process.env.KARMAX_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-dependency-base-'));
  process.env.KARMAX_HOME = dir;
  const store = await Store.create(':memory:');
  const tokens = new TokenAuthority();
  const worlds = new WorldRegistry();
  const project = await store.createProject('Forks');
  await seedProfiles(store, 'mock');
  const client = { workflow: { getHandle: () => ({ query: async () => [] }), start: async () => ({}) } } as any;
  const api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'test', contentDir: dir });
  const source = await store.createTask({ projectId: project.id, title: 'Unlanded source', workflow: 'software-dev',
    workflowVersion: '1.0.0', params: { prompt: 'source' } });
  await store.saveView(source.id, { taskId: source.id, status: 'waiting', stage: 'review', branch: 'tavya/source',
    actions: [], messages: [], state: {} } as any);
  await store.kvSet(`session:${source.id}:do`, 'source-session');
  const gateway = await Gateway.create({ store, tokens, worlds, client, api, bus: new KarmaxBus(),
    contributions: new ContributionRegistry(), overlays: new Overlays(), taskQueue: 'test', staticDir: path.resolve('web'),
    agentInfo: { provider: 'mock', reason: 'fork dependency test' } });
  const running = await gateway.listen(await findFreePortFrom(48865));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${running.url}/personal/forks`);
    // Fork the source's agent from a new task, the way a user does.
    await page.locator('#expand-task').click();
    await page.locator('#tf-body .agent-field[data-agent="do"] .af-resume-enabled').check();
    await page.locator('#tf-body .agent-field[data-agent="do"] .af-resume-pick').click();
    await page.locator(`.pick-row[data-task="${source.id}"]`).click();
    const base = page.locator('#tf-body [data-field="base"]');
    const dependency = page.locator('#tf-body .af-resume-add-dependency');
    const chips = page.locator('#dep-chips [data-depid]');
    await expect.poll(() => base.inputValue()).toBe('tavya/source');

    await dependency.check();
    expect(await chips.count()).toBe(1);
    expect(await base.inputValue()).toBe('main');
    // Dropping the dependency (here from its chip) restores the fork's branch.
    await page.locator(`#dep-chips [data-depx="${source.id}"]`).click();
    expect(await dependency.isChecked()).toBe(false);
    expect(await base.inputValue()).toBe('tavya/source');

    // A base branch the user chose is left alone either way.
    await base.fill('feature/mine');
    await base.dispatchEvent('change');
    await dependency.check();
    expect(await base.inputValue()).toBe('feature/mine');
    await dependency.uncheck();
    expect(await base.inputValue()).toBe('feature/mine');

    // The reset base is what gets saved.
    await base.fill('tavya/source');
    await base.dispatchEvent('change');
    await dependency.check();
    await page.locator('#tf-body textarea[data-field="prompt"]').fill('after the source lands');
    await expect.poll(async () => (await store.listTasks(project.id)).find((t) => t.id !== source.id)?.params, { timeout: 10_000 })
      .toMatchObject({ base: 'main', triggers: [{ kind: 'dependency', tasks: [source.id] }] });
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
