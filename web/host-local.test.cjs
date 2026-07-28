// Host-machine affordances must stay behind hostLocal(): served from a public
// URL, a field asking for a path on the host is at best noise and at worst an
// invitation to read someone else's disk.
// Run: node web/host-local.test.cjs
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const lines = src.split('\n');

let pass = 0;
let fail = 0;
const ok = (condition, message) => condition ? pass++ : (fail++, console.error('FAIL:', message));
// `const` inside eval is block-scoped, so hoist the declaration onto global.
const load = (name) => eval(lines.find((l) => l.startsWith(`const ${name} = `)).replace(`const ${name} =`, `global.${name} =`));

// ── the helper itself ────────────────────────────────────────────────────────
ok(lines.some((l) => l.startsWith('const hostLocal = ')), 'app.js defines a hostLocal() helper');
global.S = {};
load('hostLocal');

ok(hostLocal() === true, 'before /api/meta arrives, assume the usual local install');
global.S = { meta: { hostLocal: true } };
ok(hostLocal() === true, 'a host-local gateway keeps host-machine affordances');
global.S = { meta: { hostLocal: false } };
ok(hostLocal() === false, 'a gateway served elsewhere withdraws them');

// ── every host-path affordance is gated ──────────────────────────────────────
// Each marker renders an input or button that only means something on the machine
// karmax runs on. (`#environment-propose` is deliberately absent: it reads the
// project's repo server-side, so it works wherever karmax is served.)
const gated = [
  ['/srv/code/repo', 'repository source accepting a host path'],
  ['id="data-source"', 'data import from a host path'],
  ['id="resource-source-path"', 'resource import from a host directory'],
  ['id="resource-scan"', 'scan of the host checkout'],
  ['id="data-discover"', 'discovery of ignored files in the host checkout'],
  ['currently comes from the host checkout', 'legacy copyGlobs migration'],
];
for (const [marker, what] of gated) {
  const hits = lines.filter((l) => l.includes(marker));
  ok(hits.length > 0, `${what}: marker "${marker}" still exists`);
  for (const l of hits) ok(l.includes('hostLocal()'), `${what} is gated on hostLocal(), not on hosted`);
}

// Materializing a checkout to `cd` into is the same class of affordance.
ok(/if \(hostLocal\(\)\) return materializeLocalCheckout/.test(src),
  'the local checkout is only materialized for the machine that would open it');

// ── a world path is only offered to the machine that can `cd` into it ────────
global.S = { meta: { hostLocal: false } };
load('localWorldPath');
ok(localWorldPath({ worldPath: '/home/op/.karmax/worlds/task-1' }) === '',
  'a remote browser is not handed a directory on the karmax host');
global.S = { meta: { hostLocal: true } };
ok(localWorldPath({ worldPath: '/tmp/world' }) === '/tmp/world', 'the host itself still gets the path');
ok(localWorldPath({}) === '', 'a cloud world has no host path either way');

for (const l of lines.filter((l) => l.includes('cd ${v.worldPath}')))
  ok(l.includes('localWorldPath(v)'), 'every "cd into the world" command goes through localWorldPath');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
