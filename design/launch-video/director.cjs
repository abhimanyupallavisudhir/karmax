// Records the launch video in one take against the demo tavya.
// Usage: node director.cjs <out-dir> [scene,scene…]
// Frames: <out>/frames/NNNNNNN.jpg + frames.json [{f, t}], marks.json [{t, name, speed}].
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const shoot = require('./shots.cjs');

const APP = 'http://127.0.0.1:48950';
const OUT = process.argv[2] || '/tmp/demo/rec';
const ONLY = process.argv[3] ? new Set(process.argv[3].split(',')) : null;
const SHOW_HOST = 'https://tavya.io';
const projects = JSON.parse(fs.readFileSync('/tmp/demo/projects.json', 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// DEMO_HOLD > 1 records the readable cut: every pause for reading lasts that much longer.
const HOLD = Number(process.env.DEMO_HOLD || 1);
const hold = (ms) => sleep(ms * HOLD);
const Z = 4 / 3; // the stage is laid out at 1440×810 and drawn at 1920×1080

const marks = [];
let frames = [], introFrame; // introFrame: the film's first frame, which the ending zooms into
const mark = (name, speed = 1) => { marks.push({ t: Date.now() / 1000, name, speed }); console.log(`[${new Date().toISOString().slice(11, 19)}] ${name} ×${speed}`); };

let page, context, browser;
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
/** Zoom the window onto an element: its centre, or, when it is bigger than the
 *  zoomed view, its top-left part (where its text starts). */
async function zoomOn(locator, scale = 1.4, { ms = 900 } = {}) {
  const b = await boxOf(locator.filter({ visible: true }).first());
  const g = await page.evaluate(() => window.__demo.geometry);
  const sx = b.x + Math.min(b.width / 2, 0.42 * g.W / scale), sy = b.y + Math.min(b.height / 2, 0.36 * g.H / scale);
  const [x, y, left] = await page.evaluate(([x, y, l]) => [...window.__demo.unzoom(x, y), window.__demo.unzoom(l, y)[0]], [sx, sy, b.x]);
  await page.evaluate(([s, x, y, t, l]) => window.__demo.camera(s, x, y, t, l), [scale, x, y, ms, left]);
}
/** Back to the whole window; `wait` false lets it ease out under what follows. */
const zoomOut = (ms = 650, wait = true) => page.evaluate(([t, w]) => { const p = window.__demo.camera(1, 720, 405, t); return w ? p : null; }, [ms, wait]);
/** Types a budget into the task form's Authorization, zoomed in on it. */
async function setBudget(amount) {
  await zoomOut(450);
  await click(F().locator('summary', { hasText: 'Authorization' }).first());
  await sleep(300);
  const budget = F().locator('#tf-payments-budget');
  await zoomOn(budget, 1.75, { ms: 700 });
  await click(budget);
  await budget.focus();
  await budget.fill('');
  await type(amount, 130);
  await sleep(900);
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
const SLUG = { tavya: 'tavya', 'personal-website': 'personal-website', random: 'random', admin_docs: 'admin_docs', opinions: 'opinions' };
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
async function newTask(projectQuery, prompt, { paste, before, delay = 30, zoom = 1.3 } = {}) {
  await key('n');
  await F().locator('#pal-in, .palette input').first().waitFor();
  await sleep(150);
  await type(projectQuery, 55);
  await sleep(220);
  await key('Enter');
  await sleep(260);
  await key('Enter');
  await F().locator('#tf-page textarea').first().waitFor();
  await sleep(150);
  if (zoom) await zoomOn(F().locator('#tf-page textarea').first(), zoom, { ms: 650 });
  await type(prompt, delay);
  if (paste) { await sleep(150); await page.keyboard.insertText(paste); }
  if (before) await before();
  await sleep(300);
  await key('Meta+Enter');
  if (zoom) await zoomOut(650, false);
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
  await hold(2600);
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
      await caption('Give it a card and a budget.');
      await setBudget('25');
      mark('rapid-typing2', 1.6);
    },
  });
  await caption('Write a task. Hit <kbd>⌘</kbd><kbd>↵</kbd>. Write the next one.');
  await newTask('web', 'Update my CV to include tavya under my list of projects', { delay: 26 });
  await newTask('tav', "Do a pass of tavya's SEO", { delay: 30 });
  mark('rapid-done', 1);
  await caption('Each runs on its own computer, in parallel.');
  await demo('move', 1180, 520, 700);
  await hold(1900);
};

S.domain = async () => {
  mark('domain-open', 1);
  await caption(null);
  await openTask('tavya', 'Buy the domain', { click: true });
  await caption('It signs up, pays and deploys, on its own.');
  mark('domain-work', 5);
  await waitStage('tavya', 'Buy the domain', ['review']);
  await sleep(700);
  mark('domain-message', 1);
  await zoomOn(F().locator('.msg.agent', { hasText: 'Bought tavya.io' }).last(), 1.4);
  await hold(3000);
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
  await hold(1600);
};

S.cv = async () => {
  mark('cv-open', 1);
  await openTask('personal-website', 'Update my CV');
  await waitStage('personal-website', 'Update my CV', ['review']);
  await caption('Review it yourself…');
  await hold(1300);
  mark('cv-params', 1);
  await click(F().getByRole('link', { name: 'Parameters' }));
  const row = F().locator('.form-row[data-row="confirm"]');
  await row.scrollIntoViewIfNeeded();
  await sleep(300);
  await caption('…or remove the reviewer, and it confirms itself.');
  await zoomOn(row, 1.5, { ms: 700 });
  await click(row.locator('.cf-del').first());
  await sleep(600);
  await zoomOut(500);
  await click(F().getByRole('button', { name: 'Save parameter changes' }));
  mark('cv-landing', 4);
  await waitStage('personal-website', 'Update my CV', ['done']);
  mark('cv-done', 1);
  await click(F().getByRole('link', { name: 'Chat' }));
  await hold(1500);
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
  await zoomOn(row, 1.45, { ms: 700 });
  await click(row.locator('[data-route-kind="agent"]').first());
  await sleep(300);
  const ins = row.getByPlaceholder('Instructions for this agent (optional)').first();
  await click(ins);
  await ins.focus();
  mark('seo-review-typing', 2.4);
  await type('Run it. Check every public page has its own title and the sitemap is valid.', 22);
  mark('seo-review-save', 1);
  await zoomOut(500);
  await click(F().getByRole('button', { name: 'Save parameter changes' }));
  await sleep(400);
  await click(F().getByRole('link', { name: 'Chat' }));
  mark('seo-reviewing', 3);
  await waitStage('tavya', "Do a pass of tavya's SEO", ['done', 'merge']);
  mark('seo-reviewed', 1);
  await zoomOn(F().locator('.msg', { hasText: 'Checked the diff' }).last(), 1.35);
  await hold(2600);
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
  await hold(2000);
  await click(F().getByRole('button', { name: 'Close' }).first());
  await sleep(300);
  await click(F().getByRole('button', { name: /Confirm/ }).first());
  await hold(1400);
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
  await caption('Agents can operate tavya too, through its MCP.');
  mark('trigger-work', 4);
  await waitStage('tavya', 'Create a repeatable task', ['review']);
  mark('trigger-message', 1);
  await zoomOn(F().locator('.msg.agent', { hasText: 'Watch agent CLI releases' }).last(), 1.35);
  await hold(2600);
  await demo('camera', 1);
  mark('trigger-series', 1);
  await goto('/personal/tavya?q=is%3Aseries%20-is%3Aarchived');
  await caption('Tasks can start themselves: on a schedule, an event, or after another task.');
  await sleep(600);
  await zoomOn(F().getByText('Watch agent CLI releases', { exact: false }), 1.5);
  await hold(1900);
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
  await caption('tavya is not just for code. Dump all your files into tavya…');
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
  await hold(2300);
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
  await goto(ACTIVE); // behind the terminal: `n` from the organization asks for a project
  await hold(1600);
  await page.evaluate(() => window.__demo.term.close());
  await demo('scrim', false);
  await demo('cursorVisible', true);
  await sleep(300);
  await flight();
};

const FLIGHT = 'Book me the cheapest direct flight to London on January 3 with reasonable timings. My passport, loyalty card numbers etc. are in this folder.';
async function flight() {
  mark('flight', 1);
  await caption('…and let it run your life.');
  await sleep(700);
  mark('flight-typing', 1.6);
  await newTask('admin_', FLIGHT, { delay: 22, before: async () => { mark('flight-budget', 1); await setBudget('500'); mark('flight-typing2', 1.6); } });
  mark('flight-open', 1);
  await openTask('admin_docs', 'Book me the cheapest');
  mark('flight-work', 4);
  const allow = F().getByRole('button', { name: 'This task', exact: true }).first();
  await allow.waitFor({ timeout: 120000 });
  mark('flight-allow', 1);
  await sleep(300);
  await zoomOn(F().locator('.msg.agent', { hasText: 'United login' }).last(), 1.25);
  await hold(1900);
  await zoomOut(500);
  await click(allow);
  mark('flight-booking', 4);
  // It was already in Review (waiting for the approval): wait for the booking itself.
  const fold = F().locator('summary.fold-head', { hasText: 'Booked:' }).last();
  await fold.waitFor({ timeout: 120000 });
  mark('flight-booked', 1);
  await sleep(400);
  await click(fold);
  await sleep(600);
  await zoomOn(F().locator('.msg.agent', { hasText: 'Booked:' }).last(), 1.4);
  await hold(2800);
  await zoomOut(600);
}

S.wiki = async () => {
  mark('wiki', 1);
  await caption(null);
  await goto('/personal/tavya/wiki');
  await caption('What agents learn, they write down: in a wiki you can read.');
  await sleep(900);
  await click(F().getByText('Message forms', { exact: false }).first());
  await hold(2300);
};

const ICON = (d) => `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const PROVIDERS = ['E2B', 'Hetzner', 'AWS', 'Google Cloud', 'Fly.io', 'Daytona'];
S.grid = async () => {
  // Stills of the real console, taken off camera (cut from the film).
  mark('grid-shots', 0);
  const shotDir = path.join(OUT, 'shots');
  fs.mkdirSync(shotDir, { recursive: true });
  // A task that splits itself into sub-tasks, in a project the film never lists (so no task number
  // the film shows moves); deleted once its still is taken.
  const parent = await api('POST', `/api/projects/${projects.opinions}/tasks`, { prompt: 'Get tavya ready for its public launch: the Show HN post, the video, the docs and the pricing page.' });
  let kids = [];
  for (let i = 0; i < 90; i++) {
    kids = (await api('GET', `/api/tasks/${parent.id}`)).subTasks ?? [];
    if (kids.length >= 4) {
      const views = await Promise.all(kids.map((id) => api('GET', `/api/tasks/${id}`)));
      if (views.filter((v) => v.stage === 'review').length >= 2) break;
    }
    await sleep(1000);
  }
  await shoot(browser, { app: APP, storageState: '/tmp/demo/state.json', out: shotDir, route: hostedMeta, subtasks: `/personal/opinions/tasks/${parent.num}` });
  for (const id of [...kids, parent.id]) await api('DELETE', `/api/tasks/${id}`);
  const src = (n) => `/__stage/shots/${n}.png`;
  const tiles = [
    { icon: ICON('<path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/><path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>'), title: 'Claude Code, Codex, OpenCode', hint: 'Your subscription or API key', shots: [src('agents')] },
    { icon: ICON('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'), title: 'A cloud computer per task', hint: 'Sized to the job; it sleeps when idle',
      html: `<div class="pcs">${PROVIDERS.map((n, k) => `<div class="pc" style="--k:${k}"><i></i>${n}</div>`).join('')}</div>` },
    { icon: ICON('<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3M16 7l3 3"/>'), title: 'A vault for logins, keys and cards', hint: 'Agents use them without seeing them', shots: [src('vault')] },
    { icon: ICON('<path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5"/>'), title: 'Any app, over MCP', hint: 'You approve each one', shots: [src('apps')] },
    { icon: ICON('<path d="M6 3v12M6 9h7a3 3 0 0 1 3 3v3M6 15v3"/><circle cx="6" cy="20" r="1.6"/><circle cx="16" cy="18" r="2.4"/>'), title: 'Sub-tasks, dependencies, schedules, events', hint: 'Big jobs split themselves up', shots: [src('subtasks')], fit: true },
    { icon: ICON('<path d="M3 20h18M7 16v-5M12 16V5M17 16v-8"/>'), title: 'Insights', hint: 'Work, tokens and compute over time', shots: [src('insights')] },
  ];
  mark('grid', 1);
  await caption(null);
  await demo('cursorVisible', false);
  await demo('scrim', true);
  await page.evaluate((t) => window.__demo.grid.open('Also built in', t), tiles);
  for (let i = 0; i < tiles.length; i++) { await page.evaluate((j) => window.__demo.grid.show(j), i); await sleep(170); }
  await hold(4600);
  await page.evaluate(() => window.__demo.grid.close());
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
  // A real launch video takes hours; the mock finishes in seconds. Show the run as it would be.
  await F().evaluate(() => {
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

const ORDER = ['intro', 'rapid', 'domain', 'seo', 'cv', 'seoReview', 'overhaul', 'trigger', 'cli', 'wiki', 'grid', 'finale'];

// Off camera, before the take: logins the vault would hold, and admin_docs' folder (pretend documents).
const VAULT = [
  { type: 'login', label: 'flights/united', domains: ['united.com'], username: 'MileagePlus', policy: { use: 'ask', reveal: 'ask' }, secrets: { password: 'demo-not-a-password' } },
  { type: 'api-key', label: 'hetzner.com', domains: ['hetzner.com'], envVar: 'HCLOUD_TOKEN', secrets: { secret: 'demo-not-a-key' } },
  { type: 'api-key', label: 'cloudflare.com', domains: ['cloudflare.com'], envVar: 'CLOUDFLARE_API_TOKEN', secrets: { secret: 'demo-not-a-key' } },
  { type: 'ssh-key', label: 'deploy@tavya.io', secrets: { privateKey: 'demo-not-a-key' } },
];
const DOCUMENTS = {
  'passport.pdf': '%PDF-1.4\n% demo: not a real passport\n',
  'loyalty-programmes.md': '# Loyalty programmes\n\n- United MileagePlus: XX000000 (demo)\n- BA Executive Club: 00000000 (demo)\n- Virgin Atlantic Flying Club: 0000000000 (demo)\n',
  'addresses.md': '# Addresses\n\n(demo)\n',
};
async function prepare() {
  for (const item of VAULT) await api('POST', '/api/vault/items', item);
  fs.mkdirSync(LAPTOP, { recursive: true });
  fs.rmSync(path.join(LAPTOP, 'admin-docs'), { recursive: true, force: true });
  console.log(sh('tavya clone personal/admin_docs', LAPTOP).split('\n')[0]);
  const docs = path.join(LAPTOP, 'admin-docs', 'documents');
  fs.mkdirSync(docs, { recursive: true });
  for (const [f, text] of Object.entries(DOCUMENTS)) fs.writeFileSync(path.join(docs, f), text);
  console.log(sh('tavya add documents', path.join(LAPTOP, 'admin-docs')).split('\n').at(-1));
}
const hostedMeta = (ctx) => ctx.route('**/api/meta', async (route) => { const r = await route.fetch(); route.fulfill({ response: r, json: { ...(await r.json()), hosted: true, hostLocal: false } }); });

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'frames'), { recursive: true });
  browser = await chromium.launch({ args: ['--no-sandbox', '--hide-scrollbars', '--force-color-profile=srgb',
    '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights'] });
  context = await browser.newContext({ storageState: '/tmp/demo/state.json', viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, colorScheme: 'light' });
  await hostedMeta(context);
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
    const shot = new URL(req.url()).pathname.match(/^\/__stage\/shots\/(\w+\.png)$/);
    if (shot) return route.fulfill({ path: path.join(OUT, 'shots', shot[1]), contentType: 'image/png' });
    if (new URL(req.url()).pathname.startsWith('/__stage')) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><title>tavya</title></head><body></body></html>' });
    if (req.resourceType() !== 'document') return route.fallback();
    const r = await route.fetch();
    const headers = { ...r.headers() }; delete headers['x-frame-options'];
    if (headers['content-security-policy']) headers['content-security-policy'] = headers['content-security-policy'].replace(/frame-ancestors[^;]*;?/g, '');
    return route.fulfill({ response: r, headers });
  });
  await prepare();
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
  await hold(1500);
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
  fs.writeFileSync(path.join(OUT, 'stage-log.json'), JSON.stringify(await page.evaluate(() => window.__demo.log).catch(() => ({}))));
  await browser.close();
  console.log(`${frames.length} frames`);
  process.exit(failed ? 1 : 0);
})();
