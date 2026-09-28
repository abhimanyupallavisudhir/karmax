const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
test('UI-12: a failed GitHub load exposes retry instead of connection setup', () => {
  assert.ok(src.includes("if (githubLoadError) paneError($('#org-github'), githubLoadError, () => refresh('github'))"));
  assert.ok(src.includes('githubLoadError = error'));
});
