const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const fn = (name) => { const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm')); assert.ok(start >= 0, name); return src.slice(start, src.indexOf('\n}', start) + 2); };
test('UI-3/RQ-6: repeated hydration replaces static event handlers', () => {
  const ctx = vm.createContext({}); vm.runInContext(fn('setEventHandler'), ctx);
  const element = {}; let calls = 0;
  for (let i = 0; i < 3; i++) ctx.setEventHandler(element, 'click', () => calls++);
  element.onclick(); assert.equal(calls, 1);
  assert.doesNotMatch(fn('hydrateOrganizationView'), /\$\('[^']+'\)\?\.addEventListener/);
});
