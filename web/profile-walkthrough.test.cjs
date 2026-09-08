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
  assert.doesNotMatch(vm.runInContext('profileView()', ctx), /Target User|Reset walkthrough/);
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
