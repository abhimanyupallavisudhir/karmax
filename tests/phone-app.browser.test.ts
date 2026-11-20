// The console inside the phone apps (wiki features/phone-apps), against a real
// hosted gateway: window.Capacitor and its plugins are stand-ins driven by the
// test, as the Android WebView would expose them. Signed out, the app offers
// one Sign in that runs in the system browser and comes back signed in; the
// mic uses the platform's recognizer although the WebView has none; "Push to
// this device" registers the phone's FCM token, only once the installation
// has a Firebase key; a tapped notification opens its page.
// Screens: KARMAX_SHOTS=<dir> npx vitest run tests/phone-app.browser.test.ts
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { NativePush } from '../src/collaboration/native-push.js';
import { vaultVapidKeys } from '../src/collaboration/push-delivery.js';
import { consoleRequest, hostedGateway, launchChromium, openConsole, signIn, type HostedGateway } from './helpers/browser.js';

let browser: Browser, g: HostedGateway, nativePush: NativePush;
const PASSWORD = 'correct horse battery staple 42';
const PHONE = { width: 390, height: 844 };
const SHOTS = process.env.KARMAX_SHOTS;
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};
const firebaseKey = JSON.stringify({ type: 'service_account', project_id: 'tavya-push', client_email: 'push@tavya-push.iam.gserviceaccount.com',
  private_key: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });

/** The app's native side as the page sees it (runs in the page, so untyped). */
function fakeApp() {
  const w = globalThis as any;
  // The Android WebView has no speech recognition of its own.
  Object.defineProperty(w, 'SpeechRecognition', { value: undefined, configurable: true });
  Object.defineProperty(w, 'webkitSpeechRecognition', { value: undefined, configurable: true });
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
  // The phone remembers a notification permission across app starts.
  const remembered = (() => { try { return localStorage.getItem('fake-push-permission'); } catch { return null; } })();
  w.__app = { speechPermission: 'prompt', pushPermission: remembered || 'prompt' };
  const setPush = (value: string) => { w.__app.pushPermission = value; try { localStorage.setItem('fake-push-permission', value); } catch {} return value; };
  const Plugins = {
    SpeechRecognition: plugin('SpeechRecognition', {
      checkPermissions: () => ({ speechRecognition: w.__app.speechPermission }),
      requestPermissions: () => ({ speechRecognition: w.__app.speechPermission = w.__app.speechAnswer ?? 'granted' }),
      start: () => undefined,
      stop: (_options: unknown, self: any) => { self.emit('listeningState', { status: 'stopped' }); },
    }),
    PushNotifications: plugin('PushNotifications', {
      checkPermissions: () => ({ receive: w.__app.pushPermission }),
      requestPermissions: () => ({ receive: setPush('granted') }),
      register: (_options: unknown, self: any) => { setTimeout(() => self.emit('registration', { value: w.__app.fcmToken }), 10); },
      unregister: () => undefined,
    }),
    // The system browser: the test plays it (window.__systemBrowser, exposed from Node).
    TavyaSignIn: plugin('TavyaSignIn', { open: async ({ url }: { url: string }) => ({ url: await w.__systemBrowser(url) }) }),
  };
  w.__app.fcmToken = 'fcm-token-of-this-phone-0123456789:APA91b';
  w.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', isPluginAvailable: (name: string) => name in Plugins, Plugins };
}

beforeAll(async () => {
  browser = await launchChromium();
  g = await hostedGateway(({ broker }) => {
    nativePush = new NativePush({ broker, fetcher: (async () => Response.json({ access_token: 'ya29.t', expires_in: 3600 })) as unknown as typeof fetch });
    return { hostLocal: true, pushKeys: vaultVapidKeys(broker), nativePush, deliveryChannels: ['browser', 'push'] };
  });
}, 60_000);
afterAll(async () => { await g?.close(); await browser?.close(); });

it('signs the app in through the system browser and lists the phone in Apps and tokens', async () => {
  const { user } = await g.owner({ name: 'Ada', email: 'ada@example.test', password: PASSWORD, organization: 'Acme' });
  // The system browser, already signed in to tavya: authorize → consent → Allow → back to the app.
  const signedIn = await fetch(`${g.url}/api/auth/sign-in/email`, { method: 'POST', headers: { origin: g.url, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'ada@example.test', password: PASSWORD }) });
  const browserCookie = signedIn.headers.get('set-cookie')!.match(/better-auth\.session_token=[^;]+/)![0];
  const visited: string[] = [];
  const { page, errors, step, context } = await openConsole(browser, { ip: '192.0.2.91', viewport: PHONE });
  await context.exposeFunction('__systemBrowser', async (url: string) => {
    visited.push(url);
    const authorize = await fetch(url, { redirect: 'manual' });
    const request = new URL(authorize.headers.get('location')!, g.url).searchParams.get('request')!;
    const approved = await fetch(`${g.url}/api/oauth/authorizations/${request}/approve`, { method: 'POST',
      headers: { origin: g.url, cookie: browserCookie, 'content-type': 'application/json' }, body: '{}' });
    return ((await approved.json()) as { redirectUri: string }).redirectUri;
  });
  await context.addInitScript(fakeApp);
  try {
    await step('signed out, the app shows one Sign in, not the website\'s landing page', async () => {
      await page.goto(g.url);
      await page.locator('#app-sign-in').waitFor();
      expect(await page.locator('.lp, #landing, .auth-forms').count()).toBe(0);
      await shot(page, 'app-sign-in');
    });

    await step('Sign in runs in the system browser with PKCE and comes back signed in', async () => {
      await page.locator('#app-sign-in').click();
      await page.locator('.rail, .mobile-bar').first().waitFor();
      const asked = new URL(visited[0]!);
      expect(asked.pathname).toBe('/oauth/authorize');
      expect(Object.fromEntries(asked.searchParams)).toMatchObject({ client_id: 'tavya-app', redirect_uri: 'io.tavya.app://signed-in',
        response_type: 'code', code_challenge_method: 'S256' });
      expect(asked.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const session = await (await context.request.get(`${g.url}/api/session`)).json();
      expect(session).toMatchObject({ authenticated: true });
    });

    await step('Profile → Apps and tokens lists this phone, revocable', async () => {
      await page.goto(`${g.url}/profile`);
      const row = page.locator('.app-grant-row', { hasText: 'tavya on Android' });
      await row.waitFor();
      expect(await row.innerText()).toMatch(/Phone[\s\S]*This one/);
      expect(await row.getByRole('button', { name: 'Revoke' }).count()).toBe(1);
    });

    await step('revoked from the laptop, the app is signed out', async () => {
      const grants = await (await fetch(`${g.url}/api/user/app-grants`, { headers: { cookie: browserCookie } })).json() as any;
      const phone = grants.grants.find((grant: any) => grant.kind === 'app');
      expect((await fetch(`${g.url}/api/user/app-grants/${phone.id}`, { method: 'DELETE', headers: { origin: g.url, cookie: browserCookie } })).status).toBe(200);
      await page.reload();
      await page.locator('#app-sign-in').waitFor();
    });
    expect(errors).toEqual([]);
    expect(user.id).toBeTruthy();
  } finally {
    await context.close();
  }
}, 120_000);

it('dictates with the platform\'s recognizer in the app, same mic and shortcut', async () => {
  const { organization } = await g.owner({ name: 'Bea', email: 'bea@example.test', password: PASSWORD, organization: 'Bureau' });
  const { page, errors, step, context } = await openConsole(browser, { ip: '192.0.2.92', viewport: PHONE });
  await context.addInitScript(fakeApp);
  try {
    await signIn(context, g.url, 'bea@example.test', PASSWORD);
    await consoleRequest(context, g.url, 'POST', `/api/organizations/${organization.id}/projects`, { name: 'Website' });
    const prompt = page.locator('#tf-body textarea[data-field="prompt"]');
    const mic = page.locator('#tf-body [data-mic="prompt"]');
    const speech = 'window.__app.SpeechRecognition';

    await step('the mic is there although the WebView has no speech recognition', async () => {
      await page.goto(`${g.url}/bureau/website`);
      await page.locator('#expand-task').click();
      await mic.waitFor();
      expect(await mic.getAttribute('aria-label')).toBe('Dictate');
    });

    await step('it asks for permission once, then interim words fill the field', async () => {
      await prompt.click();
      await page.keyboard.type('Fix');
      await mic.click();
      await expect.poll(() => page.evaluate(`${speech}.calls.filter(([m]) => m === 'start').length`)).toBe(1);
      expect(await page.evaluate(`${speech}.calls.find(([m]) => m === 'start')[1]`)).toMatchObject({ partialResults: true, popup: false });
      expect(await page.evaluate(`${speech}.calls.filter(([m]) => m === 'requestPermissions').length`)).toBe(1);
      expect(await mic.getAttribute('aria-pressed')).toBe('true');
      await page.evaluate(`${speech}.emit('partialResults', { matches: ['the log'] })`);
      expect(await prompt.inputValue()).toBe('Fix the log');
      await page.evaluate(`${speech}.emit('partialResults', { matches: ['the login page'] })`);
      expect(await prompt.inputValue()).toBe('Fix the login page');
      await shot(page, 'app-dictation');
    });

    await step('the recognizer ending at a pause does not end dictation: it listens again, after what was heard', async () => {
      await page.evaluate(`${speech}.emit('listeningState', { status: 'stopped' })`);
      await expect.poll(() => page.evaluate(`${speech}.calls.filter(([m]) => m === 'start').length`)).toBe(2);
      expect(await mic.getAttribute('aria-pressed')).toBe('true');
      await page.evaluate(`${speech}.emit('partialResults', { matches: ['today'] })`);
      expect(await prompt.inputValue()).toBe('Fix the login page today');
      // A pause longer than the old 2 s cut-off keeps listening.
      await page.waitForTimeout(2_500);
      expect(await mic.getAttribute('aria-pressed')).toBe('true');
      await mic.click();
      await expect.poll(() => mic.getAttribute('aria-pressed')).toBe('false');
      expect(await prompt.inputValue()).toBe('Fix the login page today');
    });

    await step('⌘/Ctrl+⇧S starts and stops it; the native recognizer stops too', async () => {
      await prompt.focus();
      await page.keyboard.press('Control+Shift+S');
      await expect.poll(() => mic.getAttribute('aria-pressed')).toBe('true');
      const stops = await page.evaluate(`${speech}.calls.filter(([m]) => m === 'stop').length`) as number;
      await page.keyboard.press('Control+Shift+S');
      expect(await mic.getAttribute('aria-pressed')).toBe('false');
      expect(await page.evaluate(`${speech}.calls.filter(([m]) => m === 'stop').length`)).toBe(stops + 1);
    });

    await step('a refused microphone says where to allow it', async () => {
      await page.evaluate(`window.__app.speechPermission = 'denied'; window.__app.speechAnswer = 'denied'`);
      await mic.click();
      await page.locator('.toast', { hasText: 'in your phone’s settings to dictate' }).waitFor();
      await expect.poll(() => mic.getAttribute('aria-pressed')).toBe('false');
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 120_000);

it('turns native push on for the phone once the installation can send it, and opens a tapped notification', async () => {
  const { user } = await g.owner({ name: 'Cy', email: 'cy@example.test', password: PASSWORD, organization: 'Cyan' });
  const { page, errors, step, context } = await openConsole(browser, { ip: '192.0.2.93', viewport: PHONE });
  await context.addInitScript(fakeApp);
  const push = 'window.__app.PushNotifications';
  const toggle = page.locator('#push-this-device');
  try {
    await signIn(context, g.url, 'cy@example.test', PASSWORD);

    await step('without the installation\'s Firebase key: no device switch and no Push column', async () => {
      await page.goto(`${g.url}/profile#notifications`);
      await page.locator('#notifications [data-notify="critical:email"]').waitFor();
      expect(await toggle.count()).toBe(0);
      expect(await page.locator('#notifications [data-notify="critical:push"]').count()).toBe(0);
    });

    await nativePush.configure(firebaseKey);

    await step('with it: the switch, off, asking nothing yet', async () => {
      await page.reload();
      await toggle.waitFor();
      expect(await toggle.isChecked()).toBe(false);
      expect(await page.locator('#notifications [data-notify="critical:push"]').count()).toBe(1);
      expect(await page.evaluate(`${push}.calls.filter(([m]) => m === 'requestPermissions').length`)).toBe(0);
    });

    await step('switching it on asks the phone, registers with FCM and sends the server its token', async () => {
      await toggle.click();
      await expect.poll(async () => (await g.store.listPushSubscriptions(user.id)).length).toBe(1);
      expect((await g.store.listPushSubscriptions(user.id))[0]).toMatchObject({ kind: 'fcm', platform: 'android',
        token: 'fcm-token-of-this-phone-0123456789:APA91b', label: 'tavya on Android' });
      await expect.poll(() => toggle.isChecked()).toBe(true);
      await shot(page, 'app-push-settings');
    });

    await step('a rotated token replaces the old one when the app starts again', async () => {
      await context.addInitScript(() => { (globalThis as any).__app.fcmToken = 'rotated-fcm-token-0123456789:APA91b'; });
      await page.reload();
      await expect.poll(async () => (await g.store.listPushSubscriptions(user.id)).map((device) => device.kind === 'fcm' && device.token))
        .toEqual(['rotated-fcm-token-0123456789:APA91b']);
    });

    await step('a tapped notification opens its page in the app', async () => {
      await page.evaluate(`${push}.emit('pushNotificationActionPerformed', { actionId: 'tap', notification: { data: { url: '/inbox' } } })`);
      await expect.poll(() => new URL(page.url()).pathname).toBe('/inbox');
      // Only this console's own pages.
      await page.evaluate(`${push}.emit('pushNotificationActionPerformed', { actionId: 'tap', notification: { data: { url: 'https://evil.example/x' } } })`);
      await page.waitForTimeout(300);
      expect(new URL(page.url()).origin).toBe(g.url);
    });

    await step('switching it off forgets the phone and unregisters it', async () => {
      await page.goto(`${g.url}/profile#notifications`);
      await toggle.waitFor();
      await expect.poll(() => toggle.isChecked()).toBe(true);
      await toggle.click();
      await expect.poll(async () => (await g.store.listPushSubscriptions(user.id)).length).toBe(0);
      await expect.poll(() => page.evaluate(`${push}.calls.some(([m]) => m === 'unregister')`)).toBe(true);
      await expect.poll(() => toggle.isChecked()).toBe(false);
    });

    await step('notifications turned off in the phone\'s settings: the switch says where to turn them on', async () => {
      await page.evaluate(`localStorage.setItem('fake-push-permission', 'denied')`);
      await page.reload();
      await toggle.waitFor();
      expect(await toggle.isDisabled()).toBe(true);
      expect(await toggle.getAttribute('title')).toMatch(/in this phone’s settings/);
    });
    expect(errors).toEqual([]);
  } finally {
    await nativePush.remove();
    await context.close();
  }
}, 120_000);
