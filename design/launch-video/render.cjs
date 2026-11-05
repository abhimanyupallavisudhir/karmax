// Renders stage.html frame by frame into an MP4 (H.264, 1080p).
// Usage: ASSETS=/home/user/demo/assets node design/launch-video/render.cjs out.mp4 [--stills t1,t2,…] [--from s --to s] [--workers n]
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ASSETS = process.env.ASSETS || '/home/user/demo/assets';
const args = process.argv.slice(2);
const out = args[0];
const opt = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tavya-video-'));
for (const f of ['stage.html', 'timeline.js']) fs.copyFileSync(path.join(__dirname, f), path.join(root, f));
fs.symlinkSync(ASSETS, path.join(root, 'assets'));

async function open(browser) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.goto(`file://${root}/stage.html`);
  await page.waitForFunction(() => window.DURATION > 0);
  return page;
}
const frameAt = (page, t) => page.evaluate((t) => window.seek(t), t).then(() => page.screenshot({ type: 'png' }));

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--allow-file-access-from-files', '--font-render-hinting=none'] });
  const page = await open(browser);
  const duration = await page.evaluate(() => window.DURATION);
  const fps = await page.evaluate(() => window.FPS);
  fs.writeFileSync(`${out}.json`, JSON.stringify(await page.evaluate(() => ({ duration: window.DURATION, scenes: window.SCENES, clicks: window.CLICKS }))));
  const stills = opt('--stills');
  if (stills) {
    fs.mkdirSync(out, { recursive: true });
    for (const t of stills.split(',').map(Number)) fs.writeFileSync(path.join(out, `t${t.toFixed(2)}.png`), await frameAt(page, t));
    await browser.close(); return;
  }
  const from = Number(opt('--from', 0)), to = Number(opt('--to', duration));
  const workers = Number(opt('--workers', 3));
  const total = Math.round((to - from) * fps);
  const per = Math.ceil(total / workers);
  console.log(`duration ${duration.toFixed(2)} s, ${total} frames, ${workers} workers`);
  const parts = [];
  await Promise.all(Array.from({ length: workers }, async (_, w) => {
    const p = w === 0 ? page : await open(browser);
    const a = w * per, b = Math.min(total, a + per);
    if (a >= b) return;
    const part = `${out}.part${w}.mp4`; parts[w] = part;
    const ff = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', part], { stdio: ['pipe', 'inherit', 'inherit'] });
    for (let i = a; i < b; i++) {
      const png = await frameAt(p, from + i / fps);
      if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once('drain', r));
      if (i % 150 === 0) console.log(`worker ${w}: frame ${i}/${b}`);
    }
    ff.stdin.end();
    await new Promise((r) => ff.on('close', r));
  }));
  await browser.close();
  const list = `${out}.parts.txt`;
  fs.writeFileSync(list, parts.filter(Boolean).map((p) => `file '${path.resolve(p)}'`).join('\n'));
  await new Promise((r) => spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', `${out}.video.mp4`], { stdio: 'inherit' }).on('close', r));
  for (const p of parts.filter(Boolean)) fs.rmSync(p); fs.rmSync(list);
  console.log('wrote', `${out}.video.mp4`);
})().catch((e) => { console.error(e); process.exit(1); });
