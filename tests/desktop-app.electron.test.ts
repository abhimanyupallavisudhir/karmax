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
import { DesktopPushSockets } from '../src/collaboration/desktop-push.js';
import { PushDeliveryAdapter, vaultVapidKeys } from '../src/collaboration/push-delivery.js';
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
const sockets = new DesktopPushSockets();
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
    g = await hostedGateway(({ broker }) => ({ desktopReleases: new DesktopReleases({ fetch: (async () => Response.json([])) as unknown as typeof fetch }),
      hostLocal: true, pushKeys: vaultVapidKeys(broker), desktopPush: sockets, deliveryChannels: ['browser', 'push'] }));
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
      const cap = (globalThis as any).Capacitor;
      return { native: cap.isNativePlatform(), platform: cap.getPlatform(), plugins: Object.keys(cap.Plugins),
        desktop: Object.keys(cap.Plugins.TavyaDesktop).sort(), signIn: Object.keys(cap.Plugins.TavyaSignIn).sort(),
        offline: cap.isPluginAvailable('TavyaOfflineFiles'), ua: (globalThis as any).navigator.userAgent, node: typeof (globalThis as any).require };
    });
    expect(bridge).toMatchObject({ native: true, platform: 'electron', plugins: ['TavyaSignIn', 'TavyaDesktop'], offline: false, node: 'undefined' });
    expect(bridge.desktop).toEqual(['addListener', 'checkForUpdates', 'getHotkey', 'getLaunchAtLogin', 'getUpdateStatus', 'installUpdate',
      'removeAllListeners', 'setBadge', 'setHotkey', 'setLaunchAtLogin', 'show']);
    // The device token is offered only where the OS keychain can keep it (not under a bare Xvfb).
    const keychain = (await app.evaluate(() => (globalThis as any).tavyaDesktop.deviceToken())).secure;
    expect(bridge.signIn).toEqual(['addListener', 'clearDeviceToken', 'open', 'removeAllListeners', ...(keychain ? ['saveDeviceToken'] : [])]);
    expect(bridge.ua).toMatch(/ tavya-app$/);
    expect(bridge.ua.match(/tavya-app/g)).toHaveLength(1);
    const tray = await app.evaluate(() => (globalThis as any).tavyaDesktop.tray());
    expect(tray).toEqual({ tooltip: 'tavya', forMe: 0, items: ['Open tavya', 'Ask tavya', 'For me', 'separator', 'Launch at login', 'separator', 'Quit tavya'] });
  });

  it('shows the For-me count the console reports in the tray', async () => {
    await page.evaluate(() => (globalThis as any).Capacitor.Plugins.TavyaDesktop.setBadge({ count: 3 }));
    expect(await app.evaluate(() => (globalThis as any).tavyaDesktop.tray())).toMatchObject({ tooltip: 'tavya · 3 for you', forMe: 3,
      items: expect.arrayContaining(['For me (3)']) });
    await page.evaluate(() => (globalThis as any).Capacitor.Plugins.TavyaDesktop.setBadge({ count: 0 }));
    expect((await app.evaluate(() => (globalThis as any).tavyaDesktop.tray())).tooltip).toBe('tavya');
  });

  it('registers the global Ask shortcut, changeable, and says plainly when one is taken or invalid', async () => {
    const desktop = (call: string, options?: unknown) => page.evaluate(([name, args]) => (globalThis as any).Capacitor.Plugins.TavyaDesktop[name as string](args), [call, options] as const);
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
      (globalThis as any).__opens = [];
      await (globalThis as any).Capacitor.Plugins.TavyaDesktop.addListener('open', (target: unknown) => (globalThis as any).__opens.push(target));
    });
    if (spawnSync('xdotool', ['--version']).status === 0) {
      // A real key press, through the X server, while another window could have focus.
      spawnSync('xdotool', ['key', 'ctrl+alt+space']);
      await expect.poll(() => page.evaluate(() => (globalThis as any).__opens)).toEqual([{ path: null, url: null, ask: true }]);
      await page.evaluate(() => { (globalThis as any).__opens = []; });
    }
    // A link opened elsewhere starts a second instance, which hands it over and quits.
    const second = spawn(electronPath!, [DESKTOP, 'io.tavya.app://open?path=/acme/tasks/12'], { env: env(), stdio: 'ignore' });
    const code = await new Promise<number | null>((resolve) => second.on('exit', resolve));
    expect(code).toBe(0);
    await expect.poll(() => page.evaluate(() => (globalThis as any).__opens))
      .toEqual([{ path: '/acme/tasks/12', url: 'io.tavya.app://open?path=/acme/tasks/12', ask: false }]);
    // A link that leaves the console is refused.
    const evil = spawn(electronPath!, [DESKTOP, 'io.tavya.app://open?path=//evil.example/x'], { env: env(), stdio: 'ignore' });
    await new Promise((resolve) => evil.on('exit', resolve));
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (globalThis as any).__opens)).toHaveLength(1);
  });

  it('keeps running in the tray when the window is closed, and a second launch shows it again', async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((shown: any) => shown.isVisible()))).toEqual([false]);
    const second = spawn(electronPath!, [DESKTOP], { env: env(), stdio: 'ignore' });
    await new Promise((resolve) => second.on('exit', resolve));
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(true);
  });

  it('keeps the window on the console: other sites, links and new windows open in the system browser', async () => {
    await page.evaluate(() => { (globalThis as any).location.href = 'https://example.com/elsewhere'; });
    await expect.poll(opened).toContain('https://example.com/elsewhere');
    expect(page.url()).toBe(`${g.url}/`);
    await page.evaluate(() => (globalThis as any).open('https://example.org/new', '_blank'));
    await expect.poll(opened).toContain('https://example.org/new');
    // Nothing but web and mail links leave the app.
    await page.evaluate(() => { (globalThis as any).location.href = 'file:///etc/passwd'; });
    await page.waitForTimeout(300);
    expect(page.url()).toBe(`${g.url}/`);
    expect((await opened()).some((url) => url.startsWith('file:'))).toBe(false);
  });

  it('grants the console notifications and the microphone, and nothing else', async () => {
    const answers = await page.evaluate(async () => {
      // Runs in the page (the project's types have no DOM).
      const w = globalThis as any;
      const ask = async (constraints: object) => {
        try { (await w.navigator.mediaDevices.getUserMedia(constraints)).getTracks().forEach((track: any) => track.stop()); return 'granted'; }
        catch (error) { return (error as Error).name; }
      };
      const geolocation = await new Promise((resolve) => w.navigator.geolocation.getCurrentPosition(() => resolve('granted'), (error: any) => resolve(error.code === 1 ? 'denied' : 'error')));
      return { notification: w.Notification.permission, requested: await w.Notification.requestPermission(),
        mic: await ask({ audio: true }), camera: await ask({ video: true }), geolocation };
    });
    expect(answers).toEqual({ notification: 'granted', requested: 'granted', mic: 'granted', camera: 'NotAllowedError', geolocation: 'denied' });
  });

  it('signs in through the system browser and a one-shot loopback listener, and is listed as Desktop', async () => {
    await g.owner({ name: 'Ada', email: 'ada@example.test', password: PASSWORD, organization: 'Acme' });
    const signedIn = await fetch(`${g.url}/api/auth/sign-in/email`, { method: 'POST', headers: { origin: g.url, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ada@example.test', password: PASSWORD }) });
    const browserCookie = signedIn.headers.get('set-cookie')!.match(/better-auth\.session_token=[^;]+/)![0];
    await page.goto(g.url);
    await page.locator('#app-sign-in').click();
    // The system browser opens the console's consent for the desktop client, its redirect on this app's port.
    await expect.poll(async () => (await opened()).find((url) => url.includes('/oauth/authorize'))).toBeTruthy();
    const asked = new URL((await opened()).find((url) => url.includes('/oauth/authorize'))!);
    expect(asked.searchParams.get('client_id')).toBe('tavya-desktop');
    const redirect = new URL(asked.searchParams.get('redirect_uri')!);
    expect([redirect.hostname, redirect.pathname]).toEqual(['127.0.0.1', '/signed-in']);
    expect(Number(redirect.port)).toBeGreaterThan(0);
    // The person, signed in there, allows it (the test plays the browser).
    const authorize = await fetch(asked, { redirect: 'manual', headers: { cookie: browserCookie } });
    const request = new URL(authorize.headers.get('location')!, g.url).searchParams.get('request')!;
    const approved = await fetch(`${g.url}/api/oauth/authorizations/${request}/approve`, { method: 'POST',
      headers: { origin: g.url, cookie: browserCookie, 'content-type': 'application/json' }, body: '{}' });
    const back = (await approved.json() as { redirectUri: string }).redirectUri;
    expect(back.startsWith(redirect.href)).toBe(true);
    // The browser follows the redirect to the app's listener, which answers and closes.
    expect(await (await fetch(back)).text()).toMatch(/Signed in/);
    await expect(fetch(back)).rejects.toThrow();
    await page.locator('.rail').first().waitFor();
    await page.goto(`${g.url}/profile`);
    const row = page.locator('.app-grant-row', { hasText: 'tavya on' });
    await row.waitFor();
    expect(await row.innerText()).toMatch(/Desktop[\s\S]*This one/);
    await shot('profile');
    // Not a URL of this console's authorization endpoint: refused, nothing opened.
    const refused = await page.evaluate(() => (globalThis as any).Capacitor.Plugins.TavyaSignIn.open({ url: 'https://example.com/oauth/authorize' }).catch((error: unknown) => error));
    expect(refused).toEqual({ code: 'invalid', message: 'Sign-in must go to this tavya.' });
  });

  it('keeps a device token the server issues and refreshes it there, one rotation at a time', async () => {
    // The shell's token store (desktop/src/device-token.cjs) against this server's /oauth/token, with a stand-in keychain.
    const { DeviceToken } = createRequire(path.join(DESKTOP, 'package.json'))('./src/device-token.cjs');
    const verifier = 'v'.repeat(43);
    const challenge = (await import('node:crypto')).createHash('sha256').update(verifier).digest('base64url');
    const signedIn = await fetch(`${g.url}/api/auth/sign-in/email`, { method: 'POST', headers: { origin: g.url, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ada@example.test', password: PASSWORD }) });
    const cookie = signedIn.headers.get('set-cookie')!.match(/better-auth\.session_token=[^;]+/)![0];
    const redirect = 'http://127.0.0.1:41234/signed-in';
    const authorize = await fetch(`${g.url}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: 'tavya-desktop', redirect_uri: redirect,
      code_challenge: challenge, code_challenge_method: 'S256', state: 's' })}`, { redirect: 'manual', headers: { cookie } });
    const request = new URL(authorize.headers.get('location')!, g.url).searchParams.get('request')!;
    const approved = await (await fetch(`${g.url}/api/oauth/authorizations/${request}/approve`, { method: 'POST',
      headers: { origin: g.url, cookie, 'content-type': 'application/json' }, body: '{}' })).json() as { redirectUri: string };
    const session = await (await fetch(`${g.url}/oauth/app-session`, { method: 'POST', headers: { origin: g.url, 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: 'tavya-desktop', code: new URL(approved.redirectUri).searchParams.get('code'), code_verifier: verifier,
        redirect_uri: redirect, name: 'tavya on Linux', device_token: true }) })).json() as { deviceToken: string };
    const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptString: (text: string) => Buffer.from(text).reverse(), decryptString: (buffer: Buffer) => Buffer.from(buffer).reverse().toString() };
    const store = new DeviceToken({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'tavya-token-')), safeStorage, origin: g.url, platform: 'linux' });
    expect(await store.save(session.deviceToken)).toBe(true);
    const access = await store.accessToken();
    expect(access).toMatch(/^tva_/);
    const me = await fetch(`${g.url}/api/user/app-grants`, { headers: { authorization: `Bearer ${access}` } });
    expect(me.status).toBe(200);
    store.access = null;
    expect(await store.accessToken()).toMatch(/^tva_/);
    // The first token was rotated away: presenting it now would revoke the grant, so the store never does.
    expect(store.read()).not.toBe(session.deviceToken);
  });

  it('opens Ask on the global shortcut, signed in, with the window hidden', async () => {
    if (spawnSync('xdotool', ['--version']).status !== 0) return;
    await page.goto(g.url);
    await page.locator('.rail').first().waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.hide());
    spawnSync('xdotool', ['key', 'ctrl+alt+space']);
    await page.locator('.ask-dialog[open] textarea').waitFor();
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(true);
    await page.locator('.ask-dialog textarea').fill('What’s waiting on me?');
    await shot('ask');
    await page.keyboard.press('Escape');
  });

  it('notifies over its own connection; a click raises the hidden window on the task', async () => {
    const user = (await g.identity.listUsers()).find((entry: { email: string }) => entry.email === 'ada@example.test')!;
    const organization = (await g.store.listOrganizations()).find((entry) => entry.name === 'Acme')!;
    const project = await g.store.createProject('Website', undefined, organization.id);
    const task = await g.store.createTask({ projectId: project.id, title: 'Fix the login', workflow: 'just-do', workflowVersion: '1.0.0',
      params: {} as any, createdBy: { kind: 'user', userId: user.id } });
    await page.goto(`${g.url}/profile#notifications`);
    await page.locator('#push-this-device').click();
    await expect.poll(async () => (await g.store.listPushSubscriptions(user.id)).map((device) => [device.kind, device.label]))
      .toEqual([['desktop', 'tavya on Linux']]);
    const [device] = await g.store.listPushSubscriptions(user.id);
    await expect.poll(() => sockets.connected(device!.id)).toBe(1);
    // Electron shows the page's Notification natively; record what the page shows.
    await page.evaluate(() => {
      const w = globalThis as any;
      const Real = w.Notification;
      w.__shown = [];
      w.Notification = Object.assign(function (this: any, title: string, options: object) {
        const shown = new Real(title, options);
        (globalThis as any).__shown.push(shown);
        return shown;
      }, { permission: Real.permission, requestPermission: Real.requestPermission.bind(Real) });
    });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.hide());
    const adapter = new PushDeliveryAdapter({ store: g.store, keys: async () => { throw new Error('no web devices'); }, siteName: async () => 'tavya', desktop: sockets });
    await adapter.deliver({ inbox: { id: 'inbox_e1', organizationId: organization.id, userId: user.id, eventSeq: 1, taskId: task.id, kind: 'review-requested',
      urgency: 'high', unread: true, actionable: true, createdAt: Date.now() }, task: { id: task.id, num: task.num, title: task.title, projectId: project.id } });
    await expect.poll(() => page.evaluate(() => (globalThis as any).__shown.map((n: any) => [n.title, n.tag]))).toEqual([['Fix the login', 'inbox_e1']]);
    await page.evaluate(() => (globalThis as any).__shown[0].onclick?.(new Event('click')));
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(true);
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/acme/website/tasks/${task.num}`);
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
      const w = globalThis as any;
      const data = new w.DataTransfer();
      data.items.add(new w.File(['a,b\n1,2\n'], 'sizes.csv', { type: 'text/csv' }));
      for (const type of ['dragenter', 'dragover', 'drop']) element.dispatchEvent(new w.DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
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
      const offlinePage = await offline.firstWindow();
      await offlinePage.locator('#retry').waitFor();
      expect(await offlinePage.locator('h1').innerText()).toBe('Can’t reach 127.0.0.1:9'.replace('’', "'"));
      expect(await offlinePage.evaluate(() => typeof (globalThis as any).Capacitor)).toBe('undefined');
      if (SHOTS) await offlinePage.screenshot({ path: path.join(SHOTS, 'offline.png') });
    } finally {
      await offline.close();
      fs.rmSync(offlineData, { recursive: true, force: true });
    }
  });
});
