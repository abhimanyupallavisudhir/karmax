import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { findFreePortFrom } from '../src/util/ports.js';
import { Gateway } from '../src/gateway/server.js';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { KarmaxApi } from '../src/platform/api.js';
import { seedProfiles } from '../src/agent/profiles.js';
import { preserveReviewArtifacts } from '../src/store/review-artifacts.js';
import type { TaskView } from '../src/domain/types.js';

/** Run in the page: a 1600×1000 PNG, base64. */
const DRAW_PNG = `(() => {
  const canvas = Object.assign(document.createElement('canvas'), { width: 1600, height: 1000 });
  const context = canvas.getContext('2d');
  context.fillStyle = '#2a6'; context.fillRect(0, 0, 1600, 1000);
  context.fillStyle = '#fff'; context.font = '120px sans-serif'; context.fillText('screenshot', 400, 540);
  return canvas.toDataURL('image/png').split(',')[1];
})()`;

// The Node tsconfig has no DOM lib: code that needs the DOM runs as a string.
/** Run in the page: count changes under #main into `globalThis.renders`. */
const COUNT_RENDERS = `(() => {
  globalThis.renders = 0;
  new MutationObserver(() => globalThis.renders++).observe(document.querySelector('#main'), { childList: true, subtree: true });
})()`;

/** Run in the page: every frame's open viewer size, into `globalThis.viewerSizes`. */
const RECORD_VIEWER_SIZES = `(() => {
  const sizes = globalThis.viewerSizes = [];
  const frame = () => {
    const dialog = document.querySelector('dialog.artifact-reader');
    if (dialog?.open) { const r = dialog.getBoundingClientRect(); sizes.push(Math.round(r.width) + 'x' + Math.round(r.height)); }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
})()`;

/**
 * 2026-10-20: a Review image opened once per re-render of the task page — the
 * conversation keeps its unchanged rows, and every render wired the kept
 * buttons again — so one click stacked a dozen viewers (each darkening the
 * backdrop), every Close peeled off just one, and opening flickered. One click
 * now opens one viewer, and Escape, Close or the backdrop closes it.
 */
it('a Review image opens one viewer however often the page re-rendered, and Escape closes it', async () => {
  const priorHome = process.env.KARMAX_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-image-'));
  process.env.KARMAX_HOME = dir;
  const store = await Store.create(':memory:');
  const objects = new LocalObjectStore(path.join(dir, 'objects'));
  const bus = new KarmaxBus();
  const tokens = new TokenAuthority(store);
  const authorization = await AuthorizationService.create(store);
  const worlds = new WorldRegistry();
  const project = await store.createProject('Images');
  await seedProfiles(store, 'mock');
  const task = await store.createTask({ projectId: project.id, title: 'Redesign the header', workflow: 'just-do',
    workflowVersion: '1.0.0', params: { prompt: 'make it nicer' } });
  const world = await worlds.create('memory', { taskId: task.id, base: 'main' });
  const client = { workflow: { getHandle: () => ({ query: async () => (await store.getTask(task.id))?.lastView }),
    start: async () => ({}) } } as any;
  const api = new KarmaxApi({ store, tokens, worlds, client, authorization, taskQueue: 'test', contentDir: dir });
  const gateway = await Gateway.create({ store, tokens, worlds, client, api, authorization, objects, bus,
    contributions: new ContributionRegistry(), overlays: new Overlays(), taskQueue: 'test', staticDir: path.resolve('web'),
    agentInfo: { provider: 'mock', reason: 'review image test' } });
  const running = await gateway.listen(await findFreePortFrom(48_980));
  const browser = await chromium.launch({ headless: true });
  try {
    const drawer = await browser.newPage();
    await drawer.setContent('<!doctype html><title>drawer</title>');
    const png = Buffer.from(await drawer.evaluate<string>(DRAW_PNG), 'base64');
    await drawer.close();
    await world.writeFileBuffer!('out/header.png', png);
    const info = { caption: 'Check the header', actions: [{ kind: 'open' as const, label: 'Screenshot', target: 'out/header.png' }] };
    const view: TaskView = { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'done', status: 'done',
      state: {}, messages: [], actions: [], updatedAt: Date.now(), world: world.handle, reviewInfo: info };
    await store.saveView(task.id, view);
    await preserveReviewArtifacts(store, objects, world, task.id, info);

    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let resolves = 0;
    page.on('request', (request) => { if (request.url().endsWith('/review-action')) resolves++; });
    await page.goto(`${running.url}/personal/images/tasks/${task.num}`);
    const button = page.getByRole('button', { name: 'Screenshot' });
    await button.waitFor();
    // Live events repaint the task page; the conversation keeps the unchanged
    // review row, buttons and all.
    await button.evaluate((el) => { (el as any).marker = true; });
    await page.evaluate(COUNT_RENDERS);
    for (let i = 0; i < 6; i++) {
      await store.appendEvent({ type: 'pr.pushed', taskId: task.id, ts: Date.now(), payload: {} });
      await page.waitForTimeout(400);
    }
    expect(await button.evaluate((el) => (el as any).marker)).toBe(true);
    expect(await page.evaluate(() => (globalThis as any).renders)).toBeGreaterThan(0);

    const viewers = page.locator('dialog.artifact-reader');
    const image = page.locator('dialog.artifact-reader img');
    // Every frame's viewer size, from the moment it shows.
    await page.evaluate(RECORD_VIEWER_SIZES);
    const open = async () => {
      await page.evaluate(() => { (globalThis as any).viewerSizes.length = 0; });
      await button.click();
      await image.waitFor();
      await expect.poll(() => image.evaluate((img: any) => img.complete && img.naturalWidth)).toBe(1600);
    };

    await open();
    expect(await viewers.count()).toBe(1);
    expect(resolves).toBe(1); // the thumbnail's signed URL serves the viewer too
    // It shows at its final size: no frame of a small box growing to fit.
    await page.waitForTimeout(300);
    expect(new Set(await page.evaluate(() => (globalThis as any).viewerSizes))).toHaveLength(1);
    // The image fits the window whole, without scrolling.
    const box = (await image.boundingBox())!;
    expect(box.height).toBeLessThanOrEqual(800);
    expect(box.width).toBeLessThanOrEqual(1280);
    await page.screenshot({ path: path.join(os.tmpdir(), 'review-image-viewer.png') });

    await page.keyboard.press('Escape');
    await expect.poll(() => viewers.count()).toBe(0);
    expect(page.url()).toContain(`/tasks/${task.num}`); // Escape closed the viewer, not the task

    // Escape closes it wherever focus is, even after a click on the title.
    await open();
    await page.locator('dialog.artifact-reader h2').click();
    await page.keyboard.press('Escape');
    await expect.poll(() => viewers.count()).toBe(0);
    expect(page.url()).toContain(`/tasks/${task.num}`);

    await open();
    expect(await viewers.count()).toBe(1);
    await page.locator('dialog.artifact-reader [data-close]').click();
    await expect.poll(() => viewers.count()).toBe(0);

    await open();
    await page.mouse.click(8, 8); // the backdrop
    await expect.poll(() => viewers.count()).toBe(0);
    expect(resolves).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await running.close();
    await store.close();
    if (priorHome === undefined) delete process.env.KARMAX_HOME;
    else process.env.KARMAX_HOME = priorHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
