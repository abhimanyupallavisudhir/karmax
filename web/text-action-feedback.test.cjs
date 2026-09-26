const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const fn = (name) => { const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm')); assert.ok(start >= 0, name); return src.slice(start, src.indexOf('\n}', start) + 2); };
test('UI-19: ordinary text editing is never blocked by action feedback', () => {
  const control = { tagName: 'TEXTAREA', classList: { contains: () => true } };
  const ctx = vm.createContext({ actionableControl: () => control }); vm.runInContext(fn('rememberInteractionOrigin'), ctx);
  for (const key of [' ', 'Enter']) {
    let blocked = false;
    ctx.rememberInteractionOrigin({ type: 'keydown', key, preventDefault: () => { blocked = true; } });
    assert.equal(blocked, false);
  }
});
