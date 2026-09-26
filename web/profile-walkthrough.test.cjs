const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const views = source.slice(source.indexOf('function profileWalkthroughCard('), source.indexOf('function notificationsCard('));
const wiring = source.slice(source.indexOf('function wireProfileView('), source.indexOf('  wireNotificationsCard();', source.indexOf('function wireProfileView('))) + '\n}';
function context(operator) {
  const S = { installationAccess: operator, meta: { hosted: true }, user: { id: 'operator' },
    profileUserId: 'target', users: [{ id: 'target', name: 'Target User', email: 'target@example.com' }] };
  const ctx = vm.createContext({ S, esc: (value) => String(value), encodeURIComponent });
  vm.runInContext(views, ctx);
  return ctx;
}
test('operator sees a reset on the selected user profile, without own-account controls', () => {
  const ctx = context(true);
  const html = vm.runInContext('profileView()', ctx);
  assert.match(html, /Target User/);
  assert.match(html, /data-user-id="target"/);
  assert.doesNotMatch(html, /profile-logout|profile-password/);
});
test('non-operators never see the reset control or another user profile', () => {
  const ctx = context(false);
  assert.equal(vm.runInContext("profileWalkthroughCard('target')", ctx), '');
  assert.doesNotMatch(vm.runInContext('profileView()', ctx), /Target User|Restart walkthrough/);
});
test('profile reset targets the displayed user and restores the button after completion', async () => {
  const ctx = context(true);
  let click;
  const button = { dataset: { userId: 'target' }, disabled: false,
    addEventListener: (_event, callback) => { click = callback; } };
  const calls = [];
  Object.assign(ctx, { $: () => button, toast: () => {}, api: async (...args) => calls.push(args) });
  vm.runInContext(wiring + '\nwireProfileView();', ctx);
  await click();
  assert.equal(calls[0][0], '/api/users/target/onboarding/reset');
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(button.disabled, false);
});

test('ordinary users can restart their own walkthrough and immediately refresh it', async () => {
  const ctx = context(false);
  assert.match(vm.runInContext("profileWalkthroughCard('operator')", ctx), /Restart walkthrough/);
  ctx.S.profileUserId = null;
  let click;
  const calls = [];
  let refreshed = false;
  const button = { dataset: { userId: 'operator' }, disabled: false,
    addEventListener: (_event, callback) => { click = callback; } };
  Object.assign(ctx, { $: () => button, toast: () => {}, api: async (...args) => calls.push(args),
    refreshOnboarding: async () => { refreshed = true; } });
  // Only exercise the restart handler; the remaining profile controls are separate.
  vm.runInContext(wiring.slice(0, wiring.indexOf('  if (S.profileUserId')) + '\n}', ctx);
  vm.runInContext('wireProfileView()', ctx);
  await click();
  assert.equal(calls[0][0], '/api/user/onboarding/reset');
  assert.equal(refreshed, true);
  assert.equal(button.disabled, false);
});

function onboardingContext() {
  const host = { hidden: false, innerHTML: '' };
  let timer;
  const ctx = vm.createContext({
    S: { meta: { hosted: true }, organizationId: 'org1', user: { id: 'user1' } },
    $: (selector) => selector === '#hosted-onboarding' ? host : null,
    document: { hidden: false }, encodeURIComponent,
    clearTimeout: () => { timer = undefined; },
    setTimeout: (callback) => { timer = callback; return 1; },
  });
  vm.runInContext(source.slice(source.indexOf('const ICON = {'), source.indexOf('const TAG_SECTION_QUERY')), ctx);
  vm.runInContext(source.slice(source.indexOf('async function refreshOnboarding()'),
    source.indexOf('/** Re-point the favicon')), ctx);
  return { ctx, host, tick: async () => { assert.ok(timer); await timer(); } };
}

test('an initial status failure retries and restores the guide', async () => {
  const { ctx, host, tick } = onboardingContext();
  let failed = true;
  ctx.api = async () => {
    if (failed) throw new Error('offline');
    return { organizationId: 'org1', visible: true, display: 'minimized', completedRequired: 1, totalRequired: 4 };
  };
  await vm.runInContext('refreshOnboarding()', ctx);
  assert.equal(host.hidden, true);
  // Boot renders the shell after the initial status request.
  vm.runInContext('renderOnboarding()', ctx);
  failed = false;
  await tick();
  assert.equal(host.hidden, false);
  assert.match(host.innerHTML, /Finish setup/);
});

test('a transient status failure preserves the visible guide', async () => {
  const { ctx, host, tick } = onboardingContext();
  ctx.S.onboarding = { organizationId: 'org1', visible: true, display: 'minimized', completedRequired: 1, totalRequired: 4 };
  ctx.api = async () => { throw new Error('offline'); };
  await vm.runInContext('refreshOnboarding()', ctx);
  assert.equal(host.hidden, false);
  assert.match(host.innerHTML, /Finish setup/);
  assert.equal(host.hidden, false);
});

test('late status responses cannot replace another organization or signed-in user', async () => {
  for (const change of [ctx => { ctx.S.organizationId = 'org2'; }, ctx => { ctx.S.user = { id: 'user2' }; }]) {
    const { ctx } = onboardingContext();
    let resolve;
    ctx.api = () => new Promise(done => { resolve = done; });
    const pending = vm.runInContext('refreshOnboarding()', ctx);
    change(ctx);
    resolve({ organizationId: 'org1', visible: true, display: 'minimized' });
    await pending;
    assert.equal(ctx.S.onboarding, undefined);
  }
});

const finishedOnboarding = { organizationId: 'org1', visible: false, complete: true,
  display: 'expanded', completedRequired: 4, totalRequired: 4 };
function unfinishedOnboarding(ctx, display = 'expanded') {
  ctx.S.onboarding = { ...finishedOnboarding, visible: true, complete: false, completedRequired: 3, display };
}

test('finishing expanded or minimized onboarding shows a closeable completion notice', async () => {
  for (const display of ['expanded', 'minimized']) {
    const { ctx, host } = onboardingContext();
    unfinishedOnboarding(ctx, display);
    let close;
    ctx.$ = selector => selector === '#hosted-onboarding' ? host
      : selector === '#onboarding-complete-close' ? { addEventListener: (_event, fn) => { close = fn; } } : null;
    ctx.api = async () => finishedOnboarding;
    await vm.runInContext('refreshOnboarding()', ctx);
    assert.equal(host.hidden, false);
    assert.match(host.innerHTML, /Setup complete/);
    assert.match(host.innerHTML, /Close completed walkthrough/);
    assert.equal(ctx.S.onboardingTimer, null);
    // Background refreshes must not erase the notice or reopen it after dismissal.
    await vm.runInContext('refreshOnboarding()', ctx);
    assert.equal(host.hidden, false);
    close();
    assert.equal(host.hidden, true);
    await vm.runInContext('refreshOnboarding()', ctx);
    assert.equal(host.hidden, true);
  }
});

test('already completed setup stays hidden on a fresh page or login', async () => {
  const { ctx, host } = onboardingContext();
  ctx.api = async () => finishedOnboarding;
  await vm.runInContext('refreshOnboarding()', ctx);
  assert.equal(host.hidden, true);
  assert.equal(ctx.S.onboardingCompletion, undefined);
});

function beginNavigation(ctx) {
  // Execute the actual router entry, before route-specific rendering starts.
  const start = source.indexOf('async function applyRoute()');
  const end = source.indexOf('  const routePath', start);
  vm.runInContext(source.slice(start, end) + '\n}\napplyRoute();', ctx);
}

test('navigation removes completion feedback and returning does not restore it', async () => {
  const { ctx, host } = onboardingContext();
  unfinishedOnboarding(ctx);
  ctx.api = async () => finishedOnboarding;
  await vm.runInContext('refreshOnboarding()', ctx);
  assert.equal(host.hidden, false);
  beginNavigation(ctx);
  assert.equal(host.hidden, true);
  await vm.runInContext('refreshOnboarding()', ctx);
  beginNavigation(ctx);
  vm.runInContext('renderOnboarding()', ctx);
  assert.equal(host.hidden, true);
});

test('a completion response from the previous page cannot display a notice after navigation', async () => {
  const { ctx, host } = onboardingContext();
  unfinishedOnboarding(ctx);
  let resolve;
  ctx.api = () => new Promise(done => { resolve = done; });
  const pending = vm.runInContext('refreshOnboarding()', ctx);
  beginNavigation(ctx);
  resolve(finishedOnboarding);
  await pending;
  assert.equal(host.hidden, true);
});

test('finishing a replay through Done also shows completion feedback', async () => {
  const { ctx, host } = onboardingContext();
  unfinishedOnboarding(ctx);
  ctx.S.onboarding.replay = true;
  ctx.api = async () => finishedOnboarding;
  await vm.runInContext("setOnboardingDisplay('expanded', true)", ctx);
  assert.equal(host.hidden, false);
  assert.match(host.innerHTML, /Setup complete/);
});

test('the header minus minimizes and the header close hides the guide', async () => {
  for (const [control, display] of [['#onboarding-minimize', 'minimized'], ['#onboarding-close', 'closed']]) {
    const { ctx, host } = onboardingContext();
    unfinishedOnboarding(ctx);
    ctx.S.onboarding.steps = { github: {}, agentLogin: {}, e2b: {}, optional: {}, project: {} };
    const handlers = {};
    ctx.$ = selector => selector === '#hosted-onboarding' ? host
      : { addEventListener: (_event, fn) => { handlers[selector] = fn; } };
    Object.assign(ctx, { siteNameMarkup: () => 'Tavya', globalRoute: () => '/settings', esc: String, newProject: () => {} });
    vm.runInContext('renderOnboarding()', ctx);
    assert.doesNotMatch(host.innerHTML, />Minimize</);
    const calls = [];
    ctx.api = async (...args) => {
      calls.push(args);
      return { ...ctx.S.onboarding, display, visible: display !== 'closed' };
    };
    await handlers[control]();
    assert.deepEqual(JSON.parse(calls[0][1].body), { display, finishReplay: false });
    assert.equal(host.hidden, display === 'closed');
    if (display === 'minimized') assert.match(host.innerHTML, /Finish setup/);
  }
});
