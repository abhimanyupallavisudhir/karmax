const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const fn = (name) => { const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm')); assert.ok(start >= 0, name); return src.slice(start, src.indexOf('\n}', start) + 2); };
test('UI-5: responder uses the same avatar and MCP selection as other agents', () => {
  const spec = { provider: 'mock', avatarId: 'avatar-1', mcpConnections: ['connection-1'] };
  const ctx = vm.createContext({ readAgentSpec: () => spec }); vm.runInContext(fn('readResponder'), ctx);
  const route = ctx.readResponder({ querySelector: s => s === '.rf-kind' ? { value: 'agent' } : {}, getAttribute: () => '""' });
  assert.equal(route.avatarId, spec.avatarId); assert.deepEqual(route.mcpConnections, spec.mcpConnections);
  assert.match(fn('normResponder'), /avatarId/);
});
