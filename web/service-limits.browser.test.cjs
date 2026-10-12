// Render Installation → Service limits from the real app.js functions in
// Chromium: rows, bars and their 80%/95% states, where each number comes
// from, tooltips, the editor's request, the inbox alert, and a phone width.
// Run: node web/service-limits.browser.test.cjs
// SERVICE_LIMITS_SCREENSHOT=<file> (and _PHONE_, _DARK_, _EDITOR_SCREENSHOT) also save screenshots.
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

const NOW = Date.parse('2026-10-08T12:00:00Z');
const GIB = 1024 ** 3;
const meter = (id, label, unit, used, limit, extra = {}) => ({ id, label, tip: `${label}: what it counts.`, unit, window: 'now',
  used, usedSource: 'api', limit, limitSource: limit === undefined ? undefined : 'published',
  level: limit && used / limit >= 0.95 ? 95 : limit && used / limit >= 0.8 ? 80 : 0, history: [[NOW - 3600_000, used]], ...extra });
const service = (id, name, plan, meters, extra = {}) => ({ id, name, tip: `${name}: why it matters.`, plan, planSource: 'published',
  link: { url: `https://${id}.example/billing`, label: 'Upgrade' }, status: 'ok', checkedAt: NOW - 240_000, meters, ...extra });
const VIEW = {
  checkedAt: NOW - 240_000, thresholds: [0.8, 0.95], operatorOrganizationId: 'org_personal', canManage: true,
  cloudflare: { accountId: '35e42bcea7b0b9f09dce2860d587d418', tokenConfigured: true },
  services: [
    service('cloudflare-workers', 'Cloudflare Workers', 'Free', [meter('cloudflare-workers.requests', 'Requests today', 'count', 9_121, 100_000,
      { peak: { used: 31_500, at: NOW - 2 * 86_400_000 }, detail: 'tavya-resource-repositories 9,121' })]),
    service('cloudflare-r2', 'Cloudflare R2', 'Free allowance', [
      meter('cloudflare-r2.class-a', 'Writes this month', 'count', 74_000, 1_000_000),
      meter('cloudflare-r2.class-b', 'Reads this month', 'count', 241_000, 10_000_000),
      meter('cloudflare-r2.storage', 'Stored', 'bytes', 4.3 * GIB, 10 * GIB),
    ], { link: { url: 'https://dash.cloudflare.com/?to=/:account/r2/overview', label: 'Billing' } }),
    service('managed-storage', 'Managed storage', undefined, [
      meter('managed-storage.untracked', 'Untracked', 'bytes', 375e6, GIB, { usedSource: 'count', detail: 'nisada-personal 358 MB' }),
      meter('managed-storage.pending-delete', 'Awaiting deletion', 'bytes', 29.3e9, undefined, { usedSource: 'count', detail: 'all purged by 2026-11-09' }),
    ], { link: undefined }),
    service('composio', 'Composio', 'Pro', [
      meter('composio.tool-calls', 'Tool calls this month', 'count', 1_840, 400_000, { usedSource: 'count', limitSource: 'entered' }),
      meter('composio.accounts', 'Connected accounts', 'count', 8, undefined),
    ], { planSource: 'entered' }),
    service('e2b', 'E2B', 'Hobby', [
      meter('e2b.sandboxes', 'Running sandboxes', 'count', 6, 20),
      meter('e2b.hours', 'Hours this month', 'hours', 61.4, undefined, { usedSource: 'count' }),
    ]),
    { id: 'daytona', name: 'Daytona', tip: 'Daytona: why it matters.', link: { url: 'https://app.daytona.io/dashboard/limits', label: 'Upgrade' },
      status: 'not-connected', connect: 'Connect Daytona in the operator organization’s Compute settings.', meters: [] },
    service('resend', 'Resend', 'Free', [
      meter('resend.day', 'Emails today', 'count', 84, 100, { usedSource: 'count' }),
      meter('resend.month', 'Emails this month', 'count', 1_210, 3_000, { usedSource: 'count' }),
    ]),
    service('agentmail', 'AgentMail', 'Free', [
      meter('agentmail.inboxes', 'Inboxes', 'count', 1, 3),
      meter('agentmail.messages', 'Emails this month', 'count', 46, 3_000, { usedSource: 'count' }),
    ], { status: 'failed', error: 'AgentMail refused the credential (401)' }),
    service('letsencrypt', 'Let’s Encrypt', undefined, [meter('letsencrypt.certificates', 'Certificates, 7 days', 'count', 48, 50, { usedSource: 'count' })],
      { link: { url: 'https://letsencrypt.org/docs/rate-limits/', label: 'Limits' } }),
    service('github', 'GitHub App', undefined, [meter('github.api', 'API calls this hour', 'count', 1_320, 5_000, { limitSource: 'api', detail: 'abhimanyupallavisudhir' })],
      { link: { url: 'https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api', label: 'Limits' } }),
    service('host', 'This server', undefined, [
      meter('host.disk', 'Disk', 'bytes', 85 * GIB, 193 * GIB, { usedSource: 'host', limitSource: 'api' }),
      meter('host.memory', 'Memory', 'bytes', 5.9 * GIB, 7.8 * GIB, { usedSource: 'host', limitSource: 'api' }),
      meter('host.heap', 'Worker heap', 'bytes', 1.65 * GIB, 2 * GIB, { usedSource: 'host', limitSource: 'api' }),
      meter('host.database', 'Database connections', 'count', 18, 100, { usedSource: 'host', limitSource: 'api' }),
    ], { link: undefined }),
  ],
};

const PAGE = `<!doctype html><html data-theme="light"><body><main class="main"><div class="main-inner" style="padding:20px;max-width:800px">
  <div class="organization-settings installation-settings"><div class="settings-content">
  <div class="settings-section-title" id="installation-limits"><div>Service limits<small>Shared accounts and this server against their plans</small></div></div>
  <div class="card service-limits" id="service-limits-card"><span class="task-sub">Loading…</span></div>
  </div></div></div></main></body></html>`;

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1040, height: 900 }, locale: 'en-US', timezoneId: 'UTC' });
    await page.route('http://limits.test/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.startsWith('/fonts/')) return route.fulfill({ body: fs.readFileSync(path.join(__dirname, pathname)), contentType: 'font/woff2' });
      return route.fulfill({ body: PAGE, contentType: 'text/html' });
    });
    await page.goto('http://limits.test/');
    await page.clock.setFixedTime(new Date(NOW));
    await page.addStyleTag({ path: path.join(__dirname, 'styles.css') });
    await page.evaluate((view) => {
      window.esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
      window.$ = (selector) => document.querySelector(selector);
      window.S = { meta: { siteName: 'tavya' }, organizations: [{ id: 'org_personal', name: 'Abhimanyu' }, { id: 'org_b', name: 'Acme' }] };
      window.requests = [];
      window.toasts = [];
      window.toast = (message) => window.toasts.push(message);
      window.paneError = (box, error) => { box.textContent = `error: ${error.message}`; };
      window.api = async (url, options = {}) => {
        window.requests.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined });
        return view;
      };
    }, VIEW);
    await page.addScriptTag({ content: ['formatBytes', 'policyTip', 'fmtAgo', 'siteName', 'installationRoute', 'limitSource', 'limitAmount',
      'serviceLimitMeterMarkup', 'serviceLimitNameMarkup', 'serviceLimitActionsMarkup', 'serviceLimitsMarkup', 'serviceLimitEditorMarkup',
      'wireServiceLimitsCard', 'inboxRowLabel', 'inboxTitle'].map(fn).join('\n') });

    assert.equal(await page.evaluate(() => serviceLimitsMarkup(null)), '');
    await page.evaluate(() => wireServiceLimitsCard());
    assert.deepEqual(await page.evaluate(() => window.requests.map((r) => `${r.method} ${r.url}`)), ['GET /api/settings/service-limits']);

    // One row per measure; the service, plan and link only on its first row.
    const rows = page.locator('.limits-row');
    assert.equal(await rows.count(), 21);
    assert.equal(await page.locator('.limits-row:not(.cont) .limits-service .limits-name').count(), 11);
    const r2 = page.locator('.limits-row[data-service="cloudflare-r2"]');
    assert.equal(await r2.count(), 3);
    assert.equal(await r2.nth(0).locator('.limits-plan').textContent(), 'Free allowance');
    assert.equal(await r2.nth(1).locator('.limits-plan').count(), 0, 'the plan shows once per service');
    assert.equal(await r2.nth(0).locator('.limits-actions a').getAttribute('href'), 'https://dash.cloudflare.com/?to=/:account/r2/overview');
    assert.equal(await r2.nth(0).locator('.limits-actions a').getAttribute('target'), '_blank');
    assert.equal(await r2.nth(1).locator('.limits-actions a').count(), 0);

    // Numbers, compact limits, and where each number came from.
    const workers = page.locator('.limits-row[data-meter="cloudflare-workers.requests"]');
    assert.equal((await workers.locator('.limits-numbers').textContent()).trim(), '9,121 / 100K');
    assert.equal(await workers.locator('.limits-source').textContent(), 'API');
    assert.match(await workers.locator('.limits-bar').getAttribute('title'), /^Now 9,121 \(9%\) · 7-day high 31,500 · tavya-resource-repositories 9,121$/);
    assert.equal(await workers.locator('.limits-peak').count(), 1, 'the 7-day high is above today');
    const calls = page.locator('.limits-row[data-meter="composio.tool-calls"]');
    assert.equal(await calls.locator('.limits-source').textContent(), 'tavya');
    assert.equal(await calls.locator('.limits-source').getAttribute('title'), 'Counted by tavya');
    assert.equal(await calls.locator('.limits-limit').getAttribute('title'), 'Entered by you');
    assert.match(await calls.locator('.limits-limit').getAttribute('class'), /entered/);
    assert.equal(await page.locator('.limits-row[data-meter="host.heap"] .limits-source').textContent(), 'server');
    assert.equal((await page.locator('.limits-row[data-meter="host.disk"] .limits-numbers').textContent()).trim(), '85 GB / 193 GB');
    assert.equal((await page.locator('.limits-row[data-meter="e2b.hours"] .limits-numbers').textContent()).trim(), '61.4 h');
    assert.equal(await page.locator('.limits-row[data-meter="e2b.hours"] .limits-bar').count(), 0, 'no limit, no bar');
    // The bucket against tavya's records: untracked bytes as a meter, deleted bytes shown alongside.
    const untracked = page.locator('.limits-row[data-meter="managed-storage.untracked"]');
    assert.equal((await untracked.locator('.limits-numbers').textContent()).trim(), '358 MB / 1 GB');
    assert.match(await untracked.locator('.limits-bar').getAttribute('title'), /nisada-personal 358 MB$/);
    assert.equal((await page.locator('.limits-row[data-meter="managed-storage.pending-delete"] .limits-numbers').textContent()).trim(), '27.3 GB');

    // 80% and 95%: colour plus a marked percentage, never colour alone.
    const level = (id) => page.locator(`.limits-row[data-meter="${id}"] .limits-level`);
    assert.equal(await level('resend.day').textContent(), '▲ 84%');
    assert.match(await level('resend.day').getAttribute('class'), /warn/);
    assert.equal(await level('letsencrypt.certificates').textContent(), '▲ 96%');
    assert.match(await level('letsencrypt.certificates').getAttribute('class'), /critical/);
    assert.equal(await level('host.heap').textContent(), '▲ 82%');
    assert.equal(await level('cloudflare-workers.requests').textContent(), '9%');
    const fill = (id) => page.locator(`.limits-row[data-meter="${id}"] .limits-bar > i`).evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.notEqual(await fill('resend.day'), await fill('cloudflare-workers.requests'));
    assert.notEqual(await fill('letsencrypt.certificates'), await fill('resend.day'));
    const bar = await page.locator('.limits-row[data-meter="letsencrypt.certificates"] .limits-bar').boundingBox();
    const filled = await page.locator('.limits-row[data-meter="letsencrypt.certificates"] .limits-bar > i').boundingBox();
    assert.ok(Math.abs(filled.width / bar.width - 0.96) < 0.02, 'the fill is the share used');
    assert.match(await page.locator('.limits-head').textContent(), /Checked 4m ago · 3 near their limits/);

    // Failing and unconnected services say so; explanations are tooltips.
    assert.match(await page.locator('.limits-row[data-service="agentmail"] .limits-failed').textContent(), /Can’t read/);
    assert.match(await page.locator('.limits-row[data-service="agentmail"] .limits-failed .info-dot').getAttribute('title'), /AgentMail refused the credential \(401\)/);
    const daytona = page.locator('.limits-row[data-service="daytona"]');
    assert.match(await daytona.textContent(), /Not connected/);
    assert.match(await daytona.locator('.limits-off .info-dot').getAttribute('title'), /Compute settings/);
    assert.equal(await page.locator('.limits-row[data-meter="e2b.hours"] .limits-label').getAttribute('title'), 'Hours this month: what it counts.');
    assert.equal(await page.locator('.limits-row .limits-label.info-dot').count(), 20 + 11, 'every service and measure explains itself on hover or tap');
    if (process.env.SERVICE_LIMITS_SCREENSHOT) await page.locator('.settings-content').screenshot({ path: process.env.SERVICE_LIMITS_SCREENSHOT });
    for (const text of await page.locator('.limits-row .limits-measure, .limits-row .limits-numbers').all()) {
      const box = await text.boundingBox();
      assert.ok(box.height < 26, `a row wraps at desktop width: ${await text.textContent()}`);
    }

    // At the Installation page's width every bar keeps a readable length.
    for (const bar of await page.locator('.limits-bar').all())
      assert.ok((await bar.boundingBox()).width >= 90, 'a bar is squeezed at the settings column width');
    // Editing: limits, plan, the Cloudflare token (write-only) — one PUT.
    await page.locator('[data-limits-edit="cloudflare-workers"]').click();
    const editor = page.locator('.limits-editor');
    assert.equal(await editor.count(), 1);
    if (process.env.SERVICE_LIMITS_EDITOR_SCREENSHOT) await page.locator('#service-limits-card').screenshot({ path: process.env.SERVICE_LIMITS_EDITOR_SCREENSHOT });
    assert.equal(await editor.locator('[data-limit="cloudflare-workers.requests"]').getAttribute('placeholder'), '100000');
    assert.equal(await editor.locator('[data-cloudflare-token]').inputValue(), '');
    assert.equal(await editor.locator('[data-cloudflare-token]').getAttribute('placeholder'), 'Saved — paste to replace');
    await editor.locator('[data-plan]').fill('Paid');
    await editor.locator('[data-limit="cloudflare-workers.requests"]').fill('10000000');
    await editor.locator('[data-cloudflare-token]').fill('cfut_new');
    await editor.locator('[data-limits-save]').click();
    await page.waitForFunction(() => window.requests.length === 2);
    const put = await page.evaluate(() => window.requests[1]);
    assert.deepEqual(put, { url: '/api/settings/service-limits', method: 'PUT', body: {
      services: { 'cloudflare-workers': { plan: 'Paid', link: null, limits: { 'cloudflare-workers.requests': 10_000_000 } } },
      cloudflare: { accountId: '35e42bcea7b0b9f09dce2860d587d418', apiToken: 'cfut_new' } } });
    assert.equal(await page.locator('.limits-editor').count(), 0, 'the saved view replaces the editor');

    // Reset restores every published default for that service.
    await page.locator('[data-limits-edit="e2b"]').click();
    assert.equal(await page.locator('.limits-editor [data-operator-organization] option').count(), 2);
    await page.locator('.limits-editor [data-limits-reset]').click();
    await page.waitForFunction(() => window.requests.filter((r) => r.method === 'PUT').length === 2);
    assert.deepEqual(await page.evaluate(() => window.requests.filter((r) => r.method === 'PUT')[1].body),
      { services: { e2b: { plan: null, link: null, limits: { 'e2b.sandboxes': null, 'e2b.hours': null } } } });

    await page.locator('#service-limits-check').click();
    await page.waitForFunction(() => window.requests.some((r) => r.url === '/api/settings/service-limits/check' && r.method === 'POST'));

    // Readers see the page without controls.
    await page.evaluate((view) => { window.api = async () => ({ ...view, canManage: false }); return wireServiceLimitsCard(); }, VIEW);
    assert.equal(await page.locator('#service-limits-check, [data-limits-edit]').count(), 0);

    // The alert in the inbox.
    const alert = (subject) => ({ kind: 'escalated', subject: { kind: 'service-limit', service: 'letsencrypt', serviceName: 'Let’s Encrypt',
      label: 'Certificates, 7 days', unit: 'count', used: 48, limit: 50, level: 95, ...subject } });
    assert.equal(await page.evaluate((item) => inboxRowLabel(item), alert({})), 'Let’s Encrypt at 96% of its limit — upgrade now');
    assert.equal(await page.evaluate((item) => inboxTitle(item), alert({})), 'Let’s Encrypt · Certificates, 7 days 48 of 50');
    assert.equal(await page.evaluate((item) => inboxRowLabel(item), alert({ level: 80, used: 41 })), 'Let’s Encrypt at 82% of its limit');
    assert.equal(await page.evaluate((item) => inboxRowLabel(item), alert({ level: 'failed', error: 'no answer' })), 'Can’t read Let’s Encrypt usage');

    // A phone: nothing overflows the card.
    await page.evaluate((view) => { window.api = async () => view; return wireServiceLimitsCard(); }, VIEW);
    await page.setViewportSize({ width: 390, height: 900 });
    const card = await page.locator('#service-limits-card').boundingBox();
    for (const cell of await page.locator('.limits-row > *').all()) {
      const box = await cell.boundingBox();
      if (box) assert.ok(box.x + box.width <= card.x + card.width + 1, `overflows on a phone: ${await cell.textContent()}`);
    }
    if (process.env.SERVICE_LIMITS_PHONE_SCREENSHOT) await page.locator('.settings-content').screenshot({ path: process.env.SERVICE_LIMITS_PHONE_SCREENSHOT });
    if (process.env.SERVICE_LIMITS_DARK_SCREENSHOT) {
      await page.setViewportSize({ width: 1040, height: 900 });
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
      await page.locator('.settings-content').screenshot({ path: process.env.SERVICE_LIMITS_DARK_SCREENSHOT });
    }
    console.log('service limits browser test: ok');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
