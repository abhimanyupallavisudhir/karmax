// Organization settings should keep Phone Access beside the people/security
// controls, directly after People & authorization.
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

const sections = [...nav.matchAll(/<a href="#([^"]+)">([^<]+)<\/a>/g)]
  .map(([, id, label]) => ({ id, label: label.replace(/&amp;/g, '&') }));
const peopleIndex = sections.findIndex(({ id }) => id === 'settings-people');
const phoneIndex = sections.findIndex(({ id }) => id === 'settings-access');

let failed = 0;
function ok(condition, message) {
  if (!condition) {
    failed++;
    console.error('FAIL:', message);
  }
}

ok(peopleIndex >= 0, 'settings navigation includes People & authorization');
ok(phoneIndex >= 0, 'settings navigation includes Phone Access');
ok(phoneIndex === peopleIndex + 1,
  `Phone Access follows People & authorization (found: ${sections.map(({ label }) => label).join(' → ')})`);

console.log(`\n${3 - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
