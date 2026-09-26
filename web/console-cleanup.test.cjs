const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
test('UI-32: agent entry points are discoverable', () => {
  const text = fs.readFileSync(`${__dirname}/llms.txt`, 'utf8');
  assert.ok(text.includes('describe_platform') && text.includes('platform_request') && text.includes('MCP'));
});
test('UI-33: obsolete resources hydrator and mismatched footer are removed', () => {
  assert.ok(!src.includes('async function hydrateProjectResources('));
  const form = src.slice(src.indexOf('<div class="tf-foot">'), src.indexOf('  wireTaskPayments', src.indexOf('<div class="tf-foot">')));
  assert.ok(!form.includes('</footer>'));
});
test('UI-34: OAuth callback uses the configured brand', () => {
  assert.ok(!src.includes('Return to Tavya'));
  assert.ok(src.includes('Return to ${siteNameMarkup()}'));
});
