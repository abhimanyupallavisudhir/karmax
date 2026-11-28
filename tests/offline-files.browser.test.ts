import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { launchChromium, openConsole } from './helpers/browser.js';
import { capsOf, projectFilesFixture, sh } from './helpers/project-files-fixture.js';

// Offline files in the apps (wiki features/offline-files), driven in the
// shipped console against a real gateway (real Git remotes and restic data),
// with window.Capacitor's TavyaOfflineFiles played by an in-memory stand-in
// that downloads with fetch and keeps bytes by SHA-256 in localStorage (so
// they outlive a reload, as a phone's files do). Pin, the marks, refresh on a
// change notice, out of date when the download can't happen, unpin frees,
// the limit refuses, and the app opening offline through the service worker.
// Screens: SHOTS=1 writes design/offline-files/*.png (not tracked).

declare const window: any, localStorage: any, indexedDB: any, navigator: any, caches: any;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
let browser: Browser;
beforeAll(async () => { browser = await launchChromium(); });
afterAll(async () => { await browser?.close(); });
const shots = process.env.SHOTS === '1' ? path.join(import.meta.dirname, '..', 'design', 'offline-files') : '';
const shoot = async (page: Page, name: string) => {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
};

/** The app's native side as the page sees it (runs in the page). */
function fakeOfflineApp() {
  const w = globalThis as any;
  const KEY = 'fake-offline-files';
  const stored = (): Record<string, string> => JSON.parse(localStorage.getItem(KEY) || '{}');
  const keep = (map: Record<string, string>) => localStorage.setItem(KEY, JSON.stringify(map));
  const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const base64 = (bytes: Uint8Array) => { let text = ''; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text); };
  const fail = (code: string, message = code) => { throw { code, message }; };
  w.__offline = { downloads: [] as string[], failNetwork: false, opened: null };
  const TavyaOfflineFiles = {
    async download({ url, version, size, blob }: { url: string; version: string; size: number; blob?: string }) {
      w.__offline.downloads.push(url);
      if (w.__offline.failNetwork) fail('network', 'The Internet connection appears to be offline.');
      let response: Response;
      try { response = await fetch(url, { headers: { 'if-match': `"${version}"` } }); } catch (error) { return fail('network', String(error)); }
      if (response.status === 412) fail('changed');
      if (response.status === 403) fail('forbidden');
      if (response.status === 404) fail('missing');
      if (!response.ok) fail('http');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== size) fail('mismatch');
      if (blob) {
        const head = new TextEncoder().encode(`blob ${size}\0`);
        const all = new Uint8Array(head.length + bytes.length);
        all.set(head); all.set(bytes, head.length);
        if (hex(await crypto.subtle.digest('SHA-1', all)) !== blob) fail('mismatch');
      }
      const hash = hex(await crypto.subtle.digest('SHA-256', bytes));
      const map = stored(); map[hash] = base64(bytes); keep(map);
      return { hash, size: bytes.length };
    },
    async list() {
      const files = Object.entries(stored()).map(([hash, data]) => ({ hash, size: atob(data).length }));
      return { files, bytes: files.reduce((sum, file) => sum + file.size, 0), free: 64 * 1024 ** 3 };
    },
    async remove({ hashes }: { hashes: string[] }) { const map = stored(); for (const hash of hashes) delete map[hash]; keep(map); },
    async wipe() { localStorage.removeItem(KEY); },
    // Like iOS: no local URL, so the page reads the bytes in chunks.
    async url() { return { url: null }; },
    async read({ hash, offset = 0, length = 1 << 20 }: { hash: string; offset?: number; length?: number }) {
      const binary = atob(stored()[hash] ?? '');
      const part = binary.slice(offset, offset + length);
      return { data: btoa(part), eof: offset + part.length >= binary.length };
    },
    async open({ hash, name }: { hash: string; name: string }) { w.__offline.opened = { hash, name }; },
  };
  const Plugins = { TavyaOfflineFiles };
  w.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', isPluginAvailable: (name: string) => name in Plugins, Plugins };
}

async function setup() {
  const f = await projectFilesFixture(cleanups);
  const push = async (files: Record<string, string>) => {
    // On top of what Files committed meanwhile.
    sh(f.site.work, 'fetch', '-q', f.site.bare, 'main');
    sh(f.site.work, 'reset', '-q', '--hard', 'FETCH_HEAD');
    for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(f.site.work, file), content);
    sh(f.site.work, 'add', '-A');
    sh(f.site.work, 'commit', '-qm', 'change');
    sh(f.site.work, 'push', '-q', f.site.bare, 'HEAD:main');
    const { readMirrored } = await import('../src/world/git-mirror.js');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-offline-tip-'));
    try { await readMirrored(`git@github.com:${f.owner}/site.git`, {}, { branch: 'main', scratch }, async () => undefined); }
    finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  };
  return { ...f, push };
}

const stored = (page: Page) => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('fake-offline-files') || '{}')).length);
const menuFor = async (page: Page, name: string) => {
  const row = page.locator('#files-body .files-row', { hasText: name }).first();
  await row.hover();
  await row.locator('.files-more').click();
  return page.locator('.files-menu');
};
const mark = (page: Page, name: string) => page.locator('#files-body .files-row', { hasText: name }).first().locator('.offline-mark');

it('keeps files and folders offline, refreshes them when tavya changes, and frees them when let go', async () => {
  const f = await setup();
  const { page, errors, step, context } = await openConsole(browser, { viewport: { width: 1280, height: 820 } });
  cleanups.push(() => context.close());
  await context.addInitScript(fakeOfflineApp);

  await step('a file: ⋯ → Available offline downloads it and marks its row', async () => {
    await page.goto(`${f.server.url}/personal/site-builder/files/site/docs`);
    await page.locator('.files-row', { hasText: 'guide.md' }).waitFor();
    const menu = await menuFor(page, 'guide.md');
    const item = menu.locator('[role="menuitemcheckbox"]', { hasText: 'Available offline' });
    expect(await item.getAttribute('aria-checked')).toBe('false');
    await item.click();
    await mark(page, 'guide.md').and(page.locator('[data-state="current"]')).waitFor();
    expect(await mark(page, 'guide.md').getAttribute('title')).toMatch(/^Available offline · checked /);
    expect(await stored(page)).toBe(1);
  });

  await step('a folder says what it takes first; the right-click menu keeps it', async () => {
    await page.goto(`${f.server.url}/personal/site-builder/files/site`);
    await page.locator('.files-row', { hasText: 'src' }).first().waitFor();
    await page.locator('.files-row', { hasText: 'src' }).first().click({ button: 'right' });
    await page.locator('.files-menu [role="menuitemcheckbox"]', { hasText: 'Available offline' }).click();
    const dialog = page.locator('.offline-keep-dialog');
    await dialog.waitFor();
    expect(await dialog.locator('.offline-keep-meta').innerText()).toBe('2 files · 44 B');
    await shoot(page, 'keep-folder');
    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Enter`);
    await mark(page, 'src').and(page.locator('[data-state="current"]')).waitFor();
    expect(await stored(page)).toBe(3);
    await shoot(page, 'marks');
    // A file inside a kept folder is kept by it.
    await page.goto(`${f.server.url}/personal/site-builder/files/site/src`);
    const inside = (await menuFor(page, 'app.ts')).locator('[role="menuitemcheckbox"]');
    expect(await inside.getAttribute('aria-checked')).toBe('true');
    expect(await inside.isDisabled()).toBe(true);
    await page.keyboard.press('Escape');
  });

  await step('the Offline view lists what this device keeps, with the meter and the limit', async () => {
    await page.locator('#files-view').click();
    await page.locator('.files-view-menu [role="option"]', { hasText: 'Available offline' }).click();
    await page.waitForURL(/\/files\?offline$/);
    await page.locator('.offline-view .files-row', { hasText: 'src' }).waitFor();
    expect(await page.locator('.offline-view .files-row .files-name').allInnerTexts()).toEqual(['guide.md', 'src']);
    expect(await page.locator('#offline-meter').innerText()).toMatch(/^53 B of/);
    expect(await page.locator('#offline-limit option:checked').innerText()).toBe('2 GB');
    await shoot(page, 'offline-view');
    // Into the folder, and a file from the device's copy.
    await page.locator('.offline-view .files-link', { hasText: 'src' }).click();
    await page.locator('.offline-view .files-link', { hasText: 'app.ts' }).click();
    await page.locator('.files-content', { hasText: 'export const answer = 42;' }).waitFor();
    await page.locator('#offline-open').click();
    expect(await page.evaluate(() => window.__offline.opened.name)).toBe('app.ts');
    await shoot(page, 'offline-file');
    await page.locator('body').press('Backspace');
    await page.locator('.offline-view .files-link', { hasText: 'weird name #1.txt' }).waitFor();
  });

  await step('a change on tavya (a files change notice) downloads only what changed', async () => {
    await page.goto(`${f.server.url}/personal/site-builder/files/site/src`);
    await mark(page, 'app.ts').count();
    const before: number = await page.evaluate(() => window.__offline.downloads.length);
    // Someone else saves app.ts in Files: one commit, and a notice to readers of the project.
    const developer = await f.tokenFor(capsOf('developer') as string[]);
    const upload = await fetch(`${f.server.url}/api/projects/${f.project.id}/files/changes`, { method: 'POST',
      headers: { authorization: `Bearer ${developer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ changes: [{ op: 'write', path: 'site/src/app.ts', text: 'export const answer = 43;\n' }] }) });
    expect(upload.status).toBe(200);
    await page.waitForFunction((count: number) => window.__offline.downloads.length > count, before, { timeout: 15_000 });
    await page.waitForFunction(() => window.__offline.downloads.at(-1).includes('app.ts'));
    expect(await page.evaluate((count: number) => window.__offline.downloads.slice(count), before)).toEqual([expect.stringContaining('site%2Fsrc%2Fapp.ts')]);
    // The old bytes are let go once the new ones are whole.
    await page.waitForFunction(() => Object.keys(JSON.parse(localStorage.getItem('fake-offline-files') || '{}')).length === 3);
  });

  await step('a newer version that can’t be downloaded marks the copy out of date, and keeps it', async () => {
    await page.locator('.files-crumb', { hasText: /^site$/ }).click();
    await page.locator('.files-row', { hasText: 'src' }).first().waitFor();
    await page.evaluate(() => { window.__offline.failNetwork = true; });
    await f.push({ 'src/app.ts': 'export const answer = 44;\n' });
    // A push GitHub tells tavya about (no webhook here): the next check finds it.
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await mark(page, 'src').and(page.locator('[data-state="stale"]')).waitFor({ timeout: 15_000 });
    expect(await mark(page, 'src').getAttribute('title')).toMatch(/^Out of date: offline · checked /);
    await shoot(page, 'out-of-date');
    await page.evaluate(() => { window.__offline.failNetwork = false; });
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await mark(page, 'src').and(page.locator('[data-state="current"]')).waitFor({ timeout: 15_000 });
  });

  await step('letting go frees the bytes at once', async () => {
    await (await menuFor(page, 'src')).locator('[role="menuitemcheckbox"]', { hasText: 'Available offline' }).click();
    await page.waitForFunction(() => Object.keys(JSON.parse(localStorage.getItem('fake-offline-files') || '{}')).length === 1);
    expect(await mark(page, 'src').count()).toBe(0);
  });

  await step('past the limit a folder is refused, saying what it needs', async () => {
    await page.evaluate(() => new Promise((resolve) => {
      const open = indexedDB.open('tavya-offline', 1);
      open.onsuccess = () => { const tx = open.result.transaction('meta', 'readwrite'); tx.objectStore('meta').put(100, 'limit'); tx.oncomplete = () => { open.result.close(); resolve(null); }; };
    }));
    await page.reload();
    await page.locator('.files-row', { hasText: 'data' }).first().waitFor();
    await (await menuFor(page, 'data')).locator('[role="menuitemcheckbox"]', { hasText: 'Available offline' }).click();
    const dialog = page.locator('.offline-keep-dialog');
    await dialog.waitFor();
    expect(await dialog.locator('.offline-keep-refused').innerText()).toMatch(/^Needs 293 KB · 91 B free$/);
    expect(await dialog.locator('[data-keep]').isDisabled()).toBe(true);
    await shoot(page, 'limit');
    await dialog.locator('[data-cancel]').click();
  });
  expect(errors).toEqual([]);
});

it('opens without a network into what the device keeps (the service worker’s offline shell)', async () => {
  const f = await setup();
  // A context like the app's WebView: service workers on.
  const context: BrowserContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  cleanups.push(() => context.close());
  context.setDefaultTimeout(15_000);
  await context.addInitScript(fakeOfflineApp);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(`${f.server.url}/personal/site-builder/files/site`);
  await page.locator('.files-row', { hasText: 'README.md' }).waitFor();
  // The app registers the worker in shell mode (it has the plugin); once it controls the page, a load keeps the console.
  await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.active?.scriptURL.endsWith('/service-worker.js?shell=1')), { timeout: 15_000 }).toBe(true);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.locator('.files-row', { hasText: 'README.md' }).waitFor();
  await (await menuFor(page, 'README.md')).locator('[role="menuitemcheckbox"]', { hasText: 'Available offline' }).click();
  await mark(page, 'README.md').and(page.locator('[data-state="current"]')).waitFor();
  await expect.poll(() => page.evaluate(async () => (await (await caches.open('tavya-shell-v1')).keys()).some((request: Request) => request.url.endsWith('/app.js'))), { timeout: 15_000 }).toBe(true);

  // No network: the app still opens, into Files with what it keeps.
  await context.setOffline(true);
  await page.reload();
  await page.locator('.offline-shell .files-row', { hasText: 'README.md' }).waitFor();
  expect(await page.locator('.offline-pill').innerText()).toMatch(/^Offline · checked /);
  await shoot(page, 'offline-shell');
  await page.locator('.offline-shell .files-link', { hasText: 'README.md' }).click();
  await page.locator('.files-rendered h1', { hasText: 'Site' }).waitFor();
  await shoot(page, 'offline-shell-file');
  // Back online, the console proper.
  await context.setOffline(false);
  await page.locator('#files-page:not(.offline-view)').waitFor();
  expect(errors).toEqual([]);
});
