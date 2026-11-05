#!/usr/bin/env node
// Render web/social-card.png, the 1200×630 image link previews show for the
// public pages (og:image): the landing's hero, as the landing preview serves it,
// without its navigation buttons. Re-run after changing the hero or the logo.
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
  await page.addStyleTag({ content: '.landing-nav-actions { display: none !important; }' });
  await page.evaluate(() => {
    const host = document.querySelector('.product-browserbar span');
    if (host) host.textContent = 'tavya.io / tavya';
  });
  await page.waitForTimeout(6000); // every task in the hero lands
  await page.screenshot({ path: path.join(root, 'web/social-card.png') });
} finally {
  await browser.close();
  server.kill();
}
