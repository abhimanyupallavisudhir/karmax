// Screens of Insights rendered from the real app.js code and styles, from a
// saved Insights response (scripts/insights-from-export.ts writes one from an
// organization's real rows). Run:
//   node design/insights/shoot.cjs insights.json [outDir=/tmp/insights-shots]
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const web = path.join(root, 'web');
const src = fs.readFileSync(path.join(web, 'app.js'), 'utf8');
function fn(name) {
  const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  if (start < 0) throw new Error(`Missing function: ${name}`);
  let parens = 0, open = -1;
  for (let i = src.indexOf('(', start); i < src.length; i++) {
    if (src[i] === '(') parens++;
    else if (src[i] === ')') parens--;
    else if (src[i] === '{' && parens === 0) { open = i; break; }
  }
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`Unterminated function: ${name}`);
}
const insights = src.slice(src.indexOf('// ── insights ──'), src.indexOf('function accountIncidentHtml('));
const [input, out = '/tmp/insights-shots'] = process.argv.slice(2);
if (!input) throw new Error('usage: shoot.cjs insights.json [outDir]');
const data = JSON.parse(fs.readFileSync(input, 'utf8'));
const accounts = data._accounts || { pollable: [], usage: {} };
fs.mkdirSync(out, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2, locale: 'en-US', timezoneId: 'UTC' });
      await page.route('http://insights.test/**', (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname.startsWith('/fonts/')) return route.fulfill({ body: fs.readFileSync(path.join(web, pathname)), contentType: 'font/woff2' });
        return route.fulfill({ body: `<!doctype html><html data-theme="${theme}"><body><main class="main"><div id="main" class="main-inner"></div></main></body></html>`, contentType: 'text/html' });
      });
      await page.goto('http://insights.test/');
      await page.clock.setFixedTime(new Date(data.to));
      await page.addStyleTag({ path: path.join(web, 'styles.css') });
      await page.addStyleTag({ content: 'body { background: var(--bg); } .main-inner { padding: 24px; }' });
      await page.evaluate(({ data, accounts, days }) => {
        localStorage.setItem('karmax.insightsDays', String(days));
        window.$ = (s) => document.querySelector(s);
        const names = new Map((data.projects || []).map((p) => [p.id, p.name]));
        for (const p of data.storage?.projects || []) names.set(p.id, p.name);
        window.S = { tab: 'insights', organizationId: 'org', projects: [...names].map(([id, name]) => ({ id, name, organizationId: 'org' })) };
        window.esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
        window.projectById = (id) => S.projects.find((p) => p.id === id);
        window.projectBase = (id) => `/org/${id}`;
        window.projectRoute = (id) => `/org/${id}`;
        window.globalRoute = (tab) => `/org/${tab}`;
        window.installationRoute = () => '/installation';
        window.firstProjectForOrganization = () => S.projects[0];
        window.stageLabel = (v) => v.stage;
        window.newProject = () => {};
        window.api = async (url) => {
          if (url.includes('/insights?')) return data;
          if (url.endsWith('/accounts/usage')) return accounts;
          if (url.endsWith('/accounts/status')) return { accounts: accounts.pollable.map((id) => ({ id, status: 'available' })) };
          return {};
        };
      }, { data, accounts, days: data.days });
      await page.addScriptTag({ content: [
        ...['beginAsyncElementRender', 'fmtAgo', 'fmtCountdown', 'usageResetLabel', 'autoRecheckUsage', 'accountShortName', 'safeHref'].map(fn),
        'const asyncElementRenderEpoch = new WeakMap();', insights,
        'window.renderPage = () => { $("#main").innerHTML = insightsView(); wireInsights(); return renderInsights(); };',
      ].join('\n') });
      await page.evaluate(() => renderPage());
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);
      const suffix = theme === 'dark' ? '-dark' : '';
      await page.screenshot({ path: path.join(out, `insights-page${suffix}.png`), fullPage: true });
      if (theme === 'dark') { await page.close(); continue; }
      const chart = page.locator('.ins-chart');
      const lens = async (name, split, file, hoverAt = 0.93) => {
        await page.locator(`[data-ins-lens="${name}"]`).click();
        if (split) await page.locator(`[data-ins-split="${split}"]`).click();
        const box = await page.locator('.ins-svg').boundingBox();
        await page.mouse.move(box.x + box.width * hoverAt, box.y + 80);
        await page.waitForTimeout(100);
        await chart.screenshot({ path: path.join(out, file) });
      };
      await lens('tokens', 'login', 'chart-tokens-by-login.png', 0.97);
      await lens('compute', 'provider', 'chart-compute-by-provider.png', 0.97);
      await lens('compute', 'funding', 'chart-compute-by-funding.png', 0.97);
      await lens('storage', 'kind', 'chart-storage-by-kind.png', 0.97);
      await page.mouse.move(0, 0);
      for (const [selector, file] of [['.ins-compute', 'card-compute.png'], ['.ins-storage', 'card-storage.png'], ['.ins-logins', 'card-logins.png'],
        ['.ins-credit', 'card-credit.png'], ['.ins-routing', 'card-routing.png'], ['.ins-budgets', 'card-budgets.png'], ['.ins-kpis', 'tiles.png']])
        if (await page.locator(selector).count()) await page.locator(selector).screenshot({ path: path.join(out, file) });
      await page.close();
    }
    console.log(`screens in ${out}`);
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exit(1); });
