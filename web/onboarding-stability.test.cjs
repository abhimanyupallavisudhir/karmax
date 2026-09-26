const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const start = src.indexOf('function renderOnboarding('), body = src.slice(start, src.indexOf('\n}', start) + 2);
test('UI-9: repeated unchanged onboarding status preserves the DOM', () => {
  let writes = 0;
  const host = { hidden: true, get innerHTML() { return ''; }, set innerHTML(v) { writes++; } };
  const ctx = vm.createContext({ $: () => host, S: {}, clearTimeout: () => {}, pollOnboarding: () => {} });
  vm.runInContext(body, ctx); ctx.renderOnboarding(); ctx.renderOnboarding(); assert.equal(writes, 1);
});
test('UI-10: onboarding cannot cover task forms or the active composer', () => {
  const css = fs.readFileSync(`${__dirname}/styles.css`, 'utf8');
  assert.ok(css.includes('body:has(#tf-page, .ck-compose) .hosted-onboarding'));
});
