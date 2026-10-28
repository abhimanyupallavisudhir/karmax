// Before/after sheets of the round-2 sweep, one per area, from each area's
// before/after screens. Usage: ROOT=<dir holding a-before/, a-after/, …>
//   node design/ui-sweep/compare-2.cjs   → design/ui-sweep/review/<area>.png
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = process.env.ROOT || __dirname;
const OUT = path.join(__dirname, 'review');
const AREAS = {
  settings: ['a', [['Payments', 'org-settings-payments-light-1280'], ['Project', 'project-project-light-1280'],
    ['People', 'org-settings-people-light-1280'], ['Task defaults (phone)', 'project-project-defaults-light-390']]],
  installation: ['b', [['Paid launch', 'installation-paid-launch.light.rich'], ['Health', 'installation-health.light'],
    ['Service limits', 'installation-limits.light'], ['Profile', 'profile.light']]],
  'task-page': ['c', [['Task', 'task'], ['Task form', 'task-form'], ['Task (phone)', 'task.mobile'], ['Help', 'help'], ['Queues', 'queues']]],
  home: ['d', [['Tasks', 'tasks'], ['Org wiki', 'org-wiki'], ['Insights', 'insights'], ['Home (phone)', 'home.mobile']]],
};
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  for (const [area, [letter, shots]] of Object.entries(AREAS)) {
    const src = (side, name) => {
      const file = [path.join(ROOT, `${letter}-${side}`, `${name}.png`), path.join(ROOT, `sweep-${letter}/design/ui-sweep/${letter}-${side}/${name}.png`)].find(fs.existsSync);
      return file ? `data:image/png;base64,${fs.readFileSync(file).toString('base64')}` : '';
    };
    const rows = shots.filter(([, n]) => src('before', n) && src('after', n)).map(([label, n]) =>
      `<b>${label}</b><img src="${src('before', n)}"><img src="${src('after', n)}">`).join('');
    const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
    await page.setContent(`<html><body style="margin:0;padding:24px;background:#eef0f4;font:15px system-ui">
      <style>img{width:100%;max-height:900px;object-fit:cover;object-position:top;border:1px solid #ccd;background:#fff}b{padding-top:6px}</style>
      <div style="display:grid;grid-template-columns:150px 1fr 1fr;gap:14px;align-items:start">
      <div></div><h2 style="margin:0">Before</h2><h2 style="margin:0">After</h2>${rows}</div></body></html>`);
    await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
    await page.screenshot({ path: path.join(OUT, `${area}.png`), fullPage: true });
    await page.close();
  }
  await browser.close();
  console.log(`sheets in ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
