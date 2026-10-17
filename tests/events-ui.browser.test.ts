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
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';
import { seedProfiles } from '../src/agent/profiles.js';
import type { Project } from '../src/domain/types.js';

/**
 * The console's side of events (wiki features/events-and-automations):
 * the task form's "On event" trigger and command, Project settings → Events,
 * and the task store (its view, the default view's recommendations).
 */
describe('events in the console', () => {
  let dir: string, store: Store, project: Project, browser: Browser, base: string, close: () => Promise<void>;
  let priorHome: string | undefined;

  beforeAll(async () => {
    priorHome = process.env.KARMAX_HOME;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'events-ui-'));
    process.env.KARMAX_HOME = dir;
    store = await Store.create(':memory:');
    await seedProfiles(store, 'mock');
    const tokens = new TokenAuthority();
    const worlds = new WorldRegistry();
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const client = { workflow: { getHandle: () => ({ query: async () => [] }), start: async () => ({}) } } as any;
    const api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'test', contentDir: dir, broker });
    project = await store.createProject('Factory');
    const gateway = await Gateway.create({ store, tokens, worlds, client, api, broker, bus: new KarmaxBus(),
      contributions: new ContributionRegistry(), overlays: new Overlays(), taskQueue: 'test', staticDir: path.resolve('web'),
      agentInfo: { provider: 'mock', reason: 'events ui test' } });
    const running = await gateway.listen(await findFreePortFrom(49020));
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

  it('saves an event trigger with its conditions and repeat rule, and a command', async () => {
    const { page, errors } = await open('/personal/factory');
    await page.locator('#expand-task').click();
    const body = page.locator('#tf-body');
    await body.locator('#ev-type').waitFor();
    await body.locator('textarea[data-field="prompt"]').fill('Implement the planned issue');
    expect(await body.locator('.ev-more').isHidden()).toBe(true);
    await body.locator('#ev-type').fill('github.issues.labeled');
    await body.locator('#ev-type').dispatchEvent('change');
    expect(await body.locator('#trig-repeatable').isChecked()).toBe(true);
    await body.locator('#ev-add-cond').click();
    await body.locator('.ev-cond .ev-path').fill('label.name');
    await body.locator('.ev-cond .ev-val').fill('planned');
    await body.locator('#ev-add-cond').click();
    await body.locator('.ev-cond').nth(1).locator('.ev-path').fill('issue.number');
    await body.locator('.ev-cond').nth(1).locator('.ev-op').selectOption('in');
    await body.locator('.ev-cond').nth(1).locator('.ev-val').fill('12, 13');
    expect(await body.locator('#ev-key').isHidden()).toBe(true);
    await body.locator('#ev-mode').selectOption('tell');
    await body.locator('#ev-key').fill('{{issue.number}}');
    await body.locator('.tf-command > summary').click();
    await body.locator('textarea[data-field="command"]').fill('python scripts/plan.py');
    await body.locator('select[data-field="onCommandFailure"]').selectOption('agent');
    await body.locator('textarea[data-field="command"]').dispatchEvent('change');
    await page.locator('#tf-draft').click();
    await expect.poll(async () => (await store.listTasks(project.id)).find((task) => task.params?.prompt === 'Implement the planned issue')?.params,
      { timeout: 15_000 }).toMatchObject({
      command: 'python scripts/plan.py', onCommandFailure: 'agent', repeatable: true,
      triggers: [{ kind: 'event', type: 'github.issues.labeled', recurring: true,
        where: { 'label.name': 'planned', 'issue.number': { in: [12, 13] } },
        concurrency: { key: '{{issue.number}}', mode: 'tell' } }],
    });
    expect(errors).toEqual([]);
  });

  it('creates a webhook, shows its secret once, and lists what it received', async () => {
    const { page, errors } = await open('/personal/factory/settings#project-events');
    const box = page.locator('#project-events-box');
    await box.locator('[data-pe-new="webhook"]').click();
    await box.locator('#pe-name').fill('Sentry');
    await box.locator('#pe-type').fill('sentry.alert');
    await box.locator('#pe-create').click();
    const reveal = box.locator('.pe-reveal');
    await reveal.waitFor();
    const [url, secret] = await reveal.locator('code').allTextContents();
    expect(url).toMatch(/\/api\/hooks\/hook_/);
    expect(secret).toMatch(/^tvh_/);
    const delivered = await fetch(url!, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Boom', level: 'error' }) });
    expect(delivered.status).toBe(202);
    await reveal.locator('[data-pe-done]').click();
    await expect.poll(async () => box.locator('[data-hook]').textContent()).toMatch(/Sentry[\s\S]*sentry\.alert[\s\S]*1 received/);
    expect(await box.textContent()).not.toContain(secret);
    const event = box.locator('.pe-event').first();
    expect(await event.locator('summary').textContent()).toMatch(/sentry\.alert[\s\S]*Sentry[\s\S]*No task waits for this/);
    await event.locator('summary').click();
    expect(await event.locator('.pe-payload').textContent()).toContain('"level": "error"');
    page.once('dialog', (dialog) => dialog.accept());
    await box.locator('[data-hook-delete]').click();
    await expect.poll(async () => box.locator('[data-hook]').count()).toBe(0);
    expect(errors).toEqual([]);
  });

  it('recommends the task store on the default view until dismissed', async () => {
    const { page, errors } = await open('/personal/factory');
    const recs = page.locator('.store-recs');
    await recs.waitFor();
    expect(await recs.locator('.task-group-heading').textContent()).toMatch(/Recommended from the Task store/);
    expect(await recs.locator('[data-store-task]').evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.storeTask)))
      .toEqual(['project-wiki', 'repair-github-workflow', 'build-planned-issues', 'triage-issues', 'chat-requests']);
    if (process.env.KARMAX_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.KARMAX_SCREENSHOT_DIR, 'store-recommended.png') });
    await recs.locator('#store-recs-dismiss').click();
    expect(await recs.count()).toBe(0);
    await page.reload();
    await page.locator('#task-search').waitFor();
    await page.waitForTimeout(300);
    expect(await page.locator('.store-recs').count()).toBe(0);
    expect(errors).toEqual([]);
  });

  it('runs and installs from the Task store view; a deleted series is on offer again', async () => {
    const { page, errors } = await open('/personal/factory');
    await page.locator('.view-chip[data-view="__store__"]').click();
    await expect.poll(() => page.url()).toMatch(/q=is(:|%3A)store/);
    const row = (id: string) => page.locator(`.store-row[data-store-task="${id}"]`);
    await row('build-planned-issues').waitFor();
    expect(await page.locator('.view-chip[data-view="__store__"]').getAttribute('class')).toContain('active');
    expect(await page.locator('.store-row').count()).toBe(5);
    // Without a GitHub repository there is nothing for it to hear yet.
    expect(await row('build-planned-issues').locator('[data-store-run]').isDisabled()).toBe(true);
    expect(await row('build-planned-issues').textContent()).toContain('Needs GitHub');
    expect(await row('chat-requests').textContent()).toContain('Needs a chat bot');
    expect(await row('project-wiki').locator('[data-store-run]').textContent()).toBe('Run');

    const repository = await store.upsertRepository({ organizationId: project.organizationId ?? 'org_personal', provider: 'github', providerId: '99',
      owner: 'acme', name: 'app', sshUrl: 'git@github.com:acme/app.git', defaultBranch: 'main', private: true, gitConnectionId: 'gc_1' });
    await store.attachProjectRepository({ projectId: project.id, repositoryId: repository.id });
    await page.reload();
    await row('build-planned-issues').locator('[data-store-run]:not([disabled])').click();
    await expect.poll(async () => row('build-planned-issues').textContent()).toMatch(/installed[\s\S]*Open/);
    const series = (await store.listTasks(project.id)).find((task) => task.params?.template === 'build-planned-issues')!;
    expect(series.params).toMatchObject({ repeatable: true, triggerState: 'armed', triggers: [{ type: 'github.issues.labeled' }] });
    if (process.env.KARMAX_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.KARMAX_SCREENSHOT_DIR, 'task-store.png') });

    // An ordinary one runs at once and opens.
    await row('project-wiki').locator('[data-store-run]').click();
    await expect.poll(async () => (await store.listTasks(project.id)).filter((task) => task.params?.template === 'project-wiki').length).toBe(1);
    await expect.poll(() => page.url()).toMatch(/\/tasks\/\d+$/);

    // The series page saves it to the store, and deletes it.
    await page.goto(`${base}/personal/factory?q=is%3Astore`);
    await row('build-planned-issues').locator('a', { hasText: 'Open' }).click();
    page.once('dialog', (dialog) => dialog.accept('Our planned issues'));
    await page.locator('#sd-save-store').click();
    await expect.poll(async () => (await store.listStoreTasks(project.organizationId ?? 'org_personal')).map((a) => a.name)).toEqual(['Our planned issues']);
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#sd-delete').click();
    await expect.poll(async () => store.getTask(series.id)).toBeFalsy();

    await page.goto(`${base}/personal/factory?q=is%3Astore`);
    await expect.poll(async () => row('build-planned-issues').locator('[data-store-run]').textContent()).toBe('Install');
    const own = page.locator('.store-row[data-store-task^="atm_"]');
    expect(await own.textContent()).toContain('Our planned issues');
    // The rest of the query filters the store by its words.
    await page.locator('#task-search').fill('is:store planned');
    await expect.poll(async () => page.locator('.store-row').count()).toBe(2);
    page.once('dialog', (dialog) => dialog.accept());
    await own.locator('[data-store-remove]').click();
    await expect.poll(async () => page.locator('.store-row').count()).toBe(1);
    expect(await store.listStoreTasks(project.organizationId ?? 'org_personal')).toEqual([]);

    // Settings no longer carries a gallery.
    await page.goto(`${base}/personal/factory/settings#project-events`);
    await page.locator('#project-events-box [data-pe-new="webhook"]').waitFor();
    expect(await page.locator('#project-events-box').textContent()).not.toContain('Automations');
    expect(errors).toEqual([]);
  });

  it('deletes a repeatable task from its row in the list', async () => {
    const created = await store.createTask({ projectId: project.id, title: 'Nightly report', workflow: 'software-dev', workflowVersion: '1.28.0',
      params: { prompt: 'Report.', repeatable: true } });
    const { page, errors } = await open('/personal/factory?q=is%3Aseries%20-is%3Aarchived');
    const row = page.locator(`.series-row[data-series="${created.id}"]`);
    await row.waitFor();
    page.once('dialog', (dialog) => dialog.accept());
    await row.locator('[data-delseries]').click();
    await expect.poll(async () => row.count()).toBe(0);
    expect(await store.getTask(created.id)).toBeFalsy();
    expect(errors).toEqual([]);
  });
});
