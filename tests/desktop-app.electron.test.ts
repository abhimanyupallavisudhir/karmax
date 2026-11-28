// The desktop app (desktop/, wiki features/desktop-apps) driven end to end:
// Electron itself, through Playwright's Electron support, against a real
// hosted gateway. It runs where desktop/ is installed and there is a display
// (desktop.yml: `xvfb-run npx vitest run tests/desktop-app.electron.test.ts`),
// and skips elsewhere — the root CI shards don't install Electron.
// Screens: KARMAX_SHOTS=design/desktop xvfb-run npx vitest run tests/desktop-app.electron.test.ts
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DesktopReleases } from '../src/gateway/desktop-downloads.js';
import { consoleRequest, hostedGateway, signIn, type HostedGateway } from './helpers/browser.js';

const DESKTOP = path.resolve('desktop');
const electronPath = (() => {
  try { return createRequire(path.join(DESKTOP, 'package.json'))('electron') as string; } catch { return null; }
})();
const runnable = !!electronPath && fs.existsSync(electronPath) && (process.platform !== 'linux' || !!process.env.DISPLAY);
const SHOTS = process.env.KARMAX_SHOTS;
const PASSWORD = 'correct horse battery staple 42';

let g: HostedGateway;
let app: ElectronApplication;
let page: Page;
let userData: string;
const env = () => ({ ...process.env, TAVYA_URL: g.url, TAVYA_DESKTOP_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: '0' }) as Record<string, string>;
const shot = async (name: string) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};
/** What the system browser was asked to open (shell.openExternal, recorded in main). */
const opened = () => app.evaluate(() => (globalThis as any).__opened as string[]);

describe.skipIf(!runnable)('the desktop app', () => {
  beforeAll(async () => {
    g = await hostedGateway(() => ({ desktopReleases: new DesktopReleases({ fetch: (async () => Response.json([])) as unknown as typeof fetch }) }));
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tavya-desktop-test-'));
    app = await _electron.launch({ executablePath: electronPath!, args: [DESKTOP, '--use-fake-device-for-media-stream'], env: env() });
    await app.evaluate(({ shell }) => {
      (globalThis as any).__opened = [];
      shell.openExternal = async (url: string) => { (globalThis as any).__opened.push(url); };
    });
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
  }, 90_000);
  afterAll(async () => {
    await app?.close().catch(() => {});
    await g?.close();
    if (userData) fs.rmSync(userData, { recursive: true, force: true });
  });

  it('loads the console with the native bridge, the tavya-app user agent and a tray', async () => {
    expect(page.url()).toBe(`${g.url}/`);
    const bridge = await page.evaluate(() => {
      const cap = (window as any).Capacitor;
      return { native: cap.isNativePlatform(), platform: cap.getPlatform(), plugins: Object.keys(cap.Plugins),
        desktop: Object.keys(cap.Plugins.TavyaDesktop).sort(), signIn: Object.keys(cap.Plugins.TavyaSignIn).sort(),
        offline: cap.isPluginAvailable('TavyaOfflineFiles'), ua: navigator.userAgent, node: typeof (window as any).require };
    });
    expect(bridge).toMatchObject({ native: true, platform: 'electron', plugins: ['TavyaSignIn', 'TavyaDesktop'], offline: false, node: 'undefined' });
    expect(bridge.desktop).toEqual(['addListener', 'checkForUpdates', 'getHotkey', 'getLaunchAtLogin', 'getUpdateStatus', 'installUpdate',
      'removeAllListeners', 'setBadge', 'setHotkey', 'setLaunchAtLogin', 'show']);
    expect(bridge.signIn).toEqual(['addListener', 'clearDeviceToken', 'open', 'removeAllListeners', 'saveDeviceToken']);
    expect(bridge.ua).toMatch(/ tavya-app$/);
    expect(bridge.ua.match(/tavya-app/g)).toHaveLength(1);
    const tray = await app.evaluate(() => (globalThis as any).tavyaDesktop.tray());
    expect(tray).toEqual({ tooltip: 'tavya', forMe: 0, items: ['Open tavya', 'Ask tavya', 'For me', 'separator', 'Launch at login', 'separator', 'Quit tavya'] });
  });

  it('shows the For-me count the console reports in the tray', async () => {
    await page.evaluate(() => (window as any).Capacitor.Plugins.TavyaDesktop.setBadge({ count: 3 }));
    expect(await app.evaluate(() => (globalThis as any).tavyaDesktop.tray())).toMatchObject({ tooltip: 'tavya · 3 for you', forMe: 3,
      items: expect.arrayContaining(['For me (3)']) });
    await page.evaluate(() => (window as any).Capacitor.Plugins.TavyaDesktop.setBadge({ count: 0 }));
    expect((await app.evaluate(() => (globalThis as any).tavyaDesktop.tray())).tooltip).toBe('tavya');
  });

  it('registers the global Ask shortcut, changeable, and says plainly when one is taken or invalid', async () => {
    const desktop = (call: string, options?: unknown) => page.evaluate(([name, args]) => (window as any).Capacitor.Plugins.TavyaDesktop[name as string](args), [call, options] as const);
    expect(await desktop('getHotkey')).toMatchObject({ accelerator: 'Control+Alt+Space', registered: true, label: 'Ctrl+Alt+Space' });
    expect(await desktop('setHotkey', { accelerator: 'Control+Alt+K' })).toMatchObject({ accelerator: 'Control+Alt+K', registered: true });
    expect(await app.evaluate(({ globalShortcut }) => [globalShortcut.isRegistered('Control+Alt+K'), globalShortcut.isRegistered('Control+Alt+Space')]))
      .toEqual([true, false]);
    // Another app holds the next one (here: main itself, standing in for it).
    await app.evaluate(({ globalShortcut }) => globalShortcut.register('Control+Alt+J', () => {}));
    expect(await desktop('setHotkey', { accelerator: 'Control+Alt+J' })).toMatchObject({ registered: false, reason: 'Ctrl+Alt+J is taken by another app. Choose another shortcut.' });
    await app.evaluate(({ globalShortcut }) => globalShortcut.unregister('Control+Alt+J'));
    expect((await desktop('setHotkey', { accelerator: 'J' })).reason).toMatch(/isn't a shortcut/);
    expect(await desktop('setHotkey', { accelerator: 'Control+Alt+Space' })).toMatchObject({ registered: true });
  });

  it('opens Ask on the shortcut and console pages from io.tavya.app links, through the console\'s listener', async () => {
    await page.evaluate(async () => {
      (window as any).__opens = [];
      await (window as any).Capacitor.Plugins.TavyaDesktop.addListener('open', (target: unknown) => (window as any).__opens.push(target));
    });
    if (spawnSync('xdotool', ['--version']).status === 0) {
      // A real key press, through the X server, while another window could have focus.
      spawnSync('xdotool', ['key', 'ctrl+alt+space']);
      await expect.poll(() => page.evaluate(() => (window as any).__opens)).toEqual([{ path: null, url: null, ask: true }]);
      await page.evaluate(() => { (window as any).__opens = []; });
    }
    // A link opened elsewhere starts a second instance, which hands it over and quits.
    const second = spawn(electronPath!, [DESKTOP, 'io.tavya.app://open?path=/acme/tasks/12'], { env: env(), stdio: 'ignore' });
    const code = await new Promise<number | null>((resolve) => second.on('exit', resolve));
    expect(code).toBe(0);
    await expect.poll(() => page.evaluate(() => (window as any).__opens))
      .toEqual([{ path: '/acme/tasks/12', url: 'io.tavya.app://open?path=/acme/tasks/12', ask: false }]);
    // A link that leaves the console is refused.
    const evil = spawn(electronPath!, [DESKTOP, 'io.tavya.app://open?path=//evil.example/x'], { env: env(), stdio: 'ignore' });
    await new Promise((resolve) => evil.on('exit', resolve));
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as any).__opens)).toHaveLength(1);
  });

  it('keeps running in the tray when the window is closed, and a second launch shows it again', async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => window.isVisible()))).toEqual([false]);
    const second = spawn(electronPath!, [DESKTOP], { env: env(), stdio: 'ignore' });
    await new Promise((resolve) => second.on('exit', resolve));
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(true);
  });

  it('keeps the window on the console: other sites, links and new windows open in the system browser', async () => {
    await page.evaluate(() => { location.href = 'https://example.com/elsewhere'; });
    await expect.poll(opened).toContain('https://example.com/elsewhere');
    expect(page.url()).toBe(`${g.url}/`);
    await page.evaluate(() => window.open('https://example.org/new', '_blank'));
    await expect.poll(opened).toContain('https://example.org/new');
    // Nothing but web and mail links leave the app.
    await page.evaluate(() => { location.href = 'file:///etc/passwd'; });
    await page.waitForTimeout(300);
    expect(page.url()).toBe(`${g.url}/`);
    expect((await opened()).some((url) => url.startsWith('file:'))).toBe(false);
  });

  it('grants the console notifications and the microphone, and nothing else', async () => {
    const answers = await page.evaluate(async () => {
      const ask = async (constraints: MediaStreamConstraints) => {
        try { (await navigator.mediaDevices.getUserMedia(constraints)).getTracks().forEach((track) => track.stop()); return 'granted'; }
        catch (error) { return (error as Error).name; }
      };
      const geolocation = await new Promise((resolve) => navigator.geolocation.getCurrentPosition(() => resolve('granted'), (error) => resolve(error.code === 1 ? 'denied' : 'error')));
      return { notification: Notification.permission, requested: await Notification.requestPermission(),
        mic: await ask({ audio: true }), camera: await ask({ video: true }), geolocation };
    });
    expect(answers).toEqual({ notification: 'granted', requested: 'granted', mic: 'granted', camera: 'NotAllowedError', geolocation: 'denied' });
  });

  it('signs in through the system browser on a one-shot loopback listener', async () => {
    const authorize = `${g.url}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: 'tavya-desktop', redirect_uri: 'http://127.0.0.1/signed-in', state: 'st' })}`;
    const result = page.evaluate((url) => (window as any).Capacitor.Plugins.TavyaSignIn.open({ url }), authorize);
    await expect.poll(async () => (await opened()).find((url) => url.includes('/oauth/authorize'))).toBeTruthy();
    const asked = new URL((await opened()).find((url) => url.includes('/oauth/authorize'))!);
    const redirect = new URL(asked.searchParams.get('redirect_uri')!);
    expect(redirect.hostname).toBe('127.0.0.1');
    expect(redirect.pathname).toBe('/signed-in');
    expect(Number(redirect.port)).toBeGreaterThan(0);
    // The browser comes back (here, the test plays it).
    const back = await fetch(`${redirect.href}?code=c&state=st&iss=${encodeURIComponent(g.url)}`);
    expect(await back.text()).toMatch(/Signed in/);
    expect(await result).toEqual({ url: `${redirect.href}?code=c&state=st&iss=${encodeURIComponent(g.url)}` });
    // Not a URL of this console's authorization endpoint: refused, nothing opened.
    const refused = await page.evaluate(() => (window as any).Capacitor.Plugins.TavyaSignIn.open({ url: 'https://example.com/oauth/authorize' }).catch((error: unknown) => error));
    expect(refused).toEqual({ code: 'invalid', message: 'Sign-in must go to this tavya.' });
  });

  it('takes dropped files on the new-task form, like the browser', async () => {
    const { organization } = await g.owner({ name: 'Dee', email: 'dee@example.test', password: PASSWORD, organization: 'Dropco' });
    await signIn(app.context(), g.url, 'dee@example.test', PASSWORD);
    await consoleRequest(app.context(), g.url, 'POST', `/api/organizations/${organization.id}/projects`, { name: 'Website' });
    await page.goto(`${g.url}/dropco/website`);
    await page.locator('#expand-task').click();
    const prompt = page.locator('#tf-body textarea[data-field="prompt"]');
    await prompt.waitFor();
    await prompt.fill('Make the logo smaller');
    // An OS drag delivers a DataTransfer of files to the page; navigateOnDragDrop is off, so the page keeps it.
    await prompt.evaluate((element) => {
      const data = new DataTransfer();
      data.items.add(new File(['a,b\n1,2\n'], 'sizes.csv', { type: 'text/csv' }));
      for (const type of ['dragenter', 'dragover', 'drop']) element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
    });
    await expect.poll(() => page.locator('#tf-body').innerText()).toContain('sizes.csv');
    expect(page.url()).toBe(`${g.url}/dropco/website`);
    await shot('new-task-drop');
  });

  it('shows a retrying page, not a blank window, when the console can\'t be reached', async () => {
    const offlineData = fs.mkdtempSync(path.join(os.tmpdir(), 'tavya-desktop-offline-'));
    const offline = await _electron.launch({ executablePath: electronPath!, args: [DESKTOP],
      env: { ...env(), TAVYA_URL: 'http://127.0.0.1:9', TAVYA_DESKTOP_USER_DATA: offlineData } });
    try {
      const window = await offline.firstWindow();
      await window.locator('#retry').waitFor();
      expect(await window.locator('h1').innerText()).toBe('Can’t reach 127.0.0.1:9'.replace('’', "'"));
      expect(await window.evaluate(() => typeof (window as any).Capacitor)).toBe('undefined');
      if (SHOTS) await window.screenshot({ path: path.join(SHOTS, 'offline.png') });
    } finally {
      await offline.close();
      fs.rmSync(offlineData, { recursive: true, force: true });
    }
  });
});
