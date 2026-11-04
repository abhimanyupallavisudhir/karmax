// Automated accessibility checks (axe-core, WCAG 2.2 A/AA) on the console's main
// pages — For me with its in-row decisions, a task asking for a credential, a
// task with a question, settings, Insights, the profile — in both looks, light
// and dark, and on a phone. Fails on any violation, so a contrast, label, name
// or target-size regression is caught before it ships.
// Run: node tests/accessibility-check.cjs   (A11Y_REPORT=1 prints every violation; CI runs it from tests/accessibility.browser.test.ts)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { launch } = require('./helpers/fake-console.cjs');
const { uxConsole } = require('./helpers/ux-console.cjs');

const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const PAGES = [
  ['for me', '/org'],
  ['inbox', '/inbox'],
  ['credential request', '/org/website/tasks/2'],
  ['question', '/org/mobile-app/tasks/3'],
  ['project settings', '/org/website/settings'],
  ['organization settings', '/org/settings'],
  ['insights', '/org/insights'],
  ['profile', '/profile'],
];
const LOOKS = [
  { name: 'default light', skin: '', scheme: 'light' },
  { name: 'default dark', skin: '', scheme: 'dark' },
  { name: 'classic light', skin: 'classic', scheme: 'light' },
  { name: 'classic dark', skin: 'classic', scheme: 'dark' },
  { name: 'phone', skin: '', scheme: 'light', viewport: { width: 390, height: 844 } },
];

(async () => {
  const browser = await launch();
  const failures = [];
  try {
    for (const look of LOOKS) {
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: look.viewport || { width: 1280, height: 820 }, colorScheme: look.scheme });
      await context.addInitScript((skin) => { try { localStorage.setItem('karmax-skin', skin); } catch {} }, look.skin);
      await uxConsole(context);
      await context.route('**/api/meta', (route) => route.fulfill({ json: { siteName: 'Fixture', hostLocal: true, consoleRevision: 'one', agent: { provider: 'mock' }, worldProviders: [], skin: look.skin } }));
      const page = await context.newPage();
      for (const [name, url] of PAGES) {
        await page.goto(`http://console.test${url}`);
        await page.locator('#main').waitFor();
        await page.waitForTimeout(1200);
        await page.addScriptTag({ content: AXE });
        const result = await page.evaluate(async () => window.axe.run(document, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
          // The fixture's brand image is a stand-in without its file.
          exclude: [['.brand .mark']],
        }));
        for (const violation of result.violations) {
          failures.push(`${look.name} · ${name}: ${violation.id} (${violation.impact}) — ${violation.help}\n${violation.nodes.slice(0, 4)
            .map((node) => `    ${node.target.join(' ')}${node.failureSummary ? ` — ${node.failureSummary.split('\n').slice(1, 2).join(' ').trim()}` : ''}`).join('\n')}`);
        }
      }
      await context.close();
    }
  } finally { await browser.close(); }
  if (process.env.A11Y_REPORT || failures.length) console.error(failures.join('\n'));
  assert.equal(failures.length, 0, `${failures.length} accessibility violations`);
  console.log('Accessibility: ok');
})().catch((error) => { console.error(error.message); process.exit(1); });
