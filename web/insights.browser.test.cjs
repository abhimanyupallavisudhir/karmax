// Render the real Insights page code with fixture data in Chromium: the org-wide
// pipeline, trend tiles, chart lenses + hover, task links, quota, the period
// control, the empty organization, and narrow layouts.
// Run: node web/insights.browser.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
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

const NOW = Date.parse('2026-09-23T12:00:00Z');
const DAY = 86_400_000;
function fixture(overrides = {}) {
  const days = 7;
  const daily = Array.from({ length: days }, (_, i) => ({
    day: new Date(NOW - (days - 1 - i) * DAY).toISOString().slice(0, 10),
    shipped: [1, 0, 2, 3, 0, 1, 4][i], created: [2, 1, 3, 2, 1, 2, 5][i], turns: 3, agentSeconds: 3600 * (i + 1),
    tokens: 1000 * (i + 1), tokensByModel: { opus: 500 * (i + 1), codex: 300 * (i + 1), haiku: 100 * (i + 1), tiny: 100 * (i + 1) },
  }));
  return {
    days, from: NOW - 6 * DAY, to: NOW, utcOffsetMinutes: 0,
    totals: { shipped: 11, created: 16, turns: 21, meteredTurns: 21, failedTurns: 2, agentSeconds: 100_800, tokens: 28_000, inputTokens: 24_000, outputTokens: 4_000, medianShipMs: 3 * 3_600_000 },
    previous: { shipped: 8, created: 16, turns: 10, failedTurns: 0, agentSeconds: 50_000, tokens: 20_000, inputTokens: 1, outputTokens: 1, medianShipMs: 4 * 3_600_000 },
    daily,
    // Server order: most turns first. gpt-6 ran before Codex subscription turns
    // reported usage; codex is only partly reported.
    models: [
      { model: 'gpt-6', provider: 'openai', turns: 40, meteredTurns: 0, failedTurns: 4, agentSeconds: 90_000, tokens: 0 },
      { model: 'opus', provider: 'anthropic', turns: 10, meteredTurns: 10, failedTurns: 1, agentSeconds: 50_000, tokens: 14_000 },
      { model: 'codex', provider: 'openai', turns: 6, meteredTurns: 3, failedTurns: 1, agentSeconds: 30_000, tokens: 8_400 },
      { model: 'haiku', provider: 'anthropic', turns: 3, meteredTurns: 3, failedTurns: 0, agentSeconds: 10_000, tokens: 2_800 },
      { model: 'tiny', provider: 'local', turns: 2, meteredTurns: 2, failedTurns: 0, agentSeconds: 10_800, tokens: 2_800 },
    ],
    projects: [
      { id: 'web', name: 'Storefront', shipped: 7, open: 5, turns: 12, agentSeconds: 60_000, tokens: 18_000, daily: [1, 0, 1, 2, 0, 1, 2] },
      { id: 'api', name: 'Payments API', shipped: 4, open: 3, turns: 9, agentSeconds: 40_800, tokens: 10_000, daily: [0, 0, 1, 1, 0, 0, 2] },
    ],
    pipeline: {
      stages: {
        setup: { open: 1, working: 1, waiting: 0 }, do: { open: 4, working: 3, waiting: 1 }, review: { open: 2, working: 0, waiting: 2 },
        merge: { open: 1, working: 1, waiting: 0 }, resolve: { open: 1, working: 0, waiting: 0 },
        escalated: { open: 1, working: 0, waiting: 1 }, failed: { open: 2, working: 0, waiting: 0 },
      },
      working: 5, waiting: 4, drafts: 2,
    },
    working: [{ taskId: 't-1', num: 12, title: 'Build the refund flow', projectId: 'web', stage: 'do' }],
    waiting: [
      { taskId: 't-2', num: 9, title: 'Review checkout copy', projectId: 'web', stage: 'review' },
      { taskId: 't-3', num: 4, title: 'Pick a tax provider', projectId: 'api', stage: 'do' },
    ],
    recent: [{ taskId: 't-4', num: 7, title: 'Ship Apple Pay', projectId: 'api', stage: 'done', at: NOW - 2 * 3_600_000, pr: 'https://github.com/acme/api/pull/7' }],
    ...overrides,
  };
}
const EMPTY = { ...fixture(), totals: { ...fixture().totals, shipped: 0, created: 0, turns: 0, medianShipMs: null },
  previous: { ...fixture().previous, shipped: 0, created: 0, turns: 0 },
  pipeline: { stages: {}, working: 0, waiting: 0, drafts: 0 }, working: [], waiting: [], recent: [], projects: [], models: [] };

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, locale: 'en-US', timezoneId: 'UTC' });
    await page.route('http://insights.test/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.startsWith('/fonts/')) return route.fulfill({ body: fs.readFileSync(path.join(__dirname, pathname)), contentType: 'font/woff2' });
      return route.fulfill({ body: '<!doctype html><html data-theme="light"><body><main class="main"><div id="main" class="main-inner"></div></main></body></html>', contentType: 'text/html' });
    });
    await page.goto('http://insights.test/');
    await page.clock.setFixedTime(new Date(NOW));
    await page.addStyleTag({ path: path.join(__dirname, 'styles.css') });
    await page.evaluate(({ data, empty }) => {
      window.FIXTURE = data; window.EMPTY = empty;
      window.$ = s => document.querySelector(s);
      window.S = { tab: 'insights', organizationId: 'org_acme', projects: [{ id: 'web', name: 'Storefront', organizationId: 'org_acme' }, { id: 'api', name: 'Payments API', organizationId: 'org_acme' }] };
      window.esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
      window.projectById = id => S.projects.find(p => p.id === id);
      window.projectBase = id => projectById(id) ? `/acme/${id}` : '';
      window.projectRoute = id => `/acme/${id}`;
      window.globalRoute = tab => `/acme/${tab === 'organization' ? 'settings' : tab}`;
      window.firstProjectForOrganization = id => S.projects.find(p => p.organizationId === id);
      window.stageLabel = v => ({ do: 'working', merge: 'landing' }[v.stage] || v.stage);
      window.newProject = () => { window.createdProject = true; };
      window.requests = [];
      window.insightsResponse = () => FIXTURE;
      window.api = async (url, options = {}) => {
        requests.push({ url, method: options.method || 'GET' });
        if (url.includes('/insights?')) return insightsResponse(url);
        if (url.endsWith('/accounts/usage')) return { pollable: ['login:claude:work'], usage: { 'login:claude:work': { ok: true, at: Date.now(), session: { pct: 38, resetAt: Date.now() + 2 * 3_600_000 }, week: { pct: 93, resetAt: Date.now() + 3 * 86_400_000 } } } };
        if (url.endsWith('/accounts/status')) return { accounts: [{ id: 'login:claude:work', status: 'available' }, { id: 'key:codex', status: 'exhausted', resetAt: Date.now() + 90 * 60_000 }] };
        if (url.endsWith('/accounts/usage/recheck')) return {};
        throw new Error(`unexpected ${url}`);
      };
    }, { data: fixture(), empty: EMPTY });
    await page.addScriptTag({ content: [
      ...['beginAsyncElementRender', 'fmtAgo', 'fmtCountdown', 'usageResetLabel', 'autoRecheckUsage'].map(fn),
      'const asyncElementRenderEpoch = new WeakMap();',
      fn('safeHref'), insights,
      'window.renderPage = () => { $("#main").innerHTML = insightsView(); wireInsights(); return renderInsights(); };',
    ].join('\n') });
    await page.evaluate(() => renderPage());
    await page.evaluate(() => document.fonts.ready);

    // The live pipeline: stage totals, resolve counted as landing, agent/person split.
    const nodes = await page.$$eval('.ins-node', els => els.map(el => ({
      n: el.querySelector('.ins-node-n').firstChild.textContent.trim(),
      name: el.querySelector('.ins-node-name').textContent,
      parts: [...el.querySelectorAll('.ins-node-bar i')].map(i => i.className),
    })));
    assert.deepEqual(nodes.map(n => [n.name, n.n]), [['Setup', '1'], ['Working', '4'], ['Review', '2'], ['PR', '0'], ['Landing', '2'], ['Shipped · 7d', '11']]);
    assert.deepEqual(nodes[1].parts, ['w', 'h']);
    assert.deepEqual(nodes[4].parts, ['w', 'q'], 'an open task neither with an agent nor a person reads as queued');
    assert.ok(await page.locator('.ins-node.shipped .ins-delta.good').count(), 'more shipped than last period is good news');
    const foot = await page.locator('.ins-flow-foot').textContent();
    for (const text of ['5 with agents', '4 waiting on people', '1 escalated', '2 failed', '2 drafts']) assert.ok(foot.includes(text), text);

    // Trend tiles: lower time-to-ship is good; spend only appears with payment access.
    assert.equal(await page.locator('.ins-kpi').count(), 4);
    assert.ok((await page.locator('.ins-kpi', { hasText: 'Time to ship' }).locator('.ins-delta').getAttribute('class')).includes('good'));
    assert.ok((await page.locator('.ins-kpi', { hasText: 'Agent time' }).textContent()).includes('10% failed'));
    assert.match(await page.locator('.ins-kpi', { hasText: 'Tokens' }).locator('.ins-kpi-n').textContent(), /^28k/);

    // Chart: shipped columns (one per non-zero day) + the started line on one axis.
    assert.equal(await page.locator('.ins-svg path[fill="var(--merged)"]').count(), 5);
    assert.equal(await page.locator('.ins-svg .ins-line').count(), 1);
    assert.deepEqual(await page.$$eval('.ins-legend span', els => els.map(e => e.textContent)), ['Shipped', 'Started']);
    const svg = await page.locator('.ins-svg').boundingBox();
    await page.mouse.move(svg.x + svg.width - 8, svg.y + 60);
    assert.equal(await page.locator('.ins-tip').isVisible(), true);
    assert.equal(await page.locator('.ins-tip-h').textContent(), 'Wed, Sep 23');
    assert.deepEqual(await page.$$eval('.ins-tip b', els => els.map(e => e.textContent)), ['4', '5']);
    const tip = await page.locator('.ins-tip').boundingBox();
    assert.ok(tip.x >= svg.x - 1 && tip.x + tip.width <= svg.x + svg.width + 1, 'the tooltip stays inside the chart');
    await page.mouse.move(svg.x - 40, svg.y - 40);
    assert.equal(await page.locator('.ins-tip').isVisible(), false);

    // Tokens lens: top three models keep their colors, the rest fold into Other.
    await page.locator('[data-ins-lens="tokens"]').click();
    assert.deepEqual(await page.$$eval('.ins-legend span', els => els.map(e => e.textContent)), ['opus', 'codex', 'haiku', 'Other']);
    const legendColors = await page.$$eval('.ins-legend i', els => els.map(e => e.style.background));
    const shareColor = await page.$$eval('.ins-table tr', rows => Object.fromEntries(rows.filter(row => row.querySelector('.ins-share'))
      .map(row => [row.querySelector('.ins-model').textContent, row.querySelector('.ins-share i').style.background])));
    assert.deepEqual([shareColor.opus, shareColor.codex, shareColor.haiku], legendColors.slice(0, 3), 'a model has one color on the whole page');
    assert.equal(shareColor.tiny, 'var(--viz-other)');

    // Unreported usage reads as unknown, never as zero; partial as a lower bound.
    const tokenCell = async name => page.locator('.ins-table tr', { has: page.locator('.ins-model', { hasText: name }) }).locator('td.num').first();
    assert.equal(await (await tokenCell('gpt-6')).textContent(), '—');
    assert.equal(await (await tokenCell('gpt-6')).locator('span').getAttribute('title'), 'Not reported for these turns');
    assert.equal(await (await tokenCell('codex')).textContent(), '≥8.4k');
    assert.equal(await (await tokenCell('codex')).locator('span').getAttribute('title'), 'Reported for 3 of 6 turns');
    assert.equal(await (await tokenCell('opus')).textContent(), '14k');
    assert.deepEqual(await page.$$eval('.ins-model', els => els.map(e => e.textContent)), ['gpt-6', 'opus', 'codex', 'haiku', 'tiny'],
      'models keep the server\'s work-done order');
    assert.equal(await page.locator('.ins-share', { has: page.locator('i') }).first().getAttribute('title'), '47% of agent time');
    await page.locator('[data-ins-lens="time"]').click();
    assert.equal(await page.locator('.ins-legend span').count(), 0, 'a single series needs no legend');
    assert.equal(await page.locator('.ins-svg text.tick').first().textContent(), '0m');

    // Lists link straight to tasks; a hold during work reads as needing input.
    assert.equal(await page.locator('.ins-task-title', { hasText: 'Build the refund flow' }).getAttribute('href'), '/acme/web/tasks/12');
    assert.ok((await page.locator('.ins-task', { hasText: 'Pick a tax provider' }).textContent()).includes('needs input'));
    assert.equal(await page.locator('.ins-pr').getAttribute('href'), 'https://github.com/acme/api/pull/7');
    assert.equal(await page.locator('.ins-name a', { hasText: 'Payments API' }).getAttribute('href'), '/acme/api');

    // Quota: subscription windows plus accounts that can't take work right now.
    assert.equal(await page.locator('.ins-quota').count(), 2);
    assert.ok(await page.locator('.ins-quota-bar.crit').count(), 'a nearly spent window is flagged');
    assert.match(await page.locator('.ins-quota', { hasText: 'key:codex' }).textContent(), /exhausted · back in 1h 30m/);
    assert.equal(await page.locator('.ins-more').getAttribute('href'), '/acme/settings#settings-agents');
    const requests = () => page.evaluate(() => window.requests);
    assert.ok(!(await requests()).some(r => r.url.endsWith('/accounts/usage/recheck')), 'a fresh quota reading is not re-probed');

    // The period is remembered and refetched in the viewer's time zone.
    assert.match((await requests()).find(r => r.url.includes('/insights?')).url, /\/api\/organizations\/org_acme\/insights\?days=30&utcOffset=0$/);
    await page.locator('[data-ins-days="7"]').click();
    await page.waitForFunction(() => requests.filter(r => r.url.includes('days=7')).length === 1);
    assert.equal(await page.evaluate(() => localStorage.getItem('karmax.insightsDays')), '7');
    assert.equal(await page.locator('[data-ins-days="7"]').getAttribute('aria-checked'), 'true');

    // Spend appears for callers with payment access.
    await page.evaluate(() => { window.insightsResponse = () => ({ ...FIXTURE, totals: { ...FIXTURE.totals, spendMicros: 12_500_000 }, previous: { ...FIXTURE.previous, spendMicros: 10_000_000 }, spend: { modelMicros: 10_000_000, cardMicros: 2_500_000 } }); return renderPage(); });
    assert.equal(await page.locator('.ins-kpi').count(), 5);
    assert.match(await page.locator('.ins-kpi', { hasText: 'Spend' }).textContent(), /\$12\.50.*\$2\.50 on cards/s);

    // Tokens say how much of the work they cover when some turns went unreported.
    await page.evaluate(() => { window.insightsResponse = () => ({ ...FIXTURE, totals: { ...FIXTURE.totals, turns: 61, meteredTurns: 21 } }); return renderPage(); });
    assert.equal(await page.locator('.ins-kpi', { hasText: 'Tokens' }).locator('.ins-kpi-s').textContent(), 'reported for 21 of 61 turns');
    await page.evaluate(() => { window.insightsResponse = () => ({ ...FIXTURE, totals: { ...FIXTURE.totals, tokens: 0, meteredTurns: 0 } }); return renderPage(); });
    assert.match(await page.locator('.ins-kpi', { hasText: 'Tokens' }).locator('.ins-kpi-n').textContent(), /^—/);

    // A narrow phone: no horizontal overflow; what needs a person comes first.
    await page.setViewportSize({ width: 390, height: 900 });
    await page.waitForTimeout(100);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'no horizontal overflow at 390px');
    const order = await page.$$eval('.ins-grid > .ins-col', cols => cols.map(col => col.getBoundingClientRect().top));
    assert.ok(order[1] < order[0], 'the live column stacks above history on one column');
    const plot = await page.locator('.ins-svg').boundingBox();
    assert.ok(plot.width < 390, 'the chart redraws at the narrow width');
    await page.setViewportSize({ width: 1280, height: 1000 });

    // A brand-new organization gets one next step, not a page of zeros.
    await page.evaluate(() => { window.insightsResponse = () => EMPTY; S.projects = []; return renderPage(); });
    assert.equal(await page.locator('.ins-chart').count(), 0);
    assert.equal(await page.locator('.ins-kpi').count(), 0);
    await page.locator('#insights-new-project').click();
    assert.equal(await page.evaluate(() => window.createdProject), true);
    assert.equal(await page.locator('.ins-node.shipped.zero').count(), 1);

    console.log('insights browser checks passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
