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
 * Tasks without a computer in the console (wiki features/computerless-tasks):
 * the Computer block's None, and "Ask tavya", which starts one from anywhere.
 */
describe('a task without a computer, in the console', () => {
  let dir: string, store: Store, project: Project, browser: Browser, base: string, close: () => Promise<void>;
  let priorHome: string | undefined;
  const connections = [{ id: 'c1', organizationId: 'org_personal', provider: 'e2b', name: 'E2B', config: {}, enabled: true,
    status: 'ready', credentialConfigured: true,
    limits: { cpu: 8, memoryMb: 8192, diskGb: 64, source: { cpu: 'provider', memoryMb: 'provider', diskGb: 'provider' } } }];

  beforeAll(async () => {
    priorHome = process.env.KARMAX_HOME;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'computerless-console-'));
    process.env.KARMAX_HOME = dir;
    store = await Store.create(':memory:');
    await seedProfiles(store, 'mock');
    const tokens = new TokenAuthority();
    const worlds = new WorldRegistry();
    // A started task's live view is its stored one (no worker here).
    const client = { workflow: {
      getHandle: (id: string) => ({ query: async (name: string) => name === 'view' ? (await store.getTask(id))?.lastView ?? [] : [],
        describe: async () => ({ runId: 'run', status: { name: 'RUNNING' } }) }),
      // Started, a task publishes its view at once: the agent at work, its message box open.
      start: async (_type: unknown, options: { workflowId: string }) => {
        const task = await store.getTask(options.workflowId);
        await store.saveView(options.workflowId, { taskId: options.workflowId, title: task?.title ?? '', stage: 'do', status: 'active',
          messages: [{ id: 'm1', role: 'user', ts: Date.now(), text: String(task?.params?.prompt ?? '') }], state: {}, prs: [],
          actions: [{ name: 'followUp', label: 'Send', enabled: true }] } as never);
        return {};
      },
    } } as any;
    const providerConnections = { available: async (_organizationId: string, provider: string) => provider === 'e2b',
      list: async () => connections } as any;
    const api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'test', contentDir: dir, providerConnections });
    project = await store.createProject('Assistant');
    await store.setOrganizationExecutionPolicy(project.organizationId!, { worldProvider: 'e2b', resources: { cpu: 2, memoryMb: 4096 } });
    const gateway = await Gateway.create({ store, tokens, worlds, client, api, bus: new KarmaxBus(), providerConnections,
      contributions: new ContributionRegistry(), overlays: new Overlays(), taskQueue: 'test', staticDir: path.resolve('web'),
      agentInfo: { provider: 'mock', reason: 'computerless console test' } });
    const running = await gateway.listen(await findFreePortFrom(49060));
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
  const open = async (route: string): Promise<{ page: Page; errors: string[]; readiness: string[] }> => {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 1000 } });
    const page = await context.newPage();
    const errors: string[] = [];
    const readiness: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => { if (request.url().includes('/readiness')) readiness.push(request.url()); });
    await page.goto(`${base}${route}`);
    return { page, errors, readiness };
  };

  it('Computer: None hides the machine, is stored as such, and asks readiness for no computer', async () => {
    const { page, errors, readiness } = await open('/personal/assistant');
    await page.locator('#expand-task').click();
    const block = page.locator('#tf-body .tf-computer .computer-field');
    await block.waitFor();
    const provider = block.locator('.cf-provider');
    expect(await provider.locator('option[value="none"]').textContent()).toBe('None');
    expect(await block.locator('.cf-none').isHidden()).toBe(true);
    await page.locator('#tf-body textarea[data-field="prompt"]').fill('What is waiting on me?');
    await provider.selectOption('none');
    // Nothing to size: only the provider and its tip.
    expect(await block.locator('.cf-none').isVisible()).toBe(true);
    expect(await block.locator('.cf-none .info-dot').getAttribute('title')).toMatch(/No computer: the agent can only use tavya itself/);
    for (const size of await block.locator('.computer-size').all()) expect(await size.isHidden()).toBe(true);
    expect(await block.locator('.computer-more').isHidden()).toBe(true);
    await expect.poll(async () => (await store.listTasks(project.id)).find((task) => task.params?.prompt === 'What is waiting on me?')?.params?.computer,
      { timeout: 15_000 }).toEqual({ provider: 'none' });
    await expect.poll(() => readiness.some((url) => new URL(url).searchParams.get('computer') === 'none'), { timeout: 10_000 }).toBe(true);
    // Back to a computer: the machine shows again.
    await provider.selectOption('e2b');
    expect(await block.locator('.computer-size').first().isVisible()).toBe(true);
    expect(errors).toEqual([]);
  });

  it('Ask: a compact button and its shortcut start a task without a computer and open its page', async () => {
    const { page, errors } = await open('/personal/assistant');
    const ask = page.locator('#rail-ask');
    await ask.waitFor();
    expect(await ask.getAttribute('title')).toContain('(A)');
    // The shortcut opens it as the button does.
    await page.locator('body').press('Shift+A');
    const dialog = page.locator('dialog.ask-dialog');
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await expect.poll(() => dialog.count()).toBe(0);

    await ask.click();
    await dialog.waitFor();
    const box = dialog.locator('textarea');
    expect(await box.evaluate((element) => element === (globalThis as any).document.activeElement)).toBe(true);
    await box.fill('Turn on Codex for this project');
    await box.press('Enter');
    let created: Awaited<ReturnType<Store['listTasks']>>[number] | undefined;
    await expect.poll(async () => {
      created = (await store.listTasks(project.id)).find((task) => task.params?.prompt === 'Turn on Codex for this project');
      return created?.params?.computer;
    }, { timeout: 15_000 }).toEqual({ provider: 'none' });
    expect(created!.params.draft).toBe(false);
    // Its page opens with the message box ready for the next message.
    await expect.poll(() => page.evaluate(() => (globalThis as any).document.activeElement?.classList.contains('followup-input')), { timeout: 10_000 }).toBe(true);
    expect((created!.params._authorization as { heldBack?: string[] }).heldBack).toContain('task:delete');
    await expect.poll(() => page.url(), { timeout: 10_000 }).toContain(String(created!.num ?? created!.id));
    expect(await dialog.count()).toBe(0);
    expect(errors).toEqual([]);
  });
});
