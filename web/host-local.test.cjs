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
// Same idea for a multi-line function declaration: brace-match it, then hoist.
const loadFn = (name) => {
  const start = src.indexOf(`async function ${name}(`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0)
      return eval(`global.${name} = ${src.slice(start, i + 1)}`);
  }
  throw new Error(`unterminated ${name}`);
};

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
// Off-machine the Installation page explains why this host control is
// unavailable instead of attempting tailscale/pkexec.
const gateStart = src.indexOf('const phone = hostLocal()');
const gateEnd = src.indexOf("function wireInstallationSettings()", gateStart);
ok(gateStart > 0 && gateEnd > gateStart, 'the Installation Phone Access body is hostLocal-gated');
ok(src.indexOf('id="phone-access-card"', gateStart) < gateEnd,
  'the live Phone Access card renders only inside the Installation gate');
ok(lines.some((l) => l.includes('hostLocal()') && l.includes('hydratePhoneAccess()')),
  'the Phone Access status is not fetched when the endpoint is withdrawn');

// Phone Access is also an installation-wide host control: an organization
// administrator may manage their tenant but must not see a control that drives
// this machine's Tailscale/pkexec. Like the other installation cards below, it
// lives behind the operator-only Installation route and is revealed only after
// its settings endpoint succeeds.
ok(src.includes("if (!S.installationAccess) return go(globalRoute('insights')"),
  'the Installation route refuses a non-operator before rendering host controls');
ok(/id="phone-access-card"[^>]*\shidden/.test(src), 'the Phone Access card ships hidden');
ok(/error\?\.status === 403\) return/.test(src), 'a refused Phone Access read leaves the control absent');
ok(/function revealPhoneAccess\(\)/.test(src), 'Phone Access has an explicit post-authorization reveal');

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
// All three fail closed the same way: the markup ships empty and `hidden`, and
// only the server's `canManage` reveals it. Rendering first and removing later
// would flash an operator control at a tenant on a slow connection.
for (const [id, endpoint] of [['resilience-card', '/api/safe-mode'], ['outbound-email-card', '/api/email']]) {
  ok(new RegExp(`id="${id}" hidden></div>`).test(src), `#${id} ships empty and hidden`);
  ok(new RegExp(`hydrateInstallationCard\\('#${id}', '${endpoint.replace(/\//g, '\\/')}'`).test(src),
    `#${id} is hydrated through the shared installation-card helper`);
}
ok(/id="stripe-platform-card"/.test(src), 'the shared Stripe Connect setup has its own Installation card');
ok(!/class="pay-stripe-platform"/.test(src), 'organization Payments no longer embeds shared Stripe setup');

// Nothing may render an installation control and take it away afterwards.
for (const dead of ['card.remove()', 'platformBox.remove()', "platform.canManage ? '' : 'disabled'"])
  ok(!src.includes(dead), `no reveal-then-retract or disabled-input fallback remains (${dead})`);

// The helper itself, exercised rather than grepped: a card must stay hidden and
// unfilled for anyone the server does not vouch for.
loadFn('hydrateInstallationCard');
const runHydrate = async (answer) => {
  const card = { hidden: true, filled: false };
  global.document = { querySelector: () => card };
  global.api = async () => { if (answer instanceof Error) throw answer; return answer; };
  await hydrateInstallationCard('#x', '/api/x', (c) => { c.filled = true; });
  return card;
};
(async () => {
  const operator = await runHydrate({ canManage: true });
  ok(operator.hidden === false && operator.filled, 'an operator gets the card revealed and filled');
  for (const [label, answer] of [['canManage:false', { canManage: false }], ['a refused read', new Error('403')]]) {
    const tenant = await runHydrate(answer);
    ok(tenant.hidden === true && !tenant.filled, `${label} leaves the card hidden and unfilled`);
  }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
