// Before | after sheets of design/ux-round-2/shoot.cjs's screens, one per page.
// Usage: BEFORE=/tmp/ux2/before AFTER=/tmp/ux2/after OUT=design/ux-round-2/out node design/ux-round-2/compare.cjs
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const BEFORE = process.env.BEFORE || '/tmp/ux2/before';
const AFTER = process.env.AFTER || '/tmp/ux2/after';
const OUT = process.env.OUT || path.join(__dirname, 'out');
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const names = fs.readdirSync(AFTER).filter((f) => f.endsWith('.png') && fs.existsSync(path.join(BEFORE, f)));
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 2000, height: 600 } });
  const img = (dir, f) => `data:image/png;base64,${fs.readFileSync(path.join(dir, f)).toString('base64')}`;
  for (const f of names) {
    const phone = f.includes('-phone');
    await page.setContent(`<style>body{margin:0;padding:20px;background:#e9e9ec;font:600 20px Inter,system-ui,sans-serif;color:#18181b}
      .row{display:grid;grid-template-columns:1fr 1fr;gap:20px;${phone ? 'width:860px' : ''}}figure{margin:0}figcaption{margin:0 0 8px}
      img{width:100%;border-radius:10px;box-shadow:0 2px 12px #0002}</style>
      <div class="row"><figure><figcaption>Before</figcaption><img src="${img(BEFORE, f)}"></figure><figure><figcaption>After</figcaption><img src="${img(AFTER, f)}"></figure></div>`);
    await page.waitForTimeout(150);
    await page.locator('.row').screenshot({ path: path.join(OUT, f) });
  }
  await browser.close();
  console.log(`${names.length} sheets in ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
