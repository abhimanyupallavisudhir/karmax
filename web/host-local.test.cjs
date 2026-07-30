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

// The gateway strips `worldPath` only for REMOTE handles, so a hosted install
// backed by worktree worlds (explicitly supported) still receives it — every
// RENDER of it has to be gated client-side. `advancedTab` printed
// `localPath: v.worldPath` straight into a JSON dump, which was the one place a
// host filesystem path escaped the gate and reached a remote browser.
for (const l of lines.filter((l) => /localPath:/.test(l)))
  ok(l.includes('localWorldPath(v)'), 'a rendered world localPath goes through localWorldPath');

// ── Phone Access is setup for reaching a loopback karmax from elsewhere ──────
// Off-machine there is nothing to set up: you are already reading this page at
// the URL the section would help you obtain, and /api/remote-access 503s (it
// drives tailscale/pkexec on the host), so rendering the card only produces a
// permanent "Needs attention" error.
for (const marker of ['id="settings-access"', '#settings-access'])
  for (const l of lines.filter((l) => l.includes(marker)))
    ok(l.includes('hostLocal()'), `the Phone Access ${marker} is gated on hostLocal()`);
// The card itself sits on its own line inside that gated template, so check it
// structurally: it must fall between the gate's `${hostLocal() ?` and its `: ''}`.
const gateStart = src.indexOf('${hostLocal() ? `<div class="settings-section-title" id="settings-access"');
const gateEnd = src.indexOf(": ''}", gateStart);
ok(gateStart > 0 && gateEnd > gateStart, 'the Phone Access section is wrapped in a hostLocal() gate');
ok(src.indexOf('id="phone-access-card"') > gateStart && src.indexOf('id="phone-access-card"') < gateEnd,
  'the Phone Access card renders only inside that gate');
ok(lines.some((l) => l.includes('hostLocal()') && l.includes('hydratePhoneAccess()')),
  'the Phone Access status is not fetched when the endpoint is withdrawn');

// ── wording that only holds on the machine running karmax ───────────────────
// "On localhost, setup works without a webhook" is a claim about THIS install's
// reachability. It is stated before the GitHub App exists, so the server's
// derived syncMode is still 'on-demand' either way and cannot carry it.
for (const l of lines.filter((l) => l.includes('On localhost, setup works')))
  ok(l.includes('hostLocal()'), 'the GitHub App localhost note is gated on hostLocal()');

// Neither of these should still say "host path"/"this host" as if the reader
// were sitting at it.
for (const [marker, what] of [['Choose a host path', 'the data-import conflict toast'],
  ['Connect the store CLI on this host', 'the password-manager tooltip']])
  ok(!src.includes(marker), `${what} no longer addresses the reader as the host`);

// ── content that assumes one machine everyone shares (the SaaS axis) ────────
// Distinct from hostLocal: a self-host on a public URL still has exactly one
// operator, and its worlds really do inherit that machine's git config.
for (const l of lines.filter((l) => l.includes('use the host’s own Git setup')))
  ok(/S\.meta\?\.hosted/.test(src.slice(src.indexOf(l) - 400, src.indexOf(l) + 200)),
    'the "inherits the host git setup" empty state is not claimed on a managed cell');

// ── installation-wide settings are absent unless the server says you own them ─
// The console has no capability model, so each of these asks its endpoint and
// stays absent on a refusal or canManage:false. Deployment mode is NOT the lever:
// outbound email has no env path, so hiding it on `hosted` would leave a SaaS
// operator no way to configure email at all.
ok(/id="resilience-card" hidden/.test(src), 'the safe-mode card starts hidden and is revealed by the server');
ok(/hydrateInstallationCard\('#resilience-card', '\/api\/safe-mode'/.test(src),
  'safe mode is hydrated through the shared installation-card helper');
ok(/if \(!data\.canManage\) return void card\.remove\(\)/.test(src),
  'outbound email is removed when the reader may not manage it');
ok(/!platform\.canManage\) platformBox\.remove\(\)/.test(src),
  'the shared Stripe Connect card is removed rather than shown disabled');
// The disabled-input fallbacks are unreachable once the card is removed.
ok(!src.includes("platform.canManage ? '' : 'disabled'"), 'no dead disabled-input branches remain');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
