// Captures the third cut's new screens from the demo tavya (build.sh's clone, the
// scripted mock agent): 2x stills and typing sequences at 1440×900, the boxes the
// camera aims at (shots.json), and the CLI's real output (cli.json).
// Run through record.sh, which restores the clone and starts it:
//   DIRECTOR=third-cut/capture.cjs bash record.sh /tmp/demo/v3-assets [shot-filter]
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const APP = 'http://127.0.0.1:48950';
const OUT = process.argv[2] || '/tmp/demo/v3-assets';
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

// ── the CLI, for real ──
const LAPTOP = '/tmp/demo/laptop';
const cliEnv = { ...process.env, KARMAX_GATEWAY_URL: APP, KARMAX_TOKEN: JSON.parse(fs.readFileSync('/tmp/demo/cli-token.json', 'utf8')).token, TAVYA_NO_UPDATE_CHECK: '1' };
const cli = [];
function sh(cwdLabel, cmd, cwd, show = cmd) {
  const r = spawnSync('bash', ['-lc', cmd.replace(/\btavya\b(?=\s)/g, `node ${path.resolve(__dirname, '../../../bin/tavya.js')}`)], { cwd, env: cliEnv, encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`.replaceAll(APP, 'https://tavya.io').trimEnd();
  cli.push({ cwd: cwdLabel, cmd: show, out });
  fs.writeFileSync(path.join(OUT, 'cli.json'), JSON.stringify(cli, null, 1));
  return out;
}

const VAULT = [
  { type: 'login', label: 'Google account', domains: ['play.google.com', 'accounts.google.com'], username: 'abhimanyu', policy: { use: 'ask', reveal: 'ask' }, secrets: { password: 'demo-not-a-password' } },
  { type: 'login', label: 'amazon.com', domains: ['amazon.com'], username: 'abhimanyu', policy: { use: 'ask', reveal: 'ask' }, secrets: { password: 'demo-not-a-password' } },
  { type: 'login', label: 'flights/united', domains: ['united.com'], username: 'MileagePlus', policy: { use: 'ask', reveal: 'ask' }, secrets: { password: 'demo-not-a-password' } },
  { type: 'api-key', label: 'hetzner.com', domains: ['hetzner.com'], envVar: 'HCLOUD_TOKEN', secrets: { secret: 'demo-not-a-key' } },
  { type: 'api-key', label: 'cloudflare.com', domains: ['cloudflare.com'], envVar: 'CLOUDFLARE_API_TOKEN', secrets: { secret: 'demo-not-a-key' } },
];
const DOCUMENTS = {
  'documents/passport.pdf': '%PDF-1.4\n% demo: not a real passport\n',
  'documents/loyalty-programmes.md': '# Loyalty programmes\n\n- United MileagePlus: XX000000 (demo)\n',
  'notes/groceries.md': '# Groceries (the usual)\n\n- [ ] Oat milk ×2\n- [ ] Eggs (12)\n- [ ] Bananas\n- [ ] Coffee beans\n- [ ] Sourdough\n- [ ] Spinach\n- [ ] Greek yoghurt\n- [ ] Chickpeas ×2\n- [ ] Tomatoes\n- [ ] Lemons\n- [ ] Parmesan\n- [ ] Rice\n- [ ] Dark chocolate\n- [ ] Dish soap\n',
};
async function prepare() {
  // An app account the Play Store task asks for (like build.sh's Gmail and Search Console).
  spawnSync('python3', ['-c', `import sqlite3,json,time
c=sqlite3.connect('/tmp/demo/home/state/karmax.db')
u=sqlite3.connect('/tmp/demo/home/state/auth.db').execute('select id from user limit 1').fetchone()[0]
t=int(time.time()*1000)-86400000*30
c.execute('insert or replace into kv (k, v) values (?, ?)', ('service-connection:conn_demo_play', json.dumps({'id':'conn_demo_play','organizationId':'org_personal','ownerId':u,'toolkit':'google_play_console','label':'Google Play Console','projectIds':[],'status':'active','createdAt':t,'updatedAt':t,'accountId':'ca_conn_demo_play'})))
c.commit()`]);
  for (const item of VAULT) await api('POST', '/api/vault/items', item);
  fs.mkdirSync(LAPTOP, { recursive: true });
  fs.rmSync(path.join(LAPTOP, 'admin-docs'), { recursive: true, force: true });
  spawnSync('bash', ['-lc', `node ${path.resolve(__dirname, '../../../bin/tavya.js')} clone personal/admin_docs`], { cwd: LAPTOP, env: cliEnv });
  for (const [f, text] of Object.entries(DOCUMENTS)) {
    fs.mkdirSync(path.dirname(path.join(LAPTOP, 'admin-docs', f)), { recursive: true });
    fs.writeFileSync(path.join(LAPTOP, 'admin-docs', f), text);
  }
  spawnSync('bash', ['-lc', `node ${path.resolve(__dirname, '../../../bin/tavya.js')} add documents notes`], { cwd: path.join(LAPTOP, 'admin-docs'), env: cliEnv });
  cli.length = 0;
}
// Apps named as people know them (a request carries the toolkit's slug).
function labelApps() {
  spawnSync('python3', ['-c', `import sqlite3,json
c=sqlite3.connect('/tmp/demo/home/state/karmax.db')
for k,v in list(c.execute("select k,v from kv where k like 'service-connection:%'")):
  d=json.loads(v)
  if d.get('taskId'): d['label']={'gmail':'Gmail','google_search_console':'Google Search Console','google_play_console':'Google Play Console'}.get(d['toolkit'],d['label']); c.execute('update kv set v=? where k=?',(json.dumps(d),k))
c.commit()`]);
}
async function allowApps() {
  const allow = page.getByRole('button', { name: 'Allow', exact: true });
  await allow.first().waitFor({ timeout: 120000 });
  labelApps(); await page.reload(); await page.locator('#main').waitFor(); await sleep(900);
}

const PROMPTS = {
  cv: 'Update my CV to include tavya under my list of projects',
  domain: 'Buy the domain tavya.io, creating whatever accounts you need, and have this deploy there automatically',
  play: 'Publish tavya on the Google Play Store, and stay on top of reviews, crashes and new releases.',
  grocery: "Order this week's groceries from Amazon: the usual list is in my notes. Saturday morning delivery.",
  seo: "Do a pass of tavya's SEO",
  trigger: 'Create a repeatable task that is triggered by codex/claude code updates on github and updates tavya to be compatible with them.',
  flight: 'Book me the cheapest direct flight to London on January 3 with reasonable timings. My passport, loyalty card numbers etc. are in this folder.',
  finale: 'Create a launch video for tavya.io that shows just how great it is',
};

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
    // ── typed, then everything else started at once (the list fills with work) ──
    // Every task is started, in the same order, whatever is being shot: task numbers stay the same.
    await typed('cv-type', 'personal-website', PROMPTS.cv, { models: 'cv-models' });
    await quick('tavya', PROMPTS.domain, 25);
    await quick('tavya', PROMPTS.play, 30);
    await quick('admin_docs', PROMPTS.grocery, 100);
    await quick('tavya', PROMPTS.seo);
    await quick('tavya', PROMPTS.trigger);
    await quick('admin_docs', PROMPTS.flight, 500);
    if (want('home')) { await go('/personal?q=-is%3Aarchived', 1800); await shot('home', { first: page.locator('.task-title') }); }

    // ── accounts, keys and a card: what they are for ──
    if (want('domain')) {
    await open('tavya', 'Buy the domain');
    await page.getByText('fill_payment_card', { exact: false }).first().waitFor({ timeout: 120000 }).catch(() => {});
    await shot('domain-work', { body: page.locator('#tp-body') });
    await waitStage('tavya', 'Buy the domain', ['review']);
    await open('tavya', 'Buy the domain');
    await shot('domain-done', { msg: agentMsg('Bought tavya.io') });
    }

    let ask;
    if (want('play')) {
    await open('tavya', 'Publish tavya on the Google Play');
    ask = page.getByRole('button', { name: 'This task', exact: true }).first();
    await ask.waitFor({ timeout: 120000 });
    await sleep(800);
    await shot('play-ask', { msg: agentMsg('Google account'), approve: ask });
    await ask.click();
    await allowApps();
    await shot('play-gmail', { msg: agentMsg('Google Play Console'), allow: page.getByRole('button', { name: 'Allow', exact: true }) });
    await page.getByRole('button', { name: 'Allow', exact: true }).first().click();
    await waitStage('tavya', 'Publish tavya on the Google Play', ['review']);
    await open('tavya', 'Publish tavya on the Google Play');
    await shot('play-done', { msg: agentMsg('tavya is on Google Play') });
    }

    if (want('grocery')) {
    await open('admin_docs', "Order this week");
    ask = page.getByRole('button', { name: 'This task', exact: true }).first();
    await ask.waitFor({ timeout: 120000 });
    await sleep(800);
    await shot('grocery-ask', { msg: agentMsg('Amazon login'), approve: ask });
    await ask.click();
    await page.getByText('Ordered', { exact: false }).last().waitFor({ timeout: 120000 });
    await sleep(1200);
    await shot('grocery-done', { msg: agentMsg('Ordered') });
    }

    // ── the autonomous company ──
    if (want('ai-')) {
    await open('tavya', "Do a pass of tavya's SEO");
    await allowApps();
    for (let i = 0; i < 4 && await page.getByRole('button', { name: 'Allow', exact: true }).count(); i++) { await page.getByRole('button', { name: 'Allow', exact: true }).first().click(); await sleep(800); }
    await waitStage('tavya', "Do a pass of tavya's SEO", ['review']);
    await open('tavya', "Do a pass of tavya's SEO");
    await page.getByRole('link', { name: 'Parameters' }).click();
    const row = page.locator('.form-row[data-row="confirm"]');
    await row.scrollIntoViewIfNeeded();
    await row.locator('[data-route-kind="agent"]').first().click();
    await sleep(300);
    const ins = row.getByPlaceholder('Instructions for this agent (optional)').first();
    await ins.fill('Run it. Check every public page has its own title and the sitemap is valid.');
    await sleep(400);
    await shot('ai-route', { row });
    await page.getByRole('button', { name: 'Save parameter changes' }).click();
    await sleep(500);
    await page.getByRole('link', { name: 'Chat' }).click();
    await waitStage('tavya', "Do a pass of tavya's SEO", ['done', 'merge']);
    await open('tavya', "Do a pass of tavya's SEO");
    await shot('ai-reviewed', { msg: page.locator('.msg', { hasText: 'Checked the diff' }).last() });
    }

    if (want('mcp', 'series', 'store')) {
    await waitStage('tavya', 'Create a repeatable task', ['review']);
    await open('tavya', 'Create a repeatable task');
    await shot('mcp-trigger', { msg: agentMsg('Watch agent CLI releases') });
    for (const id of ['triage-issues', 'build-planned-issues', 'repair-github-workflow']) {
      const r = await api('POST', `/api/projects/${projects.tavya}/task-store/${id}`, {});
      console.log('store', id, r.error ?? r.id ?? JSON.stringify(r).slice(0, 120));
    }
    await go('/personal/tavya?q=is%3Aseries%20-is%3Aarchived', 1500);
    await shot('series', { list: page.locator('.task-title') });
    await page.getByText('Task store', { exact: true }).first().click().catch(() => {});
    await sleep(1500);
    await shot('store', { first: page.getByText('Triage issues daily', { exact: false }) });
    }

    // ── not just code: the CLI, photos, then a flight ──
    if (want('photos', 'albums', 'cli')) {
    fs.rmSync(path.join(LAPTOP, 'random'), { recursive: true, force: true });
    fs.rmSync(path.join(LAPTOP, 'photos'), { recursive: true, force: true });
    spawnSync('cp', ['-r', '/tmp/demo/photos-original', path.join(LAPTOP, 'photos')]);
    sh('~', 'tavya clone personal/random && cd random', LAPTOP);
    sh('~/random', 'mv ../photos . && tavya add photos', path.join(LAPTOP, 'random'), 'mv ~/Pictures/photos . && tavya add photos');
    const res = await api('GET', `/api/projects/${projects.random}/resources`);
    for (const r of (Array.isArray(res) ? res : res.resources ?? [])) if (r.name === 'photos')
      await api('PATCH', `/api/projects/${projects.random}/resources/${r.id}`, { access: 'write', publish: 'review' });
    sh('~/random', 'tavya task new "Sort my photos in whatever manner seems best to you."', path.join(LAPTOP, 'random'));
    await waitStage('random', 'Sort my photos', ['review']);
    await open('random', 'Sort my photos');
    await shot('photos-review', { tile: page.getByRole('button', { name: 'Albums' }), confirm: page.getByRole('button', { name: /^Confirm/ }) });
    await page.getByRole('button', { name: 'Albums' }).first().click();
    await sleep(1500);
    await shot('albums');
    await page.getByRole('button', { name: 'Close' }).first().click();
    await sleep(300);
    await page.getByRole('button', { name: /^Confirm/ }).first().click();
    await waitStage('random', 'Sort my photos', ['done']);
    sh('~/random', 'tavya pull && ls photos', path.join(LAPTOP, 'random'));
    }

    if (want('flight')) {
    await open('admin_docs', 'Book me the cheapest');
    ask = page.getByRole('button', { name: 'This task', exact: true }).first();
    await ask.waitFor({ timeout: 120000 });
    await sleep(800);
    await shot('flight-ask', { msg: agentMsg('United login'), approve: ask });
    await ask.click();
    const fold = page.locator('summary.fold-head', { hasText: 'Booked:' }).last();
    await fold.waitFor({ timeout: 120000 });
    await sleep(1500);
    const booked = page.locator('.msg.agent', { hasText: 'Confirmation' }).filter({ visible: true });
    for (let i = 0; i < 3 && !(await booked.count()); i++) { await fold.click(); await sleep(900); }
    await booked.last().scrollIntoViewIfNeeded();
    await sleep(500);
    await shot('flight-booked', { msg: booked.last() });
    }

    // ── and one more ──
    if (want('finale')) {
    await typed('finale-type', 'tavya', PROMPTS.finale);
    await open('tavya', 'Create a launch video');
    // A real launch video takes hours; the mock finishes in seconds. Show the run as it would be.
    const fixRun = () => page.evaluate(() => {
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
    await waitStage('tavya', 'Create a launch video', ['review']);
    await open('tavya', 'Create a launch video');
    await fixRun();
    await sleep(600);
    const tile = page.getByRole('button', { name: 'Launch video' }).first();
    await shot('finale-review', { tile, msg: agentMsg('launch video is ready') });
    await tile.click();
    await sleep(2500);
    // Where the viewer's picture sits (object-fit: contain); the compositor draws the film's
    // first frame over it, so the video's own frame does not matter.
    const pic = await page.evaluate(() => {
      const v = [...document.querySelectorAll('video')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
      if (!v) return null;
      try { v.pause(); } catch {}
      const r = v.getBoundingClientRect(), vw = v.videoWidth || 1920, vh = v.videoHeight || 1080, k = Math.min(r.width / vw, r.height / vh);
      return { x: Math.round(r.x + (r.width - vw * k) / 2), y: Math.round(r.y + (r.height - vh * k) / 2), w: Math.round(vw * k), h: Math.round(vh * k) };
    });
    await shot('finale-viewer');
    if (manifest['finale-viewer']) manifest['finale-viewer'].boxes.picture = pic;
    }
    fs.writeFileSync(path.join(OUT, 'shots.json'), JSON.stringify(manifest, null, 1));
  } catch (e) { failed = e; console.error('capture failed:', e); await page.screenshot({ path: path.join(OUT, 'failure.png') }).catch(() => {}); }
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
