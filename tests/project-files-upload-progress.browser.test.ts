import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser } from 'playwright';
import { launchChromium, openConsole } from './helpers/browser.js';
import { projectFilesFixture, sh } from './helpers/project-files-fixture.js';

// Uploading in Files never looks stuck, and one bad file never sinks a folder
// (wiki features/project-files § Uploads). Production, 2026-11-16: a folder
// (`bot_data`) was uploaded three times and never landed — its files were all
// staged, then one that changed on disk after it was chosen made Chrome refuse
// to send it ("Failed to fetch"), the whole batch was dropped, and nothing on
// the page moved while a 52 MB file went up. Screens land in design/files/
// when SHOTS=1.

declare const document: any, window: any, Event: any, KarmaxFileView: any;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
let browser: Browser;
beforeAll(async () => { browser = await launchChromium(); });
afterAll(async () => { await browser?.close(); });
const shots = process.env.SHOTS === '1' ? path.join(import.meta.dirname, '..', 'design', 'files') : '';

async function setup() {
  const f = await projectFilesFixture(cleanups);
  const bare = path.join(f.remotes, f.owner, 'site.git');
  const { page, errors, step, context } = await openConsole(browser, { viewport: { width: 1280, height: 860 } });
  cleanups.push(() => context.close());
  const shoot = async (name: string) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `${name}.png`) }); } };
  const tree = (ref = 'main') => sh(bare, 'ls-tree', '-r', '--name-only', ref).trim().split('\n');
  let base = '';
  const open = async (where: string) => {
    if (!base) {
      await page.goto(`${f.server.url}/projects/site-builder/files`);
      await page.locator('.files-row', { hasText: 'site-wiki' }).waitFor();
      base = new URL(page.url()).pathname;
    }
    await page.goto(`${f.server.url}${base}${where ? `/${where.split('/').map(encodeURIComponent).join('/')}` : ''}`);
    await page.locator('#files-body .files-row').first().waitFor();
  };
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'files-upload-progress-'));
  cleanups.push(() => fs.rmSync(local, { recursive: true, force: true }));
  return { ...f, bare, page, errors, step, context, shoot, tree, open, local };
}

/** Holds every request to `pattern` until `release()` is called. */
async function hold(page: import('playwright').Page, pattern: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let seen!: () => void;
  const reached = new Promise<void>((resolve) => { seen = resolve; });
  await page.route(pattern, async (route) => { seen(); await released; await route.continue(); });
  return { release, reached };
}

it('a folder whose file changes after it was chosen still lands, and names the file it could not send', async () => {
  const s = await setup();
  const { page, step } = s;
  const folder = path.join(s.local, 'bot_data');
  fs.mkdirSync(path.join(folder, 'state'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'config.json'), '{"a":1}\n');
  fs.writeFileSync(path.join(folder, 'state', 'seen.txt'), 'seen\n');
  fs.writeFileSync(path.join(folder, 'bot.log'), 'started\n');

  await step('progress shows the moment the folder is chosen, before the server answers', async () => {
    await s.open('site');
    const plan = await hold(page, '**/files/plan*');
    await page.locator('#files-upload').click();
    const chooser = page.waitForEvent('filechooser');
    await page.locator('.files-menu button', { hasText: 'A folder' }).click();
    await (await chooser).setFiles(folder);
    await plan.reached;
    const tray = page.locator('.files-tray');
    await tray.waitFor();
    expect(await tray.innerText()).toMatch(/bot_data/);
    expect(await tray.locator('.files-tray-bar').count()).toBe(1);
    // The bot writes to its log meanwhile: Chrome will refuse to send the copy it was given.
    fs.appendFileSync(path.join(folder, 'bot.log'), 'still running\n');
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(path.join(folder, 'bot.log'), later, later);
    // Leaving now would lose the upload: the page asks first.
    expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(true);
    plan.release();
  });

  await step('the rest is committed; the tray names what was left behind', async () => {
    await page.locator('#files-body .files-row', { hasText: 'bot_data' }).waitFor();
    expect(s.tree()).toEqual(expect.arrayContaining(['bot_data/config.json', 'bot_data/state/seen.txt']));
    expect(s.tree()).not.toContain('bot_data/bot.log');
    const tray = page.locator('.files-tray.failed');
    await tray.waitFor();
    const said = await tray.innerText();
    expect(said).toContain('bot.log');
    expect(said).toMatch(/changed/i);
    expect(said).not.toMatch(/failed to fetch/i);
    await s.shoot('upload-partial');
    // Nothing is in flight any more: leaving is free.
    expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(false);
    await tray.locator('.files-tray-close').click();
    await tray.waitFor({ state: 'detached' });
  });
});

it('a large upload shows its bytes going up, and survives moving to another folder', async () => {
  const s = await setup();
  const { page, step, context } = s;
  const big = path.join(s.local, 'corpus.txt');
  fs.writeFileSync(big, 'x'.repeat(3 * 1024 * 1024));

  await step('the bar fills as bytes leave, with what is left', async () => {
    await s.open('site');
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: -1, uploadThroughput: 1024 * 1024 });
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Shift+U');
    await (await chooser).setFiles(big);
    const tray = page.locator('.files-tray');
    await tray.waitFor();
    await page.waitForFunction(() => {
      const width = parseFloat(document.querySelector('.files-tray-bar > span')?.style.width || '0');
      return width > 5 && width < 95;
    });
    expect(await tray.locator('.files-tray-detail').innerText()).toMatch(/of 3(\.\d)? MB/);
    await s.shoot('upload-progress');
    // Moving elsewhere in the console keeps the upload (and its tray) going.
    await page.locator('.files-crumb', { hasText: /^site$/ }).first().waitFor();
    await page.locator('#files-body .files-link', { hasText: 'docs' }).click();
    await page.waitForURL(/\/files\/site\/docs$/);
    await tray.waitFor();
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await page.locator('.files-tray.done').waitFor({ timeout: 30_000 });
    expect(s.tree()).toContain('corpus.txt');
    // A finished tray leaves by itself.
    await page.locator('.files-tray').waitFor({ state: 'detached', timeout: 10_000 });
  });
});

it('Cancel stops an upload: nothing lands, and what was already sent is dropped', async () => {
  const s = await setup();
  const { page, step, context } = s;
  fs.writeFileSync(path.join(s.local, 'small.txt'), 'small\n');
  fs.writeFileSync(path.join(s.local, 'large.txt'), 'y'.repeat(2 * 1024 * 1024));
  await step('cancel while the large file is on its way', async () => {
    await s.open('site');
    const before = s.tree();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: -1, uploadThroughput: 200 * 1024 });
    const changes: string[] = [];
    page.on('request', (request) => { if (/\/files\/changes/.test(request.url())) changes.push(request.url()); });
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Shift+U');
    await (await chooser).setFiles([path.join(s.local, 'small.txt'), path.join(s.local, 'large.txt')]);
    await page.waitForFunction(() => parseFloat(document.querySelector('.files-tray-bar > span')?.style.width || '0') > 1);
    const dropped = page.waitForRequest((request) => request.method() === 'DELETE' && /\/files\/uploads\/[^/]+$/.test(request.url()));
    await page.locator('.files-tray .files-tray-close').click();
    await dropped;
    await page.locator('.files-tray').waitFor({ state: 'detached' });
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await page.waitForTimeout(500);
    expect(changes).toEqual([]);
    expect(s.tree()).toEqual(before);
  });
});

it('one way up: the address bar (no Up button), and Share has its own icon, the same for files and conversations', async () => {
  const s = await setup();
  const { page, step } = s;
  await step('no Up button; a crumb goes up, and so does Backspace', async () => {
    await s.open('site/docs');
    expect(await page.locator('.files-up').count()).toBe(0);
    await page.locator('.files-crumb', { hasText: /^site$/ }).click();
    await page.waitForURL(/\/files\/site$/);
    await page.locator('#files-body .files-link', { hasText: 'docs' }).click();
    await page.waitForURL(/\/files\/site\/docs$/);
    await page.locator('#files-body .files-row').first().waitFor();
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Backspace');
    await page.waitForURL(/\/files\/site$/);
  });
  await step('Share is not an arrow: one icon for files and conversations, unlike Upload', async () => {
    await page.locator('#files-share:not([hidden])').waitFor();
    const icons = await page.evaluate(() => {
      const drawn = (html: string) => { const box = document.createElement('div'); box.innerHTML = html; return box.firstElementChild.outerHTML; };
      return { files: drawn(KarmaxFileView.ICONS.share), button: document.querySelector('#files-share svg').outerHTML,
        upload: document.querySelector('#files-upload svg').outerHTML, up: KarmaxFileView.ICONS.up };
    });
    expect(icons.button).toBe(icons.files);
    expect(icons.files).not.toBe(icons.upload);
    // No arrow at all (the old one was Upload's tray-and-arrow).
    expect(icons.files).not.toMatch(/m16 6-4-4-4 4|M12 2v13/);
    expect(icons.up).toBeUndefined();
    // A conversation's Share draws the same icon (the console takes it from file-view.js).
    expect(fs.readFileSync(path.join(import.meta.dirname, '..', 'web', 'app.js'), 'utf8')).toMatch(/^\s*share: globalThis\.KarmaxFileView\?\.ICONS\.share/m);
  });
});
