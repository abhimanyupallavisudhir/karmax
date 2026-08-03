// Clicking an agent file citation copies a local editor command. Cloud files
// visibly materialize first instead of navigating to a server-relative URL.
// Run: node web/conversation-file-open.test.cjs
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function extractFn(name) {
  const start = src.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  const open = src.indexOf('{', start);
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

let pass = 0, fail = 0;
const ok = (condition, message) => condition ? pass++ : (fail++, console.error('FAIL:', message));
let finishMaterializing;
let copied = '';
let request;
const notices = [];
global.api = (...args) => { request = args; return new Promise((resolve) => { finishMaterializing = resolve; }); };
global.copyToClipboard = async (value) => { copied = value; };
global.toast = (value) => notices.push(value);
global.hostLocal = () => true;
global.worldFileTarget = (raw) => ({ path: raw.replace(/:12$/, ''), line: 12 });

eval(extractFn('openWorldFile'));

const classes = new Set();
const attrs = new Map();
const anchor = {
  dataset: { worldFile: '/workspace/src/app.ts:12' },
  classList: { add: (value) => classes.add(value), remove: (value) => classes.delete(value) },
  setAttribute: (key, value) => attrs.set(key, value),
  removeAttribute: (key) => attrs.delete(key),
};

(async () => {
  const opening = openWorldFile(anchor, { taskId: 'task-cloud', worldAvailable: true });
  await Promise.resolve();
  ok(classes.has('materializing'), 'the clicked link shows materialization in progress');
  ok(attrs.get('aria-busy') === 'true', 'the progress state is exposed to assistive technology');

  finishMaterializing({ command: "code --goto '/tmp/checkout/src/app.ts:12'", materialized: true });
  await opening;
  ok(request[0] === '/api/tasks/task-cloud/open-command' && JSON.parse(request[1].body).line === 12, 'the click asks the task handoff endpoint to resolve the cited location');
  ok(copied === "code --goto '/tmp/checkout/src/app.ts:12'", 'the returned local editor command is copied');
  ok(notices.includes('open command copied'), 'success uses the requested confirmation message');
  ok(!classes.has('materializing') && !attrs.has('aria-busy') && !anchor.dataset.opening, 'the progress state clears after copying');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
