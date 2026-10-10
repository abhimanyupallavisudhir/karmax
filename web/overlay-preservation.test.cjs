const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
test('UI-14: transient overlays stack above the task form', () => {
  for (const name of ['openPalette', 'openHelp', 'openActionForm']) {
    const start = src.indexOf('function ' + name + '(');
    const body = src.slice(start, src.indexOf('\n}', start) + 2);
    assert.doesNotMatch(body, /\$\('#overlay-root'\)/, name);
    assert.match(body, /createTransientOverlay\(\)/, name);
    assert.match(body, /root\.remove\(\)/, name);
  }
});
