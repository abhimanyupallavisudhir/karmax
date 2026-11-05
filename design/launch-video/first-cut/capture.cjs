// Captures every screen the launch video shows, from the demo clone (import.py,
// stage.py, seed-extras.cjs), as 2x stills and short frame sequences, plus the
// boxes of what the cursor points at (shots.json) for the compositor.
// Usage: APP=http://127.0.0.1:48950 OUT=/home/user/demo/assets node design/launch-video/first-cut/capture.cjs [shot-filter]
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const APP = process.env.APP || 'http://127.0.0.1:48950';
const STATE = process.env.STATE || '/home/user/demo/state.json';
const HOME = process.env.KARMAX_HOME || '/home/user/demo/home';
const OUT = process.env.OUT || '/home/user/demo/assets';
const ONLY = process.argv[2] ? new RegExp(process.argv[2]) : null;
const W = 1440, H = 900, DPR = 2;
const stage = (...scenes) => execFileSync('python3', ['-I', path.join(__dirname, 'stage.py'), HOME, ...scenes], { stdio: 'inherit' });
// Back to the imported data, then into these scenes (a scene may rewrite a conversation).
const prepare = (...scenes) => execFileSync(path.join(__dirname, 'prepare.sh'), scenes, { stdio: 'inherit' });
const manifest = fs.existsSync(path.join(OUT, 'shots.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'shots.json'), 'utf8')) : {};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox', '--font-render-hinting=none'] });
  // Per-task cut-off for activity events: the conversation as it stood mid-turn.
  const eventsUpTo = new Map();
  const context = await browser.newContext({ storageState: STATE, viewport: { width: W, height: H }, deviceScaleFactor: DPR, colorScheme: 'light' });
  // As on tavya.io: hosted-only controls show.
  await context.route('**/api/meta', async (route) => {
    const response = await route.fetch();
    route.fulfill({ response, json: { ...(await response.json()), hosted: true } });
  });
  // An imported task has no workspace to scan for ignored output.
  await context.route('**/resources/inventory', (route) => route.fulfill({ json: { entries: [] } }));
  await context.route(/\/api\/tasks\/[^/]+\/events/, async (route) => {
    const id = route.request().url().match(/\/api\/tasks\/([^/]+)\/events/)[1];
    const response = await route.fetch();
    let json = await response.json();
    if (eventsUpTo.has(id)) json = json.filter((e) => e.seq <= eventsUpTo.get(id));
    route.fulfill({ response, json });
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.addInitScript(() => {
    // No blinking caret or hover-only tooltips in stills; the compositor draws the cursor.
    document.addEventListener('DOMContentLoaded', () => {
      const s = document.createElement('style');
      s.textContent = '*{caret-color:transparent!important} ::-webkit-scrollbar{width:0!important;height:0!important}';
      document.head.appendChild(s);
    });
  });

  const go = async (url, wait = 2200) => {
    await page.goto(`${APP}${url}`);
    await page.locator('#main').waitFor();
    await page.waitForTimeout(wait);
  };
  const box = async (selector) => {
    const b = await page.locator(selector).first().boundingBox();
    return b && { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
  };
  const shot = async (name, marks = {}) => {
    if (ONLY && !ONLY.test(name)) return false;
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    const boxes = {};
    for (const [k, sel] of Object.entries(marks)) boxes[k] = await box(sel).catch(() => null);
    manifest[name] = { kind: 'still', boxes };
    fs.writeFileSync(path.join(OUT, 'shots.json'), JSON.stringify(manifest, null, 1));
    console.log('shot', name, JSON.stringify(boxes));
    return true;
  };
  // A frame sequence: step(i) changes the page, then frame i is taken.
  const sequence = async (name, n, step, marks = {}) => {
    if (ONLY && !ONLY.test(name)) return false;
    const dir = path.join(OUT, name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < n; i++) {
      await step(i);
      await page.screenshot({ path: path.join(dir, `${String(i).padStart(4, '0')}.jpg`), type: 'jpeg', quality: 92 });
    }
    const boxes = {};
    for (const [k, sel] of Object.entries(marks)) boxes[k] = await box(sel).catch(() => null);
    manifest[name] = { kind: 'sequence', frames: n, boxes };
    fs.writeFileSync(path.join(OUT, 'shots.json'), JSON.stringify(manifest, null, 1));
    console.log('sequence', name, n, JSON.stringify(boxes));
    return true;
  };
  const want = (name) => !ONLY || ONLY.test(name);
  const thread = '.ck-thread';
  const scrollThread = (y) => page.evaluate(([sel, y]) => { const t = document.querySelector(sel); if (t) t.scrollTop = y < 0 ? t.scrollHeight : y; }, [thread, y]);

  prepare('tidy', 'busy');

  // 1. One list for all your work: the organization's active tasks.
  if (want('home')) {
    await go('/personal?q=-is:archived%20-is:draft');
    await shot('home', { active: '.view-chip.active, .view-chip[aria-pressed="true"]', newTask: '#expand-task', sidebar: '.sidebar, nav' });
  }

  // 2. Write what needs doing: the task form, typed into.
  const PROMPT = 'Can you make my homepage design nicer and cleaner? I think it was designed by an OpenAI model which gives it the weird khaki color look.';
  if (want('form')) {
    await go('/personal/personal-website');
    await page.locator('#expand-task').click();
    await page.locator('#tf-page textarea').first().waitFor();
    await page.waitForTimeout(1200);
    const field = page.locator('#tf-page textarea').first();
    await shot('form-empty', { prompt: '#tf-page textarea', run: '#tf-page button:has-text("Run task")' });
    await field.focus();
    const per = 3;
    await sequence('form-type', Math.ceil(PROMPT.length / per) + 1, async (i) => {
      await field.fill(PROMPT.slice(0, i * per));
    }, { prompt: '#tf-page textarea', run: '#tf-page button:has-text("Run task")', model: '#tf-page .model-field, #tf-page [data-model-field]' });
  }

  // 3. The agent at work, its steps arriving (the real run, replayed).
  if (want('work')) {
    stage('hero-working');
    const id = 'task_mv5q0p2v3adc8858b7';
    const events = JSON.parse(fs.readFileSync(`/home/user/karmax/demo-export/events/${id}.json`, 'utf8'))
      .filter((e) => e.type === 'agent.activity').map((e) => e.seq).sort((a, b) => a - b);
    const cuts = [10, 14, 18, 24, 30, 38, 46, 56, 66, 78, 90];
    for (const [i, k] of cuts.entries()) {
      eventsUpTo.set(id, events[Math.min(k, events.length - 1)]);
      await go('/personal/personal-website/tasks/5', 1800);
      // Unfold every "Worked … · N steps" group: the commands are the point.
      for (const row of await page.locator('.ck-thread').getByText(/\d+ steps?$/).all()) await row.click().catch(() => {});
      await page.waitForTimeout(500);
      await scrollThread(-1); await page.waitForTimeout(300);
      await shot(`work-${String(i).padStart(2, '0')}`, { thread });
    }
    eventsUpTo.delete(id);
    prepare('tidy', 'busy');
  }

  const openTile = async (idx) => {
    await scrollThread(-1); await page.waitForTimeout(400);
    await page.locator(`.review-tile[data-idx="${idx}"]`).first().click();
    await page.waitForTimeout(2200);
  };
  // 4. Review the result: the screenshots the agent attached, then Confirm.
  if (want('review')) {
    await go('/personal/personal-website/tasks/5');
    await scrollThread(-1); await page.waitForTimeout(600);
    await shot('review', { tile: '.review-tile[data-idx="0"]', confirm: 'button:has-text("Confirm PR")', card: '.review-info' });
    await openTile(0);
    await shot('review-viewer', {});
    await page.keyboard.press('Escape');
    prepare('tidy');  // the real, merged task
    await go('/personal/personal-website/tasks/5');
    await scrollThread(-1); await page.waitForTimeout(600);
    await shot('review-done', { chip: '.tp-head .chip, .chip.done', pr: '.tp-head a[href*="github"], .tp-head .pr-chip' });
    prepare('tidy', 'busy');
  }

  // 5. Not just code: what agents made in other projects.
  if (want('made')) {
    await go('/personal/legibench3/tasks/19'); await openTile(0); await shot('made-legibench', {});
    await page.keyboard.press('Escape');
    await go('/personal/lvpm/tasks/8'); await openTile(5); await shot('made-lvpm', {});
    await page.keyboard.press('Escape');
    await go('/personal/thesis/tasks/8'); await scrollThread(0); await shot('made-thesis-task', {});
    const art = '/home/user/karmax/demo-export/artifacts';
    for (const [name, file, pages] of [['made-thesis-pdf', `${art}/task_mvw8uhdvb03ab4a7a8/0.pdf`, '1-3'], ['made-paper-pdf', `${art}/task_mvik4fo03779021f59/0.pdf`, '1-2']]) {
      if (!want(name)) continue;
      const [f, l] = pages.split('-');
      execFileSync('pdftoppm', ['-png', '-r', '110', '-f', f, '-l', l, file, path.join(OUT, name)]);
      manifest[name] = { kind: 'pdf', pages: Number(l) - Number(f) + 1 };
    }
    fs.writeFileSync(path.join(OUT, 'shots.json'), JSON.stringify(manifest, null, 1));
  }

  // 6. Sub-tasks: one review that fanned out into 25 tasks.
  if (want('subtasks')) {
    await go('/personal/tavya/tasks/367'); await scrollThread(0);
    await shot('subtasks', { rail: '.tp-rail, aside' });
  }

  // 7. Accounts, keys and a card.
  if (want('vault')) {
    await go('/personal/settings');
    await page.locator('a[href="#settings-payments"]').first().click(); await page.waitForTimeout(1200);
    await page.locator('text=Vault credentials').locator('visible=true').first().click(); await page.waitForTimeout(1200);
    await shot('vault', {});
    await page.locator('text=Payment cards, text=PAYMENT CARDS').first().scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(800);
    await shot('vault-cards', {});
  }

  // 8. Work that starts itself: repeatable tasks and what they started.
  if (want('auto')) {
    await go('/personal/tavya');
    await page.locator('.view-chip', { hasText: 'Repeatable' }).first().click(); await page.waitForTimeout(1500);
    await shot('auto-repeatable', {});
    await go('/personal/tavya/tasks/832'); await scrollThread(0);
    await shot('auto-upgrade', {});
  }

  // 9. Any agent: the model picker and the comparison chart.
  if (want('models')) {
    await go('/personal/personal-website');
    await page.locator('#expand-task').click();
    await page.locator('#tf-page textarea').first().waitFor(); await page.waitForTimeout(1000);
    await page.locator('#tf-page textarea').first().fill(PROMPT);
    await page.locator('#tf-page .model-field input[aria-label="Model"]').first().click(); await page.waitForTimeout(1200);
    await shot('models', { field: '#tf-page .model-field' });
    const chart = page.locator('#tf-page .model-field button[title*="ompare"], #tf-page .model-field [aria-label*="ompare"]').first();
    if (await chart.count()) { await page.keyboard.press('Escape'); await chart.click(); await page.waitForTimeout(2500); await shot('models-compare', {}); }
    await page.keyboard.press('Escape'); await page.waitForTimeout(400);
  }

  // 10. The same, on a phone.
  if (want('mobile')) {
    const phone = await browser.newContext({ storageState: STATE, viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    await phone.route('**/api/meta', async (route) => { const r = await route.fetch(); route.fulfill({ response: r, json: { ...(await r.json()), hosted: true } }); });
    const p = await phone.newPage();
    await p.goto(`${APP}/personal?q=-is:archived%20-is:draft`); await p.locator('#main').waitFor(); await p.waitForTimeout(2500);
    await p.screenshot({ path: path.join(OUT, 'mobile-home.png') });
    await p.goto(`${APP}/personal/personal-website/tasks/5`); await p.locator('#main').waitFor(); await p.waitForTimeout(2500);
    await p.screenshot({ path: path.join(OUT, 'mobile-task.png') });
    manifest['mobile-home'] = { kind: 'still', phone: true }; manifest['mobile-task'] = { kind: 'still', phone: true };
    fs.writeFileSync(path.join(OUT, 'shots.json'), JSON.stringify(manifest, null, 1));
    await phone.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
