// Render Installation → Error reports from the real app.js functions in
// Chromium: Off until a project is chosen, the project picker, the PUT a
// choice sends, the link to the fixer once there is one, and a phone width.
// Run: node web/error-reports.browser.test.cjs
// ERROR_REPORTS_SCREENSHOT=<file> also saves a screenshot.
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

const PAGE = `<!doctype html><html data-theme="light"><body><main class="main"><div class="main-inner" style="padding:20px;max-width:800px">
  <div class="organization-settings installation-settings"><div class="settings-content">
  <div class="settings-section-title" id="installation-errors"><div>Error reports</div></div>
  <div class="card" id="error-reports-card"><span class="task-sub">Loading…</span></div>
  </div></div></div></main></body></html>`;

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1040, height: 400 }, locale: 'en-US', timezoneId: 'UTC' });
    await page.route('http://errors.test/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.startsWith('/fonts/')) return route.fulfill({ body: fs.readFileSync(path.join(__dirname, pathname)), contentType: 'font/woff2' });
      return route.fulfill({ body: PAGE, contentType: 'text/html' });
    });
    await page.goto('http://errors.test/');
    await page.addStyleTag({ path: path.join(__dirname, 'styles.css') });
    await page.evaluate(() => {
      window.esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
      window.$ = (selector) => document.querySelector(selector);
      window.S = { meta: { siteName: 'tavya' }, organizationId: 'org_personal', projects: [
        { id: 'proj_tavya', name: 'tavya', organizationId: 'org_personal' },
        { id: 'proj_site', name: 'Website', folder: 'Clients', organizationId: 'org_personal' },
        { id: 'proj_other', name: 'Not mine', organizationId: 'org_b' }] };
      window.inSidebarOrder = (projects) => projects;
      window.projectPath = (p) => [p.folder, p.name].filter(Boolean).join('/');
      window.taskUrl = (id, record) => `/o/${record.projectId}/tasks/${id}`;
      window.requests = [];
      window.toasts = [];
      window.toast = (message) => window.toasts.push(message);
      window.paneError = (box, error) => { box.textContent = `error: ${error.message}`; };
      window.saved = {};
      window.api = async (url, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : undefined;
        window.requests.push({ url, method: options.method || 'GET', body });
        if (options.method === 'PUT') window.saved = body.projectId ? { projectId: body.projectId, fixerTaskId: 'task_fixer' } : {};
        return { settings: window.saved };
      };
    });
    await page.addScriptTag({ content: ['errorReportsMarkup', 'wireErrorReportsCard'].map(fn).join('\n') });

    await page.evaluate(() => wireErrorReportsCard());
    const select = page.locator('#error-reports-project');
    assert.equal(await select.inputValue(), '', 'off until a project is chosen');
    // Only this organization's projects, by their path.
    assert.deepEqual(await select.locator('option').allTextContents(), ['Off', 'tavya', 'Clients/Website']);
    assert.equal(await page.locator('#error-reports-card a').count(), 0, 'no fixer yet');

    await select.selectOption('proj_tavya');
    await page.waitForFunction(() => document.querySelector('#error-reports-card a'));
    assert.deepEqual(await page.evaluate(() => window.requests.map((r) => `${r.method} ${r.url} ${JSON.stringify(r.body ?? null)}`)), [
      'GET /api/settings/error-reports null',
      'PUT /api/settings/error-reports {"projectId":"proj_tavya"}',
      'GET /api/settings/error-reports null',
    ]);
    assert.equal(await page.locator('#error-reports-card a').getAttribute('href'), '/o/proj_tavya/tasks/task_fixer');
    assert.equal(await select.inputValue(), 'proj_tavya');
    assert.deepEqual(await page.evaluate(() => window.toasts), ['Error reports on']);
    if (process.env.ERROR_REPORTS_SCREENSHOT) await page.locator('.installation-settings').screenshot({ path: process.env.ERROR_REPORTS_SCREENSHOT });

    // Off again.
    await select.selectOption('');
    await page.waitForFunction(() => !document.querySelector('#error-reports-card a'));
    assert.equal(await page.evaluate(() => window.requests.at(-2).body.projectId), null);

    // A phone: the row fits.
    await page.setViewportSize({ width: 390, height: 400 });
    const box = await page.locator('#error-reports-card').boundingBox();
    assert.ok(box && box.width <= 390, 'the card fits a phone');
    console.log('error reports card: ok');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
