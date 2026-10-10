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
import { ensureIdentity, gitOrThrow } from '../src/world/git.js';
import type { Project } from '../src/domain/types.js';

/**
 * "Different branches per repo?" under Base/Target, in the task form and in a
 * project's Task defaults: off, one pair serves every repository; on, each
 * repository gets its own pair, starting from its own default branch.
 */
describe('different branches per repo', () => {
  let dir: string, store: Store, project: Project, browser: Browser, base: string, close: () => Promise<void>;
  let app: string, lib: string;
  let priorHome: string | undefined;
  const shots = process.env.KARMAX_SCREENSHOTS;

  beforeAll(async () => {
    priorHome = process.env.KARMAX_HOME;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-branches-form-'));
    process.env.KARMAX_HOME = dir;
    app = path.join(dir, 'app'); lib = path.join(dir, 'lib');
    for (const [repo, branch] of [[app, 'main'], [lib, 'master']] as const) {
      fs.mkdirSync(repo);
      await gitOrThrow(repo, ['init', '-q', '-b', branch]);
      await ensureIdentity(repo);
      await gitOrThrow(repo, ['commit', '-q', '--allow-empty', '-m', 'init']);
    }
    store = await Store.create(':memory:');
    await seedProfiles(store, 'mock');
    const tokens = new TokenAuthority();
    const worlds = new WorldRegistry();
    const client = { workflow: { getHandle: () => ({ query: async () => [] }), start: async () => ({}) } } as any;
    const api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'test', contentDir: dir });
    project = await store.createProject('Mixed', { repos: [app, lib] });
    const gateway = await Gateway.create({ store, tokens, worlds, client, api, bus: new KarmaxBus(),
      contributions: new ContributionRegistry(), overlays: new Overlays(), taskQueue: 'test', staticDir: path.resolve('web'),
      agentInfo: { provider: 'mock', reason: 'repo branches form test' } });
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
  const open = async (route: string): Promise<{ page: Page; errors: string[] }> => {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 1000 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}${route}`);
    return { page, errors };
  };
  const rows = (block: ReturnType<Page['locator']>) => block.locator('.rb-row[data-source]').evaluateAll((list) =>
    list.map((row) => [row.querySelector('.rb-repo')!.textContent, (row.querySelector('.rb-base') as unknown as { value: string }).value,
      (row.querySelector('.rb-target') as unknown as { value: string }).value]));
  const draft = (prompt: string) => store.listTasks(project.id).then((tasks) => tasks.find((task) => task.params?.prompt === prompt)?.params);

  it('opens one Base/Target pair per repository in the task form, each on its own branch', async () => {
    const { page, errors } = await open('/personal/mixed');
    await page.locator('#expand-task').click();
    const block = page.locator('#tf-body .repo-branches-field');
    await block.waitFor();
    // Off: the common pair, from the first repository.
    expect(await block.locator('.rb-toggle').isChecked()).toBe(false);
    expect(await block.locator('.rb-list').isHidden()).toBe(true);
    expect(await block.locator('[data-field="base"]').inputValue()).toBe('main');
    if (shots) await block.screenshot({ path: path.join(shots, 'branches-off.png') });

    await block.locator('.rb-toggle').check();
    expect(await block.locator('.branch-pair-slot').isHidden()).toBe(true);
    expect(await rows(block)).toEqual([['app', 'main', 'main'], ['lib', 'master', 'master']]);
    await page.locator('#tf-body textarea[data-field="prompt"]').fill('Touch both repositories');
    await block.locator('.rb-row[data-source] .rb-target').nth(1).fill('release');
    await block.locator('.rb-row[data-source] .rb-target').nth(1).dispatchEvent('change');
    if (shots) await block.screenshot({ path: path.join(shots, 'branches-per-repo.png') });
    if (shots) await page.locator('#tf-body .tf-main').screenshot({ path: path.join(shots, 'task-form.png') });
    await expect.poll(async () => (await draft('Touch both repositories'))?.repoBranches, { timeout: 15_000 })
      .toEqual({ [app]: { base: 'main', target: 'main' }, [lib]: { base: 'master', target: 'release' } });

    // Off again: nothing per repository is stored.
    await block.locator('.rb-toggle').uncheck();
    expect(await block.locator('.branch-pair-slot').isVisible()).toBe(true);
    await expect.poll(async () => (await draft('Touch both repositories'))?.repoBranches, { timeout: 15_000 }).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it('saves per-repository Task defaults that new tasks start from and can turn off', async () => {
    const settings = await open('/personal/mixed/settings#project-defaults');
    const block = settings.page.locator('#task-defaults-project .repo-branches-field');
    await block.waitFor();
    expect(await block.locator('.rb-toggle').isChecked()).toBe(false);
    await block.locator('.rb-toggle').check();
    expect(await rows(block)).toEqual([['app', 'main', 'main'], ['lib', 'master', 'master']]);
    await block.locator('.rb-row[data-source] .rb-base').nth(1).fill('develop');
    await settings.page.locator('#task-defaults-project [data-save-task-defaults]').click();
    const map = { [app]: { base: 'main', target: 'main' }, [lib]: { base: 'develop', target: 'master' } };
    await expect.poll(async () => (await store.getSettings(project.id, '__common__'))?.repoBranches).toEqual(map);
    if (shots) await settings.page.locator('#task-defaults-project .td-where').screenshot({ path: path.join(shots, 'task-defaults.png') });
    expect(settings.errors).toEqual([]);

    // A new task inherits the list; turning it off stores an explicit "off".
    const form = await open('/personal/mixed');
    await form.page.locator('#expand-task').click();
    const taskBlock = form.page.locator('#tf-body .repo-branches-field');
    await taskBlock.waitFor();
    expect(await taskBlock.locator('.rb-toggle').isChecked()).toBe(true);
    expect(await rows(taskBlock)).toEqual([['app', 'main', 'main'], ['lib', 'develop', 'master']]);
    expect(await taskBlock.locator('.rb-toggle-row .field-reset').isHidden()).toBe(true);
    await form.page.locator('#tf-body textarea[data-field="prompt"]').fill('Only the common branch');
    await taskBlock.locator('.rb-toggle').uncheck();
    expect(await taskBlock.locator('.rb-toggle-row .field-reset').isVisible()).toBe(true);
    await expect.poll(async () => (await draft('Only the common branch'))?.repoBranches, { timeout: 15_000 }).toEqual({});
    // Reset: back to the project's list.
    await taskBlock.locator('.rb-toggle-row .field-reset').click();
    expect(await taskBlock.locator('.rb-toggle').isChecked()).toBe(true);
    await expect.poll(async () => (await draft('Only the common branch'))?.repoBranches, { timeout: 15_000 }).toBeUndefined();
    expect(form.errors).toEqual([]);

    // Turning the project default off again clears it.
    const again = await open('/personal/mixed/settings#project-defaults');
    const againBlock = again.page.locator('#task-defaults-project .repo-branches-field');
    await againBlock.waitFor();
    expect(await againBlock.locator('.rb-toggle').isChecked()).toBe(true);
    await againBlock.locator('.rb-toggle-row .field-reset').click();
    await again.page.locator('#task-defaults-project [data-save-task-defaults]').click();
    await expect.poll(async () => (await store.getSettings(project.id, '__common__'))?.repoBranches).toBeUndefined();
    expect(again.errors).toEqual([]);
  });
});
