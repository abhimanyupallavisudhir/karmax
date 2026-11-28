// Store screenshots, the Play feature graphic and the download page's pictures
// (wiki features/phone-apps § Screenshots), shot from the console against a
// real hosted gateway holding an invented demo organization (Harbor Studio,
// tests/helpers/demo-organization.ts): never a real organization's data.
// The apps' native side is stood in for in the page, as the WebView exposes it.
//
// Without KARMAX_SHOTS it walks every scene once at one phone size and checks
// each rendered (so the pictures can't silently rot). With it, every size:
//   KARMAX_SHOTS=mobile/store/screenshots npx vitest run tests/store-screens.browser.test.ts
// writes <dir>/{ios,android,desktop}/…, the feature graphic and contact-sheet.jpg,
// and web/media/download/desktop-{light,dark}.webp (the /download page's picture).
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
import { hostedGateway, launchChromium, type HostedGateway } from './helpers/browser.js';
import { DEMO, DEMO_FILES, seedDemoOrganization, type DemoOrganization } from './helpers/demo-organization.js';

// Page-side code below runs in the browser; the test project has no DOM types.
declare const document: any, Image: any, requestAnimationFrame: (run: () => void) => void;
type HTMLElement = any;
type HTMLTextAreaElement = any;

const OUT = process.env.KARMAX_SHOTS ? path.resolve(process.env.KARMAX_SHOTS) : '';
const DOWNLOAD_MEDIA = path.resolve('web/media/download');
let browser: Browser, g: HostedGateway, demo: DemoOrganization, seeded: BrowserContext;

type Platform = 'ios' | 'android';
/** A store's picture size: the canvas in pixels and the device's pixel ratio. */
interface Device { id: string; platform: Platform; label: string; width: number; height: number; scale: number }
const DEVICES: Device[] = [
  // App Store: 6.9" is required (1290×2796), 6.5" (1242×2688) is shown on older phones; 13" iPad (the app runs on iPad).
  { id: 'ios/iphone-6.9', platform: 'ios', label: 'iPhone 6.9″ · 1290×2796', width: 1290, height: 2796, scale: 3 },
  { id: 'ios/iphone-6.5', platform: 'ios', label: 'iPhone 6.5″ · 1242×2688', width: 1242, height: 2688, scale: 3 },
  { id: 'ios/ipad-13', platform: 'ios', label: 'iPad 13″ · 2064×2752', width: 2064, height: 2752, scale: 2 },
  // Google Play: 9:16 (the longer side at most twice the shorter; 9:16 is what Play features), phone and 7"/10" tablets.
  { id: 'android/phone', platform: 'android', label: 'Android phone · 1080×1920', width: 1080, height: 1920, scale: 3 },
  { id: 'android/tablet-7', platform: 'android', label: 'Android 7″ tablet · 1080×1920', width: 1080, height: 1920, scale: 2 },
  { id: 'android/tablet-10', platform: 'android', label: 'Android 10″ tablet · 1440×2560', width: 1440, height: 2560, scale: 2 },
];

/** The words above each picture: short, and only what the app does. */
const CAPTIONS: Record<string, Record<Platform, [string, string]>> = {
  'for-me': { ios: ['Agents do the work', 'You make the calls'], android: ['Agents do the work', 'You make the calls'] },
  answer: { ios: ['Answer by voice', 'Dictate replies and new tasks'], android: ['Answer by voice', 'Dictate replies and new tasks'] },
  review: { ios: ['Review from anywhere', 'Confirm it, or ask for changes'], android: ['Review from anywhere', 'Confirm it, or ask for changes'] },
  share: { ios: ['Share to tavya', 'Links, photos and files into a task'], android: ['Share to tavya', 'Links, photos and files into a task'] },
  ask: { ios: ['“Hey Siri, ask tavya”', 'Or ask in the app'], android: ['Ask, hands-free', 'Your assistant, a tile or the widget'] },
  offline: { ios: ['Available offline', 'Keep project files on your iPhone'], android: ['Available offline', 'Keep project files on your phone'] },
};
const SCENES = Object.keys(CAPTIONS);

/** The app's native side as the console sees it (runs in the page). */
function fakeApp(platform: string) {
  const w = globalThis as any;
  Object.defineProperty(w, 'SpeechRecognition', { value: undefined, configurable: true });
  Object.defineProperty(w, 'webkitSpeechRecognition', { value: undefined, configurable: true });
  const plugin = (methods: Record<string, (...args: any[]) => any>, retains: string[] = []) => {
    const listeners: Record<string, Array<(data: any) => void>> = {};
    const retained: Record<string, any[]> = {};
    const self: any = {
      emit: (event: string, data: any) => {
        if (!(listeners[event] ?? []).length && retains.includes(event)) { (retained[event] ??= []).push(data); return; }
        for (const listener of (listeners[event] ?? []).slice()) listener(data);
      },
      addListener: async (event: string, listener: (data: any) => void) => {
        (listeners[event] ??= []).push(listener);
        for (const data of retained[event]?.splice(0) ?? []) setTimeout(() => listener(data), 0);
        return { remove: async () => { listeners[event] = (listeners[event] ?? []).filter((entry) => entry !== listener); } };
      } };
    for (const [method, run] of Object.entries(methods)) self[method] = async (options?: any) => run(options, self);
    return self;
  };
  const bytes = (text: string) => new TextEncoder().encode(text);
  const base64 = (data: Uint8Array) => { let text = ''; for (const byte of data) text += String.fromCharCode(byte); return btoa(text); };
  const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const kept: Record<string, Uint8Array> = {};
  w.__demo = { share: null as any, speech: null as any };
  const Plugins: Record<string, any> = {
    App: plugin({}, ['appUrlOpen']),
    SpeechRecognition: plugin({
      checkPermissions: () => ({ speechRecognition: 'granted' }),
      requestPermissions: () => ({ speechRecognition: 'granted' }),
      // What the phone's recognizer hears, word by word.
      start: (_options: unknown, self: any) => {
        const words = String(w.__demo.speech ?? '').split(' ');
        words.forEach((_, index) => setTimeout(() => self.emit('partialResults', { matches: [words.slice(0, index + 1).join(' ')] }), 60 * (index + 1)));
      },
      stop: (_options: unknown, self: any) => { self.emit('listeningState', { status: 'stopped' }); },
    }),
    PushNotifications: plugin({ checkPermissions: () => ({ receive: 'granted' }), requestPermissions: () => ({ receive: 'granted' }),
      register: () => undefined, unregister: () => undefined }),
    TavyaSignIn: plugin({ open: () => ({ url: '' }), saveDeviceToken: () => undefined, clearDeviceToken: () => undefined }),
    TavyaPhone: plugin({
      takeShare: () => ({ share: w.__demo.share && { id: w.__demo.share.id, text: w.__demo.share.text,
        files: w.__demo.share.files.map((file: any) => ({ name: file.name, type: file.type, size: bytes(file.content).length })) } }),
      readShareFile: ({ index, offset, length }: any) => {
        const all = bytes(w.__demo.share.files[index].content);
        const chunk = all.slice(offset, offset + length);
        return { data: base64(chunk), eof: offset + chunk.length >= all.length };
      },
      finishShare: () => { w.__demo.share = null; },
      setContext: () => undefined,
      assistant: () => ({ available: platform === 'android', held: true }),
      openAssistantSettings: () => undefined,
    }),
    // Offline files kept in memory, downloaded with fetch like the native plugin.
    TavyaOfflineFiles: plugin({
      download: async ({ url, size }: { url: string; size: number }) => {
        const data = new Uint8Array(await (await fetch(url)).arrayBuffer());
        if (data.length !== size) throw { code: 'mismatch', message: 'mismatch' };
        const hash = hex(await crypto.subtle.digest('SHA-256', data));
        kept[hash] = data;
        return { hash, size: data.length };
      },
      list: () => ({ files: Object.entries(kept).map(([hash, data]) => ({ hash, size: data.length })),
        bytes: Object.values(kept).reduce((sum, data) => sum + data.length, 0), free: 48 * 1024 ** 3 }),
      remove: ({ hashes }: { hashes: string[] }) => { for (const hash of hashes) delete kept[hash]; },
      wipe: () => { for (const hash of Object.keys(kept)) delete kept[hash]; },
      url: () => ({ url: null }),
      read: ({ hash, offset = 0, length = 1 << 20 }: any) => {
        const part = (kept[hash] ?? new Uint8Array()).slice(offset, offset + length);
        return { data: base64(part), eof: offset + part.length >= (kept[hash]?.length ?? 0) };
      },
      open: () => undefined,
    }),
  };
  w.Capacitor = { isNativePlatform: () => true, getPlatform: () => platform, isPluginAvailable: (name: string) => name in Plugins, Plugins };
}

/** The desktop app's bridge (desktop/src/preload.cjs), enough for the console's desktop branches. */
function fakeDesktop() {
  const w = globalThis as any;
  const noop = async () => undefined;
  const listener = async () => ({ remove: noop });
  const Plugins = {
    TavyaDesktop: { show: noop, setBadge: noop, getHotkey: async () => ({ accelerator: 'Alt+Command+Space', registered: true }), setHotkey: noop,
      getLaunchAtLogin: async () => ({ enabled: true }), setLaunchAtLogin: noop, getUpdateStatus: async () => ({ state: 'none', current: '1.0.0' }),
      checkForUpdates: noop, installUpdate: noop, addListener: listener },
    TavyaSignIn: { open: noop, saveDeviceToken: noop, clearDeviceToken: noop, addListener: listener },
  };
  w.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'electron', isPluginAvailable: (name: string) => name in Plugins, Plugins };
}

// ── the Research project's files (Files has no repository in this harness: served here, invented)
const sha1 = async (text: string) => {
  const { createHash } = await import('node:crypto');
  const body = Buffer.from(text);
  return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body])).digest('hex');
};
async function serveDemoFiles(context: BrowserContext, projectId: string) {
  const versions: Record<string, string> = {};
  for (const [file, text] of Object.entries(DEMO_FILES)) versions[file] = await sha1(text);
  const source = { kind: 'repository', name: 'research', role: 'development', branch: 'main', commit: 'c0ffee'.padEnd(40, '0') };
  const under = (folder: string) => Object.keys(DEMO_FILES).filter((file) => !folder || file.startsWith(`${folder}/`));
  const revision = (folder: string) => under(folder).map((file) => versions[file]).join('').slice(0, 40);
  const node = (relative: string) => {
    const inRepo = relative.replace(/^research\/?/, '');
    if (DEMO_FILES[inRepo] !== undefined) return { path: relative, kind: 'file', source, size: Buffer.byteLength(DEMO_FILES[inRepo]), version: versions[inRepo] };
    const files = under(inRepo);
    if (!files.length && inRepo) return null;
    const entries = new Map<string, { name: string; kind: string; size?: number; mount?: string }>();
    for (const file of files) {
      const rest = file.slice(inRepo ? inRepo.length + 1 : 0);
      const [head, ...tail] = rest.split('/');
      entries.set(head!, tail.length ? { name: head!, kind: 'directory' } : { name: head!, kind: 'file', size: Buffer.byteLength(DEMO_FILES[file]!) });
    }
    if (!relative) return { path: '', kind: 'directory', source: { kind: 'project' }, entries: [{ name: 'research', kind: 'directory', mount: 'repository' }] };
    const sorted = [...entries.values()].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
    return { path: relative, kind: 'directory', source, entries: sorted, version: revision(inRepo) };
  };
  await context.route(`**/api/projects/${projectId}/files**`, async (route) => {
    const url = new URL(route.request().url());
    const relative = (url.searchParams.get('path') ?? '').replace(/^\/+|\/+$/g, '');
    const inRepo = relative.replace(/^research\/?/, '');
    if (url.pathname.endsWith('/files/views')) return route.fulfill({ json: { tasks: [], branches: [] } });
    if (url.pathname.endsWith('/files/manifest')) {
      const single = DEMO_FILES[inRepo] !== undefined;
      const files = single ? [{ path: '', size: Buffer.byteLength(DEMO_FILES[inRepo]!), version: versions[inRepo]! }]
        : under(inRepo).map((file) => ({ path: file.slice(inRepo ? inRepo.length + 1 : 0), size: Buffer.byteLength(DEMO_FILES[file]!), version: versions[file]! }));
      return route.fulfill({ json: { path: relative, kind: single ? 'file' : 'directory', revision: single ? versions[inRepo] : revision(inRepo),
        files, bytes: files.reduce((sum, file) => sum + file.size, 0) } });
    }
    if (url.pathname.endsWith('/files/raw')) {
      if (DEMO_FILES[inRepo] === undefined) return route.fulfill({ status: 404, json: { error: 'Nothing there' } });
      return route.fulfill({ body: DEMO_FILES[inRepo], contentType: 'text/plain; charset=utf-8', headers: { etag: `"${versions[inRepo]}"` } });
    }
    if (url.pathname.endsWith('/files')) {
      const found = node(relative);
      return found ? route.fulfill({ json: found }) : route.fulfill({ status: 404, json: { error: `Nothing at ${relative}` } });
    }
    return route.continue();
  });
  await context.route('**/api/offline-files/check', async (route) => {
    const pins = (route.request().postDataJSON()?.pins ?? []) as unknown[];
    return route.fulfill({ json: { checkedAt: Date.now(), results: pins.map(() => ({ status: 'current' })) } });
  });
}

/** A context signed in as the demo organization's owner, looking like a reviewer's settled account. */
async function demoContext(options: { width: number; height: number; scale: number; mobile: boolean; dark?: boolean;
  init: [(arg: any) => void, any] }): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: options.width, height: options.height }, deviceScaleFactor: options.scale,
    isMobile: options.mobile, hasTouch: options.mobile, serviceWorkers: 'block', colorScheme: options.dark ? 'dark' : 'light',
    storageState: await seeded.storageState(), locale: 'en-US', timezoneId: 'Europe/Lisbon' });
  context.setDefaultTimeout(15_000);
  await context.addInitScript(options.init[0], options.init[1]);
  // Address confirmed, agents and computers set up: the banners a new account sees are not the app.
  await context.route('**/api/session', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), emailDelivery: false } });
  });
  await context.route('**/api/projects/*/readiness?*', (route) => route.fulfill({ json: {} }));
  // The demo's tasks have no worlds: nothing to save from them.
  await context.route('**/api/tasks/*/resources/inventory', (route) => route.fulfill({ json: { entries: [] } }));
  await context.route('**/api/tasks/*/resources?*', (route) => route.fulfill({ json: [] }));
  await serveDemoFiles(context, demo.projects.Research!.id);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { context, page, errors };
}

/** The share scene's form saves a draft: gone before the next device, whose lists would show it. */
async function forgetDrafts() {
  for (const project of Object.values(demo.projects))
    for (const task of await g.store.listTasks(project.id))
      if (!(task.title in demo.tasks)) await g.store.deleteTask(task.id);
}

/** Two frames painted, then every finite animation and transition (dialogs' and forms' fade-in) finished. */
const settle = (page: Page) => page.evaluate(async () => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  type Running = { effect: { getComputedTiming(): { iterations?: number } } | null; finished: Promise<unknown> };
  const animations: Running[] = (document as unknown as { getAnimations(): Running[] }).getAnimations();
  const finite = animations.filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
  await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
});

/** Each scene: get the page to it; the shot follows. */
const scenes: Record<string, (page: Page, platform: Platform) => Promise<void>> = {
  'for-me': async (page) => {
    await page.goto(`${g.url}/${DEMO.slug}`);
    await page.locator('.task-row, [data-task-id]').first().waitFor();
  },
  answer: async (page) => {
    await page.goto(`${g.url}/${DEMO.slug}/website/tasks/${demo.tasks['Which analytics provider should we use?']}`);
    const box = page.locator('.followup-box[data-role="do"] .followup-input');
    await box.waitFor();
    await page.evaluate(() => { (globalThis as any).__demo.speech = 'Plausible please, and keep the cookie banner off'; });
    await box.focus();
    await page.locator('.followup-box[data-role="do"] [data-mic]').click();
    await page.waitForFunction(() => /banner off/.test((document.querySelector('.followup-box[data-role="do"] .followup-input') as HTMLTextAreaElement)?.value ?? ''));
  },
  review: async (page) => {
    await page.goto(`${g.url}/${DEMO.slug}/website/tasks/${demo.tasks['Fix the flaky checkout test']}`);
    await page.getByRole('button', { name: 'Confirm' }).first().waitFor();
  },
  share: async (page) => {
    await page.goto(`${g.url}/${DEMO.slug}`);
    await page.locator('.task-row, [data-task-id]').first().waitFor();
    await page.evaluate(() => { (globalThis as any).__demo.share = { id: 'share-1', text: 'Venue for the offsite? https://example.com/lisbon-loft',
      files: [{ name: 'Lisbon loft floor plan.pdf', type: 'application/pdf', content: '%PDF-1.7\n'.padEnd(184_000, ' ') }] }; });
    await page.evaluate(() => (globalThis as any).Capacitor.Plugins.App.emit('appUrlOpen', { url: 'io.tavya.app://share' }));
    await page.locator('#tf-add-to-task').waitFor();
    await page.locator('#tf-chips .file-chip', { hasText: 'floor plan' }).waitFor();
  },
  ask: async (page) => {
    await page.goto(`${g.url}/${DEMO.slug}`);
    await page.locator('.task-row, [data-task-id]').first().waitFor();
    await page.evaluate(() => { (globalThis as any).__demo.speech = 'What is left before Friday’s launch?'; });
    await page.evaluate(() => (globalThis as any).Capacitor.Plugins.App.emit('appUrlOpen', { url: 'io.tavya.app://ask?voice=1' }));
    await page.locator('dialog.ask-dialog[open]').waitFor();
    await page.waitForFunction(() => ((document.querySelector('dialog.ask-dialog textarea') as HTMLTextAreaElement)?.value ?? '').endsWith('launch?'));
  },
  offline: async (page) => {
    // Three folders and one file, as someone would before a flight.
    const keep: Array<[string, string]> = [['research', 'interviews'], ['research', 'brand'], ['research', 'pricing'], ['research/contracts', 'Lisbon venue quote.pdf']];
    for (const [folder, name] of keep) {
      await page.goto(`${g.url}/${DEMO.slug}/research/files/${folder}`);
      const row = page.locator('#files-body .files-row', { hasText: name }).first();
      await row.click({ button: 'right' });
      await page.locator('.files-menu [role="menuitemcheckbox"]', { hasText: 'Available offline' }).click();
      if (!name.includes('.')) {
        await page.locator('.offline-keep-dialog').waitFor();
        await page.keyboard.press('Control+Enter');
      }
      await row.locator('.offline-mark[data-state="current"]').waitFor();
    }
    await page.goto(`${g.url}/${DEMO.slug}/research/files?offline`);
    await page.locator('.offline-view .files-row', { hasText: 'Lisbon venue quote' }).waitFor();
    // On a phone the address and the pins' names are readable, not squeezed to a letter.
    expect(await page.evaluate(() => {
      const address = document.querySelector('#files-address') as HTMLElement;
      const names = [...document.querySelectorAll('.offline-view .files-row .files-name')] as HTMLElement[];
      return address.scrollWidth <= address.clientWidth + 1 && names.every((name) => name.scrollWidth <= name.clientWidth + 1 || name.textContent!.length > 20);
    })).toBe(true);
  },
};

/** The page as the store shows it: the caption above, the app below, running off the bottom edge. */
async function compose(page: Page, screen: Buffer, device: Device, caption: [string, string], out: string) {
  const css = { width: device.width / device.scale, height: device.height / device.scale };
  const html = `<!doctype html><html><head><style>
    @font-face { font-family: Inter; src: url(data:font/woff2;base64,${INTER}) format('woff2'); font-weight: 100 900; }
    html, body { margin: 0; width: ${css.width}px; height: ${css.height}px; overflow: hidden; }
    body { background: radial-gradient(120% 80% at 50% 0%, #2b2b7a 0%, #16163f 55%, #0e0e26 100%); font-family: Inter, system-ui, sans-serif;
      color: #fff; display: flex; flex-direction: column; align-items: center; }
    .caption { height: ${css.height * CAPTION_SHARE}px; box-sizing: border-box; padding: 0 ${css.width * 0.06}px; text-align: center;
      display: flex; flex-direction: column; justify-content: center; }
    h1 { margin: 0; font-size: ${Math.round(css.width * 0.074)}px; line-height: 1.1; letter-spacing: -0.025em; font-weight: 700; white-space: nowrap; }
    p { margin: ${css.width * 0.02}px 0 0; font-size: ${Math.round(css.width * 0.044)}px; color: #e2c97e; font-weight: 500; white-space: nowrap; }
    .screen { width: ${SCREEN_SCALE * 100}%; flex: 1; border-radius: ${css.width * 0.06}px ${css.width * 0.06}px 0 0;
      overflow: hidden; box-shadow: 0 0 0 ${Math.max(3, css.width * 0.012)}px #0b0b1d, 0 20px 60px rgba(0,0,0,.45); background: #fff; }
    .screen img { display: block; width: 100%; }
  </style></head><body><div class="caption"><h1>${caption[0]}</h1><p>${caption[1]}</p></div>
    <div class="screen"><img src="data:image/png;base64,${screen.toString('base64')}"></div></body></html>`;
  await page.setViewportSize(css);
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(() => [...document.querySelectorAll('h1, p')].some((el) => el.scrollWidth > document.body.clientWidth * 0.94));
  expect(overflow, `${caption.join(' / ')} fits ${device.id}`).toBe(false);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out });
}
/** The app's width inside the picture, and the caption's share of its height. */
const SCREEN_SCALE = 0.86;
const CAPTION_SHARE = 0.19;
const INTER = fs.readFileSync(path.resolve('web/fonts/inter/InterVariable.woff2')).toString('base64');
/** The app's viewport for a device: as wide as the picture at its pixel ratio, as tall as the room under the caption. */
function appViewport(device: Device) {
  const css = { width: device.width / device.scale, height: device.height / device.scale };
  const top = css.height * CAPTION_SHARE;
  return { width: Math.round(css.width), height: Math.round((css.height - top) / SCREEN_SCALE) };
}

beforeAll(async () => {
  browser = await launchChromium();
  g = await hostedGateway(() => ({ hostLocal: true }));
  await g.store.setSettings('global', 'appearance', { icon: 'royal-gold-arrow' });
  seeded = await browser.newContext();
  demo = await seedDemoOrganization(g, seeded);
}, 60_000);
afterAll(async () => { await seeded?.close(); await g?.close(); await browser?.close(); });

/** Desktop scenes (the download page and the contact sheet): the console as the Mac and Linux app shows it, no caption. */
const DESKTOP_SCENES: Record<string, (page: Page) => Promise<void>> = {
  'for-me': (page) => scenes['for-me']!(page, 'ios'),
  review: (page) => scenes.review!(page, 'ios'),
  ask: async (page) => {
    await scenes['for-me']!(page, 'ios');
    await page.evaluate(() => { (globalThis as any).__demo = { speech: '' }; });
    await page.locator('#rail-ask').click();
    await page.locator('dialog.ask-dialog[open] textarea').fill('What is left before Friday’s launch?');
  },
};

/** A PNG as WebP `width` pixels wide, encoded by the browser (no image tools needed). */
async function webp(page: Page, png: Buffer, width: number, out: string) {
  await page.setContent('<!doctype html><body></body>');
  const data = await page.evaluate(async ({ source, width }) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = Object.assign(document.createElement('canvas'), { width, height: Math.round(image.height * width / image.width) });
    const context = canvas.getContext('2d')!;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/webp', 0.86).split(',')[1]!;
  }, { source: `data:image/png;base64,${png.toString('base64')}`, width });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(data, 'base64'));
}

/** Google Play's feature graphic (1024×500): the mark, the name, the line, and the app. */
async function featureGraphic(page: Page, phone: Buffer, out: string) {
  const icon = fs.readFileSync(path.resolve('web/brand/royal-gold-arrow/icon.svg'), 'utf8');
  await page.setViewportSize({ width: 1024, height: 500 });
  await page.setContent(`<!doctype html><html><head><style>
    @font-face { font-family: Inter; src: url(data:font/woff2;base64,${INTER}) format('woff2'); font-weight: 100 900; }
    html, body { margin: 0; width: 1024px; height: 500px; overflow: hidden; }
    body { background: radial-gradient(90% 120% at 20% 0%, #2b2b7a 0%, #16163f 60%, #0e0e26 100%); font-family: Inter, sans-serif; color: #fff; position: relative; }
    .words { position: absolute; left: 72px; top: 0; bottom: 0; display: flex; flex-direction: column; justify-content: center; }
    .name { display: flex; align-items: center; gap: 20px; font-size: 76px; font-weight: 700; letter-spacing: -0.03em; }
    .name svg { width: 92px; height: 92px; }
    .line { margin-top: 18px; font-size: 30px; font-weight: 500; color: #e2c97e; line-height: 1.25; }
    .phone { position: absolute; right: 70px; top: 58px; width: 300px; height: 520px; border-radius: 34px; overflow: hidden;
      box-shadow: 0 0 0 7px #0b0b1d, 0 24px 60px rgba(0,0,0,.5); background: #fff; }
    .phone img { width: 100%; display: block; }
  </style></head><body><div class="words"><div class="name">${icon}tavya</div>
    <div class="line">Agents do your tasks.<br>You review them.</div></div>
    <div class="phone"><img src="data:image/png;base64,${phone.toString('base64')}"></div></body></html>`, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out });
}

/** Every picture on one page, to look over in one go (review info, not uploaded anywhere). */
async function contactSheet(page: Page, rows: Array<{ label: string; files: string[] }>, out: string) {
  const image = (file: string) => `<figure><img src="data:image/png;base64,${fs.readFileSync(file).toString('base64')}"><figcaption>${path.basename(file)}</figcaption></figure>`;
  await page.setViewportSize({ width: 1800, height: 800 });
  await page.setContent(`<!doctype html><html><head><style>
    @font-face { font-family: Inter; src: url(data:font/woff2;base64,${INTER}) format('woff2'); font-weight: 100 900; }
    body { margin: 0; padding: 32px 40px; background: #f4f4f7; font-family: Inter, sans-serif; color: #15151f; }
    h1 { font-size: 26px; margin: 0 0 4px; } .note { color: #666; margin: 0 0 24px; font-size: 15px; }
    h2 { font-size: 17px; margin: 26px 0 10px; } .row { display: flex; gap: 14px; flex-wrap: wrap; align-items: flex-end; }
    figure { margin: 0; } img { height: 380px; display: block; border-radius: 6px; box-shadow: 0 1px 4px rgba(0,0,0,.2); }
    figcaption { font-size: 12px; color: #666; margin-top: 4px; }
  </style></head><body><h1>tavya — store and download pictures</h1>
    <p class="note">Shot from the invented demo organization Harbor Studio by tests/store-screens.browser.test.ts.</p>
    ${rows.map((row) => `<h2>${row.label}</h2><div class="row">${row.files.map(image).join('')}</div>`).join('')}</body></html>`, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: out, fullPage: true, type: 'jpeg', quality: 80 });
}

it('shoots every store scene from the demo organization', async () => {
  const devices = OUT ? DEVICES : [DEVICES[0]!];
  const composer = await browser.newPage();
  const made: Array<{ label: string; files: string[] }> = [];
  let androidHome: Buffer | undefined;
  try {
    for (const device of devices) {
      const viewport = appViewport(device);
      const { context, page, errors } = await demoContext({ ...viewport, scale: device.scale, mobile: true, init: [fakeApp, device.platform] });
      const files: string[] = [];
      try {
        for (const [index, scene] of SCENES.entries()) {
          await scenes[scene]!(page, device.platform);
          await settle(page);
          const screen = await page.screenshot();
          expect(screen.length, `${device.id} ${scene}`).toBeGreaterThan(10_000);
          if (device.id === 'android/phone' && scene === 'for-me') androidHome = screen;
          if (scene === 'share') await forgetDrafts();
          if (!OUT) continue;
          const out = path.join(OUT, device.id, `${index + 1}-${scene}.png`);
          await compose(composer, screen, device, CAPTIONS[scene]![device.platform], out);
          files.push(out);
        }
        expect(errors).toEqual([]);
      } finally {
        await context.close();
        await forgetDrafts();
      }
      made.push({ label: device.label, files });
    }
    // The desktop app (the download page's picture, light and dark).
    const desktop: string[] = [];
    for (const dark of [false, true]) {
      const { context, page, errors } = await demoContext({ width: 1200, height: 750, scale: 2, mobile: false, dark, init: [fakeDesktop, null] });
      try {
        for (const [index, [scene, go]] of Object.entries(DESKTOP_SCENES).entries()) {
          if (dark && scene !== 'for-me') continue;
          await go(page);
          await settle(page);
          const screen = await page.screenshot();
          expect(screen.length, `desktop ${scene}`).toBeGreaterThan(10_000);
          if (!OUT) continue;
          const out = path.join(OUT, 'desktop', `${index + 1}-${scene}${dark ? '-dark' : ''}.png`);
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, screen);
          desktop.push(out);
          if (scene === 'for-me') await webp(composer, screen, 1600, path.join(DOWNLOAD_MEDIA, `desktop-${dark ? 'dark' : 'light'}.webp`));
        }
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    }
    if (!OUT) return;
    made.push({ label: 'Desktop app (Mac, Linux) · 2400×1500', files: desktop });
    const graphic = path.join(OUT, 'android', 'feature-graphic.png');
    await featureGraphic(composer, androidHome!, graphic);
    made.push({ label: 'Google Play feature graphic · 1024×500', files: [graphic] });
    await contactSheet(composer, made, path.join(OUT, 'contact-sheet.jpg'));
  } finally { await composer.close(); }
}, 600_000);
