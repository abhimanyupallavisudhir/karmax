const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const fn = name => { const start = src.indexOf(`function ${name}(`); return src.slice(start, src.indexOf('\n}', start) + 2); };
test('UI-22: repeated socket setup retires the old socket and retry timer', () => {
  let closed = 0, timers = 0;
  const ctx = vm.createContext({ S: {}, location: { protocol: 'http:', host: 'test' },
    WebSocket: function () { this.close = () => { closed++; this.onclose?.(); }; }, clearTimeout: () => {},
    setTimeout: () => { timers++; }, wsHadDropped: false, wsRetryMs: 1500, setWsOnline: () => {} });
  vm.runInContext(fn('connectWs'), ctx);
  ctx.connectWs(); const old = ctx.S.ws;
  ctx.connectWs();
  assert.equal(closed, 1);
  assert.equal(old.onmessage, null);
  assert.equal(timers, 0);
});
test('UI-22: document listeners are installed once across logins', () => {
  assert.ok(/function installShellListeners\(\) \{\s*if \(installShellListeners\.installed\) return;/.test(src));
});
