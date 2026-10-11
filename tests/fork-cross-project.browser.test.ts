import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { findFreePortFrom } from '../src/util/ports.js';
import { Gateway } from '../src/gateway/server.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { KarmaxApi } from '../src/platform/api.js';
import { seedProfiles } from '../src/agent/profiles.js';

/**
 * Forking an agent from another project's task: the fork's agent reads the
 * source conversation with the task's own grants, so the task form adds the
 * source's project to the Authorization, starts with the source's grants and
 * waits for the unfinished source. Removing that project is refused when Run
 * task is clicked — not on the agent's first turn after the task was queued.
 */
it('adds a cross-project fork source’s project to the Authorization and refuses Run without it', async () => {
  const priorHome = process.env.KARMAX_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-cross-project-'));
  process.env.KARMAX_HOME = dir;
  const store = await Store.create(':memory:');
  const tokens = new TokenAuthority(store);
  const authorization = await AuthorizationService.create(store);
  const worlds = new WorldRegistry();
  const sourceProject = await store.createProject('Pramana');
  const project = await store.createProject('Indike');
  await seedProfiles(store, 'mock');
  const client = { workflow: { getHandle: () => ({ query: async () => [] }), start: async () => ({}) } } as any;
  const api = new KarmaxApi({ store, tokens, worlds, client, authorization, taskQueue: 'test', contentDir: dir });
  const source = await store.createTask({ projectId: sourceProject.id, title: 'Unlanded source', workflow: 'software-dev',
    workflowVersion: '1.0.0', params: { prompt: 'source', _authorization: { level: 'maintainer', scope: 'projects',
      projectIds: [sourceProject.id], capabilities: [] } } });
  await store.saveView(source.id, { taskId: source.id, status: 'waiting', stage: 'review', branch: 'tavya/source',
    actions: [], messages: [], state: {} } as any);
  await store.kvSet(`session:${source.id}:do`, 'source-session');
  const gateway = await Gateway.create({ store, tokens, worlds, client, api, authorization, bus: new KarmaxBus(),
    contributions: new ContributionRegistry(), overlays: new Overlays(), taskQueue: 'test', staticDir: path.resolve('web'),
    agentInfo: { provider: 'mock', reason: 'cross-project fork test' } });
  const running = await gateway.listen(await findFreePortFrom(48885));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${running.url}/personal/indike`);
    await page.locator('#expand-task').click();
    const scopes = () => page.locator('#tf-authorization .authz-scope-chip').evaluateAll(
      (chips) => chips.map((chip) => chip.getAttribute('data-scope')));
    await expect.poll(scopes).toEqual([project.id]);
    await page.locator('#tf-body .agent-field[data-agent="do"] .af-resume-enabled').check();
    await page.locator('#tf-body .agent-field[data-agent="do"] .af-resume-pick').click();
    // The picker starts at this project; widening it reaches the organization.
    await page.locator('#pk-search').fill('');
    await page.locator(`.pick-row[data-task="${source.id}"]`).click();

    // The source's grants, its project alongside this one, and a dependency on it.
    await expect.poll(scopes).toEqual([sourceProject.id, project.id]);
    expect(await page.locator('#tf-body .af-resume-reauthorize').isChecked()).toBe(true);
    expect(await page.locator('#tf-authorization .authz-level-select').inputValue()).toBe('maintainer');
    expect(await page.locator('#tf-body .af-resume-add-dependency').isChecked()).toBe(true);
    expect(await page.locator(`#dep-chips [data-depid="${source.id}"]`).count()).toBe(1);

    // Without the source's project, Run task is refused at once.
    await page.locator('details.agent-authority:has(#tf-authorization) > summary').click();
    await page.locator(`#tf-authorization .authz-scope-chip[data-scope="${sourceProject.id}"] button`).click();
    await expect.poll(scopes).toEqual([project.id]);
    await page.locator('#tf-body textarea[data-field="prompt"]').fill('continue the source’s work');
    await page.locator('#tf-queue').click();
    await expect.poll(() => page.locator('.toast.err').allTextContents())
      .toContainEqual(expect.stringContaining('Add project "Pramana" to this task’s Authorization to fork'));
    expect((await store.listTasks(project.id)).every((task) => task.params.draft)).toBe(true);

    // Putting it back lets the fork run (armed: it waits for its source).
    await page.locator('#tf-authorization .authz-scope-input').fill('Pramana');
    await page.locator('#tf-authorization .authz-scope-input').press('Enter');
    await expect.poll(scopes).toEqual([project.id, sourceProject.id]);
    await page.locator('#tf-queue').click();
    await expect.poll(async () => (await store.listTasks(project.id)).map((task) => task.params.triggerState), { timeout: 10_000 })
      .toEqual(['armed']);
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
