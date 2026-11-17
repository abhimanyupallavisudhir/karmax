// Store screenshots of the console in the phone apps (wiki features/phone-apps):
// a phone-sized viewport at 3× (1290×2796, the App Store's 6.9" size, accepted
// by Google Play), the app's native side stood in as in phone-app.browser.
// Runs only when asked:
//   KARMAX_SHOTS=mobile/store/screenshots npx vitest run tests/phone-app-screens.browser.test.ts
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { consoleRequest, hostedGateway, launchChromium, signIn, type HostedGateway } from './helpers/browser.js';

const SHOTS = process.env.KARMAX_SHOTS;
const PASSWORD = 'correct horse battery staple 42';
let browser: Browser, g: HostedGateway;

function fakeApp() {
  const w = globalThis as any;
  Object.defineProperty(w, 'webkitSpeechRecognition', { value: undefined, configurable: true });
  const plugin = () => ({ addListener: async () => ({ remove: async () => {} }), checkPermissions: async () => ({ speechRecognition: 'granted', receive: 'granted' }),
    requestPermissions: async () => ({}), start: async () => {}, stop: async () => {}, register: async () => {}, unregister: async () => {} });
  const Plugins = { SpeechRecognition: plugin(), PushNotifications: plugin(), TavyaSignIn: plugin() };
  w.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', isPluginAvailable: (name: string) => name in Plugins, Plugins };
}

beforeAll(async () => {
  if (!SHOTS) return;
  browser = await launchChromium();
  g = await hostedGateway(() => ({ hostLocal: true }));
}, 60_000);
afterAll(async () => { await g?.close(); await browser?.close(); });

it.skipIf(!SHOTS)('shoots the store screenshots', async () => {
  const { user, organization } = await g.owner({ name: 'Ada Park', email: 'ada@example.test', password: PASSWORD, organization: 'Northwind' });
  // Production's look: its brand icon.
  await g.store.setSettings('global', 'appearance', { icon: 'royal-gold-arrow' });
  const context = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    serviceWorkers: 'block', colorScheme: 'light' });
  await context.addInitScript(fakeApp);
  const page = await context.newPage();
  // A demo organization as a reviewer would see it: address confirmed, agents and computers set up.
  await page.route('**/api/session', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), emailDelivery: false } });
  });
  await page.route('**/api/projects/*/readiness?*', (route) => route.fulfill({ json: {} }));
  const shot = async (name: string) => {
    fs.mkdirSync(SHOTS!, { recursive: true });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOTS!, `${name}.png`) });
  };
  try {
    await signIn(context, g.url, 'ada@example.test', PASSWORD);
    const project = await consoleRequest(context, g.url, 'POST', `/api/organizations/${organization.id}/projects`, { name: 'Storefront' });
    const tasks: Array<[string, string, string, string]> = [
      ['Add Apple Pay to checkout', 'do', 'active', ''],
      ['Which analytics provider should we use?', 'do', 'waiting', 'human'],
      ['Fix the flaky cart test', 'review', 'waiting', 'human'],
      ['Renew the TLS certificate', 'done', 'done', ''],
      ['Translate the help pages into Spanish', 'do', 'active', ''],
      ['Compare three email providers', 'done', 'done', ''],
    ];
    let question = '';
    for (const [title, stage, status, waiting] of tasks) {
      const task = await g.store.createTask({ projectId: project.id, title, workflow: 'software-dev', workflowVersion: '1.30.0',
        params: { prompt: title }, createdBy: { kind: 'user', userId: user.id } });
      const asking = title.startsWith('Which');
      if (asking) question = String(task.num);
      await g.store.saveView(task.id, { taskId: task.id, title, workflow: 'software-dev', stage, status,
        ...(waiting ? { waitingFor: { kind: waiting } } : {}), actions: [{ name: 'followUp', label: 'Send', enabled: true }], state: {}, updatedAt: Date.now(),
        messages: [{ id: 'm0', role: 'user', text: title, ts: Date.now() - 600_000 },
          ...(asking ? [{ id: 'a1', role: 'agent', ts: Date.now() - 60_000,
            text: 'I compared Plausible, PostHog and Google Analytics for the storefront.\n\n- **Plausible**: no cookies, so no consent banner; €19/month.\n- **PostHog**: funnels and session replay; free up to 1M events.\n- **Google Analytics**: free, but needs the consent banner.\n\nWhich should I set up?' }] : [])],
        participants: [{ key: 'do', label: 'Agent', role: 'do', state: status === 'active' ? 'running' : 'idle', messages: 1 }] } as any);
    }

    // Her tasks, not the project's automations (the Repair GitHub workflow series every project gets).
    await page.goto(`${g.url}/northwind/storefront/tasks?q=${encodeURIComponent('-is:archived -is:series')}`);
    await page.locator('.task-row, [data-task-id]').first().waitFor();
    await shot('1-tasks');

    await page.goto(`${g.url}/northwind/storefront/tasks/${question}`);
    await page.locator('.followup-box[data-role="do"] .followup-input').waitFor();
    await page.locator('.followup-box[data-role="do"] .followup-input').fill('PostHog, with session replay off');
    await shot('2-answer-by-voice');

    await page.goto(`${g.url}/northwind/storefront`);
    await page.locator('#expand-task').click();
    await page.locator('#tf-body textarea[data-field="prompt"]').fill('Add a size guide to every product page, using the measurements in the product sheet');
    await shot('3-new-task');
    expect(fs.readdirSync(SHOTS!).length).toBeGreaterThanOrEqual(3);
  } finally {
    await context.close();
  }
}, 120_000);
