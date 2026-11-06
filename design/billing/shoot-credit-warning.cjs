// The task form's notice for a model on the compute credit that costs more
// than the included one, rendered from the real app.js functions and styles.
// Run: node design/billing/shoot-credit-warning.cjs [outDir]
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const src = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');
function fn(name) {
  const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  let depth = 0;
  for (let i = src.indexOf('{', src.indexOf(')', start)); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`Missing function: ${name}`);
}
const out = process.argv[2] || '/tmp/billing';
fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 760, height: 120 }, deviceScaleFactor: 2, locale: 'en-US' });
  await page.route('http://shots.test/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/fonts/')) return route.fulfill({ body: fs.readFileSync(path.join(root, 'web', pathname)), contentType: 'font/woff2' });
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html data-theme="light"><body><main class="main"><div class="main-inner" style="padding:20px;max-width:720px"><div class="tf-ready" id="tf-ready" role="status"></div></div></main></body></html>' });
  });
  await page.goto('http://shots.test/');
  await page.addStyleTag({ path: path.join(root, 'web/styles.css') });
  await page.addScriptTag({ content: `
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const siteName = () => 'tavya';
    const ACCOUNT_PROVIDER_LABELS = {};
    const globalRoute = () => '/acme/settings';
    const projectRoute = () => '/acme/web/settings';
    const formatBytes = (n) => n + ' B';
    ${['readinessGaps', 'readinessNoticeHtml'].map(fn).join('\n')}` });
  await page.evaluate(() => { document.querySelector('#tf-ready').innerHTML = readinessNoticeHtml(readinessGaps({
    agents: [{ provider: 'opencode', model: 'openrouter/openai/gpt-6.1-sol', ready: true, cost: 8 }], compute: { ready: true } })); });
  await page.locator('.main-inner').screenshot({ path: path.join(out, 'task-form-credit-warning.png') });
  await browser.close();
  console.log(`screens in ${out}`);
})().catch((error) => { console.error(error); process.exit(1); });
