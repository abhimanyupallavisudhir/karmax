// Profile → Plans & billing (profilePlansMarkup, hydrateProfilePlans): every
// organization one belongs to, its plan bought or gifted, its packs and its
// tavya credits, folding out into that organization's Plan & billing card.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const fn = (name) => {
  const start = source.indexOf(`function ${name}(`);
  let depth = 0;
  for (let i = source.indexOf('{', source.indexOf(')', start)); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(name);
};
const functions = ['planDollars', 'planMeter', 'profilePlansMarkup', 'hydrateProfilePlans'].map((name) => (name === 'hydrateProfilePlans' ? 'async ' : '') + fn(name)).join('\n');
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const policyTip = text => `<button type="button" class="info-dot" title="${esc(text)}">ⓘ</button>`;
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const context = (extra = {}) => { const ctx = vm.createContext({ esc, policyTip, S: { user: { id: 'alice' } }, ...extra }); vm.runInContext(functions, ctx); return ctx; };

test('plans precede Your data, one line per organization: plan, gift, packs and credits', () => {
  const view = source.slice(source.indexOf('function profileView('), source.indexOf('function notificationsCard('));
  assert.ok(view.indexOf('Plans &amp; billing') < view.indexOf('Your data'));
  const ctx = context();
  const html = ctx.profilePlansMarkup({ organizations: [
    { organizationId: 'o1', name: '<Acme>', planName: 'Team', gift: { plan: 'team' }, storagePacks: 1, computePacks: 0, giftedStoragePacks: 0, giftedComputePacks: 2,
      credits: { usedMicros: 3_200_000, heldMicros: 0, availableMicros: 26_800_000, totalMicros: 30_000_000 } },
    { organizationId: 'o2', name: 'Side', planName: 'Individual', gift: null, storagePacks: 0, computePacks: 0, giftedStoragePacks: 0, giftedComputePacks: 0,
      credits: { usedMicros: 5_000_000, heldMicros: 0, availableMicros: 0, totalMicros: 5_000_000 } },
    { organizationId: 'o3', name: 'Free one', planName: 'Free', gift: null, credits: null }],
  formerSubscriptions: [{ organizationName: 'Former workspace', planName: 'Individual', status: 'past_due', cancelAtPeriodEnd: true, currentPeriodEnd: Date.UTC(2026, 11, 1) }] });
  assert.match(html, /&lt;Acme>/);
  assert.match(text(html), /&lt;Acme> Team Gifted 3 packs, 2 gifted \$3\.20 of \$30\.00 ›/);
  assert.match(text(html), /Side Individual Out of credits ›/);
  assert.match(text(html), /Free one Free ›/);
  // Folded until opened (several organizations); each opens into its own card.
  assert.match(html, /<button type="button" class="profile-plan-head" aria-expanded="false" aria-controls="profile-plan-o1">/);
  assert.match(html, /<div class="profile-plan-body" id="profile-plan-o1" hidden>/);
  // Paid for, since left: still listed, in words, with what to do.
  assert.match(text(html), /Former workspace Individual Payment overdue · cancellation scheduled/);
  assert.match(html, /no longer belong to the organization/);
  // One organization: open at once.
  assert.match(ctx.profilePlansMarkup({ organizations: [{ organizationId: 'o1', name: 'Only', planName: 'Free' }] }), /aria-expanded="true"/);
  assert.match(ctx.profilePlansMarkup({}), /No organizations/);
});

test('profile loader shows failures with retry, ignores stale responses, and loads the open card', async () => {
  let retry;
  let current = { innerHTML: '', querySelector: () => ({ addEventListener: (_, fn) => { retry = fn; } }), querySelectorAll: () => [] };
  const loaded = [];
  const ctx = context({ inlineErrorHtml: (error) => esc(error.message), $: () => current, hydratePlanAndBilling: async (id) => loaded.push(id),
    api: async () => { throw new Error('<offline>'); } });
  await ctx.hydrateProfilePlans();
  assert.match(current.innerHTML, /role="alert".*&lt;offline>/);
  ctx.api = async () => ({ organizations: [], formerSubscriptions: [] });
  await retry();
  assert.match(current.innerHTML, /No organizations/);
  let resolve;
  ctx.api = () => new Promise(done => { resolve = done; });
  const pending = ctx.hydrateProfilePlans();
  const original = current;
  current = { innerHTML: 'new profile' };
  ctx.S.user.id = 'bob';
  resolve({ organizations: [{ organizationId: 'o1', name: 'Alice private workspace' }] });
  await pending;
  assert.equal(current.innerHTML, 'new profile');
  assert.doesNotMatch(original.innerHTML, /Alice private workspace/);
  assert.deepEqual(loaded, []);
});
