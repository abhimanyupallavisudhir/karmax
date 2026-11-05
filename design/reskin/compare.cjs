// Side-by-side sheets of design/reskin/shoot.cjs's screens: per page, the
// classic look (the console before the re-skin) beside the default look in
// light and dark. Usage: IN=/tmp/shots/reskin OUT=design/reskin/out node design/reskin/compare.cjs
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const IN = process.env.IN || '/tmp/shots/reskin';
const OUT = process.env.OUT || path.join(__dirname, 'out');
const LOOKS = [['classic-light', 'Classic (before)'], ['default-light', 'Default · light'], ['default-dark', 'Default · dark']];
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const pages = [...new Set(fs.readdirSync(IN).filter((f) => f.endsWith('.png')).map((f) => f.split('--')[0]))];
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 2400, height: 600 } });
  for (const name of pages) {
    const cells = LOOKS.filter(([look]) => fs.existsSync(path.join(IN, `${name}--${look}.png`))).map(([look, label]) =>
      `<figure><figcaption>${label}</figcaption><img src="data:image/png;base64,${fs.readFileSync(path.join(IN, `${name}--${look}.png`)).toString('base64')}"></figure>`).join('');
    await page.setContent(`<style>body{margin:0;padding:24px;background:#e9e9ec;font:600 22px Inter,system-ui,sans-serif;color:#18181b}
      .row{display:grid;grid-template-columns:repeat(${LOOKS.length},1fr);gap:20px}figure{margin:0}figcaption{margin:0 0 10px}
      img{width:100%;border-radius:10px;box-shadow:0 2px 12px #0002}</style><div class="row">${cells}</div>`);
    await page.waitForTimeout(200);
    await page.locator('.row').screenshot({ path: path.join(OUT, `${name}.png`) });
  }
  await browser.close();
  console.log(`${pages.length} sheets in ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
