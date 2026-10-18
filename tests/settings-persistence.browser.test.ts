import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
import { manifest } from '../src/contrib/manifests.js';
import { projectSettingsFor, globalSettingsFor, resolveParams } from '../src/platform/params.js';
import type { Project } from '../src/domain/types.js';

/**
 * What Task defaults save is what a reload shows and what tasks get: a field
 * saved as "same as inherited" is dropped, so nothing may shadow the shared row
 * and a field's inherited value may never depend on its own saved value.
 */
describe('Task defaults survive a reload', () => {
  let dir: string, store: Store, project: Project, browser: Browser, base: string, close: () => Promise<void>;
  let priorHome: string | undefined;

  beforeAll(async () => {
    priorHome = process.env.KARMAX_HOME;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-persistence-'));
    process.env.KARMAX_HOME = dir;
    // A repository whose own default branch is `develop`.
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    git('init', '-q', '-b', 'develop');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    store = await Store.create(':memory:');
    await seedProfiles(store, 'mock');
    const tokens = new TokenAuthority();
    const worlds = new WorldRegistry();
    const client = { workflow: { getHandle: () => ({ query: async () => [] }), start: async () => ({}) } } as any;
    const providerConnections = { available: async () => false, list: async () => [] } as any;
    const api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'test', contentDir: dir, providerConnections });
    project = await store.createProject('Branches', { repos: [repo] });
    const gateway = await Gateway.create({ store, tokens, worlds, client, api, bus: new KarmaxBus(), providerConnections,
      contributions: new ContributionRegistry(), overlays: new Overlays(), taskQueue: 'test', staticDir: path.resolve('web'),
      agentInfo: { provider: 'mock', reason: 'settings persistence test' } });
    const running = await gateway.listen(await findFreePortFrom(49010));
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
    await page.goto(`${base}${route}`, { waitUntil: 'networkidle' });
    await page.locator('#task-defaults-project [data-field="base"], #task-defaults-global [data-field="base"]').first().waitFor();
    return { page, errors };
  };
  const settingsFor = async () => {
    const get = async (scope: string, workflow: string) => (await store.getSettings(scope, workflow));
    return resolveParams(manifest('software-dev')!, { project: await projectSettingsFor(get, project, 'software-dev'),
      global: await globalSettingsFor(get, 'software-dev', project.organizationId) });
  };
  const save = async (page: Page, scope = 'project') => {
    const button = page.locator(`#task-defaults-${scope} [data-save-task-defaults]`);
    await button.click();
    await expect.poll(() => button.textContent()).toContain('Saved');
  };

  it('turns "Allow several branches per task" back on, by the switch and by Reset to default', async () => {
    // Production's state: an old workflow row still says off, beside the shared row.
    await store.db.prepare('INSERT INTO settings (scopeKey, workflow, json) VALUES (?, ?, ?)')
      .run(project.id, 'software-dev', JSON.stringify({ multiPr: false }));
    await store.setSettings(project.id, '__common__', { otherAttempts: 'cancel', multiPr: false });
    const route = '/personal/branches/settings#project-defaults';
    const toggle = (page: Page) => page.locator('#task-defaults-project [data-field="multiPr"]');

    let { page, errors } = await open(route);
    expect(await toggle(page).isChecked()).toBe(false);
    await toggle(page).check();
    await save(page);
    ({ page } = await open(route));
    expect(await toggle(page).isChecked()).toBe(true);
    expect((await settingsFor()).multiPr).toBe(true);

    await toggle(page).uncheck();
    await save(page);
    ({ page } = await open(route));
    expect(await toggle(page).isChecked()).toBe(false);
    expect((await settingsFor()).multiPr).toBe(false);

    await page.locator('#task-defaults-project .field-reset[data-reset="multiPr"]').click();
    await save(page);
    ({ page } = await open(route));
    expect(await toggle(page).isChecked()).toBe(true);
    expect((await settingsFor()).multiPr).toBe(true);
    expect(await store.getSettings(project.id, '__common__')).toEqual({ otherAttempts: 'cancel' });
    expect(errors).toEqual([]);
  });

  it('keeps a project base branch that differs from the repository\'s when saving again', async () => {
    const route = '/personal/branches/settings#project-defaults';
    const baseField = (page: Page) => page.locator('#task-defaults-project [data-field="base"]');
    let { page, errors } = await open(route);
    expect(await baseField(page).inputValue()).toBe('develop');
    await baseField(page).fill('main');
    await save(page);
    ({ page } = await open(route));
    expect(await baseField(page).inputValue()).toBe('main');
    // Saving the card again for something else keeps it.
    await page.locator('#task-defaults-project [data-field="landingAuthority"]').selectOption('external');
    await save(page);
    ({ page } = await open(route));
    expect(await baseField(page).inputValue()).toBe('main');
    expect((await settingsFor()).base).toBe('main');
    expect(errors).toEqual([]);
  });

  it('stores an organization base branch even when it is "main"', async () => {
    const route = '/personal/settings#settings-defaults';
    const baseField = (page: Page) => page.locator('#task-defaults-global [data-field="base"]');
    let { page, errors } = await open(route);
    // Unset, a task uses its repository's branch: nothing to show but that.
    expect(await baseField(page).inputValue()).toBe('');
    expect(await baseField(page).getAttribute('placeholder')).toBe('Repository default');
    await baseField(page).fill('main');
    await save(page, 'global');
    ({ page } = await open(route));
    expect(await baseField(page).inputValue()).toBe('main');
    expect(await store.getSettings(`organization:${project.organizationId}`, '__common__')).toMatchObject({ base: 'main' });
    expect(errors).toEqual([]);
  });
});
