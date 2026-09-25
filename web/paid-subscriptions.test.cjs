const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const functions = source.slice(source.indexOf('function profilePaidSubscriptionsMarkup('), source.indexOf('function wireProfileView('));
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

test('paid subscriptions precede Your data and show escaped links, cancellation, and lost access', () => {
  const view = source.slice(source.indexOf('function profileView('), source.indexOf('function notificationsCard('));
  assert.ok(view.indexOf('Paid subscriptions') < view.indexOf('Your data'));
  const ctx = vm.createContext({ esc });
  vm.runInContext(functions, ctx);
  const html = ctx.profilePaidSubscriptionsMarkup([{ organizationName: '<Private>', planName: 'Team', status: 'active',
    settingsUrl: '/private/settings#settings-plan', canManage: true, cancelAtPeriodEnd: true },
  { organizationName: 'Former workspace', planName: 'Individual', status: 'past_due', canManage: false, settingsUrl: null }]);
  assert.match(html, /&lt;Private>/);
  assert.match(html, /data-spa href="\/private\/settings#settings-plan"/);
  assert.match(html, /cancellation scheduled/);
  assert.match(html, /no longer have billing-management access/);
  assert.doesNotMatch(html, /href="null"/);
  assert.match(ctx.profilePaidSubscriptionsMarkup([]), /Unfinished checkouts and gifted plans are not listed/);
});

test('profile loader shows failures with retry and ignores stale responses', async () => {
  let retry;
  let current = { innerHTML: '', querySelector: () => ({ addEventListener: (_, fn) => { retry = fn; } }) };
  const ctx = vm.createContext({ esc, S: { user: { id: 'alice' } }, $: () => current,
    api: async () => { throw new Error('<offline>'); } });
  vm.runInContext(functions, ctx);
  await ctx.hydrateProfilePaidSubscriptions();
  assert.match(current.innerHTML, /role="alert".*&lt;offline>/);
  ctx.api = async () => ({ subscriptions: [] });
  await retry();
  assert.match(current.innerHTML, /No paid subscriptions/);
  let resolve;
  ctx.api = () => new Promise(done => { resolve = done; });
  const pending = ctx.hydrateProfilePaidSubscriptions();
  const original = current;
  current = { innerHTML: 'new profile' };
  ctx.S.user.id = 'bob';
  resolve({ subscriptions: [{ organizationName: 'Alice private workspace' }] });
  await pending;
  assert.equal(current.innerHTML, 'new profile');
  assert.doesNotMatch(original.innerHTML, /Alice private workspace/);
});
