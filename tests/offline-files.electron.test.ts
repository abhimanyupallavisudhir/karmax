// Offline files in the desktop app (wiki features/offline-files), end to end:
// Electron itself with the real TavyaOfflineFiles plugin
// (desktop/src/plugins/offline-files.cjs), through Playwright's Electron
// support, against a real gateway (Git remotes on disk, real restic data).
// Keep a file and a folder, see the bytes on disk read-only by their SHA-256,
// show one in the app from tavya-offline://, Open in… with the default app,
// open the app with tavya unreachable (the service worker's offline shell),
// and let go. Runs where desktop/ is installed and there is a display
// (desktop.yml, under xvfb-run); skips elsewhere.
// Screens: KARMAX_SHOTS=<dir> xvfb-run npx vitest run tests/offline-files.electron.test.ts
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { projectFilesFixture } from './helpers/project-files-fixture.js';

const DESKTOP = path.resolve('desktop');
const electronPath = (() => {
  try { return createRequire(path.join(DESKTOP, 'package.json'))('electron') as string; } catch { return null; }
})();
const runnable = !!electronPath && fs.existsSync(electronPath) && (process.platform !== 'linux' || !!process.env.DISPLAY);
const SHOTS = process.env.KARMAX_SHOTS;
declare const navigator: any;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const sha256 = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest('hex');

describe.skipIf(!runnable)('offline files in the desktop app', () => {
  it('keeps files on disk by their SHA-256, shows and opens them, and opens without tavya', async () => {
    const f = await projectFilesFixture(cleanups);
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tavya-desktop-offline-'));
    cleanups.push(() => fs.rmSync(userData, { recursive: true, force: true }));
    const app: ElectronApplication = await _electron.launch({ executablePath: electronPath!, args: [DESKTOP],
      env: { ...process.env, TAVYA_URL: f.server.url, TAVYA_DESKTOP_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: '0' } as Record<string, string> });
    cleanups.push(() => app.close().catch(() => {}));
    await app.evaluate(({ shell }) => {
      (globalThis as any).__openedPaths = [];
      shell.openPath = async (file: string) => { (globalThis as any).__openedPaths.push(file); return ''; };
    });
    const page: Page = await app.firstWindow();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const shot = async (name: string) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); } };
    const blobs = path.join(userData, 'offline-files', 'blobs');
    const stored = () => fs.existsSync(blobs) ? fs.readdirSync(blobs).sort() : [];
    const menu = async (name: string) => {
      const row = page.locator('#files-body .files-row', { hasText: name }).first();
      await row.hover();
      await row.locator('.files-more').click();
      return page.locator('.files-menu [role="menuitemcheckbox"]', { hasText: 'Available offline' });
    };

    // The plugin is there, with the same methods as the phones'.
    await page.waitForLoadState('domcontentloaded');
    const methods = await page.evaluate(() => Object.keys((globalThis as any).Capacitor.Plugins.TavyaOfflineFiles).sort());
    expect(methods).toEqual(expect.arrayContaining(['download', 'list', 'open', 'read', 'remove', 'url', 'wipe']));

    // Keep a file: on disk by its SHA-256, read-only, the bytes Files serves.
    await page.goto(`${f.server.url}/personal/site-builder/files/site/docs`);
    await (await menu('guide.md')).click();
    await page.locator('#files-body .files-row', { hasText: 'guide.md' }).locator('.offline-mark[data-state="current"]').waitFor();
    expect(stored()).toEqual([sha256('## Guide\n')]);
    const guide = path.join(blobs, sha256('## Guide\n'));
    expect(fs.readFileSync(guide, 'utf8')).toBe('## Guide\n');
    expect(fs.statSync(guide).mode & 0o777).toBe(0o444);

    // A folder, with data mounted inside (restic bytes, checked by size).
    await page.goto(`${f.server.url}/personal/site-builder/files/site/data`);
    await (await menu('raw')).click();
    await page.locator('.offline-keep-dialog [data-keep]').click();
    await page.locator('#files-body .files-row', { hasText: 'raw' }).locator('.offline-mark[data-state="current"]').waitFor();
    expect(stored()).toContain(sha256(f.corpus[2]!.data));
    expect(stored()).toHaveLength(4);
    await shot('desktop-marks');

    // Shown from the device's copy (tavya-offline://, past the console's CSP), and Open in… with the default app.
    await page.goto(`${f.server.url}/personal/site-builder/files?offline`);
    await page.locator('.offline-view .files-link', { hasText: 'guide.md' }).click();
    await page.locator('.files-rendered h2', { hasText: 'Guide' }).waitFor();
    expect(await page.evaluate(async () => (await (globalThis as any).Capacitor.Plugins.TavyaOfflineFiles.url({ hash: 'a'.repeat(64) })).url)).toBe(`tavya-offline://file/${'a'.repeat(64)}`);
    await page.locator('#offline-open').click();
    await expect.poll(() => app.evaluate(() => (globalThis as any).__openedPaths)).toHaveLength(1);
    const opened = (await app.evaluate(() => (globalThis as any).__openedPaths))[0] as string;
    expect(path.basename(opened)).toBe('guide.md');
    expect(fs.readFileSync(opened, 'utf8')).toBe('## Guide\n');
    // tavya unreachable: the app still opens, into what it keeps.
    await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.active?.scriptURL.endsWith('?shell=1')), { timeout: 15_000 }).toBe(true);
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.locator('.offline-view .files-row').first().waitFor();
    await expect.poll(() => page.evaluate(async () => (await (await caches.open('tavya-shell-v1')).keys()).some((request: Request) => request.url.endsWith('/app.js'))), { timeout: 15_000 }).toBe(true);
    await f.server.close();
    await page.reload();
    await page.locator('.offline-shell .files-row', { hasText: 'guide.md' }).waitFor();
    expect(await page.locator('.offline-pill').innerText()).toMatch(/^Offline · checked /);
    await page.locator('.offline-shell .files-link', { hasText: 'raw' }).click();
    await page.locator('.offline-shell .files-link', { hasText: 'pages' }).click();
    await page.locator('.offline-shell .files-link', { hasText: 'b.csv' }).click();
    await page.locator('.files-table td', { hasText: '2' }).first().waitFor();
    await shot('desktop-offline-shell');

    // Letting go (here, offline) frees the bytes at once.
    await page.locator('.offline-shell .files-crumb-root').click();
    const raw = page.locator('.offline-shell .files-row', { hasText: 'raw' });
    await raw.hover();
    await raw.locator('.files-more').click();
    await page.locator('.files-menu button', { hasText: 'Remove from this device' }).click();
    await expect.poll(() => stored()).toEqual([sha256('## Guide\n')]);
    expect(errors).toEqual([]);
  }, 120_000);
});
