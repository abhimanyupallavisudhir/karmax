// Installation controls do not belong in an organization's settings rail.
// Run: node web/settings-navigation-order.test.cjs
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const viewStart = src.indexOf('function organizationView()');
const viewEnd = src.indexOf('async function hydrateOrganizationView()', viewStart);
if (viewStart < 0 || viewEnd < 0) throw new Error('organizationView not found');

const view = src.slice(viewStart, viewEnd);
const nav = view.match(/<nav class="settings-nav" aria-label="Settings sections">([\s\S]*?)<\/nav>/)?.[1];
if (!nav) throw new Error('organization settings navigation not found');

const sections = [...nav.matchAll(/<a\b([^>]*)>([^<]+)<\/a>/g)]
  .map(([, attributes, label]) => ({
    id: attributes.match(/href="#([^"]+)"/)?.[1],
    label: label.replace(/&amp;/g, '&'),
  }))
  .filter(({ id }) => id);
const phoneIndex = sections.findIndex(({ id }) => id === 'settings-access');

let failed = 0;
function ok(condition, message) {
  if (!condition) {
    failed++;
    console.error('FAIL:', message);
  }
}

ok(sections.some(({ id }) => id === 'settings-people'), 'settings navigation keeps People & authorization');
ok(phoneIndex < 0, 'settings navigation no longer includes installation Phone Access');
ok(!view.includes('id="appearance-card"') && !view.includes('id="resilience-card"') && !view.includes('id="outbound-email-card"'),
  'organization settings contains no installation-wide cards');

console.log(`\n${3 - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
