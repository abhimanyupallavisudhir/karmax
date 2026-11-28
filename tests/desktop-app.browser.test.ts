// The console inside the desktop apps (wiki features/desktop-apps), against a
// real hosted gateway: window.Capacitor is the Electron preload's stand-in, as
// planned/native-apps-round-2 § contracts defines it (getPlatform 'electron',
// TavyaSignIn, TavyaDesktop). Signed out, the app signs in through the system
// browser to a loopback listener and hands its device token to the shell;
// "Push to this device" registers a desktop device reached over /ws; the For-me
// count goes to the dock badge; io.tavya.app links and the tray open pages.
// Screens: KARMAX_SHOTS=<dir> npx vitest run tests/desktop-app.browser.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { DesktopPushSockets } from '../src/collaboration/desktop-push.js';
import { PushDeliveryAdapter, vaultVapidKeys } from '../src/collaboration/push-delivery.js';
import { hostedGateway, launchChromium, openConsole, signIn, type HostedGateway } from './helpers/browser.js';

let browser: Browser, g: HostedGateway;
const sockets = new DesktopPushSockets();
const PASSWORD = 'correct horse battery staple 42';
const SHOTS = process.env.KARMAX_SHOTS;
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

/** The Electron preload as the page sees it (runs in the page, so untyped). */
function fakeDesktop() {
  const w = globalThis as any;
  const plugin = (name: string, methods: Record<string, (...args: any[]) => any>) => {
    const listeners: Record<string, Array<(data: any) => void>> = {};
    const calls: Array<[string, any]> = [];
    const self: any = { calls, listeners,
      emit: (event: string, data: any) => { for (const listener of (listeners[event] ?? []).slice()) listener(data); },
      addListener: async (event: string, listener: (data: any) => void) => {
        (listeners[event] ??= []).push(listener);
        return { remove: async () => { listeners[event] = (listeners[event] ?? []).filter((entry) => entry !== listener); } };
      } };
    for (const [method, run] of Object.entries(methods))
      self[method] = async (options?: any) => { calls.push([method, options]); return run(options, self); };
    w.__app[name] = self;
    return self;
  };
  w.__app = { notifications: [] as any[], hotkey: { accelerator: 'Control+Alt+Space', registered: true }, login: false };
  // Electron shows the web Notification API natively; the test records what the page shows.
  w.Notification = class {
    static permission = 'granted';
    static requestPermission = async () => 'granted';
    onclick: any = null; onclose: any = null;
    constructor(public title: string, public options: any) { w.__app.notifications.push(this); }
    close() {}
  };
  const update = { state: 'idle', current: '1.2.0' };
  const Plugins = {
    // The system browser and the loopback listener: the test plays them (window.__systemBrowser).
    TavyaSignIn: plugin('TavyaSignIn', {
      open: async ({ url }: { url: string }) => {
        const asked = new URL(url);
        asked.searchParams.set('redirect_uri', 'http://127.0.0.1:53682/signed-in');
        return { url: await w.__systemBrowser(asked.href) };
      },
      saveDeviceToken: () => undefined,
      // Signing out reloads the page: the shell remembers it was told.
      clearDeviceToken: () => { localStorage.setItem('fake-token-cleared', '1'); },
    }),
    TavyaDesktop: plugin('TavyaDesktop', {
      setBadge: () => undefined,
      show: () => undefined,
      getHotkey: () => w.__app.hotkey,
      setHotkey: ({ accelerator }: { accelerator: string }) => (w.__app.hotkey = { accelerator, registered: true }),
      getLaunchAtLogin: () => ({ enabled: w.__app.login }),
      setLaunchAtLogin: ({ enabled }: { enabled: boolean }) => { w.__app.login = enabled; },
      getUpdateStatus: () => update,
      checkForUpdates: () => ({ ...update, state: 'none' }),
      installUpdate: () => undefined,
    }),
  };
  w.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'electron', isPluginAvailable: (name: string) => name in Plugins, Plugins };
}

beforeAll(async () => {
  browser = await launchChromium();
  g = await hostedGateway(({ broker }) => ({ hostLocal: true, pushKeys: vaultVapidKeys(broker), desktopPush: sockets, deliveryChannels: ['browser', 'push'] }));
}, 60_000);
afterAll(async () => { await g?.close(); await browser?.close(); });

it('signs the desktop app in through the system browser to a loopback listener, and keeps the device token in the shell', async () => {
  await g.owner({ name: 'Ada', email: 'ada@example.test', password: PASSWORD, organization: 'Acme' });
  const signedIn = await fetch(`${g.url}/api/auth/sign-in/email`, { method: 'POST', headers: { origin: g.url, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'ada@example.test', password: PASSWORD }) });
  const browserCookie = signedIn.headers.get('set-cookie')!.match(/better-auth\.session_token=[^;]+/)![0];
  const visited: string[] = [];
  const { page, errors, step, context } = await openConsole(browser, { ip: '192.0.2.81' });
  await context.exposeFunction('__systemBrowser', async (url: string) => {
    visited.push(url);
    const authorize = await fetch(url, { redirect: 'manual' });
    const request = new URL(authorize.headers.get('location')!, g.url).searchParams.get('request')!;
    const view = await (await fetch(`${g.url}/api/oauth/authorizations/${request}`, { headers: { cookie: browserCookie } })).json() as any;
    expect(view.client.id).toBe('tavya-desktop');
    const approved = await fetch(`${g.url}/api/oauth/authorizations/${request}/approve`, { method: 'POST',
      headers: { origin: g.url, cookie: browserCookie, 'content-type': 'application/json' }, body: '{}' });
    return ((await approved.json()) as { redirectUri: string }).redirectUri;
  });
  await context.addInitScript(fakeDesktop);
  const signInPlugin = 'window.__app.TavyaSignIn';
  try {
    await step('Sign in uses the desktop client and its loopback redirect, then hands the device token to the shell', async () => {
      await page.goto(g.url);
      await page.locator('#app-sign-in').click();
      await page.locator('.rail').first().waitFor();
      const asked = new URL(visited[0]!);
      expect(Object.fromEntries(asked.searchParams)).toMatchObject({ client_id: 'tavya-desktop', redirect_uri: 'http://127.0.0.1:53682/signed-in' });
      const saved = await page.evaluate(`${signInPlugin}.calls.filter(([m]) => m === 'saveDeviceToken').map(([, o]) => o.token)`) as string[];
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatch(/^tvr_grant_/);
      // Never kept by the page.
      expect(await page.evaluate(`JSON.stringify(localStorage)`)).not.toContain('tvr_');
    });

    await step('Profile → Apps and tokens lists it as the desktop', async () => {
      await page.goto(`${g.url}/profile`);
      const row = page.locator('.app-grant-row', { hasText: 'tavya on' });
      await row.waitFor();
      expect(await row.innerText()).toMatch(/Desktop[\s\S]*This one/);
    });

    await step('signing out clears the shell\'s device token', async () => {
      await page.locator('#profile-logout').click();
      await page.locator('#app-sign-in').waitFor();
      expect(await page.evaluate(`localStorage.getItem('fake-token-cleared')`)).toBe('1');
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 120_000);

it('notifies over the app\'s own connection, badges the For-me count, opens links, and has its settings in Profile', async () => {
  const { user, organization } = await g.owner({ name: 'Bea', email: 'bea@example.test', password: PASSWORD, organization: 'Bureau' });
  const project = await g.store.createProject('Website', undefined, organization.id);
  const task = await g.store.createTask({ projectId: project.id, title: 'Fix the login', workflow: 'just-do', workflowVersion: '1.0.0',
    params: {} as any, createdBy: { kind: 'user', userId: user.id } });
  const { page, errors, step, context } = await openConsole(browser, { ip: '192.0.2.82' });
  await context.addInitScript(fakeDesktop);
  const desktop = 'window.__app.TavyaDesktop';
  const toggle = page.locator('#push-this-device');
  const adapter = new PushDeliveryAdapter({ store: g.store, keys: async () => { throw new Error('no web devices'); }, siteName: async () => 'tavya', desktop: sockets });
  try {
    await signIn(context, g.url, 'bea@example.test', PASSWORD);

    await step('Push to this device registers a desktop device, and the Push column shows', async () => {
      await page.goto(`${g.url}/profile#notifications`);
      await toggle.waitFor();
      expect(await page.locator('#notifications [data-notify="critical:push"]').count()).toBe(1);
      await toggle.click();
      await expect.poll(async () => (await g.store.listPushSubscriptions(user.id)).map((device) => device.kind)).toEqual(['desktop']);
      expect((await g.store.listPushSubscriptions(user.id))[0]!.label).toMatch(/^tavya on (Mac|Linux)$/);
      await expect.poll(() => toggle.isChecked()).toBe(true);
      const [device] = await g.store.listPushSubscriptions(user.id);
      await expect.poll(() => sockets.connected(device!.id)).toBe(1);
      await shot(page, 'desktop-push-settings');
    });

    await step('a push arrives over /ws as a notification that replaces by tag, and a click opens its page', async () => {
      await page.goto(`${g.url}/profile`);
      const [device] = await g.store.listPushSubscriptions(user.id);
      await expect.poll(() => sockets.connected(device!.id)).toBe(1);
      const inbox = { id: 'inbox_d1', organizationId: organization.id, userId: user.id, eventSeq: 1, taskId: task.id, kind: 'review-requested' as const,
        urgency: 'high' as const, unread: true, actionable: true, createdAt: Date.now() };
      await adapter.deliver({ inbox, task: { id: task.id, num: task.num, title: task.title, projectId: project.id } });
      await expect.poll(() => page.evaluate(`window.__app.notifications.filter((n) => n.options.tag === 'inbox_d1').length`)).toBeGreaterThan(0);
      expect(await page.evaluate(`window.__app.notifications.find((n) => n.options.tag === 'inbox_d1').title`)).toBe('Fix the login');
      await page.evaluate(`window.__app.notifications.find((n) => n.options.tag === 'inbox_d1').onclick()`);
      await expect.poll(() => new URL(page.url()).pathname).toBe(`/bureau/website/tasks/${task.num}`);
      expect(await page.evaluate(`${desktop}.calls.some(([m]) => m === 'show')`)).toBe(true);
    });

    await step('no second popup for the task already open in the focused window', async () => {
      const before = await page.evaluate(`window.__app.notifications.length`) as number;
      const inbox = { id: 'inbox_d2', organizationId: organization.id, userId: user.id, eventSeq: 2, taskId: task.id, kind: 'escalated' as const,
        urgency: 'high' as const, unread: true, actionable: true, createdAt: Date.now() };
      await page.evaluate(`window.focus()`);
      await page.bringToFront();
      await adapter.deliver({ inbox, task: { id: task.id, num: task.num, title: task.title, projectId: project.id } });
      await page.waitForTimeout(400);
      expect(await page.evaluate(`window.__app.notifications.slice(${before}).filter((n) => n.options.tag === 'inbox_d2').length`)).toBe(0);
    });

    await step('the For-me count goes to the badge', async () => {
      await g.store.appendEvent({ taskId: task.id, type: 'task.mentioned', ts: Date.now(), payload: { recipients: [`user:${user.id}`], by: 'agent:do', text: 'Look.' } });
      await page.goto(`${g.url}/bureau`);
      await expect.poll(() => page.evaluate(`${desktop}.calls.filter(([m]) => m === 'setBadge').map(([, o]) => o.count).at(-1)`), { timeout: 8000 })
        .toBeGreaterThan(0);
    });

    await step('io.tavya.app links and the tray open console pages, only on this console; ask opens Ask', async () => {
      await page.evaluate(`${desktop}.emit('open', { url: 'io.tavya.app://open?path=%2Fprofile' })`);
      await expect.poll(() => new URL(page.url()).pathname).toBe('/profile');
      await page.evaluate(`${desktop}.emit('open', { path: '/inbox' })`);
      await expect.poll(() => new URL(page.url()).pathname).toBe('/inbox');
      for (const bad of [`{ path: 'https://evil.example/x' }`, `{ path: '//evil.example/x' }`, `{ url: 'io.tavya.app://open?path=https%3A%2F%2Fevil.example' }`]) {
        await page.evaluate(`${desktop}.emit('open', ${bad})`);
        await page.waitForTimeout(150);
        expect(new URL(page.url()).origin).toBe(g.url);
        expect(new URL(page.url()).pathname).toBe('/inbox');
      }
      await page.evaluate(`${desktop}.emit('open', { ask: true })`);
      await page.locator('dialog.ask-dialog').waitFor({ timeout: 5000 });
      await page.keyboard.press('Escape');
    });

    await step('Profile → This app: Ask shortcut, open at login, version and updates', async () => {
      await page.goto(`${g.url}/profile`);
      const card = page.locator('#this-app');
      await card.waitFor();
      expect(await card.innerText()).toMatch(/Ctrl\+Alt\+Space|Control\+Alt\+Space/);
      expect(await card.innerText()).toContain('1.2.0');
      await card.locator('#app-login').click();
      await expect.poll(() => page.evaluate(`window.__app.login`)).toBe(true);
      await card.locator('#app-hotkey').click();
      await page.keyboard.press('Control+Shift+K');
      await expect.poll(() => page.evaluate(`window.__app.hotkey.accelerator`)).toBe('Control+Shift+K');
      await card.locator('#app-update-check').click();
      await expect.poll(() => page.evaluate(`${desktop}.calls.some(([m]) => m === 'checkForUpdates')`)).toBe(true);
      await page.evaluate(`${desktop}.emit('updateStatus', { state: 'ready', version: '1.3.0', current: '1.2.0' })`);
      await card.locator('#app-update-install').waitFor();
      await shot(page, 'desktop-this-app');
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 120_000);
