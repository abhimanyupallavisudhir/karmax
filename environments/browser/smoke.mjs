import { createRequire } from 'node:module';

const require = createRequire('/opt/karmax/browser/package.json');
const { chromium } = require('playwright');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setContent('<title>karmax browser ready</title><main>ready</main>');
if (await page.title() !== 'karmax browser ready') throw new Error('Chromium render smoke test failed');
await page.screenshot({ path: '/tmp/karmax-browser-smoke.png' });
await browser.close();
