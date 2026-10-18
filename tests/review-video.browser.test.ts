import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { findFreePortFrom } from '../src/util/ports.js';
import { Gateway } from '../src/gateway/server.js';
import { Store } from '../src/store/db.js';
import { LocalObjectStore, type ObjectStore } from '../src/store/objects.js';
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

const MB = 1024 * 1024;

/** An EBML Void element of `total` bytes: skipped by any WebM parser. */
function voidElement(total: number): Buffer {
  const size = total - 9;
  const header = Buffer.alloc(9);
  header[0] = 0xec;
  header[1] = 0x01; // an 8-byte size
  header.writeUIntBE(Math.floor(size / 2 ** 32), 2, 3);
  header.writeUInt32BE(size % 2 ** 32, 5);
  return Buffer.concat([header, Buffer.alloc(size)]);
}

/** Run in the page: four seconds of canvas animation recorded as VP8 WebM, base64. */
const RECORD_WEBM = `(async () => {
  const canvas = Object.assign(document.createElement('canvas'), { width: 320, height: 180 });
  const context = canvas.getContext('2d');
  const media = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm;codecs=vp8' });
  const chunks = [];
  media.ondataavailable = (event) => chunks.push(event.data);
  const stopped = new Promise((resolve) => { media.onstop = resolve; });
  media.start(100);
  const started = performance.now();
  while (performance.now() - started < 4000) {
    const t = (performance.now() - started) / 1000;
    context.fillStyle = 'hsl(' + ((t * 90) % 360) + ' 70% 50%)';
    context.fillRect(0, 0, 320, 180);
    context.fillStyle = '#fff';
    context.fillText(t.toFixed(2), 20, 40);
    await new Promise(requestAnimationFrame);
  }
  media.stop();
  await stopped;
  const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
  let binary = '';
  for (let at = 0; at < bytes.length; at += 32768) binary += String.fromCharCode(...bytes.subarray(at, at + 32768));
  return btoa(binary);
})()`;

/**
 * videos #1 (2026-10-18): "Watch the video" on a 91.5 MB saved artifact did
 * nothing. Now a ~100 MB saved video opens in the page's viewer and starts
 * playing while most of it is still unread, with no popup involved. The
 * object store is throttled to 10 MB/s, so playing early proves the bytes are
 * streamed in ranges rather than fetched whole first.
 */
it('a ~100 MB saved video starts playing in the Review viewer', async () => {
  const priorHome = process.env.KARMAX_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-video-'));
  process.env.KARMAX_HOME = dir;
  const store = await Store.create(':memory:');
  const local = new LocalObjectStore(path.join(dir, 'objects'));
  let delivered = 0;
  let deliveredAll: number | undefined;
  const objects: ObjectStore = {
    put: (key, data) => local.put(key, data),
    get: (key) => local.get(key),
    delete: (key) => local.delete(key),
    async getStream(key, range) {
      const inner = await local.getStream(key, range);
      return { bytes: inner.bytes, body: (async function* () {
        let sinceWait = 0;
        for await (const chunk of inner.body) {
          yield chunk;
          delivered += chunk.length;
          if ((sinceWait += chunk.length) >= MB) { sinceWait = 0; await new Promise((resolve) => setTimeout(resolve, 100)); }
        }
        if (!range || range.end === inner.bytes - 1) deliveredAll ??= Date.now();
      })() };
    },
  };
  const tokens = new TokenAuthority(store);
  const authorization = await AuthorizationService.create(store);
  const worlds = new WorldRegistry();
  const project = await store.createProject('Videos');
  await seedProfiles(store, 'mock');
  const task = await store.createTask({ projectId: project.id, title: 'The great experiment', workflow: 'just-do',
    workflowVersion: '1.0.0', params: { prompt: 'make the explainer' } });
  const world = await worlds.create('memory', { taskId: task.id, base: 'main' });
  const client = { workflow: { getHandle: () => ({ query: async () => (await store.getTask(task.id))?.lastView }),
    start: async () => ({}) } } as any;
  const api = new KarmaxApi({ store, tokens, worlds, client, authorization, taskQueue: 'test', contentDir: dir });
  const gateway = await Gateway.create({ store, tokens, worlds, client, api, authorization, objects, bus: new KarmaxBus(),
    contributions: new ContributionRegistry(), overlays: new Overlays(), taskQueue: 'test', staticDir: path.resolve('web'),
    agentInfo: { provider: 'mock', reason: 'review video test' } });
  const running = await gateway.listen(await findFreePortFrom(48_960));
  const browser = await chromium.launch({ headless: true });
  try {
    // A real, playable WebM recorded by the browser, padded to ~100 MB.
    const recorder = await browser.newPage();
    await recorder.setContent("<!doctype html><title>recorder</title>");
    const recorded = Buffer.from(await recorder.evaluate<string>(RECORD_WEBM), 'base64');
    await recorder.close();
    const video = Buffer.concat([recorded, voidElement(100 * MB - recorded.length)]);
    expect(video.length).toBe(100 * MB);
    await world.writeFileBuffer!('out/the_great_experiment_web.webm', video);
    const info = { caption: 'Watch the explainer', actions: [{ kind: 'open' as const, label: 'Watch the video', target: 'out/the_great_experiment_web.webm' }] };
    const view: TaskView = { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'review', status: 'waiting',
      state: {}, messages: [], actions: [], updatedAt: Date.now(), world: world.handle, reviewInfo: info };
    await store.saveView(task.id, view);
    await preserveReviewArtifacts(store, local, world, task.id, info);
    await world.destroy(); // only the saved copy remains

    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let popups = 0;
    page.on('popup', () => { popups++; });
    await page.addInitScript(() => {
      (globalThis as any).opened = [];
      (globalThis as any).open = (...args: unknown[]) => { (globalThis as any).opened.push(args); return null; };
    });
    const statuses: number[] = [];
    page.on('response', (response) => { if (response.url().includes('/api/artifact-content/')) statuses.push(response.status()); });
    let resolves = 0;
    page.on('request', (request) => { if (request.url().endsWith('/review-action')) resolves++; });
    // The first link answers as an expired one would: the viewer gets a fresh
    // URL and plays anyway.
    const media = '**/api/artifact-content/**';
    await page.route(media, async (route) => { await route.fulfill({ status: 403, body: '' }); await page.unroute(media); });
    await page.goto(`${running.url}/personal/videos/tasks/${task.num}`);
    await page.getByRole('button', { name: /Watch the video/ }).click();

    const player = page.locator('dialog.artifact-reader video');
    await player.waitFor();
    await expect.poll(() => player.evaluate((v) => (v as any).currentTime), { timeout: 20_000 }).toBeGreaterThan(0.5);
    const playingAt = Date.now();
    expect(await player.evaluate((v) => (v as any).paused)).toBe(false);
    // Played while most of the 100 MB was still unread (the store needs ~10 s for all of it).
    expect(deliveredAll === undefined || deliveredAll > playingAt).toBe(true);
    expect(delivered).toBeLessThan(80 * MB);
    expect(statuses).toContain(206);
    expect(resolves).toBe(2);
    // Download stays available, from the same signed URL.
    const src = await player.getAttribute('src');
    expect(src).toMatch(/^\/api\/artifact-content\//);
    const download = page.locator('dialog.artifact-reader [data-download]');
    expect(await download.getAttribute('href')).toBe(src);
    expect(await download.getAttribute('download')).toBe('the_great_experiment_web.webm');
    expect(popups).toBe(0);
    expect(await page.evaluate(() => (globalThis as any).opened.length)).toBe(0);
    await page.screenshot({ path: path.join(os.tmpdir(), 'review-video-viewer.png') });

    // Closing the viewer stops the stream.
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('dialog.artifact-reader').count()).toBe(0);
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
