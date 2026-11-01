import crypto from 'node:crypto';
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
  let api: KarmaxApi, tokens: TokenAuthority;
  let priorHome: string | undefined;

  beforeAll(async () => {
    priorHome = process.env.KARMAX_HOME;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'events-ui-'));
    process.env.KARMAX_HOME = dir;
    store = await Store.create(':memory:');
    await seedProfiles(store, 'mock');
    tokens = new TokenAuthority();
    const worlds = new WorldRegistry();
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const client = { workflow: { getHandle: () => ({ query: async () => [] }), start: async () => ({}) } } as any;
    api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'test', contentDir: dir, broker });
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
    // Recent events fold behind their count; a type shows as written (what triggers and follows match).
    await box.locator('.pe-recent > summary').click();
    const event = box.locator('.pe-event').first();
    expect(await event.locator('summary').textContent()).toMatch(/sentry\.alert[\s\S]*Sentry[\s\S]*No task waits for this/);
    expect(await event.locator('.setting-label code').textContent()).toBe('sentry.alert');
    await event.locator('summary').click();
    expect(await event.locator('.pe-payload').textContent()).toContain('"level": "error"');
    page.once('dialog', (dialog) => dialog.accept());
    await box.locator('[data-hook-delete]').click();
    await expect.poll(async () => box.locator('[data-hook]').count()).toBe(0);
    expect(errors).toEqual([]);
  });

  it('shows a Slack bot where its URL goes, and lets the project choose who can ask it', async () => {
    const token = (await tokens.mintPrincipal('user:test', ['*'], project.id)).token;
    const fetcher = (async () => new Response(JSON.stringify({ ok: true, user_id: 'UBOT', user: 'tavya' }))) as unknown as typeof fetch;
    const { hook } = await api.createIncomingWebhook(token, project.id, { name: 'Slack bot', kind: 'slack', credentials: { signingSecret: 'shh', botToken: 'xoxb-1' } },
      { hookUrl: (id) => `${base}/api/hooks/${id}`, fetcher });
    // Someone not allowed asks: nothing starts, and the project sees them asking.
    const raw = JSON.stringify({ type: 'event_callback', event_id: 'Ev9', event: { type: 'app_mention', user: 'U9', text: '<@UBOT> drop the tables', channel: 'C1', ts: '2.0' } });
    const at = String(Math.floor(Date.now() / 1000));
    const delivered = await fetch(`${base}/api/hooks/${hook.id}`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json',
      'x-slack-request-timestamp': at, 'x-slack-signature': `v0=${crypto.createHmac('sha256', 'shh').update(`v0:${at}:${raw}`).digest('hex')}` } });
    expect(delivered.status).toBe(202);
    expect(((await delivered.json()) as { event?: string }).event).toBeUndefined();

    const { page, errors } = await open('/personal/factory/settings#project-events');
    const box = page.locator('#project-events-box');
    const bot = box.locator(`[data-hook="${hook.id}"]`);
    await bot.waitFor();
    expect(await bot.locator('[data-hook-copy]').getAttribute('data-hook-copy')).toBe(`${base}/api/hooks/${hook.id}`);
    expect(await bot.locator('[data-hook-copy]').getAttribute('title')).toContain('Request URL');
    const people = box.locator(`[data-people="${hook.id}"]`);
    expect(await people.textContent()).toContain('Nobody yet');
    const asking = box.locator('[data-person="U9"]');
    expect(await asking.textContent()).toContain('drop the tables');

    await asking.locator('[data-people-allow]').click();
    await expect.poll(async () => box.locator('[data-person="U9"]').count()).toBe(0);
    await expect.poll(async () => people.locator('.pe-person').allTextContents()).toEqual(['U9✕']);
    expect((await api.listIncomingWebhooks(token, project.id))[0]!.allowed).toEqual([{ id: 'U9' }]);
    await people.locator('[data-people-remove="U9"]').click();
    await expect.poll(async () => people.textContent()).toContain('Nobody yet');
    await people.locator('[data-people-anyone]').check();
    await expect.poll(async () => people.textContent()).toContain('Anyone who can message the bot');
    expect((await api.listIncomingWebhooks(token, project.id))[0]).toMatchObject({ allowed: [], anyone: true });

    // Connecting another Slack bot ends on the URL to paste into Slack (the platform itself is not called here).
    await page.route('**/api/projects/*/webhooks', (route) => route.request().method() === 'POST'
      ? route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ hook: { id: 'hook_new', kind: 'slack' }, url: `${base}/api/hooks/hook_new` }) })
      : route.fallback());
    await box.locator('[data-pe-new="chat"]').click();
    await box.locator('[data-pe-platform="slack"]').click();
    await box.locator('[data-pe-cred="signingSecret"]').fill('s');
    await box.locator('[data-pe-cred="botToken"]').fill('xoxb-2');
    await box.locator('#pe-starts').uncheck();
    await box.locator('#pe-connect').click();
    const reveal = box.locator('.pe-reveal');
    await reveal.waitFor();
    expect(await reveal.textContent()).toMatch(/Paste into your Slack app[\s\S]*Request URL/);
    expect(await reveal.locator('code').allTextContents()).toEqual([`${base}/api/hooks/hook_new`]);
    await api.deleteIncomingWebhook(token, hook.id);
    expect(errors).toEqual([]);
  });

  it('recommends the task store on the default view until dismissed', async () => {
    const { page, errors } = await open('/personal/factory');
    const recs = page.locator('.store-recs');
    await recs.waitFor();
    expect(await recs.locator('.task-group-heading').textContent()).toMatch(/Recommended from the Task store/);
    // Below the usual task list (or its empty state), never above it.
    expect(await page.locator('* + .store-recs').count()).toBe(1);
    expect(await page.locator('.store-recs + *').count()).toBe(0);
    // Only what can run now; the rest wait in the store, and the GitHub they lack is said once.
    expect(await recs.locator('[data-store-task]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-store-task'))))
      .toEqual(['project-wiki']);
    expect(await recs.locator('.store-recs-more').innerText()).toMatch(/^4 more in the Task store\s*·\s*Connect GitHub$/);
    expect(await recs.locator('.store-recs-more a', { hasText: 'Connect GitHub' }).getAttribute('href')).toBe('/personal/factory/settings#project');
    expect(await recs.textContent()).not.toContain('Needs GitHub');
    if (process.env.KARMAX_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.KARMAX_SCREENSHOT_DIR, 'store-recommended.png') });
    await recs.locator('#store-recs-dismiss').click();
    expect(await recs.count()).toBe(0);
    // A preference of the person, not of this browser: another device agrees.
    await expect.poll(async () => (await store.userPreferences('me')).dismissed).toEqual([`task-store:${project.id}`]);
    const elsewhere = await open('/personal/factory');
    await elsewhere.page.locator('#task-search').waitFor();
    await elsewhere.page.waitForTimeout(500);
    expect(await elsewhere.page.locator('.store-recs').count()).toBe(0);
    // Bringing it back is the same preference.
    await store.updateUserPreferences('me', { undismiss: [`task-store:${project.id}`] });
    await elsewhere.page.reload();
    await elsewhere.page.locator('.store-recs').waitFor();
    expect(errors).toEqual([]);
    expect(elsewhere.errors).toEqual([]);
  });

  it('opens a store task as the task form, every field editable, without taking it', async () => {
    const before = (await store.listTasks(project.id)).length;
    const { page, errors } = await open('/personal/factory?q=is%3Astore');
    const row = page.locator('.store-row[data-store-task="build-planned-issues"]');
    await row.waitFor();
    await row.click({ position: { x: 40, y: 12 } });
    await expect.poll(() => page.url()).toMatch(/\/personal\/factory\/store\/build-planned-issues$/);
    const form = page.locator('#tf-page:not([aria-busy])');
    await form.waitFor();
    expect(await form.locator('.tf-head h2').textContent()).toBe('Build planned issues');
    expect(await form.locator('[data-field="prompt"]').inputValue()).toContain('Build what the GitHub issue below asks for');
    expect(await form.locator('#ev-type').inputValue()).toBe('github.issues.labeled');
    expect(await form.locator('#ev-conds .ev-path').inputValue()).toBe('label.name');
    expect(await form.locator('#ev-conds .ev-val').inputValue()).toBe('planned');
    expect(await form.locator('#trig-repeatable').isChecked()).toBe(true);
    expect(await form.locator('#tf-queue').textContent()).toMatch(/^Install/);
    expect(await form.locator('.tf-foot .store-need').textContent()).toBe('Needs GitHub');
    // Not a template picked from `n`: the store entry is what it starts from.
    expect(await form.locator('#tf-template').count()).toBe(0);
    if (process.env.KARMAX_SCREENSHOT_DIR) {
      await page.waitForTimeout(600); // the page's entrance animation
      await page.screenshot({ path: path.join(process.env.KARMAX_SCREENSHOT_DIR, 'store-task-form.png') });
    }
    // Unticked, it runs once instead of installing.
    await form.locator('#trig-repeatable').uncheck();
    expect(await form.locator('#tf-queue').textContent()).toMatch(/^Run task/);
    await form.locator('#trig-repeatable').check();
    // Esc goes back to the store it was opened from; nothing was taken.
    await page.keyboard.press('Escape');
    await expect.poll(() => page.url()).toMatch(/\/personal\/factory\?q=is(:|%3A)store$/);
    await row.waitFor();
    expect(await page.locator('#tf-page').count()).toBe(0);
    expect((await store.listTasks(project.id)).length).toBe(before);

    // The keyboard opens it too, and a permalink paints the form by itself.
    await page.locator('.store-row[data-store-task="project-wiki"]').focus();
    await page.keyboard.press('o');
    await expect.poll(() => page.url()).toMatch(/\/store\/project-wiki$/);
    const fresh = await open('/personal/factory/store/project-wiki');
    await fresh.page.locator('#tf-page:not([aria-busy]) [data-field="prompt"]').waitFor();
    expect(await fresh.page.locator('[data-field="prompt"]').inputValue()).toContain('Maintain this project');
    expect(await fresh.page.locator('#trig-repeatable').isChecked()).toBe(true);
    // An entry the store does not have lands on the store.
    const missing = await open('/personal/factory/store/no-such-task');
    await expect.poll(() => missing.page.url()).toMatch(/\/personal\/factory\?q=is(:|%3A)store$/);
    await missing.page.locator('.store-row').first().waitFor();
    expect((await store.listTasks(project.id)).length).toBe(before);
    expect([...errors, ...fresh.errors, ...missing.errors]).toEqual([]);
  });

  it('runs and installs a store task as changed in its form', async () => {
    const { page, errors } = await open('/personal/factory/store/project-wiki');
    const form = page.locator('#tf-page:not([aria-busy])');
    await form.locator('[data-field="prompt"]').fill('Write the wiki, but only for the API.');
    await form.locator('#tf-queue').click();
    // It installs, and its first run starts now: that run is where it goes.
    await expect.poll(() => page.url()).toMatch(/\/personal\/factory\/tasks\/\d+$/);
    const wiki = (await store.listTasks(project.id)).find((task) => task.params?.template === 'project-wiki' && !task.params?.runOf)!;
    expect(wiki.params).toMatchObject({ repeatable: true, triggerState: 'armed', triggers: [{ kind: 'schedule', cron: '0 6 * * 1' }] });
    const run = (await store.listTasks(project.id)).find((task) => task.params?.runOf === wiki.id)!;
    expect(run.title).toBe('Maintain the project wiki');
    expect(run.params.prompt).toBe('Write the wiki, but only for the API.');
    expect(page.url()).toMatch(new RegExp(`/tasks/${run.num}$`));

    // A changed automation keeps its run title and its place in the store.
    await page.goto(`${base}/personal/factory/store/build-planned-issues`);
    await form.locator('#ev-conds .ev-val').fill('ready');
    await form.locator('[data-field="prompt"]').fill('Build the issue below; keep the change small.');
    await form.locator('#tf-queue').click();
    await expect.poll(() => page.url()).toMatch(/\/personal\/factory\?q=is(:|%3A)store$/);
    const series = (await store.listTasks(project.id)).find((task) => task.params?.template === 'build-planned-issues')!;
    expect(series.title).toBe('#{{issue.number}} {{issue.title}}');
    expect(series.params).toMatchObject({ repeatable: true, triggerState: 'armed', prompt: 'Build the issue below; keep the change small.',
      triggers: [{ type: 'github.issues.labeled', where: { 'label.name': 'ready' } }] });
    const row = page.locator('.store-row[data-store-task="build-planned-issues"]');
    // Said before its button, so nobody installs it again not knowing.
    await expect.poll(async () => row.locator('.task-right').innerText()).toMatch(/^✓ Installed\s*Open$/);
    // Installed, its row still opens the form, to install another (say, for another label).
    await row.click({ position: { x: 40, y: 12 } });
    await form.locator('#ev-conds .ev-val').waitFor();
    expect(await form.locator('.tf-foot .store-need').textContent()).toBe('Installed already');
    await form.locator('#ev-conds .ev-val').fill('urgent');
    await form.locator('#tf-queue').click();
    await expect.poll(() => page.url()).toMatch(/\/personal\/factory\?q=is(:|%3A)store$/);
    const both = (await store.listTasks(project.id)).filter((task) => task.params?.template === 'build-planned-issues');
    expect(both.map((task) => (task.params.triggers as any)[0].where['label.name']).sort()).toEqual(['ready', 'urgent']);
    await expect.poll(async () => row.locator('.store-installed').textContent()).toBe('✓ 2 installed');
    // Open lists them both.
    await row.locator('a', { hasText: 'Open' }).click();
    await expect.poll(() => page.url()).toMatch(/q=store(:|%3A)build-planned-issues(\+|%20)is(:|%3A)series$/);
    await expect.poll(async () => page.locator('#main .series-row').count()).toBe(2);
    for (const task of [...both, run, wiki]) await store.deleteTask(task.id);
    expect(errors).toEqual([]);
  });

  it('asks which project a store task is for on the organization home', async () => {
    // With one project there is nobody to ask: the home shows that project's store.
    const single = await open('/personal?q=is%3Astore');
    await single.page.locator('.store-row[data-store-task="triage-issues"]').waitFor();
    expect(await single.page.locator('.store-row[data-store-task="project-wiki"] [data-store-run]').textContent()).toBe('Install');
    expect(await single.page.locator('.store-row[data-store-task="triage-issues"]').textContent()).toContain('Needs GitHub');
    expect(single.errors).toEqual([]);
    const other = await store.createProject('Website');
    try {
      const { page, errors } = await open('/personal?q=is%3Astore');
      const row = page.locator('.store-row[data-store-task="triage-issues"]');
      await row.waitFor();
      // Nothing about a project nobody chose: no installed/needs state, no one-click run.
      expect(await page.locator('.store-row [data-store-run]').count()).toBe(0);
      expect(await row.locator('[data-store-choose]').first().textContent()).toBe('Install…');
      expect(await row.textContent()).not.toContain('Needs GitHub');
      await row.click({ position: { x: 40, y: 12 } });
      const picker = page.locator('.store-project-picker');
      await picker.waitFor();
      expect(await picker.locator('.opt').count()).toBe(2);
      await picker.locator('#sp-in').fill('webs');
      await page.keyboard.press('Enter');
      await expect.poll(() => page.url()).toMatch(/\/personal\/website\/store\/triage-issues$/);
      const form = page.locator('#tf-page:not([aria-busy])');
      await form.waitFor();
      expect(await form.locator('#tf-project').textContent()).toContain('Website');
      // Another project from the form: the same store task there, with what you wrote.
      await form.locator('[data-field="prompt"]').fill('Triage only bug reports.');
      await form.locator('#tf-project').click();
      await form.locator('.project-pick-opt', { hasText: 'factory' }).click();
      await expect.poll(() => page.url()).toMatch(/\/personal\/factory\/store\/triage-issues$/);
      await expect.poll(async () => page.locator('#tf-page:not([aria-busy]) [data-field="prompt"]').inputValue()).toBe('Triage only bug reports.');
      expect(await page.locator('#tf-page .tf-head h2').textContent()).toBe('Triage issues daily');
      expect(await page.locator('#trig-repeatable').isChecked()).toBe(true);
      // Back returns to the home it was chosen on; nothing was taken anywhere.
      await page.keyboard.press('Escape');
      await expect.poll(() => page.url()).toMatch(/\/personal\?q=is(:|%3A)store$/);
      expect((await store.listTasks(other.id)).length).toBe(0);
      expect((await store.listTasks(project.id)).filter((task) => task.params?.template === 'triage-issues')).toEqual([]);
      if (process.env.KARMAX_SCREENSHOT_DIR) {
        await row.locator('[data-store-choose]').first().click();
        await picker.waitFor();
        await page.screenshot({ path: path.join(process.env.KARMAX_SCREENSHOT_DIR, 'store-choose-project.png') });
      }
      expect(errors).toEqual([]);
    } finally { await store.deleteProject(other.id); }
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
    expect(await row('project-wiki').locator('[data-store-run]').textContent()).toBe('Install');

    const repository = await store.upsertRepository({ organizationId: project.organizationId ?? 'org_personal', provider: 'github', providerId: '99',
      owner: 'acme', name: 'app', sshUrl: 'git@github.com:acme/app.git', defaultBranch: 'main', private: true, gitConnectionId: 'gc_1' });
    await store.attachProjectRepository({ projectId: project.id, repositoryId: repository.id });
    await page.reload();
    await row('build-planned-issues').locator('[data-store-run]:not([disabled])').click();
    await expect.poll(async () => row('build-planned-issues').textContent()).toMatch(/Installed[\s\S]*Open/);
    const series = (await store.listTasks(project.id)).find((task) => task.params?.template === 'build-planned-issues')!;
    expect(series.params).toMatchObject({ repeatable: true, triggerState: 'armed', triggers: [{ type: 'github.issues.labeled' }] });
    if (process.env.KARMAX_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.KARMAX_SCREENSHOT_DIR, 'task-store.png') });

    // One that runs when installed installs, and its first run opens.
    await row('project-wiki').locator('[data-store-run]').click();
    await expect.poll(() => page.url()).toMatch(/\/tasks\/\d+$/);
    const wiki = (await store.listTasks(project.id)).filter((task) => task.params?.template === 'project-wiki');
    expect(wiki.map((task) => task.params.runOf ? 'run' : 'series').sort()).toEqual(['run', 'series']);
    expect(page.url()).toMatch(new RegExp(`/tasks/${wiki.find((task) => task.params.runOf)!.num}$`));

    // The series page deletes it, and the store offers it again.
    await page.goto(`${base}/personal/factory?q=is%3Astore`);
    await row('build-planned-issues').locator('a', { hasText: 'Open' }).click();
    expect(await page.locator('#sd-save-store').count()).toBe(0);
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#sd-delete').click();
    await expect.poll(async () => store.getTask(series.id)).toBeFalsy();

    await page.goto(`${base}/personal/factory?q=is%3Astore`);
    await expect.poll(async () => row('build-planned-issues').locator('[data-store-run]').textContent()).toBe('Install');
    // The rest of the query filters the store by its words.
    await page.locator('#task-search').fill('is:store planned');
    await expect.poll(async () => page.locator('.store-row').count()).toBe(1);
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
