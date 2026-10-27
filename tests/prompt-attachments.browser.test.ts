import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Request } from 'playwright';
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
import { closeConsoleBrowser, consolePage } from './helpers/console-page.js';

/**
 * Prompt attachments as a person meets them: a paste shows its chip at once
 * and its progress while it uploads, a copied picture is not sent as the
 * browser's bloated clipboard PNG, and a message sent meanwhile waits for it.
 * The real console against a real gateway, so the bytes checked are the ones stored.
 */

// In-page helpers, plain JavaScript (the tests' TypeScript has no DOM types).
const PAGE_HELPERS = `
  // A page of scanned text: grain makes the clipboard's PNG several MB, as a copied photo or scan does.
  globalThis.makePng ??= async (grain, width, height) => {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const g = canvas.getContext('2d');
    g.fillStyle = '#e4ead8'; g.fillRect(0, 0, width, height);
    g.fillStyle = '#222'; g.font = '44px serif';
    for (let y = 70; y < height; y += 64) g.fillText('The quick brown fox jumps over the lazy dog 0123', 50, y);
    if (grain) {
      const image = g.getImageData(0, 0, width, height);
      let seed = 7;
      for (let i = 0; i < image.data.length; i += 4) {
        seed = (seed * 16807) % 2147483647;
        const n = (seed % (2 * grain + 1)) - grain;
        image.data[i] += n; image.data[i + 1] += n; image.data[i + 2] += n;
      }
      g.putImageData(image, 0, 0);
    }
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };
  // What a browser hands the page when a copied image is pasted.
  globalThis.pasteImage ??= (el, base64) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], 'image.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  };
`;
const makePng = async (page: Page, grain: number, width = 1400, height = 2000): Promise<string> => {
  await page.evaluate(PAGE_HELPERS);
  return page.evaluate(([g, w, h]) => (globalThis as any).makePng(g, w, h), [grain, width, height]);
};
const paste = async (target: Locator, base64: string) => {
  await target.page().evaluate(PAGE_HELPERS);
  await target.evaluate((el, b64) => (globalThis as any).pasteImage(el, b64), base64);
};

/** Holds every upload until `release()`, recording what was sent. */
async function holdUploads(context: BrowserContext, reply?: unknown) {
  const sent: Array<{ type: string; bytes: number }> = [];
  let open!: () => void;
  let gate = new Promise<void>((resolve) => { open = resolve; });
  await context.route(/\/api\/(attachments|files)\?/, async (route) => {
    const request: Request = route.request();
    sent.push({ type: String(request.headers()['content-type']), bytes: request.postDataBuffer()?.length ?? 0 });
    await gate;
    // A cancelled upload is already gone.
    await (reply ? route.fulfill({ json: reply }) : route.continue()).catch(() => {});
  });
  return {
    sent,
    release: () => open(),
    hold: () => { gate = new Promise<void>((resolve) => { open = resolve; }); },
  };
}

describe('prompt attachments', () => {
  let dir: string, store: Store, project: Project, browser: Browser, base: string, close: () => Promise<void>;
  let priorHome: string | undefined;

  beforeAll(async () => {
    priorHome = process.env.KARMAX_HOME;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-attachments-'));
    process.env.KARMAX_HOME = dir;
    store = await Store.create(':memory:');
    await seedProfiles(store, 'mock');
    const tokens = new TokenAuthority();
    const worlds = new WorldRegistry();
    const client = { workflow: { getHandle: () => ({ query: async () => [] }), start: async () => ({}) } } as any;
    const api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'test', contentDir: dir });
    project = await store.createProject('Pictures');
    const gateway = await Gateway.create({ store, tokens, worlds, client, api, bus: new KarmaxBus(),
      contributions: new ContributionRegistry(), overlays: new Overlays(), taskQueue: 'test', staticDir: path.resolve('web'),
      agentInfo: { provider: 'mock', reason: 'prompt attachments test' } });
    const running = await gateway.listen(await findFreePortFrom(49120));
    base = running.url;
    close = running.close;
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
    await closeConsoleBrowser();
    await close?.();
    if (priorHome === undefined) delete process.env.KARMAX_HOME; else process.env.KARMAX_HOME = priorHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const openForm = async () => {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 1000 } });
    const uploads = await holdUploads(context);
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}/personal/pictures`);
    await page.locator('#expand-task').click();
    const prompt = page.locator('#tf-body textarea[data-field="prompt"]');
    await prompt.waitFor();
    return { context, page, errors, uploads, prompt, chips: page.locator('#tf-chips') };
  };
  const draftWith = (text: string) => store.listTasks(project.id).then((tasks) => tasks.find((task) => task.params?.prompt === text));
  const stored = (id: string) => fs.readdirSync(path.join(dir, 'attachments')).filter((name) => name.startsWith(id));

  it('shows a pasted picture at once, uploads it compactly, and a save waits for it', async () => {
    const { context, page, errors, uploads, prompt, chips } = await openForm();
    const png = await makePng(page, 6);
    const pngBytes = Buffer.from(png, 'base64').length;
    expect(pngBytes).toBeGreaterThan(2 * 1024 * 1024);

    await paste(prompt, png);
    // Seen at once, before a byte has arrived: a preview with progress.
    const pending = chips.locator('.img-chip[data-upload]');
    await pending.waitFor();
    expect(await pending.locator('img').getAttribute('src')).toMatch(/^blob:/);
    await expect.poll(() => pending.locator('[role="progressbar"]').count()).toBe(1);
    await expect.poll(() => uploads.sent.length).toBe(1);
    // The clipboard's PNG went as WebP, a fraction of its size.
    expect(uploads.sent[0]!.type).toBe('image/webp');
    expect(uploads.sent[0]!.bytes).toBeLessThan(pngBytes / 2);

    // Saving while it uploads waits for it instead of dropping it.
    await prompt.fill('Read this page');
    await page.locator('#tf-draft').click();
    await page.waitForTimeout(300);
    expect((await draftWith('Read this page'))?.params?.images ?? []).toEqual([]);
    uploads.release();
    await expect.poll(async () => (await draftWith('Read this page'))?.params?.images, { timeout: 15_000 })
      .toEqual([expect.objectContaining({ mediaType: 'image/webp', bytes: uploads.sent[0]!.bytes })]);
    const [ref] = (await draftWith('Read this page'))!.params!.images as Array<{ id: string }>;
    expect(stored(ref!.id)).toEqual([`${ref!.id}.webp`]);
    expect(errors).toEqual([]);
    await context.close();
  });

  it('keeps small pastes and chosen files as they are, and fits an over-limit picture', async () => {
    const { context, page, errors, uploads, prompt, chips } = await openForm();
    uploads.release();
    // A screenshot is small already: its lossless PNG stays.
    const screenshot = await makePng(page, 0, 1200, 800);
    await paste(prompt, screenshot);
    await expect.poll(() => chips.locator('.img-chip:not([data-upload])').count()).toBe(1);
    expect(uploads.sent[0]).toEqual({ type: 'image/png', bytes: Buffer.from(screenshot, 'base64').length });

    // A chosen file is the person's own bytes: sent unchanged...
    const large = Buffer.from(await makePng(page, 6), 'base64');
    await page.locator('#tf-files').setInputFiles({ name: 'scan.png', mimeType: 'image/png', buffer: large });
    await expect.poll(() => chips.locator('.img-chip:not([data-upload])').count()).toBe(2);
    expect(uploads.sent[1]).toEqual({ type: 'image/png', bytes: large.length });

    // ...unless it is over the 5 MB image limit, which would refuse it.
    const huge = Buffer.from(await makePng(page, 24, 1800, 2400), 'base64');
    expect(huge.length).toBeGreaterThan(5 * 1024 * 1024);
    await page.locator('#tf-files').setInputFiles({ name: 'huge.png', mimeType: 'image/png', buffer: huge });
    await expect.poll(() => chips.locator('.img-chip:not([data-upload])').count(), { timeout: 15_000 }).toBe(3);
    expect(uploads.sent[2]!.type).toBe('image/webp');
    expect(uploads.sent[2]!.bytes).toBeLessThan(5 * 1024 * 1024);
    expect(errors).toEqual([]);
    await context.close();
  });

  it('cancels an upload from its chip', async () => {
    const { context, page, errors, uploads, prompt, chips } = await openForm();
    await paste(prompt, await makePng(page, 6));
    await expect.poll(() => uploads.sent.length).toBe(1);
    await chips.locator('.img-chip[data-upload] button').click();
    expect(await chips.locator('.img-chip').count()).toBe(0);
    uploads.release();
    await prompt.fill('Nothing attached');
    await page.locator('#tf-draft').click();
    await expect.poll(async () => !!(await draftWith('Nothing attached')), { timeout: 15_000 }).toBe(true);
    expect((await draftWith('Nothing attached'))?.params?.images).toBeUndefined();
    expect(await chips.locator('.img-chip').count()).toBe(0);
    expect(errors).toEqual([]);
    await context.close();
  });

  it('sends a follow-up once its pasted picture has uploaded', async () => {
    const signals: any[] = [];
    const ui = await consolePage({ api: ({ method, path: route, body }) => {
      if (method === 'POST' && route === '/api/tasks/task/signal') { signals.push(body); return {}; }
      return undefined;
    } });
    const uploads = await holdUploads(ui.page.context(), { id: 'a'.repeat(64), mediaType: 'image/webp', bytes: 1 });
    await ui.run(`
      Object.assign(S, { projects: [{ id: 'project', organizationId: 'org' }], projectId: 'project',
        taskEvents: [], sessions: {}, meta: {}, selected: 'task', taskTab: 'checkin' });
      S.view = { taskId: 'task', stage: 'do', status: 'active', actions: [{ name: 'followUp', enabled: true }],
        transcripts: [{ role: 'do', messages: [{ role: 'assistant', text: 'Working.' }] }] };
      refreshTask = async () => {}; refreshTasks = async () => {};
      renderTaskPage = () => {
        patchTaskPage(document.getElementById('main'), checkinTab(S.view));
        wireFollowups(S.view); wireCheckinSidebar(S.view);
      };
      renderTaskPage();
    `);
    const input = ui.page.locator('.followup-input');
    await paste(input, await makePng(ui.page, 6));
    const pending = ui.page.locator('.followup-chips .img-chip[data-upload]');
    await pending.waitFor();
    // A background re-render mid-upload keeps the chip.
    await ui.run('renderTaskPage()');
    await pending.waitFor();
    await input.fill('What does it say?');
    await ui.page.locator('.followup-send').click();
    await ui.page.waitForTimeout(300);
    expect(signals).toEqual([]);
    uploads.release();
    await expect.poll(() => signals.length, { timeout: 15_000 }).toBe(1);
    expect(signals[0]).toMatchObject({ signal: 'followUp', text: 'What does it say?', images: [expect.objectContaining({ mediaType: 'image/webp' })] });
    expect(uploads.sent[0]!.type).toBe('image/webp');
    expect(ui.errors).toEqual([]);
    await ui.close();
  });
});
