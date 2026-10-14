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
 * Depending on another project's task, exactly like forking one: the
 * dependency picker reaches the organization, the chip names the project, and
 * the task form adds that project to the Authorization while the dependency is
 * chosen. Removing the project is refused when Run task is clicked.
 */
it('adds a cross-project dependency’s project to the Authorization and refuses Run without it', async () => {
  const priorHome = process.env.KARMAX_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-cross-project-'));
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
  const source = await store.createTask({ projectId: sourceProject.id, title: 'Ship the billing API', workflow: 'software-dev',
    workflowVersion: '1.0.0', params: { prompt: 'source' } });
  await store.saveView(source.id, { taskId: source.id, status: 'waiting', stage: 'review', branch: 'tavya/source',
    actions: [], messages: [], state: {} } as any);
  const gateway = await Gateway.create({ store, tokens, worlds, client, api, authorization, bus: new KarmaxBus(),
    contributions: new ContributionRegistry(), overlays: new Overlays(), taskQueue: 'test', staticDir: path.resolve('web'),
    agentInfo: { provider: 'mock', reason: 'cross-project dependency test' } });
  const running = await gateway.listen(await findFreePortFrom(48895));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${running.url}/personal/indike`);
    await page.locator('#expand-task').click();
    const scopes = () => page.locator('#tf-authorization .authz-scope-chip').evaluateAll(
      (chips) => chips.map((chip) => chip.getAttribute('data-scope')));
    await expect.poll(scopes).toEqual([project.id]);
    const pickDependency = async () => {
      await page.locator('#dep-add').click();
      // The picker starts at this project; widening it reaches the organization.
      await page.locator('#pk-search').fill('');
      await page.locator(`.pick-row[data-task="${source.id}"]`).click();
    };
    await pickDependency();

    // The chip names the other project, and that project joins the Authorization.
    const chip = page.locator(`#dep-chips [data-depid="${source.id}"]`);
    expect(await chip.locator('.task-project').innerText()).toBe('pramana');
    await expect.poll(scopes).toEqual([project.id, sourceProject.id]);
    await page.locator('#tf-body textarea[data-field="prompt"]').fill('update the client once the billing API lands');
    await page.locator('details.agent-authority:has(#tf-authorization) > summary').click();

    // Removing the dependency withdraws the project it brought along.
    await chip.locator('.dep-x').click();
    await expect.poll(scopes).toEqual([project.id]);

    // Without the dependency's project, Run task is refused at once.
    await pickDependency();
    await expect.poll(scopes).toEqual([project.id, sourceProject.id]);
    await page.locator(`#tf-authorization .authz-scope-chip[data-scope="${sourceProject.id}"] button`).click();
    await expect.poll(scopes).toEqual([project.id]);
    await page.locator('#tf-queue').click();
    await expect.poll(() => page.locator('.toast.err').allTextContents())
      .toContainEqual(expect.stringContaining('Add project "Pramana" to this task’s Authorization to depend on'));
    expect((await store.listTasks(project.id)).every((task) => task.params.draft)).toBe(true);

    // Putting it back lets the task run: armed, it waits for the other project's task.
    await page.locator('#tf-authorization .authz-scope-input').fill('Pramana');
    await page.locator('#tf-authorization .authz-scope-input').press('Enter');
    await expect.poll(scopes).toEqual([project.id, sourceProject.id]);
    await page.locator('#tf-queue').click();
    await expect.poll(async () => (await store.listTasks(project.id)).map((task) => task.params.triggerState), { timeout: 10_000 })
      .toEqual(['armed']);
    expect((await store.listTasks(project.id))[0]!.params.triggers).toEqual([{ kind: 'dependency', tasks: [source.id] }]);
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
