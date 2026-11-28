// Screens of the desktop app (desktop/, wiki features/desktop-apps) against a
// real local tavya (src/main.ts with the mock agent and its own Temporal), and
// the checks only a whole app can make: files dropped on the new-task form and
// on a task's message box, the Ask shortcut, the tray in a real panel.
//
//   Xvfb :99 -screen 0 1440x900x24 &  DISPLAY=:99 openbox &  DISPLAY=:99 tint2 &
//   DISPLAY=:99 npx tsx design/desktop/shoot.ts
//
// Writes design/desktop/*.png. Needs desktop/ installed (cd desktop && npm ci) and xdotool.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';
import { consoleRequest, launchApp, launchChromium, stopEmbeddedTemporal } from '../../tests/helpers/browser.js';
import { ensureIdentity, gitOrThrow } from '../../src/world/git.js';

const OUT = path.resolve('design/desktop');
const PASSWORD = 'correct horse battery staple 42';
const electron = createRequire(path.resolve('desktop/package.json'))('electron') as string;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tavya-desktop-shots-'));
const home = path.join(root, 'home');
fs.mkdirSync(home);
fs.mkdirSync(OUT, { recursive: true });

async function repository(name: string) {
  const repo = path.join(root, name);
  await gitOrThrow(root, ['init', '-q', '-b', 'main', repo]);
  await ensureIdentity(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), `# ${name}\n`);
  await gitOrThrow(repo, ['add', '-A']);
  await gitOrThrow(repo, ['commit', '-q', '-m', 'init']);
  return repo;
}
const until = async (check: () => Promise<boolean>, what: string, ms = 60_000) => {
  const end = Date.now() + ms;
  while (!(await check().catch(() => false))) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
};

const app = await launchApp(home);
const browser = await launchChromium();
let desktop: Awaited<ReturnType<typeof _electron.launch>> | undefined;
try {
  // The administrator, two projects and work that waits on them, as a person would leave it.
  const setup = await browser.newContext();
  const page0 = await setup.newPage();
  await page0.goto(app.url);
  await page0.getByLabel('Name').fill('Hana Home');
  await page0.getByLabel('Email').fill('hana@example.test');
  await page0.getByLabel('Password (10+ characters)').fill(PASSWORD);
  await page0.locator('#setup-btn').click();
  await page0.locator('#new-project').waitFor();
  const config = (repo: string) => ({ repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false });
  const web = await consoleRequest(setup, app.url, 'POST', '/api/projects', { name: 'Website', config: config(await repository('website')) });
  const mobile = await consoleRequest(setup, app.url, 'POST', '/api/projects', { name: 'Mobile App', config: config(await repository('mobile')) });
  const create = (projectId: string, title: string, prompt: string) => consoleRequest(setup, app.url, 'POST', `/api/projects/${projectId}/tasks`,
    { title, prompt, workflow: 'software-dev' });
  const review = await create(web.id, 'Keep the cart when signing in', '@write cart.txt :: kept');
  await create(web.id, 'Shorter checkout page', '@write checkout.txt :: one step');
  await create(mobile.id, 'Index the reading list overnight', '@pause 120');
  await until(async () => (await consoleRequest(setup, app.url, 'GET', `/api/tasks/${review.id}`))?.stage === 'review', 'the agent reaches Review');

  const userData = fs.mkdtempSync(path.join(root, 'app-'));
  desktop = await _electron.launch({ executablePath: electron, args: [path.resolve('desktop')],
    env: { ...process.env, TAVYA_URL: app.url, TAVYA_DESKTOP_USER_DATA: userData } as Record<string, string> });
  const page = await desktop.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setBounds({ x: 40, y: 30, width: 1280, height: 800 }));
  // Signed out, the app shows one Sign in (the system browser does the rest).
  await page.locator('#app-sign-in').waitFor();
  await page.screenshot({ path: path.join(OUT, 'sign-in.png') });

  // Signed in as the system browser would leave it.
  const signedIn = await desktop.context().request.post(`${app.url}/api/auth/sign-in/email`,
    { headers: { origin: app.url }, data: { email: 'hana@example.test', password: PASSWORD } });
  if (!signedIn.ok()) throw new Error(`sign-in: ${signedIn.status()}`);
  await page.goto(app.url);
  await page.waitForURL(/\/personal$/);
  await page.locator(`[data-id="${review.id}"]`).waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, 'for-me.png') });

  // The Ask shortcut, pressed through the X server: the window comes forward with Ask open.
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.hide());
  spawnSync('xdotool', ['key', 'ctrl+alt+space']);
  const asked = await until(() => page.locator('.ask-dialog[open]').isVisible(), 'Ask opens on the shortcut', 5000).then(() => true, () => false);
  if (asked) {
    await page.locator('.ask-dialog textarea').fill('What’s waiting on me in Website?');
    await page.screenshot({ path: path.join(OUT, 'ask.png') });
    await page.keyboard.press('Escape');
  } else console.warn('Ask did not open from the shortcut (needs the console\'s open listener, sub-task A)');

  // Files dropped from the file manager: on a task's message box, and on the new-task form.
  const drop = (selector: string, name: string) => page.locator(selector).evaluate((element, file) => {
    const data = new DataTransfer();
    data.items.add(new File(['width,height\n1200,630\n'], file, { type: 'text/csv' }));
    for (const type of ['dragenter', 'dragover', 'drop']) element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
  }, name);
  await page.goto(`${app.url}/personal/website/tasks/${review.id}`);
  await page.locator('.followup-input').waitFor();
  await page.locator('.followup-input').fill('Also keep the coupon');
  await drop('.followup-input', 'coupon-sizes.csv');
  try {
    await until(async () => (await page.locator('.followup-box').first().innerText()).includes('coupon-sizes'), 'the message box takes the dropped file', 10_000);
  } catch (error) {
    await page.screenshot({ path: '/tmp/dsk/fail.png' });
    console.log((await page.locator('body').innerText()).slice(-1500));
    console.log(await page.evaluate(() => [...document.querySelectorAll('.followup-box')].map((b) => b.outerHTML.slice(0, 600))));
    throw error;
  }
  await page.screenshot({ path: path.join(OUT, 'task-drop.png') });

  await page.goto(`${app.url}/personal/website`);
  await page.locator('#expand-task').click();
  await page.locator('#tf-body textarea[data-field="prompt"]').fill('Make the social card 1200×630');
  await drop('#tf-body textarea[data-field="prompt"]', 'social-card.csv');
  await until(async () => (await page.locator('#tf-body').innerText()).includes('social-card.csv'), 'the new-task form takes the dropped file', 10_000);
  await page.screenshot({ path: path.join(OUT, 'new-task-drop.png') });

  // The whole screen: the window and, in the panel, the tray icon with its dot.
  await page.goto(app.url);
  await page.locator(`[data-id="${review.id}"]`).waitFor();
  await page.evaluate(() => (window as any).Capacitor.Plugins.TavyaDesktop.setBadge({ count: 2 }));
  await page.waitForTimeout(1500);
  spawnSync('import', ['-window', 'root', path.join(OUT, 'screen.png')]);
  console.log('tray:', JSON.stringify(await desktop.evaluate(() => (globalThis as any).tavyaDesktop.tray())));
  console.log(`screens in ${OUT}`);
} finally {
  await desktop?.close().catch(() => {});
  await browser.close();
  await app.stop();
  await stopEmbeddedTemporal(home);
  fs.rmSync(root, { recursive: true, force: true });
}
