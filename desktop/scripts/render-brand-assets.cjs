// Renders the desktop app's icons from the production brand mark
// (web/brand/royal-gold-arrow/icon.svg), like mobile/scripts/render-brand-assets.cjs.
// Run from desktop/:  npm run icons   (sharp is a devDependency)
//
//   build/icon-mac.png        1024 px, the tile on Apple's icon grid (824 px, transparent margin); electron-builder makes the .icns
//   build/icons/<n>x<n>.png   Linux hicolor sizes, the full tile
//   src/assets/icon.png       the window icon on Linux
//   src/assets/tray*.png      the Linux tray icon, and with a dot when something is for you
//   src/assets/trayTemplate*.png  the Mac menu-bar icon (a template: black + alpha; macOS tints it)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, '..', 'web', 'brand', 'royal-gold-arrow', 'icon.svg'), 'utf8');
const TILE = '<rect width="512" height="512" rx="112" fill="#181220"/>';
if (!src.includes(TILE)) throw new Error('icon.svg layout changed; update render-brand-assets.cjs');
const markOnly = src.replace(TILE, '');
const DOT = '#F2B53C';

const svg = (text, px) => sharp(Buffer.from(text), { density: (72 * px) / 512 }).resize(px, px);
const out = (...parts) => { const file = path.join(root, ...parts); fs.mkdirSync(path.dirname(file), { recursive: true }); return file; };

async function tile(px) { return svg(src, px).png().toBuffer(); }

async function withDot(px) {
  const r = Math.round(px * 0.2);
  const dot = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}"><circle cx="${px - r}" cy="${r}" r="${r}" fill="${DOT}" stroke="#181220" stroke-width="${Math.max(1, Math.round(px / 24))}"/></svg>`);
  return sharp(await tile(px)).composite([{ input: dot }]).png().toBuffer();
}

// The menu-bar template: macOS tints it, so only alpha counts. The arrow is
// solid, the knot half-transparent with a gap around the arrow (the arrow's
// dark outline in the colour mark), so the two read apart at 18 px.
const ARROW_OUTLINE = /<path fill="url\(#gold\)" stroke="#120D19"[^>]*\/>/;
const ARROW = /<path fill="url\(#gold\)" stroke="url\(#gold\)"[^>]*\/>/;
const KNOT = /<rect width="512" height="512" fill="url\(#face\)" mask="url\(#weave\)"\/>/;
if (!ARROW_OUTLINE.test(markOnly) || !ARROW.test(markOnly) || !KNOT.test(markOnly)) throw new Error('icon.svg layout changed; update render-brand-assets.cjs');
async function alpha(text, px) {
  const { data } = await svg(text, px).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return Array.from({ length: px * px }, (_, i) => data[i * 4 + 3] / 255);
}
async function template(px) {
  const outline = await alpha(markOnly.replace(ARROW, '').replace(KNOT, ''), px);
  const arrow = await alpha(markOnly.replace(ARROW_OUTLINE, '').replace(KNOT, ''), px);
  const knot = await alpha(markOnly.replace(ARROW_OUTLINE, '').replace(ARROW, ''), px);
  const data = Buffer.alloc(px * px * 4);
  for (let i = 0; i < px * px; i++) data[i * 4 + 3] = Math.round(255 * Math.max(arrow[i], 0.55 * knot[i] * (1 - outline[i])));
  return sharp(data, { raw: { width: px, height: px, channels: 4 } }).png().toBuffer();
}

(async () => {
  const inset = await tile(824);
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: inset, left: 100, top: 100 }]).png().toFile(out('build', 'icon-mac.png'));
  for (const n of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) await sharp(await tile(n)).toFile(out('build', 'icons', `${n}x${n}.png`));
  await sharp(await tile(256)).toFile(out('src', 'assets', 'icon.png'));
  await sharp(await tile(32)).toFile(out('src', 'assets', 'tray.png'));
  await sharp(await tile(64)).toFile(out('src', 'assets', 'tray@2x.png'));
  await sharp(await withDot(32)).toFile(out('src', 'assets', 'tray-dot.png'));
  await sharp(await withDot(64)).toFile(out('src', 'assets', 'tray-dot@2x.png'));
  await sharp(await template(18)).toFile(out('src', 'assets', 'trayTemplate.png'));
  await sharp(await template(36)).toFile(out('src', 'assets', 'trayTemplate@2x.png'));
})().catch((error) => { console.error(error); process.exit(1); });
