// Renders the @capacitor/assets sources in mobile/assets/ from the production
// brand mark (web/brand/royal-gold-arrow/icon.svg). Run from mobile/:
//   node scripts/render-brand-assets.cjs && npm run assets
// sharp comes with @capacitor/assets.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const root = path.join(__dirname, '..');
const svgPath = path.join(root, '..', 'web', 'brand', 'royal-gold-arrow', 'icon.svg');
const out = path.join(root, 'assets');
const BG = '#181220';
const BG_DARK = '#0e0a14';
const src = fs.readFileSync(svgPath, 'utf8');
// Full-bleed square tile (stores and iOS apply their own corner mask).
const square = src.replace('rx="112" ', '');
// Mark only: drop the background tile, keep the 1.12 scale group.
const markOnly = src.replace(/<rect width="512" height="512" rx="112" fill="#181220"\/>/, '');
if (markOnly === src || square === src) throw new Error('svg layout changed; update render.cjs');

async function mark(px) {
  return sharp(Buffer.from(markOnly), { density: 72 * px / 512 }).resize(px, px).png().toBuffer();
}
async function canvas(size, bg, markPx) {
  const base = sharp({ create: { width: size, height: size, channels: 4, background: bg } });
  const m = await mark(markPx);
  const off = Math.round((size - markPx) / 2);
  return base.composite([{ input: m, left: off, top: off }]).png().toBuffer();
}
(async () => {
  fs.mkdirSync(out, { recursive: true });
  await sharp(Buffer.from(square), { density: 72 * 1024 / 512 }).resize(1024, 1024).flatten({ background: BG }).png().toFile(path.join(out, 'icon-only.png'));
  // Adaptive icon foreground. @capacitor/assets insets both layers by 16.7%
  // (ic_launcher.xml), so this 1024 image maps onto the 72dp visible area and
  // the mark must stay inside the 66dp safe circle (radius ~469 px here).
  await sharp(await canvas(1024, { r: 0, g: 0, b: 0, alpha: 0 }, 720)).toFile(path.join(out, 'icon-foreground.png'));
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: BG } }).png().toFile(path.join(out, 'icon-background.png'));
  await sharp(await canvas(2732, BG, 560)).flatten({ background: BG }).toFile(path.join(out, 'splash.png'));
  await sharp(await canvas(2732, BG_DARK, 560)).flatten({ background: BG_DARK }).toFile(path.join(out, 'splash-dark.png'));
})().catch((e) => { console.error(e); process.exit(1); });
