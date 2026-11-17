// The landing page's screenshots (web/media/landing/*), from the launch video's demo
// tavya (design/launch-video: fetch.py, build.sh), each in the light and the dark look,
// 2× and cropped to the part that tells its story. Run through record.sh, which restores
// the clone and starts it:
//   DIRECTOR=../landing-v3/shoot.cjs bash design/launch-video/record.sh /tmp/landing-shots
// then `node design/landing-v3/encode.cjs /tmp/landing-shots` writes the .webp files.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const APP = 'http://127.0.0.1:48950';
const OUT = process.argv[2] || '/tmp/landing-shots';
const projects = JSON.parse(fs.readFileSync('/tmp/demo/projects.json', 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOOKS = ['light', 'dark'];
let browser, api;

// How a task goes: one task, the launch video, written down, at work, then in review.
const PROMPTS = {
  video: 'Create a launch video for tavya.io that shows just how great it is',
  errand: 'Book me the cheapest direct flight to London on January 3 with reasonable timings. My passport, loyalty card numbers etc. are in this folder.',
};

async function context(look, viewport = { width: 1440, height: 900 }, scale = 2) {
  const ctx = await browser.newContext({ storageState: '/tmp/demo/state.json', viewport, deviceScaleFactor: scale, colorScheme: look });
  await ctx.route('**/api/meta', async (route) => { const r = await route.fetch(); route.fulfill({ response: r, json: { ...(await r.json()), hosted: true, hostLocal: false } }); });
  // Every agent in the demo is the scripted mock, whatever the form picked.
  await ctx.route((u) => u.origin === APP && u.pathname.startsWith('/api/'), async (route) => {
    const req = route.request(), body = req.postData();
    if (!body || !['POST', 'PUT', 'PATCH'].includes(req.method()) || !/"provider"\s*:/.test(body)) return route.fallback();
    return route.fallback({ postData: body.replace(/"provider"\s*:\s*"(claude|codex|opencode)"/g, '"provider":"mock"') });
  });
  await ctx.addInitScript((theme) => {
    try { Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }); } catch {}
    try { localStorage.setItem('karmax-theme', theme); } catch {}
    document.addEventListener('DOMContentLoaded', () => {
      const s = document.createElement('style');
      s.textContent = '*{caret-color:transparent!important} ::-webkit-scrollbar{width:0!important;height:0!important}';
      document.head.appendChild(s);
    });
  }, look);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  page.setDefaultTimeout(60000);
  return { ctx, page };
}
const go = async (page, url, wait = 1500) => { await page.goto(APP + url); await page.locator('#main').waitFor(); await sleep(wait); };
/** A crop around the locators (page px), padded; `maxH` caps a tall one. */
async function crop(page, name, look, locators, { pad = 16, maxH, minH, top, spanOf } = {}) {
  const boxes = [];
  for (const l of locators) { const b = await l.first().boundingBox(); if (b) boxes.push(b); }
  if (!boxes.length) throw new Error(`${name}: nothing to crop`);
  const vw = page.viewportSize().width, vh = page.viewportSize().height;
  let x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const y = Math.max(0, (top ?? Math.min(...boxes.map((b) => b.y))) - pad);
  let r = Math.min(vw, Math.max(...boxes.map((b) => b.x + b.width)) + pad);
  let b = Math.min(vh, Math.max(...boxes.map((b) => b.y + b.height)) + pad);
  if (maxH) b = Math.min(b, y + maxH);
  if (minH) b = Math.min(vh, Math.max(b, y + minH));
  // A crop as wide as another element (a list's rows, not just their titles).
  if (spanOf) { const sb = await spanOf.first().boundingBox(); if (sb) { x = Math.max(0, sb.x - pad); r = Math.min(vw, sb.x + sb.width + pad); } }
  await page.screenshot({ path: path.join(OUT, `${name}-${look}.png`), clip: { x, y, width: r - x, height: b - y } });
  console.log('shot', `${name}-${look}`, Math.round(r - x), '×', Math.round(b - y));
}
async function findTask(projectName, title) {
  const r = await api.get(`${APP}/api/projects/${projects[projectName]}/search?q=${encodeURIComponent('sort:created-desc')}`);
  return ((await r.json()).tasks ?? []).find((t) => t.title.startsWith(title));
}
async function waitFor(projectName, title, check, timeout = 180000) {
  const t0 = Date.now();
  for (;;) {
    const t = await findTask(projectName, title);
    if (t) { const v = await (await api.get(`${APP}/api/tasks/${t.id}`)).json(); if (check(v)) return t; }
    if (Date.now() - t0 > timeout) throw new Error(`${projectName} "${title.slice(0, 30)}" never got there`);
    await sleep(800);
  }
}
/** The form saves what is typed as a draft; drafts are not part of any picture. */
async function dropDrafts() {
  for (const id of Object.values(projects)) {
    const drafts = await (await api.get(`${APP}/api/projects/${id}/search?q=${encodeURIComponent('is:draft')}`)).json();
    for (const t of drafts.tasks ?? []) await api.delete(`${APP}/api/tasks/${t.id}`, { headers: { origin: APP } });
  }
}
async function newForm(page, slug) {
  await go(page, `/personal/${slug}`, 900);
  await page.locator('#expand-task').click();
  const ta = page.locator('#tf-page textarea').first();
  await ta.waitFor(); await sleep(700);
  return ta;
}
async function start(page, slug, prompt, budget) {
  const ta = await newForm(page, slug);
  await ta.fill(prompt);
  if (budget) {
    await page.locator('summary', { hasText: 'Authorization' }).first().click(); await sleep(300);
    await page.locator('#tf-payments-budget').fill(String(budget));
  }
  await ta.focus(); await page.keyboard.press('Meta+Enter');
  await page.getByText('Task started').first().waitFor({ timeout: 15000 }).catch(() => {});
  await sleep(500);
}

const VAULT = [
  { type: 'login', label: 'flights/united', domains: ['united.com'], username: 'MileagePlus', policy: { use: 'ask', reveal: 'ask' }, secrets: { password: 'demo-not-a-password' } },
  { type: 'api-key', label: 'hetzner.com', domains: ['hetzner.com'], envVar: 'HCLOUD_TOKEN', secrets: { secret: 'demo-not-a-key' } },
  { type: 'api-key', label: 'cloudflare.com', domains: ['cloudflare.com'], envVar: 'CLOUDFLARE_API_TOKEN', secrets: { secret: 'demo-not-a-key' } },
  { type: 'ssh-key', label: 'deploy@tavya.io', secrets: { privateKey: 'demo-not-a-key' } },
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  browser = await chromium.launch({ args: ['--no-sandbox', '--font-render-hinting=none'] });
  const { ctx: driverCtx, page: driver } = await context('light');
  api = driverCtx.request;
  let failed;
  try {
    for (const item of VAULT) await api.post(`${APP}/api/vault/items`, { data: item, headers: { origin: APP } });
    // admin_docs' folder: pretend documents for the flight.
    const tavya = path.resolve(__dirname, '../../bin/tavya.js'), laptop = '/tmp/demo/laptop';
    const env = { ...process.env, KARMAX_GATEWAY_URL: APP, KARMAX_TOKEN: JSON.parse(fs.readFileSync('/tmp/demo/cli-token.json', 'utf8')).token, TAVYA_NO_UPDATE_CHECK: '1' };
    fs.rmSync(path.join(laptop, 'admin-docs'), { recursive: true, force: true }); fs.mkdirSync(laptop, { recursive: true });
    spawnSync('node', [tavya, 'clone', 'personal/admin_docs'], { cwd: laptop, env });
    fs.mkdirSync(path.join(laptop, 'admin-docs/documents'), { recursive: true });
    fs.writeFileSync(path.join(laptop, 'admin-docs/documents/passport.pdf'), '%PDF-1.4\n% demo\n');
    fs.writeFileSync(path.join(laptop, 'admin-docs/documents/loyalty-programmes.md'), '# Loyalty programmes\n\n- United MileagePlus: XX000000 (demo)\n');
    spawnSync('node', [tavya, 'add', 'documents'], { cwd: path.join(laptop, 'admin-docs'), env });
    // The automations an autonomous company runs on (dependency updates and Dream are being built: mocked here).
    for (const a of [
      { title: 'Fix errors in deployment', prompt: 'An error was reported on the server: find its cause, fix it, and ship the fix.', params: { repeatable: true, triggers: [{ kind: 'event', type: 'errors.new', recurring: true }] } },
      { title: 'Update dependencies', prompt: 'A dependency published a new version: bump it, adapt the code to what changed, run the tests, and open a pull request.', params: { repeatable: true, triggers: [{ kind: 'event', type: 'dependency.released', recurring: true }] } },
      { title: 'Dream', prompt: 'Go over what happened since the last dream: tidy the wiki\'s memories, notice what keeps going wrong, and propose improvements.', params: { repeatable: true, triggers: [{ kind: 'schedule', cron: '0 3 * * *', recurring: true }] } },
    ]) await api.post(`${APP}/api/projects/${projects.tavya}/tasks`, { data: a, headers: { origin: APP } });
    await api.post(`${APP}/api/projects/${projects.tavya}/task-store/project-wiki`, { data: {}, headers: { origin: APP } });

    // The video the launch-video task attaches (script.py): the film, from its title card on, so its thumbnail is that card.
    if (process.env.FILM) spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-ss', '1.6', '-i', process.env.FILM, '-c:v', 'libx264', '-crf', '28', '-c:a', 'aac', '/tmp/demo/assets/launch-v1.mp4']);
    // The tasks the stills show, started at once.
    await start(driver, 'tavya', PROMPTS.video);
    const video = await findTask('tavya', 'Create a launch video');
    await start(driver, 'admin_docs', PROMPTS.errand, 500);
    await waitFor('tavya', 'Create a launch video', (v) => v.stage === 'review');
    const errand = await waitFor('admin_docs', 'Book me the cheapest', (v) => (v.stage === 'review' || v.waitingFor) && true);
    await sleep(4000);

    for (const look of LOOKS) {
      const { ctx, page } = await context(look);
      // 1 · Write it down: a task typed in plain words.
      const ta = await newForm(page, 'tavya');
      await ta.fill(PROMPTS.video); await sleep(500);
      await crop(page, 'write', look, [page.locator('#tf-page .form-row').first(), page.locator('#tf-page [data-row="agent:do"]')], { pad: 18 });
      await page.keyboard.press('Escape'); await sleep(800);
      await dropDrafts();
      // 2 · An agent does it: the same task again, caught a dozen steps in while it works.
      await start(driver, 'tavya', PROMPTS.video);
      const work = await findTask('tavya', 'Create a launch video');
      await sleep(6000);
      await go(page, `/personal/tavya/tasks/${work.num}`, 1500);
      // Its steps from the first (the landing shows a shot's top left; the thread follows the newest).
      await page.evaluate(() => { for (const el of document.querySelectorAll('#tp-body, #tp-body .ck-thread')) el.scrollTop = 0; });
      await sleep(250);
      const steps = page.locator('.fold-head').last();
      await crop(page, 'work', look, [steps], { pad: 22, minH: 470, maxH: 560, spanOf: page.locator('.msg.user').last().locator('xpath=..') });
      // 3 · You review the result: the video it attached. A real launch video takes hours; the mock's run took seconds.
      // A shorter window, so Confirm sits just under the result instead of a screen below it.
      await page.setViewportSize({ width: 1440, height: 800 });
      await go(page, `/personal/tavya/tasks/${video.num}`, 2500);
      await page.evaluate(() => { for (const l of document.querySelectorAll('.fold-label')) if (l.textContent.startsWith('Worked ')) l.textContent = 'Worked 2 h 40 min'; });
      await sleep(400);
      // The attached video at the top (the landing shows a shot's top left), Confirm under it.
      const result = page.locator('.msg.agent.review-info').last();
      await crop(page, 'review', look, [result, page.getByRole('button', { name: /Confirm/ }).first()], { pad: 22 });
      await page.setViewportSize({ width: 1440, height: 900 });
      // Big jobs fan out: a review that became 25 sub-tasks.
      await go(page, '/personal/tavya/tasks/367', 2500);
      await crop(page, 'fan-out', look, [page.locator('.rail-sec.subtasks')], { pad: 10, maxH: 520 });
      // Accounts, keys and a card: the vault.
      await go(page, '/personal/settings#settings-payments', 1800);
      await page.getByText('Vault credentials').filter({ visible: true }).first().click(); await sleep(1500);
      await crop(page, 'vault', look, [page.locator('dialog[open], [role="dialog"]').filter({ visible: true })], { pad: 0, maxH: 520 });
      await page.keyboard.press('Escape');
      // The autonomous company: tasks that start themselves.
      await go(page, '/personal/tavya?q=is%3Aseries%20-is%3Aarchived', 1800);
      await crop(page, 'automations', look, [page.locator('.task-title').first(), page.locator('.task-title').last()], { pad: 26, spanOf: page.locator('.task-title').first().locator('xpath=ancestor::*[contains(@class,"task-row") or self::li or self::article][1]') });
      // The autonomous company: a new project made fully autonomous (task #918 builds the toggle: drawn here as it looks there).
      await go(page, '/personal?q=-is%3Aarchived', 900);
      await page.locator('#new-project').click();
      await page.locator('#new-project-name').waitFor(); await sleep(400);
      await page.locator('#new-project-name').fill('acme');
      await page.evaluate(() => {
        const actions = document.querySelector('.new-project-dialog .new-project-actions');
        const row = document.createElement('label');
        row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:14px 0;margin:4px 0 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);color:var(--ink);font-size:var(--fs-14)';
        row.innerHTML = '<input type="checkbox" class="toggle" checked> Fully autonomous project <span style="color:var(--ink-3)">ⓘ</span>';
        actions.parentElement.insertBefore(row, actions);
      });
      await sleep(500);
      await crop(page, 'autonomous', look, [page.locator('.new-project-dialog')], { pad: 0 });
      await page.keyboard.press('Escape'); await sleep(400);
      // Any model: the model picker.
      await newForm(page, 'tavya');
      await page.locator('#tf-page .model-field input[aria-label="Model"]').first().click(); await sleep(1200);
      await crop(page, 'models', look, [page.locator('#tf-page .model-field')], { pad: 14, minH: 380 });
      await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await sleep(800);
      await dropDrafts();
      // Not just code: an errand, asking before it uses your login.
      await go(page, `/personal/admin_docs/tasks/${errand.num}`, 2500);
      await crop(page, 'errand', look, [page.locator('.msg.agent', { hasText: 'United login' }).last(), page.getByRole('button', { name: /^(Allow for this task|This task)$/ }).first()], { pad: 22 });
      await ctx.close();
    }
  } catch (e) { failed = e; console.error('shoot failed:', e); await driver.screenshot({ path: path.join(OUT, 'failure.png') }).catch(() => {}); }
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
