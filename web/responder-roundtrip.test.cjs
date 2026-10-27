const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const fn = (name) => { const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm')); assert.ok(start >= 0, name); return src.slice(start, src.indexOf('\n}', start) + 2); };
test('UI-5: a responder agent keeps its fork source and MCP selection like other agents', () => {
  // An Avatar Responder is an agent that forks the Avatar (wiki features/avatars).
  const spec = { provider: 'mock', resumeFrom: { taskId: 'avatar-1', role: 'do' }, mcpConnections: ['connection-1'] };
  const ctx = vm.createContext({ readAgentBlock: () => ({ ...spec }) }); vm.runInContext(fn('readResponder'), ctx);
  const agent = ctx.readResponder({ querySelector: s => s === '.rf-kind' ? { value: 'agent' } : {}, getAttribute: () => '\"\"' });
  assert.equal(agent.kind, 'agent');
  assert.deepEqual(agent.resumeFrom, spec.resumeFrom);
  assert.deepEqual(agent.mcpConnections, spec.mcpConnections);
  assert.match(fn('normResponder'), /resume: route\.resumeFrom/);
});
