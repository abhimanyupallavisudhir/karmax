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

const start = src.indexOf('const COMPUTER_PROVIDERS = {');
const end = src.indexOf('\n};', start);
ok(start >= 0 && end > start, 'Computers settings declare COMPUTER_PROVIDERS');
const providers = start >= 0 && end > start ? new Function(`${src.slice(start, end + 3)} return COMPUTER_PROVIDERS;`)() : {};

const tip = providers.daytona?.tip || '';
ok(/Tiers? 1.2/.test(tip), 'Daytona tip names Tiers 1–2');
ok(tip.includes('E2B') && /Tier 3/.test(tip), 'Daytona tip points to E2B or a higher Daytona tier');
ok(!providers.e2b?.tip, 'E2B has no network tip');

const dialog = src.slice(src.indexOf('function openComputerDialog('), src.indexOf('function organizationView()'));
ok(/info\.tip \? policyTip\(info\.tip\)/.test(dialog), 'The provider dialog shows its tip beside the provider name');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
