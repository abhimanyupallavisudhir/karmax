// A review server that exits before its preview opens must not open a dead tab
// (task 364: the tab showed ERR_SSL_PROTOCOL_ERROR; the output said why).
// Run: node web/review-action-open.test.cjs
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  const open = src.indexOf('{', start);
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

let failures = 0;
function ok(value, message) {
  if (value) console.log(`ok - ${message}`);
  else { failures++; console.error(`not ok - ${message}`); }
}

async function run({ exitFirst }) {
  const opened = [];
  const timers = [];
  let socket;
  let click;
  const button = {
    disabled: false, isConnected: true, textContent: 'Live preview',
    getAttribute: (name) => ({ 'data-idx': '0', 'data-kind': 'run' })[name],
    addEventListener: (_type, fn) => { click = fn; },
  };
  const out = { textContent: '', scrollTop: 0, scrollHeight: 0, classList: { remove() {} } };
  global.document = { getElementById: (id) => ({ 'review-actions': { querySelectorAll: () => [button] }, 'review-action-out': out })[id] };
  global.location = { protocol: 'https:', host: 'tavya.test' };
  global.S = {};
  global.reviewActionWs = null;
  global.WebSocket = function WebSocket(url) { socket = this; this.url = url; this.close = () => {}; };
  global.window = { open: (url) => opened.push(url) };
  global.setTimeout = (fn) => { timers.push(fn); return timers.length; };
  global.setStopBtn = () => {};
  global.stripAnsi = (value) => value;
  global.toast = () => {};
  global.wireCheckoutApprovals = () => {};
  global.api = async () => ({ kind: 'run', procId: 'execution-1', server: true,
    openUrls: ['https://p-1.preview.tavya.test/preview/preview-1/?token=t'] });
  eval(`${extractFn('wireReviewActions')}; global.wireReviewActions = wireReviewActions;`);
  global.wireReviewActions({ taskId: 'task-1', reviewInfo: { actions: [{ kind: 'run' }] } });
  await click();
  if (exitFirst) {
    socket.onmessage({ data: JSON.stringify({ type: 'data', data: 'Error: listen EADDRINUSE :::4173\n' }) });
    socket.onmessage({ data: JSON.stringify({ type: 'exit', code: 1 }) });
  }
  for (const timer of timers) timer();
  return { opened, output: out.textContent };
}

(async () => {
  const healthy = await run({ exitFirst: false });
  ok(healthy.opened.length === 1, 'a running server opens its preview');
  const failed = await run({ exitFirst: true });
  ok(failed.opened.length === 0, 'a server that already exited opens no tab');
  ok(failed.output.includes('EADDRINUSE') && failed.output.includes('[exited: code 1]'), 'its output explains the failure');
  if (failures) process.exit(1);
})().catch((error) => { console.error(error); process.exit(1); });
