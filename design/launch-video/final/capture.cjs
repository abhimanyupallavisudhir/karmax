// Captures the final cut's screens from the demo tavya (build.sh's clone, the scripted
// mock agent): 2x stills and frame sequences at 1440×900, and the boxes the camera aims
// at (shots.json). Run through record.sh, which restores the clone and starts it:
//   FILM=…/tavya-launch.mp4 DIRECTOR=final/capture.cjs bash record.sh /tmp/demo/final-assets [shot-filter]
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const APP = 'http://127.0.0.1:48950';
const OUT = process.argv[2] || '/tmp/demo/final-assets';
const ONLY = process.argv[3] ? new RegExp(process.argv[3]) : null;
const W = 1440, H = 900, DPR = 2;
const projects = JSON.parse(fs.readFileSync('/tmp/demo/projects.json', 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const want = (...names) => !ONLY || names.some((n) => ONLY.test(n));
// Re-shooting some screens keeps the rest: start from what the last capture recorded.
const manifest = fs.existsSync(path.join(OUT, 'shots.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'shots.json'), 'utf8')) : {};
let page, context;

const api = async (method, p, body) => {
  const r = await context.request.fetch(APP + p, { method, data: body, headers: { origin: APP } });
  return r.json().catch(() => ({}));
};
async function findTask(projectName, title) {
  const d = await api('GET', `/api/projects/${projects[projectName]}/search?q=${encodeURIComponent('sort:created-desc')}`);
  return (d.tasks ?? []).find((t) => t.title.startsWith(title));
}
async function waitStage(projectName, title, stages, timeout = 240000) {
  const t0 = Date.now();
  for (;;) {
    const t = await findTask(projectName, title);
    if (t) { const v = await api('GET', `/api/tasks/${t.id}`); if (stages.includes(v.stage) || stages.includes(v.status)) return v; }
    if (Date.now() - t0 > timeout) throw new Error(`${projectName} "${title}" never reached ${stages}`);
    await sleep(700);
  }
}
const go = async (url, wait = 1500) => { await page.goto(APP + url); await page.locator('#main').waitFor(); await sleep(wait); };
const box = async (locator) => {
  const b = await locator.first().boundingBox().catch(() => null);
  return b && { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
};
/** A still, with the boxes of the named locators (the camera's and cursor's targets). */
async function shot(name, marks = {}) {
  if (ONLY && !ONLY.test(name)) return;
  await sleep(250);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const boxes = {};
  for (const [k, loc] of Object.entries(marks)) boxes[k] = await box(loc);
  manifest[name] = { kind: 'still', boxes };
  fs.writeFileSync(path.join(OUT, 'shots.json'), JSON.stringify(manifest, null, 1));
  console.log('shot', name, JSON.stringify(boxes));
}
/** A task typed into the new-task form, one frame every few characters; then started. */
async function newForm(slug) {
  await go(`/personal/${slug}`, 900);
  await page.locator('#expand-task').click();
  const ta = page.locator('#tf-page textarea').first();
  await ta.waitFor(); await sleep(900);
  return ta;
}
async function typed(name, slug, prompt, { budget, every = 2, models } = {}) {
  const ta = await newForm(slug);
  await ta.click();
  const dir = path.join(OUT, name);
  const record = !ONLY || ONLY.test(name);
  if (record) { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); }
  let n = 0;
  const frame = async () => { if (record) await page.screenshot({ path: path.join(dir, `${String(n++).padStart(4, '0')}.jpg`), type: 'jpeg', quality: 92 }); };
  await frame();
  for (let i = 0; i < prompt.length; i += every) { await page.keyboard.insertText(prompt.slice(i, i + every)); if (record) await frame(); }
  if (record) manifest[name] = { kind: 'sequence', frames: n, boxes: { prompt: await box(ta) } };
  if (models) {
    await page.locator('#tf-page .model-field input[aria-label="Model"]').first().click(); await sleep(1200);
    await shot(models, { field: page.locator('#tf-page .model-field') });
    await page.keyboard.press('Escape'); await sleep(400);
  }
  await start(ta, budget);
}
async function start(ta, budget) {
  if (budget) {
    await page.locator('summary', { hasText: 'Authorization' }).first().click();
    await sleep(300);
    await page.locator('#tf-payments-budget').fill(String(budget));
  }
  await ta.focus();
  await page.keyboard.press('Meta+Enter');
  await page.getByText('Task started').first().waitFor({ timeout: 15000 }).catch(() => {});
  await sleep(500);
}
async function quick(slug, prompt, budget) {
  const ta = await newForm(slug);
  await ta.fill(prompt);
  await start(ta, budget);
}
async function open(projectName, title) {
  const t = await findTask(projectName, title);
  await go(`/personal/${projectName}/tasks/${t.num}`, 900);
  return t;
}
const agentMsg = (text) => page.locator('.msg.agent', { hasText: text }).last();


const LAPTOP = '/tmp/demo/laptop';
const cliEnv = { ...process.env, KARMAX_GATEWAY_URL: APP, KARMAX_TOKEN: JSON.parse(fs.readFileSync('/tmp/demo/cli-token.json', 'utf8')).token, TAVYA_NO_UPDATE_CHECK: '1' };
const tavyaCli = path.resolve(__dirname, '../../../bin/tavya.js');
/** A frame sequence: step(i) changes the page, then frame i is taken. */
async function frames(name, n, step, marks = {}) {
  if (!want(name)) return;
  const dir = path.join(OUT, name);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) { await step(i); await page.screenshot({ path: path.join(dir, `${String(i).padStart(4, '0')}.jpg`), type: 'jpeg', quality: 92 }); }
  const boxes = {};
  for (const [k, loc] of Object.entries(marks)) boxes[k] = await box(loc);
  manifest[name] = { kind: 'sequence', frames: n, boxes };
  fs.writeFileSync(path.join(OUT, 'shots.json'), JSON.stringify(manifest, null, 1));
  console.log('frames', name, n, JSON.stringify(boxes));
}
/** The form saves what is typed as a draft; drafts are not part of any picture. */
async function dropDrafts() {
  for (const id of Object.values(projects)) {
    const drafts = await api('GET', `/api/projects/${id}/search?q=${encodeURIComponent('is:draft')}`);
    for (const t of drafts.tasks ?? []) await api('DELETE', `/api/tasks/${t.id}`);
  }
}

const VAULT = [
  { type: 'login', label: 'flights/united', domains: ['united.com'], username: 'MileagePlus', policy: { use: 'ask', reveal: 'ask' }, secrets: { password: 'demo-not-a-password' } },
  { type: 'api-key', label: 'hetzner.com', domains: ['hetzner.com'], envVar: 'HCLOUD_TOKEN', secrets: { secret: 'demo-not-a-key' } },
  { type: 'api-key', label: 'cloudflare.com', domains: ['cloudflare.com'], envVar: 'CLOUDFLARE_API_TOKEN', secrets: { secret: 'demo-not-a-key' } },
  { type: 'ssh-key', label: 'deploy@tavya.io', secrets: { privateKey: 'demo-not-a-key' } },
  { type: 'login', label: 'amazon.com', domains: ['amazon.com'], username: 'abhimanyu', policy: { use: 'ask', reveal: 'ask' }, secrets: { password: 'demo-not-a-password' } },
];
async function prepare() {
  for (const item of VAULT) await api('POST', '/api/vault/items', item);
  // admin_docs' folder: pretend documents for the flight.
  fs.mkdirSync(LAPTOP, { recursive: true });
  fs.rmSync(path.join(LAPTOP, 'admin-docs'), { recursive: true, force: true });
  spawnSync('node', [tavyaCli, 'clone', 'personal/admin_docs'], { cwd: LAPTOP, env: cliEnv });
  fs.mkdirSync(path.join(LAPTOP, 'admin-docs/documents'), { recursive: true });
  fs.writeFileSync(path.join(LAPTOP, 'admin-docs/documents/passport.pdf'), '%PDF-1.4\n% demo\n');
  fs.writeFileSync(path.join(LAPTOP, 'admin-docs/documents/loyalty-programmes.md'), '# Loyalty programmes\n\n- United MileagePlus: XX000000 (demo)\n');
  spawnSync('node', [tavyaCli, 'add', 'documents'], { cwd: path.join(LAPTOP, 'admin-docs'), env: cliEnv });
  // The video the launch-video task delivers: the film itself (the compositor draws its new first frame over it).
  if (process.env.FILM && fs.existsSync(process.env.FILM)) fs.copyFileSync(process.env.FILM, '/tmp/demo/assets/launch-v1.mp4');
}

const PROMPTS = {
  video: 'Create a launch video for tavya.io that shows just how great it is',
  homepage: 'Can you make my homepage design nicer and cleaner? I think it was designed by an OpenAI model which gives it the weird khaki color look.',
  cv: 'Update my CV to include tavya under my list of projects',
  seo: "Do a pass of tavya's SEO",
  slides: 'Fill in slides.md with content from README.md and the experimental results.',
  flight: 'Book me the cheapest direct flight to London on January 3 with reasonable timings. My passport, loyalty card numbers etc. are in this folder.',
  errors: 'Whenever something breaks on the server, fix it.',
};
// The automations "The autonomous company" shows, as repeatable tasks (dependency updates and Dream are being built: mocked here).
const AUTOMATIONS = [
  { key: 'auto-deps', title: 'Update dependencies', prompt: 'A dependency published a new version: bump it, adapt the code to what changed, run the tests, and open a pull request.',
    params: { repeatable: true, triggers: [{ kind: 'event', type: 'dependency.released', recurring: true }] } },
  { key: 'auto-dream', title: 'Dream', prompt: 'Go over what happened since the last dream: tidy the wiki\'s memories, notice what keeps going wrong, and propose improvements.',
    params: { repeatable: true, triggers: [{ kind: 'schedule', cron: '0 3 * * *', recurring: true }] } },
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox', '--font-render-hinting=none'] });
  context = await browser.newContext({ storageState: '/tmp/demo/state.json', viewport: { width: W, height: H }, deviceScaleFactor: DPR, colorScheme: 'light' });
  await context.route('**/api/meta', async (route) => { const r = await route.fetch(); route.fulfill({ response: r, json: { ...(await r.json()), hosted: true, hostLocal: false } }); });
  // Every agent in the demo is the scripted mock, whatever the form picked.
  await context.route((u) => u.origin === APP && u.pathname.startsWith('/api/'), async (route) => {
    const req = route.request(), body = req.postData();
    if (!body || !['POST', 'PUT', 'PATCH'].includes(req.method()) || !/"provider"\s*:/.test(body)) return route.fallback();
    return route.fallback({ postData: body.replace(/"provider"\s*:\s*"(claude|codex|opencode)"/g, '"provider":"mock"') });
  });
  await context.addInitScript(() => {
    try { Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }); } catch {}
    try { localStorage.setItem('karmax-theme', 'light'); } catch {}
    document.addEventListener('DOMContentLoaded', () => {
      const s = document.createElement('style');
      s.textContent = '*{caret-color:transparent!important} ::-webkit-scrollbar{width:0!important;height:0!important}';
      document.head.appendChild(s);
    });
  });
  page = await context.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  page.setDefaultTimeout(60000);
  let failed;
  try {
    await prepare();
    // The list fills with work: every task starts, in the same order whatever is shot (numbers stay the same).
    await quick('personal-website', PROMPTS.cv);
    await quick('tavya', PROMPTS.seo);
    await quick('takehomev2', PROMPTS.slides);
    await quick('admin_docs', PROMPTS.flight, 500);
    // The launch video starts now; it is reviewed in 6.
    await quick('tavya', PROMPTS.video);
    const video = await findTask('tavya', 'Create a launch video');
    // 2 · Say what needs doing: the homepage redesign, typed.
    await typed('say', 'personal-website', PROMPTS.homepage);
    const site = await findTask('personal-website', 'Can you make my homepage design');
    // 3 · Its agent at work: the real run of this task on tavya.io (fetch.py), its rows as they arrived.
    if (want('work')) {
      const run = JSON.parse(fs.readFileSync('/tmp/demo/assets/homepage-run.json', 'utf8'))
        .filter((e) => e.payload.id !== 'claude-startup' && !(e.payload.kind === 'turn' && e.payload.phase === 'completed'));
      // Up to where it says the design is verified, and checks it: still mid-run, with its commands on screen.
      const last = run.findIndex((e) => e.payload.kind === 'message' && /verified/.test(e.payload.title)) + 3;
      let upTo = 0, start = 0;
      // The rows keep their real timings, the newest just now; the message that asked sits just before the first.
      await context.route(`**/api/tasks/${site.id}/events*`, async (route) => {
        const r = await route.fetch(), own = await r.json();
        const kept = own.filter((e) => e.type !== 'agent.activity');
        const seq0 = Math.max(0, ...own.map((e) => e.seq ?? 0)) + 1;
        const shown = run.slice(0, upTo), now = Date.now(), end = shown.length ? shown[shown.length - 1].ts : now;
        start = now - (end - run[0].ts);
        const turn = own.find((e) => e.type === 'agent.activity')?.payload ?? {};
        const rows = shown.map((e, i) => ({ seq: seq0 + i, type: 'agent.activity', taskId: site.id, ts: now - (end - e.ts),
          payload: { ...e.payload, workflowRunId: turn.workflowRunId ?? e.payload.workflowRunId, turnId: turn.turnId ?? e.payload.turnId } }));
        route.fulfill({ response: r, json: [...kept, ...rows] });
      });
      const viewUrl = new RegExp(`/api/tasks/${site.id}(\\?|$)`);
      await context.route(viewUrl, async (route) => {
        const r = await route.fetch(), view = await r.json();
        const asked = (o) => { if (o && typeof o === 'object') for (const v of Object.values(o)) {
          if (v && typeof v === 'object' && v.role === 'user' && typeof v.ts === 'number' && /khaki/.test(v.text || '')) v.ts = start - 9000;
          else asked(v);
        } };
        if (start) asked(view);
        route.fulfill({ response: r, json: view });
      });
      await frames('work', 26, async (i) => {
        upTo = Math.round(14 + (last - 14) * Math.pow(i / 25, 1.1));
        await go(`/personal/personal-website/tasks/${site.num}`, i ? 900 : 1500);
        // Every step on show, as in the first cut: the commands are the point.
        await page.evaluate(() => { for (const d of document.querySelectorAll('#tp-body details')) if (d.querySelector(':scope > summary.fold-head')) d.open = true; });
        await sleep(200);
        await page.evaluate(() => { const t = document.querySelector('#tp-body .ck-thread, #tp-body'); if (t) t.scrollTop = t.scrollHeight; });
        await sleep(150);
      }, { thread: page.locator('#tp-body') });
      await context.unroute(viewUrl);
      await context.unroute(`**/api/tasks/${site.id}/events*`);
      manifest.work.url = `/personal/personal-website/tasks/${site.num}`;
      fs.writeFileSync(path.join(OUT, 'shots.json'), JSON.stringify(manifest, null, 1));
    }
    // 1 · One list: everything under way.
    await go('/personal?q=-is%3Aarchived', 1800);
    await shot('home', { first: page.locator('.task-title') });
    // 6 · Review the result: the video it attached, then approve.
    await waitStage('tavya', 'Create a launch video', ['review']);
    await go(`/personal/tavya/tasks/${video.num}`, 2000);
    // A real launch video takes hours; the mock's run took seconds. Show it as it would be.
    await page.evaluate(() => {
      const fmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const fix = () => {
        for (const l of document.querySelectorAll('.fold-label')) if (l.textContent.startsWith('Worked ') && l.textContent !== 'Worked 2 h 40 min') l.textContent = 'Worked 2 h 40 min';
        const you = document.querySelector('.msg.user time');
        if (you && you.dataset.shifted !== you.getAttribute('datetime')) {
          you.textContent = fmt.format(new Date(Date.parse(you.getAttribute('datetime')) - (2 * 3600 + 40 * 60 + 9) * 1000));
          you.dataset.shifted = you.getAttribute('datetime');
        }
      };
      fix(); new MutationObserver(fix).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await sleep(400);
    const tile = page.getByRole('button', { name: 'Launch video' }).first();
    const confirm = page.getByRole('button', { name: /^Confirm/ }).first();
    await shot('review', { tile, confirm });
    if (want('review')) {
      await tile.click();
      await sleep(2500);
      const pic = await page.evaluate(() => {
        const v = [...document.querySelectorAll('video')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
        if (!v) return null;
        try { v.pause(); } catch {}
        const r = v.getBoundingClientRect(), vw = v.videoWidth || 1920, vh = v.videoHeight || 1080, k = Math.min(r.width / vw, r.height / vh);
        return { x: Math.round(r.x + (r.width - vw * k) / 2), y: Math.round(r.y + (r.height - vh * k) / 2), w: Math.round(vw * k), h: Math.round(vh * k) };
      });
      await shot('review-viewer', { close: page.getByRole('button', { name: 'Close' }) });
      manifest['review-viewer'].boxes.picture = pic;
      await page.getByRole('button', { name: 'Close' }).first().click();
      await sleep(500);
      await confirm.click();
      await sleep(2500);
      await shot('review-done', { msg: page.locator('.msg.agent').last() });
    }
    // 4 · Big jobs fan out.
    await go('/personal/tavya/tasks/367', 2500);
    await shot('fanout', { panel: page.locator('.rail-sec.subtasks') });
    // 5 · Accounts, keys and a card: the vault.
    if (want('vault')) {
      await go('/personal/settings#settings-payments', 1800);
      await page.getByText('Vault credentials').filter({ visible: true }).first().click(); await sleep(1500);
      await shot('vault', { dialog: page.locator('dialog[open], [role="dialog"]').filter({ visible: true }) });
      await page.keyboard.press('Escape');
    }
    // 7a · An autonomous project (task #918 builds the toggle: drawn here as it looks there).
    if (want('auto-project')) {
      await go('/personal?q=-is%3Aarchived', 900);
      await page.locator('#new-project').click();
      const name = page.locator('#new-project-name');
      await name.waitFor(); await sleep(400);
      await name.fill('acme');
      await page.evaluate(() => {
        const actions = document.querySelector('.new-project-dialog .new-project-actions');
        const row = document.createElement('label');
        row.className = 'np-autonomous';
        row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:14px 0;margin:4px 0 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);color:var(--ink);font-size:var(--fs-14);cursor:pointer';
        row.innerHTML = '<input type="checkbox" class="toggle" id="np-autonomous"> Fully autonomous project <span style="color:var(--ink-3)">ⓘ</span>';
        actions.parentElement.insertBefore(row, actions);
      });
      await sleep(400);
      const toggle = page.locator('#np-autonomous');
      await frames('auto-project', 2, async (i) => { if (i) { await toggle.check(); await sleep(500); } }, { toggle, name });
      await page.keyboard.press('Escape'); await sleep(400);
    }
    // … and a task's review handed to an agent.
    if (want('auto-review')) {
      const ta = await newForm('tavya');
      await ta.fill('Fix the flaky checkout test');
      const row = page.locator('#tf-page .form-row[data-row="confirm"]');
      await row.scrollIntoViewIfNeeded(); await sleep(500);
      await frames('auto-review', 2, async (i) => {
        if (!i) return;
        await row.locator('[data-route-kind="agent"]').first().click(); await sleep(400);
        const ins = row.getByPlaceholder('Instructions for this agent (optional)').first();
        if (await ins.count()) await ins.fill('Check the tests pass and the change does what was asked.');
        await sleep(500);
      }, { row, agent: row.locator('[data-route-kind="agent"]') });
      await page.keyboard.press('Escape'); await sleep(600);
      await dropDrafts();
    }
    // 7b · Work that starts itself: an agent sets one up…
    await quick('tavya', PROMPTS.errors);
    await waitStage('tavya', 'Whenever something breaks', ['review']);
    await open('tavya', 'Whenever something breaks');
    await sleep(800);
    await shot('auto-created', { msg: agentMsg('Created Task') });
    // … and the automations a company runs on.
    for (const a of AUTOMATIONS) await api('POST', `/api/projects/${projects.tavya}/tasks`, { title: a.title, prompt: a.prompt, params: a.params });
    await api('POST', `/api/projects/${projects.tavya}/task-store/project-wiki`, {});
    await sleep(1500);
    for (const [key, title] of [['auto-deps', 'Update dependencies'], ['auto-wiki', 'Maintain the project wiki'], ['auto-dream', 'Dream']]) {
      // The automation itself (its series), not a run it has started.
      const series = await api('GET', `/api/projects/${projects.tavya}/search?q=${encodeURIComponent('is:series')}`);
      const t = (series.tasks ?? []).find((x) => x.title.startsWith(title));
      if (!t) { console.error('no task', title); continue; }
      await go(`/personal/tavya/tasks/${t.num}`, 1800);
      await shot(key, { head: page.locator('#tp-body').first() });
    }
    await go('/personal/tavya?q=is%3Aseries%20-is%3Aarchived', 1800);
    await shot('auto-series', { list: page.locator('.task-title').first() });
    // 8 · Any model: the picker.
    if (want('models')) {
      await newForm('tavya');
      await page.locator('#tf-page .model-field input[aria-label="Model"]').first().click(); await sleep(1200);
      await shot('models', { field: page.locator('#tf-page .model-field') });
      await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await sleep(600);
      await dropDrafts();
    }
    // 9 · Chores: the flight, booked.
    if (want('flight')) {
      await open('admin_docs', 'Book me the cheapest');
      const ask = page.getByRole('button', { name: /^(Allow for this task|This task)$/ }).first();
      await ask.waitFor({ timeout: 120000 });
      await ask.click();
      const fold = page.locator('summary.fold-head', { hasText: 'Booked:' }).last();
      await fold.waitFor({ timeout: 120000 });
      await sleep(1500);
      const booked = page.locator('.msg.agent', { hasText: 'Confirmation' }).filter({ visible: true });
      for (let i = 0; i < 3 && !(await booked.count()); i++) { await fold.click(); await sleep(900); }
      await booked.last().scrollIntoViewIfNeeded(); await sleep(500);
      await shot('flight', { msg: booked.last() });
    }
    await dropDrafts();
  } catch (e) { failed = e; console.error('capture failed:', e); await page.screenshot({ path: path.join(OUT, 'failure.png') }).catch(() => {}); }
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
