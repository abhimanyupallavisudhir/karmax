// When the landing first paints text, and when Inter arrives: a font that
// lands after the first text paint shows as a flash of the fallback face.
// Usage: APP=http://localhost:4173 node design/landing-v2/font-timing.cjs  (THROTTLE=1 for a slow connection)
const { chromium } = require('playwright');
const APP = process.env.APP || 'http://localhost:4173';
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  if (process.env.THROTTLE) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1.5e6 / 8 * 10, uploadThroughput: 1e6 });
  }
  // Every 40 ms, note which face renders the page's first heading.
  await page.addInitScript(() => {
    window.__faces = [];
    const t0 = performance.now();
    const tick = () => {
      const h = document.querySelector('.landing-page h1');
      if (h) window.__faces.push([Math.round(performance.now() - t0), document.fonts.check(`700 40px Inter`) && [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'Inter' && f.status === 'loaded')]);
      if (performance.now() - t0 < 4000) setTimeout(tick, 40);
    };
    tick();
  });
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForTimeout(4200);
  const faces = await page.evaluate(() => window.__faces);
  const fallback = faces.filter(([, inter]) => !inter);
  const font = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('/fonts/')).map((e) => [e.name.split('/').pop(), Math.round(e.startTime), Math.round(e.responseEnd)]));
  console.log(JSON.stringify({ firstHeading: faces[0]?.[0], fallbackFrames: fallback.length, fallbackUntil: fallback.at(-1)?.[0], font }));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
