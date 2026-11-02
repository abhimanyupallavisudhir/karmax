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
    compute: computeFixture(daily),
    storage: storageFixture(daily),
    logins: loginsFixture(),
    ...overrides,
  };
}
const M = 1e6, GB = 1024 ** 3;
function computeFixture(daily, money = true) {
  const list = [2, 3, 1, 4, 0, 6, 5].map(v => v * 0.4 * M);
  const days = daily.map((d, i) => ({ listMicros: list[i], chargedMicros: i >= 5 ? list[i] * 2 * 0.5 : 0, activeSeconds: 3600 * (i + 2), diskGbHours: 10,
    byProvider: { hetzner: list[i] * 0.5, e2b: list[i] * 0.3, gcp: list[i] * 0.15, fly: list[i] * 0.05 },
    byFunding: { own: i >= 5 ? list[i] * 0.5 : list[i], managed: i >= 5 ? list[i] * 0.5 : 0 },
    byProject: { web: list[i] * 0.7, api: list[i] * 0.3 }, bySize: { '2 CPU · 4 GB': list[i] * 0.8, '4 CPU · 16 GB': list[i] * 0.2 } }));
  const sum = (key) => days.reduce((total, d) => total + d[key], 0);
  const totals = { listMicros: sum('listMicros'), chargedMicros: sum('chargedMicros'), activeSeconds: sum('activeSeconds'), diskGbHours: 70 };
  const row = (key, label, share, extra = {}) => ({ key, label, listMicros: totals.listMicros * share, chargedMicros: extra.funding === 'managed' ? totals.chargedMicros : 0,
    activeSeconds: Math.round(totals.activeSeconds * share), diskGbHours: 10, ...extra });
  return {
    money, multiplier: 2,
    totals: { ...totals, managed: { ...totals, listMicros: totals.chargedMicros / 2 }, own: { ...totals, chargedMicros: 0 } },
    previous: { listMicros: 4 * M, chargedMicros: 0, activeSeconds: 40_000, diskGbHours: 0 },
    daily: days,
    providers: [row('hetzner', 'hetzner', 0.4, { funding: 'own' }), row('e2b', 'e2b', 0.3, { funding: 'own' }), row('gcp', 'gcp', 0.15, { funding: 'managed' }),
      row('hetzner', 'hetzner', 0.1, { funding: 'managed' }), row('fly', 'fly', 0.05, { funding: 'managed' })],
    projects: [row('web', 'Storefront', 0.7), row('api', 'Payments API', 0.3)],
    tasks: [row('t-1', 'Build the refund flow', 0.5, { projectId: 'web', num: 12 }), row('t-9', 'Nightly ETL', 0.2, { projectId: 'api', num: 3 })],
    sizes: [row('2 CPU · 4 GB', '2 CPU · 4 GB', 0.8), row('4 CPU · 16 GB', '4 CPU · 16 GB', 0.2)],
    credit: { month: '2026-09', from: Date.parse('2026-09-01T00:00:00Z'), to: Date.parse('2026-10-01T00:00:00Z'), daysInMonth: 30,
      creditMicros: 13 * M, includedMicros: 13 * M, packMicros: 0, giftMicros: 0, topUpMicros: 0, usedMicros: 12.1 * M, heldMicros: 0.3 * M,
      availableMicros: 0.6 * M, cumulative: Array.from({ length: 23 }, (_, i) => Math.round(0.55 * M * i)) },
    routing: { total: 9, fellOver: 2, unplaced: 1, full: [{ provider: 'hetzner', count: 2 }],
      providers: [{ provider: 'gcp', funding: 'managed', count: 5, reasons: [{ reason: 'cheapest that fits', count: 5 }] },
        { provider: 'hetzner', funding: 'managed', count: 3, reasons: [{ reason: 'cheapest that fits', count: 3 }] },
        { provider: 'e2b', funding: 'own', count: 1, reasons: [{ reason: 'restored where it ran', count: 1 }] }] },
  };
}
function storageFixture(daily) {
  const kinds = (i) => ({ resources: (2 + i * 0.1) * GB, workspaces: (1 + i * 0.2) * GB, reviewFiles: 0.05 * GB * i, other: 0 });
  return {
    bytes: 4.9 * GB, byKind: kinds(6), quotaBytes: 150 * GB, includedBytes: 50 * GB,
    packs: { paid: 1, gifted: 0, packBytes: 100 * GB, monthlyCents: 400 },
    daily: daily.map((d, i) => ({ bytes: Object.values(kinds(i)).reduce((a, b) => a + b, 0), byKind: kinds(i),
      byProject: { web: 3 * GB, api: 1 * GB }, added: 0.2 * GB, ...(i < 3 ? { estimated: true } : {}) })),
    projects: [{ id: 'web', name: 'Storefront', bytes: 3.5 * GB, byKind: { resources: 2 * GB, workspaces: 1.4 * GB, reviewFiles: 0.1 * GB, other: 0 } },
      { id: 'api', name: 'Payments API', bytes: 1.4 * GB, byKind: { resources: 0.6 * GB, workspaces: 0.6 * GB, reviewFiles: 0.2 * GB, other: 0 } }],
  };
}
function loginsFixture() {
  const hours = 168;
  const session = Array.from({ length: hours }, (_, h) => (h % 24) < 5 ? ((h % 24) + 1) * 0.18 : 0);
  const week = Array.from({ length: hours }, (_, h) => Math.min(1, h / hours * 0.8));
  return [
    { id: 'login:claude:work', provider: 'anthropic', turns: 40, tokens: 9e6, usd: 210, share: 0.7, daily: [130, 120, 140, 110, 130, 140, 150],
      dailyTokens: [1, 1, 1, 1, 1, 1, 1], capacity: { session: 150, week: 900, learned: true }, hourly: { from: NOW - hours * 3_600_000, session, week } },
    { id: 'login:claude:spare', provider: 'anthropic', turns: 12, tokens: 3e6, usd: 90, share: 0.3, daily: [60, 50, 60, 70, 60, 70, 60],
      dailyTokens: [1, 1, 1, 1, 1, 1, 1], capacity: { session: 150, week: 900, learned: false }, hourly: { from: NOW - hours * 3_600_000, session: session.map(v => v / 2), week: week.map(v => v / 3) } },
  ];
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
      window.installationRoute = () => '/installation';
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
      ...['beginAsyncElementRender', 'fmtAgo', 'fmtCountdown', 'usageResetLabel', 'autoRecheckUsage', 'accountShortName'].map(fn),
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
    assert.deepEqual(nodes.map(n => [n.name, n.n]), [['Setup', '1'], ['Working', '4'], ['Review', '2'], ['PR', '0'], ['Landing', '2'], ['Shipped', '11']]);
    assert.deepEqual(nodes[1].parts, ['w', 'h']);
    assert.deepEqual(nodes[4].parts, ['w', 'q'], 'an open task neither with an agent nor a person reads as queued');
    assert.ok(await page.locator('.ins-node.shipped .ins-delta.good').count(), 'more shipped than last period is good news');
    const foot = await page.locator('.ins-flow-foot').textContent();
    for (const text of ['1 escalated', '2 failed', '2 drafts']) assert.ok(foot.includes(text), text);
    // Who holds the work is said once, by the panels.
    assert.ok(!foot.includes('with agents') && !foot.includes('waiting on people'), 'the foot does not repeat the panels');
    assert.equal(await page.locator('.ins-card-h', { hasText: 'Waiting on people' }).locator('.ins-count').textContent(), '4');
    assert.equal(await page.locator('.ins-card-h', { hasText: 'With agents' }).locator('.ins-count').textContent(), '5');

    // Trend tiles: lower time-to-ship is good; spend only appears with payment access.
    assert.equal(await page.locator('.ins-kpi').count(), 6);
    // Compute: list cost with machine time and what was charged to credit; storage against its quota.
    assert.match(await page.locator('.ins-kpi', { hasText: 'Compute' }).textContent(), /\$8\.40.*\$4\.40 charged/s);
    assert.match(await page.locator('.ins-kpi', { hasText: 'Storage' }).textContent(), /4\.9 GB.*3% of 150 GB/s);
    assert.ok((await page.locator('.ins-kpi', { hasText: 'Time to ship' }).locator('.ins-delta').getAttribute('class')).includes('good'));
    assert.ok((await page.locator('.ins-kpi', { hasText: 'Agent time' }).textContent()).includes('10% failed'));
    assert.match(await page.locator('.ins-kpi', { hasText: 'Tokens' }).locator('.ins-kpi-n').textContent(), /^28k/);

    // Chart: shipped columns (one per non-zero day) + the started line on one axis.
    assert.equal(await page.locator('.ins-svg path[fill="var(--merged)"]').count(), 5);
    assert.equal(await page.locator('.ins-svg .ins-line').count(), 1);
    assert.deepEqual(await page.$$eval('.ins-chart .ins-legend span', els => els.map(e => e.textContent)), ['Shipped', 'Started']);
    const svg = await page.locator('.ins-svg').boundingBox();
    await page.mouse.move(svg.x + svg.width - 8, svg.y + 60);
    assert.equal(await page.locator('.ins-plot .ins-tip').isVisible(), true);
    assert.equal(await page.locator('.ins-plot .ins-tip-h').textContent(), 'Wed, Sep 23');
    assert.deepEqual(await page.$$eval('.ins-plot .ins-tip b', els => els.map(e => e.textContent)), ['4', '5']);
    const tip = await page.locator('.ins-plot .ins-tip').boundingBox();
    assert.ok(tip.x >= svg.x - 1 && tip.x + tip.width <= svg.x + svg.width + 1, 'the tooltip stays inside the chart');
    await page.mouse.move(svg.x - 40, svg.y - 40);
    assert.equal(await page.locator('.ins-plot .ins-tip').isVisible(), false);

    // Tokens lens: top three models keep their colors, the rest fold into Other.
    await page.locator('[data-ins-lens="tokens"]').click();
    assert.deepEqual(await page.$$eval('.ins-chart .ins-legend span', els => els.map(e => e.textContent)), ['opus', 'codex', 'haiku', 'Other']);
    const legendColors = await page.$$eval('.ins-chart .ins-legend i', els => els.map(e => e.style.background));
    const shareColor = await page.$$eval('.ins-table tr', rows => Object.fromEntries(rows.filter(row => row.querySelector('.ins-share') && row.querySelector('.ins-model'))
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
    assert.equal(await page.locator('.ins-table:has(.ins-model) .ins-share', { has: page.locator('i') }).first().getAttribute('title'), '47% of agent time');
    await page.locator('[data-ins-lens="time"]').click();
    assert.equal(await page.locator('.ins-chart .ins-legend span').count(), 0, 'a single series needs no legend');
    assert.equal(await page.locator('.ins-svg text.tick').first().textContent(), '0m');

    // Tokens by login: API-equivalent dollars, the logins' weekly quotas as a pace line.
    await page.locator('[data-ins-lens="tokens"]').click();
    await page.locator('[data-ins-split="login"]').click();
    assert.deepEqual(await page.$$eval('.ins-chart .ins-legend span', els => els.map(e => e.textContent)), ['claude:work', 'claude:spare', 'Weekly pace']);
    assert.equal(await page.locator('.ins-svg .ins-limit line').count(), 1, 'the weekly pace is drawn');
    assert.match(await page.locator('.ins-svg .ins-limit text').textContent(), /^Weekly pace \$257$/);
    assert.match(await page.locator('.ins-svg .ins-limit title').textContent(), /weekly quotas/);
    await page.locator('[data-ins-split="model"]').click();
    assert.equal(await page.locator('.ins-svg .ins-limit').count(), 0);

    // Compute lens: cost at list by provider (top three + Other), charged and machine time in the tooltip.
    await page.locator('[data-ins-lens="compute"]').click();
    assert.deepEqual(await page.$$eval('.ins-chart .ins-legend span', els => els.map(e => e.textContent)), ['Hetzner', 'E2B', 'Google Cloud', 'Other']);
    assert.deepEqual(await page.$$eval('[data-ins-split]', els => els.map(e => e.textContent)), ['Provider', 'Funding', 'Project', 'Size']);
    {
      const box = await page.locator('.ins-svg').boundingBox();
      await page.mouse.move(box.x + box.width - 8, box.y + 60);
      const tipText = await page.locator('.ins-plot .ins-tip').first().textContent();
      assert.match(tipText, /Total\$2\.00/);
      assert.match(tipText, /Charged to credit\$2\.00/);
      assert.match(tipText, /Machine time8h/);
    }
    await page.locator('[data-ins-split="funding"]').click();
    assert.deepEqual(await page.$$eval('.ins-chart .ins-legend span', els => els.map(e => e.textContent)), ['Own accounts', 'Managed']);
    await page.locator('[data-ins-split="size"]').click();
    assert.deepEqual(await page.$$eval('.ins-chart .ins-legend span', els => els.map(e => e.textContent)), ['2 CPU · 4 GB', '4 CPU · 16 GB']);

    // Storage lens: stored bytes by kind; the quota is far above, so it is named, not drawn.
    await page.locator('[data-ins-lens="storage"]').click();
    assert.deepEqual(await page.$$eval('.ins-chart .ins-legend span', els => els.map(e => e.textContent)), ['Data versions', 'Task workspaces', 'Review files', 'Quota']);
    assert.equal(await page.locator('.ins-svg .ins-limit line').count(), 0);
    assert.equal(await page.locator('.ins-svg .ins-limit.off text').textContent(), 'Quota 150 GB ↑');
    {
      const box = await page.locator('.ins-svg').boundingBox();
      await page.mouse.move(box.x + 50, box.y + 60);
      assert.match(await page.locator('.ins-plot .ins-tip').first().textContent(), /Estimated from what is stored now/);
    }
    assert.deepEqual(await page.$$eval('.ins-svg text.tick', els => els.map(e => e.textContent).filter(t => /B$/.test(t))), ['0 B', '2 GB', '4 GB', '6 GB'],
      'bytes tick in whole units');
    // Close to the quota, the line is drawn on the axis.
    await page.evaluate(() => { const data = S.insightsData; data.storage = { ...data.storage, quotaBytes: 8 * 1024 ** 3 }; drawInsightChart(document.querySelector('.ins-chart'), data); });
    assert.equal(await page.locator('.ins-svg .ins-limit line').count(), 1);
    await page.locator('[data-ins-split="project"]').click();
    assert.deepEqual(await page.$$eval('.ins-chart .ins-legend span', els => els.map(e => e.textContent)), ['Storefront', 'Payments API', 'Quota']);

    // Compute card: by provider (whose account), project, task (linked), size; list and charged.
    const compute = page.locator('.ins-compute');
    assert.deepEqual(await compute.locator('th').evaluateAll(els => els.map(e => e.textContent)), ['provider', 'Machine', 'List', 'Charged']);
    assert.match(await compute.locator('tr', { hasText: 'Google Cloud' }).textContent(), /managed/);
    assert.equal(await compute.locator('tr', { hasText: 'E2B' }).locator('.ins-tag').getAttribute('title'), 'Your own provider accounts: the provider bills you at its list price');
    await compute.locator('[data-ins-cby="task"]').click();
    assert.equal(await page.locator('.ins-compute a', { hasText: 'Nightly ETL' }).getAttribute('href'), '/acme/api/tasks/3');
    await page.locator('.ins-compute [data-ins-cby="size"]').click();
    assert.equal(await page.locator('.ins-compute tbody tr').count(), 2);

    // Storage card: against the quota, by kind and project, packs and their price.
    const storage = page.locator('.ins-storage');
    assert.equal(await storage.locator('.ins-count').textContent(), '4.9 GB of 150 GB');
    assert.match(await storage.locator('.ins-count').getAttribute('title'), /Plan 50 GB \+ 1 storage pack of 100 GB · \$4\/month/);
    assert.equal(await storage.locator('tbody tr').count(), 2);
    assert.equal(await storage.locator('.ins-foot').textContent(), '1 storage pack · $4/month');

    // Logins: share of the work, each one's 5-hour and weekly windows against its limit.
    const logins = page.locator('.ins-logins');
    assert.equal(await logins.locator('.ins-login-share b').first().textContent(), '70%');
    assert.match(await logins.locator('.ins-login-share').first().getAttribute('title'), /70% of the work in 7 days · \$210 at API prices · 40 turns/);
    assert.equal(await logins.locator('.ins-mini svg').count(), 2);
    assert.equal(await logins.locator('.ins-mini-limit').count(), 2, 'each login\'s window limit is drawn');
    {
      const box = await logins.locator('.ins-mini svg').first().boundingBox();
      await page.mouse.move(box.x + box.width - 2, box.y + 10);
      assert.match(await logins.locator('.ins-mini .ins-tip').first().textContent(), /5-hour window.*Week.*Of \$150 per 5 hours and \$900 per week/s);
    }

    // Turns from before logins were recorded: one gray row and bar, apart from the logins' shares.
    await page.evaluate(() => { window.insightsResponse = () => ({ ...FIXTURE, logins: [...FIXTURE.logins, { id: 'unrecorded:anthropic', provider: 'anthropic',
      unrecorded: true, turns: 1681, tokens: 1e9, usd: 3699, share: 0, daily: [500, 0, 0, 0, 0, 0, 0], dailyTokens: [0, 0, 0, 0, 0, 0, 0] }] }); return renderPage(); });
    assert.match(await page.locator('.ins-unrecorded').textContent(), /Login not recorded\s*1\.7k turns/);
    assert.match(await page.locator('.ins-unrecorded').getAttribute('title'), /before tavya recorded which login/);
    await page.locator('[data-ins-lens="tokens"]').click();
    await page.locator('[data-ins-split="login"]').click();
    assert.deepEqual(await page.$$eval('.ins-chart .ins-legend span', els => els.map(e => e.textContent)), ['claude:work', 'claude:spare', 'Not recorded', 'Weekly pace']);
    await page.locator('[data-ins-split="model"]').click();
    await page.locator('[data-ins-lens="shipped"]').click();
    await page.evaluate(() => { window.insightsResponse = () => FIXTURE; return renderPage(); });

    // Credit: charges so far against the month's credit, with the pace to the end.
    const credit = page.locator('.ins-credit');
    assert.equal(await credit.locator('.ins-count').textContent(), '$12.10 of $13.00');
    assert.equal(await credit.locator('.ins-mini-limit').count(), 1);
    assert.match(await credit.locator('.ins-foot').textContent(), /^\$0\.60 left · runs out ~Sep 25$/);

    // Where Any ran, and how often an account was full.
    const routing = page.locator('.ins-routing');
    assert.equal(await routing.locator('.ins-count').textContent(), '9');
    assert.match(await routing.locator('.ins-foot').textContent(), /2 fell over · 1 waited/);

    // Budgets are for operators only.
    assert.equal(await page.locator('.ins-budgets').count(), 0);
    await page.evaluate(() => { window.insightsResponse = () => ({ ...FIXTURE, compute: { ...FIXTURE.compute, budgets: [
      { provider: 'gcp', pool: { cpu: 24, machines: 24 }, peakCpu: [2, 4, 8, 6, 0, 24, 10], peakMachines: [1, 2, 3, 3, 0, 9, 4] },
      { provider: 'e2b', pool: { machines: 20 }, peakCpu: [0, 0, 0, 0, 0, 0, 0], peakMachines: [1, 0, 2, 3, 0, 1, 1] }] } }); return renderPage(); });
    assert.deepEqual(await page.$$eval('.ins-budget .ins-count', els => els.map(e => e.textContent)), ['peak 24 of 24 CPU', 'peak 3 of 20 machines']);
    assert.ok((await page.locator('.ins-budget .ins-count').first().getAttribute('class')).includes('over'));
    assert.equal(await page.locator('.ins-budgets .ins-more').getAttribute('href'), '/installation#installation-compute');
    await page.evaluate(() => { window.insightsResponse = () => FIXTURE; return renderPage(); });
    await page.locator('[data-ins-lens="shipped"]').click();

    // Members without payment access see machine time, not amounts.
    await page.evaluate(() => { window.insightsResponse = () => ({ ...FIXTURE, compute: { ...FIXTURE.compute, money: false, credit: undefined } }); return renderPage(); });
    assert.match(await page.locator('.ins-kpi', { hasText: 'Compute' }).locator('.ins-kpi-n').textContent(), /^35h/);
    assert.deepEqual(await page.$$eval('.ins-compute th', els => els.map(e => e.textContent)), ['size', 'Machine'], 'the chosen split is kept');
    await page.locator('[data-ins-lens="compute"]').click();
    assert.equal(await page.locator('[data-ins-split]').count(), 0);
    assert.equal(await page.locator('.ins-credit').count(), 0);
    await page.locator('[data-ins-lens="time"]').click();
    await page.evaluate(() => { window.insightsResponse = () => FIXTURE; return renderPage(); });

    // Lists link straight to tasks; a hold during work reads as needing input.
    assert.equal(await page.locator('.ins-task-title', { hasText: 'Build the refund flow' }).getAttribute('href'), '/acme/web/tasks/12');
    assert.ok((await page.locator('.ins-task', { hasText: 'Pick a tax provider' }).textContent()).includes('Needs input'));
    assert.ok((await page.locator('.ins-task', { hasText: 'Review checkout copy' }).textContent()).includes('Storefront · Review'), 'stages read as the pipeline names them');
    assert.equal(await page.locator('.ins-pr').getAttribute('href'), 'https://github.com/acme/api/pull/7');
    assert.equal(await page.locator('.ins-name a', { hasText: 'Payments API' }).first().getAttribute('href'), '/acme/api');

    // Logins: the period's logins plus accounts that can't take work right now.
    assert.equal(await page.locator('.ins-quota').count(), 3);
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
    assert.equal(await page.locator('.ins-kpi').count(), 7);
    assert.match(await page.locator('.ins-kpi', { hasText: 'Spend' }).textContent(), /\$12\.50.*\$2\.50 on cards/s);

    // Tokens say how much of the work they cover when some turns went unreported.
    await page.evaluate(() => { window.insightsResponse = () => ({ ...FIXTURE, totals: { ...FIXTURE.totals, turns: 61, meteredTurns: 21 } }); return renderPage(); });
    assert.equal(await page.locator('.ins-kpi', { hasText: 'Tokens' }).locator('.ins-kpi-s').textContent(), 'reported for 21 of 61 turns');
    await page.evaluate(() => { window.insightsResponse = () => ({ ...FIXTURE, totals: { ...FIXTURE.totals, tokens: 0, meteredTurns: 0 } }); return renderPage(); });
    assert.match(await page.locator('.ins-kpi', { hasText: 'Tokens' }).locator('.ins-kpi-n').textContent(), /^—/);

    // Nothing to flag: no foot under the pipeline; a tile with nothing more to say has no third line.
    await page.evaluate(() => { window.insightsResponse = () => ({ ...FIXTURE, pipeline: { ...FIXTURE.pipeline, drafts: 0,
      stages: { ...FIXTURE.pipeline.stages, escalated: { open: 0 }, failed: { open: 0 } } } }); return renderPage(); });
    assert.equal(await page.locator('.ins-flow-foot').count(), 0);
    assert.equal(await page.locator('.ins-kpi', { hasText: 'Started' }).locator('.ins-kpi-s').count(), 0);
    // The Projects card does not repeat its title as a column; time is "Agent time" as on its tile.
    assert.deepEqual(await page.$$eval('.ins-table:has(.ins-spark-col) th', els => els.map(e => e.textContent)), ['Project', 'Shipped per day', 'Shipped', 'Open', 'Agent time']);
    assert.equal(await page.locator('.ins-table th .sr-only', { hasText: 'Project' }).count(), 1);

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
