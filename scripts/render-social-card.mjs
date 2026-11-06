#!/usr/bin/env node
// Render web/social-card.png, the 1200×630 image link previews show for the
// public pages (og:image): the landing's hero — the tagline over the launch
// film's poster — as the landing preview serves it, without its buttons. Re-run after changing the hero or the logo.
//
//   node scripts/render-social-card.mjs        # needs Playwright's Chromium
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4179;
const server = spawn(process.execPath, [path.join(root, 'scripts/preview-landing.mjs')],
  { env: { ...process.env, PORT: String(port), SITE_NAME: 'tavya', BRAND_ICON: 'royal-gold-arrow' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve) => server.stdout.once('data', resolve));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, colorScheme: 'dark' });
  await page.goto(`http://localhost:${port}/`);
  // The tagline over the film's poster: no navigation, no buttons.
  await page.addStyleTag({ content: '.landing-nav-actions, .landing-hero-actions, .landing-lede { display: none !important; } .landing-film { margin-top: 28px !important; }' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500); // the poster loads
  await page.screenshot({ path: path.join(root, 'web/social-card.png') });
} finally {
  await browser.close();
  server.kill();
}
