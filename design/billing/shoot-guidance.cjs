// The task page of a task waiting Out of compute, rendered by the real
// console (web/app.js with a scripted /api): one line saying what happened,
// the ways out as buttons, the whole reason on hover.
// Run: node design/billing/shoot-guidance.cjs [outDir]  (default /tmp/billing)
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = process.argv[2] || '/tmp/billing';
fs.mkdirSync(out, { recursive: true });
const spent = "Out of compute: this month's $10.00 of compute is used up. Add a $10 pack or turn on auto top-up in Plan & billing, or connect your own Hetzner account in Settings → Computers. It renews on 2026-12-01.";
const noPlan = "Out of compute: tavya's computers come with a paid plan. Choose one in Plan & billing, or connect your own E2B account in Settings → Computers.";
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 560 }, deviceScaleFactor: 2, locale: 'en-US', timezoneId: 'UTC' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://shots.test/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/fonts/')) return route.fulfill({ body: fs.readFileSync(path.join(root, 'web', pathname)), contentType: 'font/woff2' });
    if (pathname.startsWith('/api/')) return route.fulfill({ json: {} });
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html data-theme="light"><body><div id="app"><main id="main" style="height:520px"></main></div><div id="toasts"></div></body></html>' });
  });
  await page.goto('http://shots.test/fern-lab/lab/tasks/12');
  await page.addStyleTag({ path: path.join(root, 'web/styles.css') });
  for (const script of ['totp-qr.js', 'markdown.js']) await page.addScriptTag({ path: path.join(root, 'web', script) });
  await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'web/app.js'), 'utf8').replace(/^boot\(\)\.catch\(.*$/m, '') });
  const shoot = async (name, detail) => {
    await page.evaluate(([detail]) => {
      Object.assign(S, { organizations: [{ id: 'o', name: 'Fern Lab', slug: 'fern-lab' }], organizationId: 'o',
        projects: [{ id: 'p', organizationId: 'o', name: 'Lab', slug: 'lab' }], projectId: 'p',
        taskEvents: [], sessions: {}, meta: { siteName: 'tavya' }, selected: 'task', taskTab: 'checkin' });
      S.view = { taskId: 'task', num: 12, title: 'Benchmark the new parser on the full corpus', stage: 'do', status: 'waiting',
        waitingFor: { kind: 'retry', summary: 'Out of compute', until: Date.UTC(2026, 10, 2, 14, 35), detail },
        actions: [{ name: 'followUp', enabled: true }],
        transcripts: [{ role: 'do', messages: [
          { role: 'user', text: 'Benchmark the new parser on the full corpus and write up the numbers.', ts: Date.UTC(2026, 10, 2, 13, 2) },
          { role: 'agent', text: 'Downloaded the corpus (38 GB) and built the parser. Starting the benchmark run now.', ts: Date.UTC(2026, 10, 2, 13, 41) }] }] };
      toast = () => {}; refreshTask = async () => {}; refreshTasks = async () => {};
      document.getElementById('main').innerHTML = '<div class="task-page">' + taskBar(S.view, 'checkin') + checkinTab(S.view) + '</div>';
    }, [detail]);
    await page.locator('.wait-notice').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, `${name}.png`) });
  };
  await shoot('task-out-of-compute', spent);
  await shoot('task-out-of-compute-no-plan', noPlan);
  await browser.close();
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`screens in ${out}`);
})().catch((error) => { console.error(error); process.exit(1); });
