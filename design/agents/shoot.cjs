// Screenshots of Settings → Agents with the accounts from the 2026-10-27 report
// (three Claude logins, one Codex login; quota incidents; one out of quota).
// Usage: node design/agents/shoot.cjs [out-dir]   (light + dark, desktop + phone)
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const WEB = path.join(__dirname, '../../web');
const OUT = process.argv[2] || path.join(__dirname, 'after');
const H = 3600_000, now = Date.now();
const key = (provider, account) => `login:org_x:${provider}:${account}`;
const creds = [
  ['claude', 'manyu'], ['claude', 'manyu-old'], ['claude', 'manyu-old-2'], ['codex', 'manyu'],
].map(([provider, account]) => ({ key: key(provider, account), label: `${provider}:${account}`, provider, kind: 'login', account }));
creds.push({ key: 'key:handle:kimi-work', label: 'kimi:work', provider: 'kimi', kind: 'key', account: 'work' });
const incident = (num, title, at) => ({ kind: 'quota', at, sourceTask: { id: `t${num}`, num, title } });
const accounts = [
  { id: key('claude', 'manyu'), status: 'exhausted', window: 'weekly', resetAt: now + 38 * H, weeklyResetAt: now + 38 * H, inUse: 0, maxConcurrent: 10,
    lastTransition: incident(11, 'Atlas M8: state and institutional capture', now - 20 * H) },
  { id: key('codex', 'manyu'), status: 'available', inUse: 2, maxConcurrent: 10 },
  { id: key('claude', 'manyu-old'), status: 'available', inUse: 0, maxConcurrent: 10,
    lastTransition: incident(15, 'Atlas M12: international opinion, foreign influence, representation, elites, street power', now - 21 * H) },
  { id: key('claude', 'manyu-old-2'), status: 'available', inUse: 0, maxConcurrent: 10,
    lastTransition: incident(16, 'M12-R1: UN/USCIRF/State/EU/UK opinion evidence', now - 24 * H) },
  { id: 'key:handle:kimi-work', status: 'available', inUse: 0, maxConcurrent: 1_000_000 },
];
const usage = {
  [key('claude', 'manyu')]: { ok: false, reason: 'setup-token' },
  [key('claude', 'manyu-old-2')]: { ok: false, reason: 'setup-token' },
  [key('codex', 'manyu')]: { ok: true, at: now - 30_000, week: { pct: 0, resetAt: now + 6.9 * 24 * H } },
  [key('claude', 'manyu-old')]: { ok: true, at: now - 30_000, session: { pct: 23, resetAt: now + 1.2 * H }, week: { pct: 69, resetAt: now + 5.2 * 24 * H },
    models: [{ name: 'Fable', pct: 0, resetAt: now + 5.2 * 24 * H }] },
};
const pollable = [key('claude', 'manyu-old'), key('codex', 'manyu')];

async function shoot(browser, { theme, width, name, expand }) {
  const page = await browser.newPage({ viewport: { width, height: 2400 }, colorScheme: theme, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('http://agents.test/**', (route) => {
    const p = new URL(route.request().url()).pathname;
    const base = '/api/organizations/org_x';
    const json = {
      [`${base}/credentials`]: { credentials: creds, global: { own: {}, enabled: creds.map((c) => c.key) } },
      [`${base}/accounts`]: { logins: creds.filter((c) => c.kind === 'login') },
      [`${base}/accounts/status`]: { accounts },
      [`${base}/accounts/usage`]: { usage, pollable },
    }[p];
    if (json) return route.fulfill({ json });
    if (p.startsWith('/api/')) return route.fulfill({ status: 404, json: {} });
    if (p === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html data-theme="${theme}"><head><link rel="stylesheet" href="/styles.css"></head><body><div id="app"><main id="main"></main></div><div id="modal-root"></div><div id="toasts"></div></body></html>` });
    const file = path.join(WEB, p);
    if (!fs.existsSync(file)) return route.abort();
    let body = fs.readFileSync(file, p.endsWith('.js') || p.endsWith('.css') ? 'utf8' : undefined);
    if (p === '/app.js') body = body.replace(/^boot\(\)\.catch\(.*$/m, '');
    return route.fulfill({ body, contentType: p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : undefined });
  });
  await page.goto('http://agents.test/');
  for (const s of ['totp-qr.js', 'markdown.js', 'app.js']) {
    let content = fs.readFileSync(path.join(WEB, s), 'utf8');
    if (s === 'app.js') content = content.replace(/^boot\(\)\.catch\(.*$/m, '');
    await page.addScriptTag({ content });
  }
  await page.evaluate(() => {
    S.organizationId = 'org_x';
    document.getElementById('main').innerHTML = `<div class="main-inner" style="max-width:820px;padding:24px"><div id="shot" data-pane="settings-agents">
      <div class="settings-section-title" id="settings-agents"><div>Agents</div></div>${agentAccountsCard()}</div></div>`;
    wireGlobalSettings('org_x');
  });
  await page.waitForTimeout(800);
  if (expand) for (const id of expand) await page.locator(`[data-key="${id}"] .acct-expand`).click().catch(() => {});
  await page.waitForTimeout(300);
  fs.mkdirSync(OUT, { recursive: true });
  await page.locator('#settings-agents').evaluate((el) => el.closest("#shot").scrollIntoView());
  await page.locator("#shot").screenshot({ path: path.join(OUT, `${name}.png`) });
  if (errors.length) console.error(name, errors);
  await page.close();
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    await shoot(browser, { theme: 'dark', width: 860, name: 'dark' });
    await shoot(browser, { theme: 'light', width: 860, name: 'light' });
    await shoot(browser, { theme: 'dark', width: 860, name: 'dark-expanded', expand: [key('claude', 'manyu'), key('claude', 'manyu-old')] });
    await shoot(browser, { theme: 'light', width: 390, name: 'phone', expand: [key('claude', 'manyu-old')] });
  } finally { await browser.close(); }
  console.log(`screens in ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
