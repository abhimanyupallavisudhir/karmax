// Voice input and Web Push in the console (wiki features/push-and-voice),
// against a real hosted gateway: a mic in the new-task prompt and the task's
// message box only where the browser recognises speech; dictation fills the
// field (interim words first) and stays editable; ⌘/Ctrl+⇧S toggles it. Push:
// a Push column beside Email, and "Push to this device", which asks for the
// browser's permission only when switched on and registers the device with the
// server — the browser's speech and push services are stand-ins here.
// Screens: KARMAX_SHOTS=<dir> npx vitest run tests/push-and-voice.browser.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { vaultVapidKeys } from '../src/collaboration/push-delivery.js';
import { consoleRequest, hostedGateway, launchChromium, openConsole, signIn, type HostedGateway } from './helpers/browser.js';

let browser: Browser, g: HostedGateway;
const PASSWORD = 'correct horse battery staple 42';
const SHOTS = process.env.KARMAX_SHOTS;
const shot = async (page: Page, name: string, clip?: string) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const target = path.join(SHOTS, `${name}.png`);
  if (clip) await page.locator(clip).first().screenshot({ path: target }); else await page.screenshot({ path: target });
};

/** The browser's speech recognition and push service, driven by the test. */
function fakeBrowser({ speech, push }: { speech: boolean; push: boolean }) {
  // Runs in the page (addInitScript): the page's globals, untyped here.
  const w = globalThis as any;
  if (speech) {
    w.__speech = [];
    w.SpeechRecognition = w.webkitSpeechRecognition = class {
      started = false; onresult: any; onend: any; onerror: any; lang = ''; interimResults = false; continuous = true;
      constructor() { w.__speech.push(this); }
      start() { this.started = true; }
      stop() { if (!this.started) return; this.started = false; this.onend?.(); }
      /** The browser's own end of a recognizer, at a pause in speech. */
      end(error?: string) { if (!this.started) return; if (error) this.onerror?.({ error }); this.started = false; this.onend?.(); }
      hear(parts: Array<[string, boolean]>) {
        const results = parts.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal }));
        this.onresult?.({ results });
      }
    };
  } else {
    Object.defineProperty(w, 'SpeechRecognition', { value: undefined, configurable: true });
    Object.defineProperty(w, 'webkitSpeechRecognition', { value: undefined, configurable: true });
  }
  if (!push) { Object.defineProperty(w, 'PushManager', { value: undefined, configurable: true }); return; }
  let permission = 'default';
  const state = w.__push = { asked: 0, subscription: null as any };
  Object.defineProperty(w.Notification, 'permission', { get: () => permission, configurable: true });
  w.Notification.requestPermission = async () => { state.asked++; permission = 'granted'; return 'granted'; };
  // The RFC 8291 example's browser keys: a real P-256 point the server accepts.
  const keys = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
  const registration = { pushManager: {
    getSubscription: async () => state.subscription,
    subscribe: async (options: any) => {
      state.subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/this-laptop', options,
        toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/this-laptop', expirationTime: null, keys }),
        unsubscribe: async () => { state.subscription = null; return true; } };
      return state.subscription;
    },
  } };
  Object.defineProperty(w.navigator, 'serviceWorker', { configurable: true, value: {
    getRegistration: async () => registration, register: async () => registration, ready: Promise.resolve(registration),
    addEventListener() {},
  } });
  w.PushManager = function PushManager() {};
}

beforeAll(async () => {
  browser = await launchChromium();
  g = await hostedGateway(({ broker }) => ({ pushKeys: vaultVapidKeys(broker), deliveryChannels: ['browser', 'push'] }));
}, 60_000);
afterAll(async () => { await g?.close(); await browser?.close(); });

it('dictates into the new-task prompt and the message box, editable, and hides the mic where speech is unsupported', async () => {
  const { user, organization } = await g.owner({ name: 'Ada', email: 'ada@example.test', password: PASSWORD, organization: 'Acme' });
  const { page, errors, step, context } = await openConsole(browser, { ip: '192.0.2.81', viewport: { width: 1280, height: 860 } });
  await context.addInitScript(fakeBrowser, { speech: true, push: false });
  try {
    await signIn(context, g.url, 'ada@example.test', PASSWORD);
    const project = await consoleRequest(context, g.url, 'POST', `/api/organizations/${organization.id}/projects`, { name: 'Website' });
    const prompt = page.locator('#tf-body textarea[data-field="prompt"]');
    const mic = page.locator('#tf-body [data-mic="prompt"]');
    const recognizer = (index = -1) => `window.__speech.at(${index})`;

    await step('the prompt has a mic, an icon with its tooltip', async () => {
      await page.goto(`${g.url}/acme/website`);
      await page.locator('#expand-task').click();
      await mic.waitFor();
      expect(await mic.getAttribute('aria-label')).toBe('Dictate');
      expect(await mic.getAttribute('title')).toMatch(/^Dictate \((Ctrl\+⇧S|⌘⇧S)\)$/);
      expect((await mic.innerText()).trim()).toBe('');
    });

    await step('speech fills the field where the caret is, interim words first', async () => {
      await prompt.click();
      await page.keyboard.type('Fix');
      await mic.click();
      expect(await mic.getAttribute('aria-pressed')).toBe('true');
      expect(await prompt.getAttribute('placeholder')).toBe('Listening…');
      await page.evaluate(`${recognizer()}.hear([['the log', false]])`);
      expect(await prompt.inputValue()).toBe('Fix the log');
      await shot(page, 'mic-new-task-listening', '#tf-body .prompt-field');
      await page.evaluate(`${recognizer()}.hear([['the login page', true]])`);
      expect(await prompt.inputValue()).toBe('Fix the login page');
    });

    await step('a pause does not end it: the next words follow what was heard, until the mic is tapped', async () => {
      const recognizers = await page.evaluate('window.__speech.length') as number;
      await page.evaluate(`${recognizer()}.end('no-speech')`);
      expect(await mic.getAttribute('aria-pressed')).toBe('true');
      expect(await prompt.getAttribute('placeholder')).toBe('Listening…');
      expect(await page.evaluate('window.__speech.length')).toBe(recognizers + 1);
      expect(await page.evaluate(`${recognizer()}.started`)).toBe(true);
      // A desktop browser keeps one recognizer listening across sentences; its results join.
      expect(await page.evaluate(`${recognizer()}.continuous`)).toBe(true);
      await page.evaluate(`${recognizer()}.hear([['and its', true], [' footer', false]])`);
      expect(await prompt.inputValue()).toBe('Fix the login page and its footer');
      await mic.click();
      expect(await mic.getAttribute('aria-pressed')).toBe('false');
      expect(await page.evaluate(`${recognizer()}.started`)).toBe(false);
      expect(await prompt.getAttribute('placeholder')).not.toBe('Listening…');
      expect(await prompt.inputValue()).toBe('Fix the login page and its footer');
    });

    await step('what was heard is editable and saved like typing', async () => {
      await prompt.press('End');
      await page.keyboard.type(' today');
      const draft = async () => (await g.store.listTasks(project.id)).find((task) => task.params?.draft);
      await expect.poll(async () => (await draft())?.params?.prompt, { timeout: 10_000 }).toBe('Fix the login page and its footer today');
    });

    await step('⌘/Ctrl+⇧S starts and stops dictation from the field', async () => {
      await prompt.focus();
      await page.keyboard.press('Control+Shift+S');
      expect(await mic.getAttribute('aria-pressed')).toBe('true');
      expect(await page.evaluate(`${recognizer()}.started`)).toBe(true);
      await page.keyboard.press('Control+Shift+S');
      expect(await mic.getAttribute('aria-pressed')).toBe('false');
      expect(await page.evaluate(`${recognizer()}.started`)).toBe(false);
    });

    await step('typing takes over from the mic', async () => {
      await mic.click();
      await page.evaluate(`${recognizer()}.hear([['and', false]])`);
      await page.keyboard.type('!');
      expect(await mic.getAttribute('aria-pressed')).toBe('false');
      expect(await prompt.inputValue()).toBe('Fix the login page and its footer today and!');
    });

    await step('a microphone the browser cannot use ends it, saying why', async () => {
      await mic.click();
      await page.evaluate(`${recognizer()}.end('not-allowed')`);
      await page.locator('.toast', { hasText: 'Allow the microphone for this site to dictate.' }).waitFor();
      expect(await mic.getAttribute('aria-pressed')).toBe('false');
    });

    await step('Chrome on Android, which repeats words in a continuous recognizer, gets one per sentence', async () => {
      await page.evaluate(`Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/140.0 Mobile Safari/537.36' })`);
      await prompt.fill('');
      await mic.click();
      expect(await page.evaluate(`${recognizer()}.continuous`)).toBe(false);
      await page.evaluate(`${recognizer()}.hear([['Ship it', true]]); ${recognizer()}.end()`);
      await page.evaluate(`${recognizer()}.hear([['on Friday', false]])`);
      expect(await prompt.inputValue()).toBe('Ship it on Friday');
      await mic.click();
      expect(await mic.getAttribute('aria-pressed')).toBe('false');
      await shot(page, 'mic-new-task', '#tf-body .prompt-field');
      await page.locator('#tf-close').click();
    });

    const task = await g.store.createTask({ projectId: project.id, title: 'Ship the login page', workflow: 'software-dev', workflowVersion: '1.30.0',
      params: { prompt: 'Ship the login page' }, createdBy: { kind: 'user', userId: user.id } });
    await g.store.saveView(task.id, { taskId: task.id, title: task.title, workflow: 'software-dev', stage: 'do', status: 'waiting',
      waitingFor: { kind: 'human' }, actions: [{ name: 'followUp', label: 'Send', enabled: true }], state: {}, updatedAt: 2,
      messages: [{ id: 'm0', role: 'user', text: 'Ship the login page', ts: 1 }, { id: 'a1', role: 'agent', text: 'Which provider should sign people in?', ts: 2 }],
      participants: [{ key: 'do', label: 'Agent', role: 'do', state: 'idle', messages: 1 }] } as any);

    await step('the task\'s message box has one too', async () => {
      await page.goto(`${g.url}/acme/website/tasks/${task.num}`);
      const box = page.locator('.followup-box[data-role="do"]');
      const boxMic = box.locator('[data-mic]');
      await boxMic.waitFor();
      await boxMic.click();
      await page.evaluate(`${recognizer()}.hear([['GitHub, and keep email as a fallback', false]])`);
      expect(await box.locator('.followup-input').inputValue()).toBe('GitHub, and keep email as a fallback');
      await shot(page, 'mic-message-box-listening', '.ck-compose');
      await page.evaluate(`${recognizer()}.end()`);
      expect(await boxMic.getAttribute('aria-pressed')).toBe('true');
      // Sending takes what the box shows and ends dictation: nothing more is written into the emptied box.
      const listening = await page.evaluate('window.__speech.length') as number;
      await box.locator('.followup-send').click();
      await expect.poll(() => boxMic.getAttribute('aria-pressed')).toBe('false');
      expect(await page.evaluate(`${recognizer()}.started`)).toBe(false);
      await page.evaluate(`${recognizer()}.hear([['late words', false]])`);
      expect(await box.locator('.followup-input').inputValue()).not.toContain('late words');
      expect(await page.evaluate('window.__speech.length')).toBe(listening);
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }

  const plain = await openConsole(browser, { ip: '192.0.2.82', viewport: { width: 1280, height: 860 } });
  await plain.context.addInitScript(fakeBrowser, { speech: false, push: false });
  try {
    await signIn(plain.context, g.url, 'ada@example.test', PASSWORD);
    await plain.step('no mic where the browser cannot recognise speech', async () => {
      await plain.page.goto(`${g.url}/acme/website`);
      await plain.page.locator('#expand-task').click();
      await plain.page.locator('#tf-body textarea[data-field="prompt"]').waitFor();
      expect(await plain.page.locator('[data-mic]').count()).toBe(0);
      const task = (await g.store.listTasks((await g.store.listProjects()).find((p) => p.name === 'Website')!.id))
        .find((entry) => entry.title === 'Ship the login page')!;
      await plain.page.goto(`${g.url}/acme/website/tasks/${task.num}`);
      await plain.page.locator('.followup-box[data-role="do"] .followup-input').waitFor();
      expect(await plain.page.locator('[data-mic]').count()).toBe(0);
    });
    expect(plain.errors).toEqual([]);
  } finally {
    await plain.context.close();
  }
}, 120_000);

it('turns push on for this device from the notification settings, asking permission only then', async () => {
  const { user, organization } = await g.owner({ name: 'Bea', email: 'bea@example.test', password: PASSWORD, organization: 'Bureau' });
  const { page, errors, step, context } = await openConsole(browser, { ip: '192.0.2.83', viewport: { width: 1280, height: 900 } });
  await context.addInitScript(fakeBrowser, { speech: true, push: true });
  try {
    await signIn(context, g.url, 'bea@example.test', PASSWORD);
    // Her phone already has push on.
    const phone = await g.store.savePushSubscription(user.id, { endpoint: 'https://fcm.googleapis.com/fcm/send/bea-phone',
      keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
      label: 'Chrome on Android' });
    const toggle = page.locator('#push-this-device');
    const card = page.locator('#notifications');

    await step('a Push column beside Email, and the device switch, off', async () => {
      await page.goto(`${g.url}/profile#notifications`);
      await toggle.waitFor();
      expect(await toggle.isChecked()).toBe(false);
      const heads = await card.locator('.notify-head > span').allInnerTexts();
      expect(heads.map((text) => text.split('\n')[0]!.trim()).slice(4, 6)).toEqual(['Email', 'Push']);
      // The person's defaults: high and critical are pushed.
      await expect.poll(() => card.locator('[data-notify="critical:push"]').isChecked()).toBe(true);
      expect(await card.locator('[data-notify="normal:push"]').isChecked()).toBe(false);
      expect(await page.evaluate('window.__push.asked')).toBe(0);
    });

    await step('switching it on asks the browser, subscribes, and registers the device', async () => {
      await toggle.click();
      await expect.poll(async () => (await g.store.listPushSubscriptions(user.id)).length).toBe(2);
      expect(await page.evaluate('window.__push.asked')).toBe(1);
      const device = (await g.store.listPushSubscriptions(user.id)).find((entry) => entry.id !== phone.id);
      expect(device).toMatchObject({ endpoint: 'https://fcm.googleapis.com/fcm/send/this-laptop', label: expect.stringMatching(/ on |Chrome|Browser/) });
      // Subscribed with the installation's VAPID key.
      const applicationServerKey = await page.evaluate('btoa(String.fromCharCode(...window.__push.subscription.options.applicationServerKey)).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "")');
      expect(applicationServerKey).toBe((await vaultVapidKeys(g.broker)()).publicKey);
      await expect.poll(() => toggle.isChecked()).toBe(true);
    });

    await step('the Push column saves per level', async () => {
      await card.locator('[data-notify="normal:push"]').check();
      await expect.poll(async () => (await g.store.getDeliveryPreferences(user.id, organization.id)).pushUrgencies?.normal).toBe(true);
      // Her other devices are listed under this one, each removable.
      await expect.poll(() => card.locator('.push-device .setting-label').allInnerTexts()).toEqual(['Chrome on Android']);
      await shot(page, 'push-settings', '#notifications');
    });

    await step('another device can be removed from here', async () => {
      await card.getByRole('button', { name: 'Stop push to Chrome on Android' }).click();
      await expect.poll(async () => (await g.store.listPushSubscriptions(user.id)).map((entry) => entry.id)).not.toContain(phone.id);
      await expect.poll(() => card.locator('.push-device').count()).toBe(0);
    });

    await step('switching it off forgets the device', async () => {
      await toggle.click();
      await expect.poll(async () => (await g.store.listPushSubscriptions(user.id)).length).toBe(0);
      await expect.poll(() => page.evaluate('window.__push.subscription')).toBeNull();
      await expect.poll(() => toggle.isChecked()).toBe(false);
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }

  const plain = await openConsole(browser, { ip: '192.0.2.84', viewport: { width: 1280, height: 900 } });
  await plain.context.addInitScript(fakeBrowser, { speech: false, push: false });
  try {
    await signIn(plain.context, g.url, 'bea@example.test', PASSWORD);
    await plain.step('no device switch where the browser cannot receive push; the column stays', async () => {
      await plain.page.goto(`${g.url}/profile#notifications`);
      await plain.page.locator('#notifications [data-notify="critical:push"]').waitFor();
      expect(await plain.page.locator('#push-this-device').count()).toBe(0);
    });
    expect(plain.errors).toEqual([]);
  } finally {
    await plain.context.close();
  }
}, 120_000);
