const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const fn = (name) => { const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm')); return src.slice(start, src.indexOf('\n}', start) + 2); };
test('UI-11: a new deployment offers a reload without destroying edits', async () => {
  let reloads = 0, offers = 0, reads = 0;
  const ctx = vm.createContext({ S: { meta: { consoleRevision: 'old' } }, document: { hidden: false },
    api: async () => { reads++; return { consoleRevision: 'new' }; }, location: { reload: () => reloads++ },
    toast: () => offers++, applyTimingSetting: () => {} });
  vm.runInContext(fn('consoleRevisionChanged') + '\n' + fn('checkConsoleRevision'), ctx);
  await ctx.checkConsoleRevision(); await ctx.checkConsoleRevision();
  assert.equal(reloads, 0); assert.equal(offers, 1);
  ctx.document.hidden = true; await ctx.checkConsoleRevision(); assert.equal(reads, 2);
});
