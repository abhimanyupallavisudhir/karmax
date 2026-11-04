// Records the launch video in one take against the demo tavya.
// Usage: node director.cjs <out-dir> [scene,scene…]
// Frames: <out>/frames/NNNNNNN.jpg + frames.json [{f, t}], marks.json [{t, name, speed}].
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const APP = 'http://127.0.0.1:48950';
const OUT = process.argv[2] || '/tmp/demo/rec';
const ONLY = process.argv[3] ? new Set(process.argv[3].split(',')) : null;
const SHOW_HOST = 'https://tavya.io';
const projects = JSON.parse(fs.readFileSync('/tmp/demo/projects.json', 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const Z = 4 / 3; // the stage is laid out at 1440×810 and drawn at 1920×1080

const marks = [];
let frames = [], introFrame; // introFrame: the film's first frame, which the ending zooms into
const mark = (name, speed = 1) => { marks.push({ t: Date.now() / 1000, name, speed }); console.log(`[${new Date().toISOString().slice(11, 19)}] ${name} ×${speed}`); };

let page, context;
const F = () => page.frame({ name: 'app' });
const demo = (fn, ...args) => page.evaluate(([f, a]) => window.__demo[f](...a), [fn, args]);
const caption = (html) => page.evaluate((h) => window.__demo.caption(h), html);

async function boxOf(locator) {
  await locator.waitFor({ state: 'visible', timeout: 60000 });
  // Keep it clear of sticky bars: scroll it towards the middle when near an edge.
  const moved = await locator.evaluate((e) => {
    const r = e.getBoundingClientRect();
    if (r.top > 90 && r.bottom < innerHeight - 130) return false;
    e.scrollIntoView({ block: 'center', behavior: 'smooth' }); return true;
  }).catch(() => false);
  if (moved) await sleep(650);
  const b = await locator.boundingBox();
  // Page pixels (1920×1080) → stage pixels (1440×810), the stage's own coordinates.
  return { x: b.x / Z, y: b.y / Z, width: b.width / Z, height: b.height / Z };
}
/** Moves the cursor to the element like a hand would, then clicks it. */
async function click(locator, { ms, dx = 0.5, dy = 0.5, pause = 120 } = {}) {
  const b = await boxOf(locator);
  const x = b.x + b.width * dx, y = b.y + b.height * dy;
  const cur = await page.evaluate(() => window.__demo.where());
  const dist = Math.hypot(x - cur[0], y - cur[1]);
  await demo('move', x, y, ms ?? Math.max(320, Math.min(900, 260 + dist * 0.7)));
  await sleep(pause);
  await demo('ripple');
  await page.mouse.click(x * Z, y * Z);
}
/** Zoom the window onto an element (its centre, shifted down by `down` of the window height). */
async function zoomOn(locator, scale = 1.4, down = 0) {
  const b = await boxOf(locator.filter({ visible: true }).first());
  const g = await page.evaluate(() => window.__demo.geometry);
  await page.evaluate(([s, x, y]) => window.__demo.camera(s, x, y, 900), [scale, b.x + b.width / 2, b.y + b.height / 2 + g.WH * down / scale]);
}
async function type(text, delay = 34) { await page.keyboard.type(text, { delay }); }
async function key(k) { await page.keyboard.press(k); }
// In-app navigation (the console's own router), so a scene change never flashes a blank page.
async function goto(url) {
  await F().evaluate((u) => { history.pushState({}, '', u); dispatchEvent(new PopStateEvent('popstate')); }, url);
  await F().locator('#main').waitFor(); await sleep(700);
}
const api = async (method, p, body) => {
  const r = await context.request.fetch(APP + p, { method, data: body, headers: { origin: APP } });
  return r.json().catch(() => ({}));
};
/** The newest task in a project whose title starts with `title`. */
async function findTask(projectName, title) {
  const d = await api('GET', `/api/projects/${projects[projectName]}/search?q=${encodeURIComponent('sort:created-desc')}`);
  return (d.tasks ?? []).find((t) => t.title.startsWith(title));
}
async function waitStage(projectName, title, stages, timeout = 240000) {
  const t0 = Date.now();
  for (;;) {
    const t = await findTask(projectName, title);
    if (t) { const v = await api('GET', `/api/tasks/${t.id}`); if (stages.includes(v.stage) || stages.includes(v.status) || stages.includes(`${v.stage}/${v.status}`)) return v; }
    if (Date.now() - t0 > timeout) throw new Error(`${projectName} "${title}" never reached ${stages}`);
    await sleep(700);
  }
}
const SLUG = { tavya: 'tavya', 'personal-website': 'personal-website', random: 'random' };
/** Opens a task: by clicking its row when that is part of the story, else (or if the
 *  list re-sorted under the cursor) through the console's router. */
async function openTask(projectName, title, { click: viaRow = false } = {}) {
  let t;
  for (let i = 0; i < 40 && !(t = await findTask(projectName, title)); i++) await sleep(500);
  const url = `/personal/${SLUG[projectName]}/tasks/${t.num}`;
  if (viaRow) {
    await click(F().locator('.task-title', { hasText: title.replace(/^## /, '') }).first()).catch(() => {});
    await sleep(900);
  }
  if (!(await F().evaluate(() => location.pathname)).startsWith(url)) await goto(url);
  await F().locator('#tp-body').waitFor();
  return t;
}
/** A new task from anywhere: n → project → template → prompt. */
async function newTask(projectQuery, prompt, { paste, before, delay = 30 } = {}) {
  await key('n');
  await F().locator('#pal-in, .palette input').first().waitFor();
  await sleep(150);
  await type(projectQuery, 55);
  await sleep(220);
  await key('Enter');
  await sleep(260);
  await key('Enter');
  await F().locator('#tf-page textarea').first().waitFor();
  await sleep(250);
  await type(prompt, delay);
  if (paste) { await sleep(150); await page.keyboard.insertText(paste); }
  if (before) await before();
  await sleep(300);
  await key('Meta+Enter');
  await F().getByText('Task started').first().waitFor({ timeout: 15000 }).catch(() => {});
}

// ── the CLI, for real, against the demo tavya ────────────────────────────
const LAPTOP = '/tmp/demo/laptop';
const cliEnv = { ...process.env, KARMAX_GATEWAY_URL: APP, KARMAX_TOKEN: JSON.parse(fs.readFileSync('/tmp/demo/cli-token.json', 'utf8')).token, TAVYA_NO_UPDATE_CHECK: '1' };
function sh(cmd, cwd) {
  const r = spawnSync('bash', ['-lc', cmd.replace(/\btavya\b(?=\s)/g, `node ${path.resolve(__dirname, '../../bin/tavya.js')}`)], { cwd, env: cliEnv, encoding: 'utf8' });
  return `${r.stdout}${r.stderr}`.replaceAll(APP, SHOW_HOST).trimEnd();
}
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
async function termRun(cwdLabel, cmd, cwd, { show = cmd, colour } = {}) {
  await page.evaluate((h) => window.__demo.term.html(h), `<span class="p">${cwdLabel}</span> <span class="dim">$</span> `);
  await page.evaluate(([t]) => window.__demo.term.type(t, 34), [show]);
  await sleep(250);
  const out = sh(cmd, cwd);
  const lines = out.split('\n').map((l) => colour ? colour(esc(l)) : esc(l)).join('\n');
  await page.evaluate((h) => window.__demo.term.html(h), `\n${lines}${lines ? '\n' : ''}`);
  return out;
}

// ── scenes ───────────────────────────────────────────────────────────────
const S = {};
let photoUrl;
const ACTIVE = '/personal?q=-is%3Aarchived';

S.intro = async () => {
  await demo('cursorVisible', false);
  await sleep(400);
  introFrame = frames[frames.length - 1]?.f;
  mark('intro', 1);
  await page.evaluate(() => window.__demo.cardSub());
  await sleep(2600);
  await page.evaluate(() => window.__demo.card({ word: null }));
  await sleep(700);
  await demo('cursorVisible', true);
};

const OVERHAUL = fs.readFileSync('/tmp/demo/assets/815-prompt.md', 'utf8');
S.rapid = async () => {
  mark('rapid', 1);
  await caption('Write a task. Hit <kbd>⌘</kbd><kbd>↵</kbd>. Write the next one.');
  await sleep(900);
  mark('rapid-typing', 1.6);
  const firstLine = OVERHAUL.split('\n').slice(0, 3).join('\n');
  await newTask('tav', firstLine.slice(0, 60), { paste: OVERHAUL.slice(60), delay: 26 });
  await newTask('tav', 'Buy the domain tavya.io, creating whatever accounts you need, and have this deploy there automatically', {
    delay: 24,
    before: async () => {
      mark('budget', 1);
      await click(F().locator('summary', { hasText: 'Authorization' }).first());
      await sleep(250);
      const budget = F().locator('#tf-payments-budget');
      await click(budget);
      await budget.focus();
      await budget.fill('');
      await type('25', 120);
      await sleep(600);
      mark('rapid-typing2', 1.6);
    },
  });
  await newTask('web', 'Update my CV to include tavya under my list of projects', { delay: 26 });
  await newTask('tav', "Do a pass of tavya's SEO", { delay: 30 });
  mark('rapid-done', 1);
  await caption('Each runs on its own computer, in parallel.');
  await demo('move', 1180, 520, 700);
  await sleep(1900);
};

S.domain = async () => {
  mark('domain-open', 1);
  await caption(null);
  await openTask('tavya', 'Buy the domain', { click: true });
  await caption('Give it a card and a budget. It signs up, pays and deploys.');
  mark('domain-work', 5);
  await waitStage('tavya', 'Buy the domain', ['review']);
  await sleep(700);
  mark('domain-message', 1);
  await zoomOn(F().getByText('Bought tavya.io', { exact: false }), 1.4);
  await sleep(3000);
  await demo('camera', 1);
  await sleep(300);
  mark('domain-confirm', 1);
  await click(F().getByRole('button', { name: /Confirm/ }).first());
  await sleep(400);
  await demo('move', 900, 300, 600);
  await sleep(500);
};

S.seo = async () => {
  mark('seo-open', 1.5);
  await goto(ACTIVE);
  await openTask('tavya', "Do a pass of tavya's SEO", { click: true });
  await caption('Agents ask for the accounts they need. You click <em>Allow</em>.');
  await F().getByRole('button', { name: 'Allow', exact: true }).first().waitFor({ timeout: 120000 });
  // Name the apps as people know them (Composio requests carry the toolkit slug).
  spawnSync('python3', ['-c', `import sqlite3,json
c=sqlite3.connect('/tmp/demo/home/state/karmax.db')
for k,v in list(c.execute("select k,v from kv where k like 'service-connection:%'")):
  d=json.loads(v)
  if d.get('taskId'): d['label']={'gmail':'Gmail','google_search_console':'Google Search Console'}.get(d['toolkit'],d['label']); c.execute('update kv set v=? where k=?',(json.dumps(d),k))
c.commit()`]);
  await goto(await F().evaluate(() => location.pathname));
  await sleep(900);
  mark('seo-allow', 1);
  await click(F().getByRole('button', { name: 'Allow', exact: true }).first());
  await sleep(700);
  await click(F().getByRole('button', { name: 'Allow', exact: true }).first());
  await sleep(1600);
};

S.cv = async () => {
  mark('cv-open', 1);
  await openTask('personal-website', 'Update my CV');
  await waitStage('personal-website', 'Update my CV', ['review']);
  await caption('Review it yourself…');
  await sleep(1300);
  mark('cv-params', 1);
  await click(F().getByRole('link', { name: 'Parameters' }));
  const row = F().locator('.form-row[data-row="confirm"]');
  await row.scrollIntoViewIfNeeded();
  await sleep(300);
  await caption('…or remove the reviewer, and it confirms itself.');
  await click(row.locator('.cf-del').first());
  await sleep(500);
  await click(F().getByRole('button', { name: 'Save parameter changes' }));
  mark('cv-landing', 4);
  await waitStage('personal-website', 'Update my CV', ['done']);
  mark('cv-done', 1);
  await click(F().getByRole('link', { name: 'Chat' }));
  await sleep(1500);
};

S.seoReview = async () => {
  mark('seo-review', 1);
  await openTask('tavya', "Do a pass of tavya's SEO");
  await waitStage('tavya', "Do a pass of tavya's SEO", ['review']);
  await caption('…or hand the review to an AI reviewer.');
  await sleep(600);
  await click(F().getByRole('link', { name: 'Parameters' }));
  const row = F().locator('.form-row[data-row="confirm"]');
  await row.scrollIntoViewIfNeeded();
  await sleep(300);
  await click(row.locator('[data-route-kind="agent"]').first());
  await sleep(300);
  const ins = row.getByPlaceholder('Instructions for this agent (optional)').first();
  await click(ins);
  await ins.focus();
  mark('seo-review-typing', 2.4);
  await type('Run it. Check every public page has its own title and the sitemap is valid.', 22);
  mark('seo-review-save', 1);
  await click(F().getByRole('button', { name: 'Save parameter changes' }));
  await sleep(400);
  await click(F().getByRole('link', { name: 'Chat' }));
  mark('seo-reviewing', 3);
  await waitStage('tavya', "Do a pass of tavya's SEO", ['done', 'merge']);
  mark('seo-reviewed', 1);
  await zoomOn(F().getByText('Checked the diff', { exact: false }), 1.35);
  await sleep(2600);
  await demo('camera', 1);
  await sleep(200);
};

S.overhaul = async () => {
  mark('overhaul', 1);
  await openTask('tavya', '## usability overhaul');
  await waitStage('tavya', '## usability overhaul', ['review']);
  await caption('Check the proof, and approve.');
  await sleep(400);
  await click(F().getByRole('button', { name: /Tasks: classic vs new/ }).first());
  await sleep(2000);
  await click(F().getByRole('button', { name: 'Close' }).first());
  await sleep(300);
  await click(F().getByRole('button', { name: /Confirm/ }).first());
  await sleep(1400);
};

const TRIGGER = 'Create a repeatable task that is triggered by codex/claude code updates on github and updates tavya to be compatible with them.';
S.trigger = async () => {
  mark('trigger', 1);
  await goto(ACTIVE);
  await caption('Tasks can start themselves: on a schedule, an event, or after another task.');
  mark('trigger-typing', 1.8);
  await newTask('tav', TRIGGER, { delay: 22 });
  mark('trigger-open', 1);
  await openTask('tavya', 'Create a repeatable task', { click: true });
  await caption('Agents use tavya too, through its MCP.');
  mark('trigger-work', 4);
  await waitStage('tavya', 'Create a repeatable task', ['review']);
  mark('trigger-message', 1);
  await zoomOn(F().getByText('Watch agent CLI releases', { exact: false }), 1.35);
  await sleep(2600);
  await demo('camera', 1);
  mark('trigger-series', 1);
  await goto('/personal/tavya?q=is%3Aseries%20-is%3Aarchived');
  await caption('Tasks can start themselves: on a schedule, an event, or after another task.');
  await sleep(600);
  await zoomOn(F().getByText('Watch agent CLI releases', { exact: false }), 1.5);
  await sleep(1900);
  await demo('camera', 1);
  await sleep(200);
};

S.cli = async () => {
  mark('cli', 1);
  fs.rmSync(path.join(LAPTOP, 'random'), { recursive: true, force: true });
  fs.rmSync(path.join(LAPTOP, 'photos'), { recursive: true, force: true });
  execFileSync('cp', ['-r', '/tmp/demo/photos-original', path.join(LAPTOP, 'photos')]);
  await caption(null);
  await demo('cursorVisible', false);
  await demo('scrim', true);
  await page.evaluate(() => window.__demo.term.open('abhimanyu — ~'));
  await sleep(400);
  await caption('Work from your laptop too: the tavya CLI.');
  mark('cli-typing', 1.6);
  await termRun('~', 'tavya clone personal/random && cd random', LAPTOP, { colour: (l) => l.startsWith('Cloned') ? `<span class="ok">${l}</span>` : l });
  await termRun('~/random', 'mv ../photos . && tavya add photos', path.join(LAPTOP, 'random'), { show: 'mv ~/Pictures/photos . && tavya add photos' });
  // Data the agent may reorganize (the project setting a person would flip once).
  const res = await api('GET', `/api/projects/${projects.random}/resources`);
  for (const r of (Array.isArray(res) ? res : res.resources ?? [])) if (r.name === 'photos')
    await api('PATCH', `/api/projects/${projects.random}/resources/${r.id}`, { access: 'write', publish: 'review' });
  const out = await termRun('~/random', 'tavya task new "Sort my photos in whatever manner seems best to you."', path.join(LAPTOP, 'random'));
  photoUrl = out.match(/https?:\/\/\S+/)?.[0]?.replace(SHOW_HOST, '');
  await page.evaluate(() => window.__demo.term.caret());
  mark('cli-typed', 1);
  await sleep(900);
  await page.evaluate(() => window.__demo.term.close());
  await demo('scrim', false);
  await demo('cursorVisible', true);
  await goto(photoUrl || '/personal/random');
  mark('cli-work', 4);
  await waitStage('random', 'Sort my photos', ['review']);
  mark('cli-review', 1);
  await sleep(500);
  await click(F().getByRole('button', { name: 'Albums' }).first());
  await sleep(2300);
  await click(F().getByRole('button', { name: 'Close' }).first());
  await sleep(250);
  await click(F().getByRole('button', { name: /^Confirm/ }).first());
  mark('cli-landing', 4);
  await waitStage('random', 'Sort my photos', ['done']);
  mark('cli-pull', 1);
  await demo('cursorVisible', false);
  await demo('scrim', true);
  await page.evaluate(() => window.__demo.term.open('abhimanyu — ~/random'));
  await sleep(300);
  await termRun('~/random', 'tavya pull && ls photos', path.join(LAPTOP, 'random'));
  await page.evaluate(() => window.__demo.term.caret());
  await sleep(2000);
  await page.evaluate(() => window.__demo.term.close());
  await demo('scrim', false);
  await demo('cursorVisible', true);
  await sleep(300);
};

S.wiki = async () => {
  mark('wiki', 1);
  await caption(null);
  await goto('/personal/tavya/wiki');
  await caption('What agents learn, they write down: in a wiki you can read.');
  await sleep(900);
  await click(F().getByText('Message forms', { exact: false }).first());
  await sleep(2300);
};

S.checklist = async () => {
  mark('checklist', 1);
  await caption(null);
  await demo('cursorVisible', false);
  await demo('scrim', true);
  const rows = [
    ['Claude Code, Codex and OpenCode', 'your subscription or key'],
    ['A cloud computer per task', 'E2B · Hetzner · AWS · Google Cloud · Fly.io'],
    ['A vault for logins, keys and cards', 'with budgets'],
    ['Any app, over MCP', 'you approve each one'],
    ['Sub-tasks, dependencies, schedules, events', ''],
    ['Human or AI review, then it lands', ''],
    ['Live previews of what agents build', ''],
    ['Insights on work, tokens and compute', ''],
  ];
  await page.evaluate((r) => window.__demo.list.open('Also on the list', r), rows);
  for (let i = 0; i < rows.length; i++) { await page.evaluate((j) => window.__demo.list.show(j), i); await sleep(140); }
  await sleep(250);
  for (let i = 0; i < rows.length; i++) { await page.evaluate((j) => window.__demo.list.tick(j), i); await sleep(290); }
  await sleep(1300);
  await page.evaluate(() => window.__demo.list.close());
  await demo('scrim', false);
  await demo('cursorVisible', true);
  await sleep(400);
};

S.finale = async () => {
  mark('finale', 1);
  await goto(ACTIVE);
  await caption('And one more.');
  mark('finale-typing', 1.6);
  await newTask('tav', 'Create a launch video for tavya.io that shows just how great it is', { delay: 30 });
  mark('finale-open', 1);
  await openTask('tavya', 'Create a launch video', { click: true });
  await caption(null);
  mark('finale-work', 4);
  await waitStage('tavya', 'Create a launch video', ['review']);
  mark('finale-review', 1);
  await sleep(700);
  await click(F().getByRole('button', { name: 'Launch video' }).first());
  // The viewer's video (the review card has a small one of its own): the largest.
  await F().waitForFunction(() => document.querySelectorAll('video').length > 1, null, { timeout: 20000 });
  await sleep(900); // the viewer finishes opening
  await F().evaluate(() => { window.__viewer = [...document.querySelectorAll('video')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
    const v = window.__viewer; v.muted = true; v.pause(); v.currentTime = 0; });
  await F().waitForFunction(() => window.__viewer.readyState >= 2, null, { timeout: 20000 });
  await demo('cursorVisible', false);
  // Where the picture itself sits (object-fit: contain), in stage pixels.
  const [bx, by, bw, bh, vw, vh] = await F().evaluate(() => { const v = window.__viewer, r = v.getBoundingClientRect(); return [r.x, r.y, r.width, r.height, v.videoWidth, v.videoHeight]; });
  const g = await page.evaluate(() => window.__demo.geometry);
  const box = { x: g.X0 + bx * g.S, y: g.Y0 + g.BAR + by * g.S, width: bw * g.S, height: bh * g.S };
  const k = Math.min(box.width / vw, box.height / vh), cw = vw * k, ch = vh * k;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  // Into the video, held on its first frame (the film's own first frame, so it loops):
  // that frame, laid exactly over the picture, grows to fill the screen.
  mark('finale-zoom', 1);
  await page.evaluate(([x, y, w, h]) => window.__demo.still('/__stage/first.png', x, y, w, h, 1500), [cx - cw / 2, cy - ch / 2, cw, ch]);
  await sleep(500);
  mark('end', 1);
};

const ORDER = ['intro', 'rapid', 'domain', 'seo', 'cv', 'seoReview', 'overhaul', 'trigger', 'cli', 'wiki', 'checklist', 'finale'];

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'frames'), { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox', '--hide-scrollbars', '--force-color-profile=srgb',
    '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights'] });
  context = await browser.newContext({ storageState: '/tmp/demo/state.json', viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, colorScheme: 'light' });
  await context.route('**/api/meta', async (route) => { const r = await route.fetch(); route.fulfill({ response: r, json: { ...(await r.json()), hosted: true, hostLocal: false } }); });
  await context.addInitScript({ path: path.join(__dirname, 'stage.js') });
  // The console refuses to be framed elsewhere; the stage is the console's own origin.
  // Every agent in the demo is the scripted mock, whatever the form picked.
  await context.route((u) => u.origin === APP && u.pathname.startsWith('/api/'), async (route) => {
    const req = route.request(), body = req.postData();
    if (!body || !['POST', 'PUT', 'PATCH'].includes(req.method()) || !/"provider"\s*:/.test(body)) return route.fallback();
    return route.fallback({ postData: body.replace(/"provider"\s*:\s*"(claude|codex|opencode)"/g, '"provider":"mock"') });
  });
  await context.route((u) => u.origin === APP && !u.pathname.startsWith('/api/'), async (route) => {
    const req = route.request();
    if (new URL(req.url()).pathname === '/__stage/first.png') return route.fulfill({ path: path.join(OUT, 'frames', introFrame), contentType: 'image/jpeg' });
    if (new URL(req.url()).pathname.startsWith('/__stage')) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><title>tavya</title></head><body></body></html>' });
    if (req.resourceType() !== 'document') return route.fallback();
    const r = await route.fetch();
    const headers = { ...r.headers() }; delete headers['x-frame-options'];
    if (headers['content-security-policy']) headers['content-security-policy'] = headers['content-security-policy'].replace(/frame-ancestors[^;]*;?/g, '');
    return route.fulfill({ response: r, headers });
  });
  page = await context.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('console', m.text().slice(0, 200)); });
  page.setDefaultTimeout(60000);
  const cdp = await context.newCDPSession(page);
  let n = 0;
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const f = `${String(n++).padStart(7, '0')}.jpg`;
    fs.writeFile(path.join(OUT, 'frames', f), Buffer.from(data, 'base64'), () => {});
    frames.push({ f, t: metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await page.goto(APP + '/__stage');
  await page.evaluate((src) => { window.__demo.build(src); window.__demo.cardInstant(); }, ACTIVE);
  await page.waitForFunction(() => !!document.querySelector('#app')?.contentDocument?.querySelector('#main'), null, { timeout: 60000 });
  await sleep(1500);
  // Keyboard shortcuts go to the console.
  await F().evaluate(() => window.focus());
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  let failed;
  try {
    for (const name of ORDER) if (!ONLY || ONLY.has(name)) await S[name]();
  } catch (e) { failed = e; console.error('scene failed:', e); await page.screenshot({ path: path.join(OUT, 'failure.png') }).catch(() => {}); }
  mark('stop', 1);
  await cdp.send('Page.stopScreencast').catch(() => {});
  await sleep(500);
  fs.writeFileSync(path.join(OUT, 'frames.json'), JSON.stringify(frames));
  fs.writeFileSync(path.join(OUT, 'marks.json'), JSON.stringify(marks, null, 1));
  await browser.close();
  console.log(`${frames.length} frames`);
  process.exit(failed ? 1 : 0);
})();
