// Daytona Tiers 1–2 reach only an allowlist of essential services, so agents
// there cannot browse or call most APIs. Settings must say so next to Daytona.
// Run: node web/world-providers.test.cjs
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
let pass = 0, fail = 0;
function ok(condition, message) {
  if (condition) pass++;
  else { fail++; console.error('FAIL:', message); }
}

const start = src.indexOf('const providerInfo = {');
// The object closes at the indentation it opened with.
const indent = start >= 0 ? src.slice(src.lastIndexOf('\n', start) + 1, start) : '';
const end = src.indexOf(`\n${indent}};`, start);
ok(start >= 0 && end > start, 'Organization settings declare providerInfo');
const providerInfo = start >= 0 && end > start ? new Function(`${src.slice(start, end + indent.length + 3)} return providerInfo;`)() : {};

const note = providerInfo.daytona?.note || '';
ok(/Tiers? 1.2/.test(note), 'Daytona note names Tiers 1–2');
ok(note.includes('E2B') && /Tier 3/.test(note), 'Daytona note points to E2B or a higher Daytona tier');
ok(note.includes('https://www.daytona.io/docs/en/network-limits/'), 'Daytona note links Daytona network limits');
ok(!providerInfo.e2b?.note, 'E2B has no network note');

const card = src.slice(src.indexOf("$('#org-providers').innerHTML"), src.indexOf("$('#org-runners').innerHTML"));
ok(/info\.note \? `<p class="provider-note"/.test(card), 'Provider card renders its note');
ok(/\.provider-note\s*\{/.test(fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8')), 'Provider note is styled');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
