// The experiment behind the project icon and the task status style: candidate
// project icons in the real sidebar, and status-style variants over the real
// list (fixture.cjs), as comparison sheets, light and dark.
// Usage: OUT=/tmp/pis node design/project-icon-status/variants.cjs
const fs = require('node:fs');
const path = require('node:path');
const { launch } = require('../../tests/helpers/fake-console.cjs');
const { statusConsole } = require('./fixture.cjs');

const OUT = process.env.OUT || path.join(__dirname);
const svg = (body) => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const BOX = svg('<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>');
const ICONS = {
  'Checklist (before)': svg('<path d="M10 6h11"/><path d="M10 12h11"/><path d="M10 18h11"/><path d="m3 6 1.5 1.5L7.5 4.5"/><path d="m3 12 1.5 1.5L7.5 10.5"/><path d="m3 18 1.5 1.5L7.5 16.5"/>'),
  'Box (shipped)': BOX,
  Board: svg('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M8 7v7"/><path d="M12 7v4"/><path d="M16 7v9"/>'),
  Layers: svg('<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>'),
  Target: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>'),
  'Initial tile': 'TILE',
  'Hued box': 'HUED',
};
const STATUS = {
  'Glyph + label (shipped)': '',
  'Dot + label': `.status > svg { display: none; } .status::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--status); flex: none; }
    .status:is(.waiting, .stopped, .draft)::before { background: transparent; box-shadow: inset 0 0 0 1.5px var(--status); }`,
  'Tinted pill + glyph': '.status { padding: 2px 8px 2px 6px; border-radius: 999px; background: color-mix(in srgb, var(--status) 14%, transparent); }',
};

// What a wait looks like: grey said "inert" like a draft; the shipped clock
// takes the accent of a task carrying on by itself.
const WAITING = {
  'Grey clock (before)': '.status.waiting { --status: var(--ink-3); }',
  'Accent clock (shipped)': '',
  'Muted accent': '.status.waiting { --status: color-mix(in srgb, var(--accent) 55%, var(--ink-3)); }',
};

async function shot(browser, scheme, prepare, clip, file, scale = 1) {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 1180 }, colorScheme: scheme, deviceScaleFactor: scale });
  await statusConsole(context);
  const page = await context.newPage();
  await page.goto('http://console.test/org/website?q=-is%3Aarchived');
  await page.locator('.task-row').first().waitFor();
  await page.waitForTimeout(600);
  await prepare(page);
  await page.screenshot({ path: file, clip });
  await context.close();
}

async function sheet(browser, cells, file) {
  const img = (f) => `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;
  const page = await browser.newPage({ viewport: { width: 1700, height: 600 } });
  await page.setContent(`<style>body{font:600 14px Inter,system-ui;margin:16px;background:#fff;color:#333}.row{display:flex;gap:14px}figure{margin:0}figcaption{margin:0 0 6px}img{border:1px solid #ddd;border-radius:6px;display:block}</style>
    <div class="row">${cells.map((c) => `<figure><figcaption>${c.name}</figcaption><img src="${img(c.file)}" width="${c.width}"></figure>`).join('')}</div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: file, fullPage: true });
  await page.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pis-'));
  const browser = await launch();
  for (const scheme of ['light', 'dark']) {
    const icons = [];
    for (const [name, icon] of Object.entries(ICONS)) {
      const file = path.join(tmp, `icon-${scheme}-${icons.length}.png`);
      await shot(browser, scheme, (page) => page.evaluate(({ icon, box }) => {
        const dark = matchMedia('(prefers-color-scheme: dark)').matches;
        const hues = [262, 200, 152, 28, 330, 96, 12, 228];
        document.querySelectorAll('.rail .project-link').forEach((a) => {
          const glyph = a.querySelector('.glyph');
          const hue = hues[[...a.dataset.project].reduce((h, c) => h * 31 + c.charCodeAt(0), 7) % hues.length];
          if (icon === 'TILE') glyph.innerHTML = `<span style="display:grid;place-items:center;width:16px;height:16px;border-radius:4px;font:600 10px/1 Inter;background:oklch(0.62 0.13 ${hue} / .16);color:oklch(${dark ? 0.8 : 0.45} 0.12 ${hue})">${a.textContent.trim()[0]}</span>`;
          else if (icon === 'HUED') { glyph.innerHTML = box; glyph.style.color = `oklch(${dark ? 0.78 : 0.55} 0.13 ${hue})`; }
          else glyph.innerHTML = icon;
        });
      }, { icon, box: BOX }), { x: 0, y: 300, width: 232, height: 300 }, file, 2);
      icons.push({ name, file, width: 220 });
    }
    await sheet(browser, icons, path.join(OUT, `project-icons-${scheme}.png`));
    const styles = [];
    for (const [name, css] of Object.entries(STATUS)) {
      const file = path.join(tmp, `status-${scheme}-${styles.length}.png`);
      await shot(browser, scheme, (page) => css && page.addStyleTag({ content: css }), { x: 260, y: 262, width: 520, height: 820 }, file);
      styles.push({ name, file, width: 520 });
    }
    await sheet(browser, styles, path.join(OUT, `status-styles-${scheme}.png`));
    const waits = [];
    for (const [name, css] of Object.entries(WAITING)) {
      const file = path.join(tmp, `waiting-${scheme}-${waits.length}.png`);
      await shot(browser, scheme, (page) => css && page.addStyleTag({ content: css }), { x: 260, y: 262, width: 520, height: 820 }, file);
      waits.push({ name, file, width: 520 });
    }
    await sheet(browser, waits, path.join(OUT, `waiting-tone-${scheme}.png`));
  }
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`sheets in ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
