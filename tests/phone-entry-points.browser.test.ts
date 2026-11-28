// The phones' OS entry points (wiki features/phone-apps § Entry points), as the
// console inside the app sees them, against a real hosted gateway. The shell
// turns Share to tavya, Siri, the assistant gesture, the Quick Settings tile,
// the widget and verified links into links that Capacitor's App plugin hands
// the page (keeping them until it listens), plus the TavyaPhone plugin for the
// shared items and what the phone shows outside the app. Both are stand-ins
// here, driven by the test, as the Android WebView would expose them.
// Screens: KARMAX_SHOTS=<dir> npx vitest run tests/phone-entry-points.browser.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
import { consoleRequest, hostedGateway, launchChromium, openConsole, signIn, type HostedGateway } from './helpers/browser.js';

let browser: Browser, g: HostedGateway;
const PASSWORD = 'correct horse battery staple 42';
const PHONE = { width: 390, height: 844 };
const SHOTS = process.env.KARMAX_SHOTS;
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

/** The app's native side as the page sees it (runs in the page, so untyped). */
function fakeApp() {
  const w = globalThis as any;
  Object.defineProperty(w, 'SpeechRecognition', { value: undefined, configurable: true });
  Object.defineProperty(w, 'webkitSpeechRecognition', { value: undefined, configurable: true });
  const plugin = (name: string, methods: Record<string, (...args: any[]) => any>, retains: string[] = []) => {
    const listeners: Record<string, Array<(data: any) => void>> = {};
    const retained: Record<string, any[]> = {};
    const calls: Array<[string, any]> = [];
    const self: any = { calls, listeners,
      // Capacitor's retainUntilConsumed: an event nobody listens to yet waits for the first listener.
      emit: (event: string, data: any) => {
        if (!(listeners[event] ?? []).length && retains.includes(event)) { (retained[event] ??= []).push(data); return; }
        for (const listener of (listeners[event] ?? []).slice()) listener(data);
      },
      addListener: async (event: string, listener: (data: any) => void) => {
        (listeners[event] ??= []).push(listener);
        for (const data of retained[event]?.splice(0) ?? []) setTimeout(() => listener(data), 0);
        return { remove: async () => { listeners[event] = (listeners[event] ?? []).filter((entry) => entry !== listener); } };
      } };
    for (const [method, run] of Object.entries(methods))
      self[method] = async (options?: any) => { calls.push([method, options]); return run(options, self); };
    w.__app[name] = self;
    return self;
  };
  // What a share left in the shell (the test sets w.__app.share before firing the link).
  const bytesOf = (text: string) => new TextEncoder().encode(text);
  const base64 = (bytes: Uint8Array) => { let text = ''; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text); };
  // A phone without the assistant role (iOS) is remembered across a reload.
  const noRole = (() => { try { return localStorage.getItem('fake-no-assistant-role') === '1'; } catch { return false; } })();
  w.__app = { share: null, assistant: { available: !noRole, held: false } };
  const Plugins = {
    App: plugin('App', {}, ['appUrlOpen']),
    SpeechRecognition: plugin('SpeechRecognition', {
      checkPermissions: () => ({ speechRecognition: 'granted' }),
      requestPermissions: () => ({ speechRecognition: 'granted' }),
      start: () => undefined,
      stop: (_options: unknown, self: any) => { self.emit('listeningState', { status: 'stopped' }); },
    }),
    TavyaPhone: plugin('TavyaPhone', {
      takeShare: () => ({ share: w.__app.share ? { id: w.__app.share.id, text: w.__app.share.text,
        files: w.__app.share.files.map((file: any) => ({ name: file.name, type: file.type, size: bytesOf(file.content).length })) } : null }),
      readShareFile: ({ index, offset, length }: any) => {
        const bytes = bytesOf(w.__app.share.files[index].content);
        const chunk = bytes.slice(offset, offset + length);
        return { data: base64(chunk), eof: offset + chunk.length >= bytes.length };
      },
      finishShare: () => { w.__app.share = null; },
      setContext: () => undefined,
      assistant: () => w.__app.assistant,
      openAssistantSettings: () => undefined,
    }),
    // The system browser: the test plays it (window.__systemBrowser, exposed from Node).
    TavyaSignIn: plugin('TavyaSignIn', { open: async ({ url }: { url: string }) => ({ url: await w.__systemBrowser(url) }),
      saveDeviceToken: () => undefined, clearDeviceToken: () => undefined }),
  };
  w.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', isPluginAvailable: (name: string) => name in Plugins, Plugins };
}

const calls = (page: Page, plugin: string, method: string) =>
  page.evaluate(([p, m]) => (window as any).__app[p].calls.filter(([name]: [string]) => name === m).map(([, options]: [string, any]) => options), [plugin, method]);
const fire = (page: Page, url: string) => page.evaluate((link) => (window as any).__app.App.emit('appUrlOpen', { url: link }), url);
const share = (page: Page, value: unknown) => page.evaluate((v) => { (window as any).__app.share = v; }, value);

/** The system browser, already signed in to tavya: authorize → consent → Allow → back to the app. */
async function systemBrowser(context: BrowserContext, email: string) {
  const signedIn = await fetch(`${g.url}/api/auth/sign-in/email`, { method: 'POST', headers: { origin: g.url, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }) });
  const cookie = signedIn.headers.get('set-cookie')!.match(/better-auth\.session_token=[^;]+/)![0];
  await context.exposeFunction('__systemBrowser', async (url: string) => {
    const authorize = await fetch(url, { redirect: 'manual' });
    const request = new URL(authorize.headers.get('location')!, g.url).searchParams.get('request')!;
    const approved = await fetch(`${g.url}/api/oauth/authorizations/${request}/approve`, { method: 'POST',
      headers: { origin: g.url, cookie, 'content-type': 'application/json' }, body: '{}' });
    return ((await approved.json()) as { redirectUri: string }).redirectUri;
  });
}

beforeAll(async () => {
  browser = await launchChromium();
  g = await hostedGateway(() => ({ hostLocal: true }));
}, 60_000);
afterAll(async () => { await g?.close(); await browser?.close(); });

it('Share to tavya: signed out, it waits for the sign-in, then opens the new task form with the text and the files attached', async () => {
  const { organization } = await g.owner({ name: 'Ada', email: 'ada@example.test', password: PASSWORD, organization: 'Acme' });
  const { page, errors, step, context } = await openConsole(browser, { ip: '192.0.2.81', viewport: PHONE });
  await systemBrowser(context, 'ada@example.test');
  await context.addInitScript(fakeApp);
  try {
    await step('a share arrives while the app is signed out: it shows Sign in, nothing else', async () => {
      await page.goto(g.url);
      await page.locator('#app-sign-in').waitFor();
      await share(page, { id: 'share-1', text: 'Look at this bug https://example.com/issue/7',
        files: [{ name: 'notes.txt', type: 'text/plain', content: 'line one\nline two\n'.repeat(40_000) }] });
      await fire(page, 'io.tavya.app://share');
      await page.waitForTimeout(300);
      expect(await page.locator('#tf-page').count()).toBe(0);
    });

    await step('after signing in, the form opens in the project, prompt filled, the file uploaded as an attachment', async () => {
      // A project to put it in, made from the laptop meanwhile.
      const cookie = (await (await fetch(`${g.url}/api/auth/sign-in/email`, { method: 'POST', headers: { origin: g.url, 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'ada@example.test', password: PASSWORD }) })).headers.get('set-cookie'))!.match(/better-auth\.session_token=[^;]+/)![0];
      const made = await fetch(`${g.url}/api/organizations/${organization.id}/projects`, { method: 'POST',
        headers: { origin: g.url, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Website' }) });
      expect(made.status).toBe(200);
      await page.locator('#app-sign-in').click();
      await page.locator('#tf-page').waitFor();
      expect(await page.locator('#tf-body textarea[data-field="prompt"]').inputValue()).toBe('Look at this bug https://example.com/issue/7');
      await page.locator('#tf-chips .file-chip', { hasText: 'notes.txt' }).waitFor();
      await expect.poll(() => page.locator('#tf-chips .file-chip[data-upload]').count()).toBe(0);
      // Read in chunks across the bridge (the file is ~700 KB), then let go of.
      expect((await calls(page, 'TavyaPhone', 'readShareFile')).length).toBeGreaterThan(1);
      expect(await calls(page, 'TavyaPhone', 'finishShare')).toEqual([{ id: 'share-1' }]);
      expect(await page.locator('#tf-add-to-task').isVisible()).toBe(true);
      await shot(page, 'share-new-task');
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 120_000);

it('Share to tavya → Add to task…: a recent task’s message box gets the text and the files, and the draft goes', async () => {
  const { organization, user } = await g.owner({ name: 'Bea', email: 'bea@example.test', password: PASSWORD, organization: 'Bureau' });
  const { page, errors, step, context } = await openConsole(browser, { ip: '192.0.2.82', viewport: PHONE });
  await context.addInitScript(fakeApp);
  try {
    await signIn(context, g.url, 'bea@example.test', PASSWORD);
    const project = await consoleRequest(context, g.url, 'POST', `/api/organizations/${organization.id}/projects`, { name: 'Website' });
    const task = await g.store.createTask({ projectId: project.id, title: 'Fix the login page', workflow: 'software-dev', workflowVersion: '1',
      params: { prompt: 'Fix the login page' }, createdBy: { kind: 'user', userId: user.id } });
    await g.store.saveView(task.id, { taskId: task.id, title: 'Fix the login page', stage: 'do', status: 'active',
      messages: [{ id: 'm1', role: 'user', ts: Date.now(), text: 'Fix the login page' }], state: {}, prs: [],
      actions: [{ name: 'followUp', label: 'Send', enabled: true }] } as never);
    await page.goto(`${g.url}/bureau/website`);
    await page.locator('.rail, .mobile-bar').first().waitFor();

    await step('the share opens the form; Add to task… lists recent tasks', async () => {
      await share(page, { id: 'share-2', text: 'The error from the screenshot', files: [{ name: 'log.txt', type: 'text/plain', content: 'Error: 500' }] });
      await fire(page, 'io.tavya.app://share');
      await page.locator('#tf-add-to-task').waitFor();
      await page.locator('#tf-chips .file-chip', { hasText: 'log.txt' }).waitFor();
      await expect.poll(() => page.locator('#tf-chips .file-chip[data-upload]').count()).toBe(0);
      await page.locator('#tf-add-to-task').click();
      await page.locator('.opt', { hasText: 'Fix the login page' }).waitFor();
      await shot(page, 'share-add-to-task');
    });

    await step('choosing one opens it with the message box filled, ready to send; no draft is left behind', async () => {
      await page.locator('.opt', { hasText: 'Fix the login page' }).click();
      await page.waitForURL(new RegExp(`/tasks/${task.num}`));
      const input = page.locator('.followup-box .followup-input');
      await expect.poll(() => input.inputValue()).toBe('The error from the screenshot');
      await page.locator('.followup-box .file-chip', { hasText: 'log.txt' }).waitFor();
      await expect.poll(() => page.locator('.followup-box .file-chip[data-upload]').count()).toBe(0);
      // The form's auto-saved draft (it held the attachment) is gone.
      const drafts = (await g.store.listTasks(project.id)).filter((t) => String(t.params?.prompt ?? '').includes('The error from the screenshot'));
      expect(drafts).toEqual([]);
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 120_000);

it('Siri, the assistant gesture, the tile and the widget open Ask (listening), a new task, For me or a verified link', async () => {
  const { organization } = await g.owner({ name: 'Cy', email: 'cy@example.test', password: PASSWORD, organization: 'Studio' });
  const { page, errors, step, context } = await openConsole(browser, { ip: '192.0.2.83', viewport: PHONE });
  await context.addInitScript(fakeApp);
  try {
    await signIn(context, g.url, 'cy@example.test', PASSWORD);
    await consoleRequest(context, g.url, 'POST', `/api/organizations/${organization.id}/projects`, { name: 'Website' });
    await page.goto(`${g.url}/studio/website`);
    await page.locator('.rail, .mobile-bar').first().waitFor();

    await step('io.tavya.app://ask?voice=1 opens Ask with dictation already listening', async () => {
      await fire(page, 'io.tavya.app://ask?voice=1');
      await page.locator('dialog.ask-dialog[open]').waitFor();
      await expect.poll(async () => (await calls(page, 'SpeechRecognition', 'start')).length).toBe(1);
      expect(await page.locator('dialog.ask-dialog [data-mic="ask"]').getAttribute('aria-pressed')).toBe('true');
      // A second gesture while it is open keeps the one dialog.
      await fire(page, 'io.tavya.app://ask?voice=1');
      await page.waitForTimeout(200);
      expect(await page.locator('dialog.ask-dialog').count()).toBe(1);
      await shot(page, 'ask-listening');
      await page.keyboard.press('Escape');
    });

    await step('io.tavya.app://new opens the new task form', async () => {
      await fire(page, 'io.tavya.app://new');
      await page.locator('#tf-page').waitFor();
      expect(await page.locator('#tf-add-to-task').count()).toBe(0);
      await page.locator('#tf-close').click();
    });

    await step('the widget’s count opens For me; a verified https link opens its page; the sign-in callback is ignored', async () => {
      await fire(page, 'io.tavya.app://for-me');
      // The organization's home, whose default list is For me.
      await page.waitForURL((url) => url.pathname === '/studio' && !url.search);
      await fire(page, `${g.url}/studio/website`);
      await page.waitForURL(`${g.url}/studio/website`);
      await fire(page, 'io.tavya.app://signed-in?code=x&state=y');
      await fire(page, 'https://elsewhere.example/studio');
      await page.waitForTimeout(200);
      expect(page.url()).toBe(`${g.url}/studio/website`);
    });

    await step('the phone is told the organization and its For-me count (the widget, Siri)', async () => {
      await expect.poll(async () => (await calls(page, 'TavyaPhone', 'setContext')).at(-1)).toMatchObject({ organizationId: organization.id, forMe: expect.any(Number) });
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 120_000);

it('Profile → This app: whether tavya is the phone’s digital assistant, and the system setting to change it', async () => {
  await g.owner({ name: 'Di', email: 'di@example.test', password: PASSWORD, organization: 'Desk' });
  const { page, errors, step, context } = await openConsole(browser, { ip: '192.0.2.84', viewport: PHONE });
  await context.addInitScript(fakeApp);
  try {
    await signIn(context, g.url, 'di@example.test', PASSWORD);
    await step('the row says another app is the assistant; its tip says what choosing tavya replaces', async () => {
      await page.goto(`${g.url}/profile`);
      const row = page.locator('#this-app #app-assistant');
      await row.waitFor();
      expect(await row.locator('.setting-value').innerText()).toBe('Another app');
      const tip = await row.locator('.setting-label').innerHTML();
      expect(tip).toContain('replaces Google’s assistant and “Hey Google”');
      await page.locator('#app-assistant-open').click();
      expect(await calls(page, 'TavyaPhone', 'openAssistantSettings')).toHaveLength(1);
      await shot(page, 'assistant-setting');
    });

    await step('chosen in the system settings, it says so on return; a phone without the role shows no card', async () => {
      await page.evaluate(() => { (window as any).__app.assistant = { available: true, held: true }; document.dispatchEvent(new Event('visibilitychange')); });
      await expect.poll(() => page.locator('#app-assistant .setting-value').innerText()).toBe('tavya');
      await page.evaluate(() => localStorage.setItem('fake-no-assistant-role', '1'));
      await page.reload();
      await page.locator('#profile-logout, .profile').first().waitFor();
      await page.waitForTimeout(300);
      expect(await page.locator('#this-app').isHidden()).toBe(true);
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 120_000);
