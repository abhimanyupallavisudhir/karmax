import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import type { Project } from '../src/domain/types.js';

/**
 * The Computer block (wiki features/computers): one block in the task form and
 * Task defaults, like the Agent. It shows the machine a task would get and
 * stores only what someone changed; Task defaults write the execution policy.
 */
describe('the Computer block', () => {
  let dir: string, store: Store, project: Project, browser: Browser, base: string, close: () => Promise<void>;
  let priorHome: string | undefined;
  const connections = [{ id: 'c1', organizationId: 'org_personal', provider: 'e2b', name: 'E2B', config: {}, enabled: true,
    status: 'ready', credentialConfigured: true }];

  beforeAll(async () => {
    priorHome = process.env.KARMAX_HOME;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-form-'));
    process.env.KARMAX_HOME = dir;
    store = await Store.create(':memory:');
    await seedProfiles(store, 'mock');
    const tokens = new TokenAuthority();
    const worlds = new WorldRegistry();
    const client = { workflow: { getHandle: () => ({ query: async () => [] }), start: async () => ({}) } } as any;
    const providerConnections = { available: async (_organizationId: string, provider: string) => provider === 'e2b',
      list: async () => connections } as any;
    const api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'test', contentDir: dir, providerConnections });
    project = await store.createProject('Machines');
    await store.setOrganizationExecutionPolicy(project.organizationId!, { worldProvider: 'e2b', resources: { cpu: 2, memoryMb: 4096 } });
    await store.setProjectExecutionPolicy(project.id, { resources: { diskGb: 50 } });
    const gateway = await Gateway.create({ store, tokens, worlds, client, api, bus: new KarmaxBus(), providerConnections,
      contributions: new ContributionRegistry(), overlays: new Overlays(), taskQueue: 'test', staticDir: path.resolve('web'),
      agentInfo: { provider: 'mock', reason: 'computer form test' } });
    const running = await gateway.listen(await findFreePortFrom(48960));
    base = running.url;
    close = running.close;
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
    await close?.();
    if (priorHome === undefined) delete process.env.KARMAX_HOME; else process.env.KARMAX_HOME = priorHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const open = async (route: string): Promise<{ page: Page; errors: string[] }> => {
    const page = await (await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 1000 } })).newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}${route}`);
    return { page, errors };
  };
  const values = (block: ReturnType<Page['locator']>) => block.evaluate((box) => Object.fromEntries(
    ['provider', 'cpu', 'memory', 'disk', 'flavor', 'hibernate', 'network'].map((key) => [key, (box.querySelector(`.cf-${key}`) as unknown as { value: string }).value])));

  it('shows the inherited machine in the task form and stores only what changed', async () => {
    const { page, errors } = await open('/personal/machines');
    await page.locator('#expand-task').click();
    const body = page.locator('#tf-body');
    const block = body.locator('.tf-computer .computer-field');
    await block.waitFor();
    // The computer sits between the agents and the branches; triggers come last.
    expect(await body.locator('.tf-main > section').evaluateAll((sections) => sections.map((section) => section.className.replace('tf-section ', ''))))
      .toEqual(['tf-agent', 'tf-responder', 'tf-confirmer', 'tf-computer', 'tf-where', 'tf-triggers']);
    expect(await values(block)).toEqual({ provider: 'e2b', cpu: '2', memory: '4', disk: '50', flavor: 'headless', hibernate: '7', network: 'unrestricted' });
    await body.locator('textarea[data-field="prompt"]').fill('Download the dataset');
    await block.locator('.cf-disk').fill('60');
    await block.locator('.cf-disk').dispatchEvent('change');
    await expect.poll(async () => (await store.listTasks(project.id)).find((task) => task.params?.prompt === 'Download the dataset')?.params?.computer,
      { timeout: 15_000 }).toEqual({ diskGb: 60 });
    // Restricted network reveals its allowlist; E2B caps the disk.
    await block.locator('.computer-more > summary').click();
    expect(await block.locator('.cf-allowlist').isHidden()).toBe(true);
    await block.locator('.cf-network').selectOption('restricted');
    expect(await block.locator('.cf-allowlist').isVisible()).toBe(true);
    expect(await block.locator('.cf-disk').getAttribute('max')).toBe('50');
    expect(errors).toEqual([]);
  });

  it('saves the project and organization computer from Task defaults', async () => {
    const { page, errors } = await open('/personal/machines/settings#project-defaults');
    const block = page.locator('#task-defaults-project .td-computer .computer-field');
    await block.waitFor();
    expect(await values(block)).toMatchObject({ provider: 'e2b', cpu: '2', memory: '4', disk: '50' });
    const reset = page.locator('#task-defaults-project .td-computer .field-reset');
    expect(await reset.isVisible()).toBe(true);
    await block.locator('.cf-cpu').fill('4');
    await page.locator('#task-defaults-project [data-save-task-defaults]').click();
    await expect.poll(async () => (await store.getProject(project.id))!.config.resources).toEqual({ cpu: 4, diskGb: 50 });
    // Reset: the project inherits the organization's computer again.
    await reset.click();
    await page.locator('#task-defaults-project [data-save-task-defaults]').click();
    await expect.poll(async () => (await store.getProject(project.id))!.config.resources).toBeUndefined();
    expect(errors).toEqual([]);

    const organization = await open('/personal/settings#settings-defaults');
    const orgBlock = organization.page.locator('#task-defaults-global .td-computer .computer-field');
    await orgBlock.waitFor();
    await orgBlock.locator('.computer-more > summary').click();
    await orgBlock.locator('.cf-hibernate').fill('3');
    await organization.page.locator('#task-defaults-global [data-save-task-defaults]').click();
    await expect.poll(async () => (await store.getOrganizationExecutionPolicy(project.organizationId!)).hibernateAfterMs).toBe(3 * 86_400_000);
    expect((await store.getOrganizationExecutionPolicy(project.organizationId!)).resources).toMatchObject({ cpu: 2, memoryMb: 4096 });
    expect(organization.errors).toEqual([]);
  });
});
