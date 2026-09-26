const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
test('UI-13: the console shell has no inline executable script', () => {
  const html = fs.readFileSync(`${__dirname}/index.html`, 'utf8');
  assert.doesNotMatch(html, /<script>([\s\S]*?)<\/script>/);
});
test('UI-13: the pinned MathJax entrypoint has cross-origin integrity metadata', () => {
  const src = fs.readFileSync(`${__dirname}/markdown.js`, 'utf8');
  assert.match(src, /script\.integrity = 'sha384-[A-Za-z0-9+/=]+'/);
  assert.match(src, /script\.crossOrigin = 'anonymous'/);
});
