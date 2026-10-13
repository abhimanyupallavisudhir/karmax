// Side-by-side before/after sheet of the main console pages.
// Usage: node design/ui-sweep/compare.cjs   → design/ui-sweep/before-after.png
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const dir = path.resolve(__dirname);
const pages = [['home', 'Home'], ['tasks-all', 'Project tasks'], ['queues', 'Queues'], ['insights', 'Insights'],
  ['project-settings', 'Project settings'], ['org-settings--01-plan-billing', 'Organization settings'],
  ['installation--04-host-capacity', 'Installation'], ['wiki', 'Wiki'], ['avatars', 'Avatars'], ['profile', 'Profile']];
const img = (side, name) => `file://${dir}/${side}/${name}.png`;
const html = `<html><body style="margin:0;padding:24px;background:#eef0f4;font:15px system-ui">
<div style="display:grid;grid-template-columns:160px 1fr 1fr;gap:10px 14px;align-items:start">
<div></div><h2 style="margin:0">Before</h2><h2 style="margin:0">After</h2>
${pages.filter(([n]) => fs.existsSync(`${dir}/before/${n}.png`) && fs.existsSync(`${dir}/after/${n}.png`)).map(([n, label]) =>
  `<b style="padding-top:6px">${label}</b><img src="${img('before', n)}" style="width:100%;max-height:520px;object-fit:cover;object-position:top;border:1px solid #ccd"><img src="${img('after', n)}" style="width:100%;max-height:520px;object-fit:cover;object-position:top;border:1px solid #ccd">`).join('\n')}
</div></body></html>`;
fs.writeFileSync('/tmp/ui-sweep-compare.html', html);
(async () => {
  const b = await chromium.launch({ args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const p = await b.newPage({ viewport: { width: 1800, height: 900 } });
  await p.goto('file:///tmp/ui-sweep-compare.html'); await p.waitForTimeout(1000);
  await p.screenshot({ path: path.join(dir, 'before-after.png'), fullPage: true }); await b.close();
})();
