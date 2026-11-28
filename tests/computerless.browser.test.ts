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
    // These tests are about the quick task Ask can start; by default it goes to the CEO (tested below).
    await store.setSettings(`organization:${project.organizationId}`, 'ask', { to: 'task' });
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
  const allTasks = async () => (await Promise.all((await store.listProjects()).map((p) => store.listTasks(p.id)))).flat();
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

  it('Ask: a compact button and its shortcut start a task without a computer in the organization’s co-ordinator project and open its page', async () => {
    const { page, errors } = await open('/personal/assistant');
    // Nobody is asked which project: the dialog names none.
    expect(await page.locator('#mobile-ask').isVisible()).toBe(false); // a computer's Ask is in the sidebar
    const ask = page.locator('#rail-ask');
    // The sidebar's bright button is Ask; beside it a plain + starts a task, and no template button.
    await ask.waitFor();
    expect(await ask.textContent()).toBe('Ask tavya');
    expect(await ask.evaluate((element) => element.classList.contains('primary'))).toBe(true);
    const plus = page.locator('#rail-new-task');
    expect(await plus.getAttribute('aria-label')).toBe('New task');
    expect(((await plus.textContent()) ?? '').trim()).toBe('');
    expect(await plus.evaluate((element) => element.classList.contains('primary'))).toBe(false);
    expect(await page.locator('#rail-new-template').count()).toBe(0);
    await ask.waitFor();
    expect(await ask.getAttribute('title')).toContain('(A)');
    // The shortcut opens it as the button does.
    await page.locator('body').press('Shift+A');
    const dialog = page.locator('dialog.ask-dialog');
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await expect.poll(() => dialog.count()).toBe(0);

    const tasksBefore = (await allTasks()).length;
    await ask.click();
    await dialog.waitFor();
    expect(await dialog.locator('button[value="submit"]').getAttribute('title')).toMatch(/^Ask \((Ctrl\+|⌘)↵\)$/);
    const box = dialog.locator('textarea');
    expect(await box.evaluate((element) => element === (globalThis as any).document.activeElement)).toBe(true);
    await box.fill('Turn on Codex for this');
    // Enter is a new line, never a send (three half-finished questions went that way); ⌘/Ctrl+Enter asks.
    await box.press('Enter');
    expect(await box.inputValue()).toBe('Turn on Codex for this\n');
    expect(await allTasks()).toHaveLength(tasksBefore);
    await box.fill('Turn on Codex for this project');
    await box.press('ControlOrMeta+Enter');
    let created: Awaited<ReturnType<typeof allTasks>>[number] | undefined;
    await expect.poll(async () => {
      created = (await allTasks()).find((task) => task.params?.prompt === 'Turn on Codex for this project');
      return created?.params?.computer;
    }, { timeout: 15_000 }).toEqual({ provider: 'none' });
    // It lives in the co-ordinator project, made for it, which the sidebar now lists.
    const coordinator = (await store.getProject(created!.projectId))!;
    expect(coordinator).toMatchObject({ name: 'CEO', organizationId: project.organizationId });
    await expect.poll(() => page.locator('#rail-list').textContent(), { timeout: 10_000 }).toContain('CEO');
    // It leads the projects, with its own icon, and is not dragged or renamed from there.
    const first = page.locator('#rail-list .proj').first();
    expect(await first.evaluate((element) => element.classList.contains('ceo-project'))).toBe(true);
    expect(await first.getAttribute('draggable')).toBe('false');
    expect(await first.locator('[data-project-edit]').count()).toBe(0);
    expect(await first.locator('.glyph svg path').first().getAttribute('d')).toBe('M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z');
    if (process.env.KARMAX_SHOTS) await page.locator('#rail').screenshot({ path: path.join(process.env.KARMAX_SHOTS, 'sidebar-ceo.png') });
    expect(created!.params.draft).toBe(false);
    // Its page opens with the message box ready for the next message.
    await expect.poll(() => page.evaluate(() => (globalThis as any).document.activeElement?.classList.contains('followup-input')), { timeout: 10_000 }).toBe(true);
    expect((created!.params._authorization as { heldBack?: string[] }).heldBack).toContain('task:delete');
    await expect.poll(() => page.url(), { timeout: 10_000 }).toContain(`/ceo/tasks/${created!.num ?? created!.id}`);
    expect(await dialog.count()).toBe(0);

    // The next question goes to the same project.
    await ask.click();
    await dialog.waitFor();
    await dialog.locator('textarea').fill('And what about E2B?');
    await dialog.locator('textarea').press('ControlOrMeta+Enter');
    await expect.poll(async () => (await allTasks()).find((task) => task.params?.prompt === 'And what about E2B?')?.projectId,
      { timeout: 15_000 }).toBe(coordinator.id);
    expect((await store.listProjects()).filter((p) => p.coordinator)).toHaveLength(1);
    // It is the organization's for good: its settings offer no rename, move or delete.
    await page.goto(`${base}/personal/ceo/settings`);
    await page.locator('#project-advanced').waitFor({ state: 'attached' });
    await expect.poll(() => page.locator('.setting-row', { hasText: 'CEO project' }).count(), { timeout: 10_000 }).toBe(1);
    expect(await page.locator('#delete-project, #move-project, #rename-project').count()).toBe(0);
    expect(errors).toEqual([]);
  });

  it('by default Ask goes to the organization’s CEO: the first question starts it and its page opens', async () => {
    const scopeKey = `organization:${project.organizationId}`;
    await store.setSettings(scopeKey, 'ask', {});
    try {
      const { page, errors } = await open('/personal/assistant');
      await page.locator('#rail-ask').click();
      const dialog = page.locator('dialog.ask-dialog');
      await dialog.waitFor();
      expect(await dialog.locator('.ask-where .info-dot').getAttribute('title')).toMatch(/CEO/);
      await dialog.locator('textarea').fill('Plan the quarter');
      await dialog.locator('textarea').press('ControlOrMeta+Enter');
      let ceo: Awaited<ReturnType<typeof allTasks>>[number] | undefined;
      await expect.poll(async () => {
        ceo = (await allTasks()).find((task) => task.params?.coordinator && task.params?.prompt === 'Plan the quarter');
        return ceo?.params?.draft;
      }, { timeout: 15_000 }).toBe(false);
      expect(ceo!.title).toBe('CEO (Organization Co-ordinator)');
      expect(ceo!.params.computer).not.toEqual({ provider: 'none' });
      await expect.poll(() => page.url(), { timeout: 10_000 }).toContain(`/ceo/tasks/${ceo!.num ?? ceo!.id}`);
      expect((await allTasks()).filter((task) => task.params?.prompt === 'Plan the quarter')).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally { await store.setSettings(scopeKey, 'ask', { to: 'task' }); }
  });

  it('On a phone, Ask is in the top bar', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}/personal/assistant`);
    const ask = page.locator('.mobile-bar #mobile-ask');
    await ask.waitFor();
    expect(await ask.textContent()).toBe('Ask');
    // Inside the bar, on its right, beside where you are; not again in the sidebar.
    const bar = (await page.locator('.mobile-bar').boundingBox())!, button = (await ask.boundingBox())!;
    expect(button.y).toBeGreaterThanOrEqual(bar.y);
    expect(button.y + button.height).toBeLessThanOrEqual(bar.y + bar.height);
    expect(bar.x + bar.width - (button.x + button.width)).toBeLessThan(24);
    if (process.env.KARMAX_SHOTS) await page.screenshot({ path: path.join(process.env.KARMAX_SHOTS, 'ask-phone-bar.png') });
    await page.locator('#mobile-menu').click();
    await expect.poll(() => page.locator('#rail-new-task').isVisible()).toBe(true);
    // The drawer leads with Ask too.
    expect(await page.locator('#rail-ask').isVisible()).toBe(true);
    await page.locator('#mobile-menu').click();

    await ask.tap();
    const dialog = page.locator('dialog.ask-dialog');
    await dialog.waitFor();
    if (process.env.KARMAX_SHOTS) await page.screenshot({ path: path.join(process.env.KARMAX_SHOTS, 'ask-phone-dialog.png') });
    await dialog.locator('textarea').fill('Asked from my phone');
    await dialog.locator('button[value="submit"]').tap();
    await expect.poll(async () => (await store.getProject((await allTasks())
      .find((task) => task.params?.prompt === 'Asked from my phone')?.projectId ?? ''))?.name, { timeout: 15_000 }).toBe('CEO');
    expect(errors).toEqual([]);
    await context.close();
  });

  it('Ask takes dictation like any message box: a mic in it, and its shortcut works inside the dialog', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 1000 } });
    // The browser's speech recognition, driven by the test (as tests/push-and-voice.browser.test.ts does).
    await context.addInitScript(() => {
      const w = globalThis as any;
      w.__speech = [];
      w.SpeechRecognition = w.webkitSpeechRecognition = class {
        started = false; onresult: any; onend: any; onerror: any; lang = ''; interimResults = false; continuous = true;
        constructor() { w.__speech.push(this); }
        start() { this.started = true; }
        stop() { if (!this.started) return; this.started = false; this.onend?.(); }
      };
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}/personal/assistant`);
    await page.locator('#rail-ask').click();
    const dialog = page.locator('dialog.ask-dialog');
    const mic = dialog.locator('[data-mic]');
    await mic.waitFor();
    await mic.click();
    // Listening, the box says how to stop by voice; so does the mic's tooltip.
    expect(await dialog.locator('textarea').getAttribute('placeholder')).toBe('Listening… say “stop listening” to end');
    expect(await mic.getAttribute('title')).toMatch(/· or say “stop listening”$/);
    if (process.env.KARMAX_SHOTS) await dialog.screenshot({ path: path.join(process.env.KARMAX_SHOTS, 'ask-listening.png') });
    await page.evaluate(() => (globalThis as any).__speech.at(-1).onresult({ results: [Object.assign([{ transcript: 'what waits on me' }], { isFinal: true })] }));
    expect(await dialog.locator('textarea').inputValue()).toBe('what waits on me');
    if (process.env.KARMAX_SHOTS) await dialog.screenshot({ path: path.join(process.env.KARMAX_SHOTS, 'ask-dictation.png') });
    await mic.click(); // a second tap stops it
    expect(await mic.getAttribute('aria-pressed')).toBe('false');
    // The dictation shortcut reaches the dialog's mic though the dialog keeps other shortcuts to itself.
    await dialog.locator('textarea').focus();
    await page.keyboard.press('ControlOrMeta+Shift+S');
    await expect.poll(() => mic.getAttribute('aria-pressed')).toBe('true');
    expect(await page.evaluate(() => (globalThis as any).__speech.length)).toBe(2);
    // Saying the stop ends it here too, and is not typed.
    await page.evaluate(() => (globalThis as any).__speech.at(-1).onresult({ results: [Object.assign([{ transcript: 'today stop listening' }], { isFinal: true })] }));
    expect(await mic.getAttribute('aria-pressed')).toBe('false');
    expect(await dialog.locator('textarea').inputValue()).toBe('what waits on me today');
    expect(errors).toEqual([]);
    await context.close();
  });

  it('Ask keeps what is typed or dictated, through closing it, a reload and a failed send, until an Ask goes through', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 1000 } });
    await context.addInitScript(() => {
      const w = globalThis as any;
      w.__speech = [];
      w.SpeechRecognition = w.webkitSpeechRecognition = class {
        started = false; onresult: any; onend: any; onerror: any; lang = ''; interimResults = false; continuous = true;
        constructor() { w.__speech.push(this); }
        start() { this.started = true; }
        stop() { if (!this.started) return; this.started = false; this.onend?.(); }
      };
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const dialog = page.locator('dialog.ask-dialog');
    const box = dialog.locator('textarea');
    // KARMAX_SHOTS=dir: the steps, one frame each (the review's GIF).
    let frame = 0;
    const shot = async () => { if (process.env.KARMAX_SHOTS) await page.screenshot({ path: path.join(process.env.KARMAX_SHOTS, `ask-draft-${String(++frame).padStart(2, '0')}.png`) }); };
    const reopen = async () => {
      if (await dialog.count()) { await page.keyboard.press('Escape'); await expect.poll(() => dialog.count()).toBe(0); }
      await page.locator('#rail-ask').click();
      await dialog.waitFor();
    };
    await page.goto(`${base}/personal/assistant`);
    await reopen();
    expect(await box.inputValue()).toBe('');
    await box.pressSequentially('Half a thought');
    await box.press('Enter'); // a new line, not a send
    await box.pressSequentially('and a second line');
    await shot();
    // Closed and opened again, it is all there, the caret where it stopped.
    await reopen();
    expect(await box.inputValue()).toBe('Half a thought\nand a second line');
    expect(await box.evaluate((el: any) => [el.selectionStart, el.value.length])).toEqual([32, 32]);
    await shot();

    // Dictation saves as it types: a reload while still listening keeps the words heard.
    await dialog.locator('[data-mic]').click();
    await page.evaluate(() => (globalThis as any).__speech.at(-1).onresult({ results: [Object.assign([{ transcript: 'about billing' }], { isFinal: true })] }));
    expect(await box.inputValue()).toBe('Half a thought\nand a second line about billing');
    await shot();
    await page.reload();
    await reopen();
    expect(await box.inputValue()).toBe('Half a thought\nand a second line about billing');
    await shot();

    // A send that fails keeps the text, open or reopened.
    let refused = 0;
    await page.route('**/api/organizations/*/ask', (route) => { refused++; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Down for a moment' }) }); });
    await box.press('ControlOrMeta+Enter');
    await expect.poll(() => refused).toBe(1);
    await expect.poll(() => dialog.locator('button[value="submit"]').isDisabled()).toBe(false);
    expect(await box.inputValue()).toBe('Half a thought\nand a second line about billing');
    await shot();
    await page.reload();
    await reopen();
    expect(await box.inputValue()).toBe('Half a thought\nand a second line about billing');

    // Once an Ask goes through, the draft is gone.
    await page.unroute('**/api/organizations/*/ask');
    await box.press('ControlOrMeta+Enter');
    await expect.poll(async () => (await allTasks()).some((task) => task.params?.prompt === 'Half a thought\nand a second line about billing'),
      { timeout: 15_000 }).toBe(true);
    await expect.poll(() => dialog.count(), { timeout: 10_000 }).toBe(0);
    await shot();
    // Its page opens: a follow-up typed there is kept through a reload as well (the same drafts).
    const followup = page.locator('.followup-input');
    await expect.poll(() => page.evaluate(() => (globalThis as any).document.activeElement?.classList.contains('followup-input')), { timeout: 10_000 }).toBe(true);
    await followup.pressSequentially('One more thing');
    await page.reload();
    await expect.poll(() => followup.inputValue(), { timeout: 10_000 }).toBe('One more thing');
    await reopen();
    expect(await box.inputValue()).toBe('');
    await shot();
    expect(errors).toEqual([]);
    await context.close();
  });
});
