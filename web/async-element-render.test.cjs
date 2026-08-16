// Async panel hydration must stop when a route change removes its target.
// Run: node web/async-element-render.test.cjs
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  const open = src.indexOf('{', start);
  for (let index = open; index < src.length; index++) {
    if (src[index] === '{') depth++;
    else if (src[index] === '}' && --depth === 0) return src.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

global.asyncElementRenderEpoch = new WeakMap();
eval(extractFn('beginAsyncElementRender'));

let passed = 0;
let failed = 0;
function ok(condition, message) {
  if (condition) passed++;
  else {
    failed++;
    console.error('FAIL:', message);
  }
}

const element = { isConnected: true };
const firstRenderIsCurrent = beginAsyncElementRender(element);
ok(firstRenderIsCurrent(), 'a connected panel may render its current response');

const secondRenderIsCurrent = beginAsyncElementRender(element);
ok(!firstRenderIsCurrent(), 'a newer hydration invalidates the older response');
ok(secondRenderIsCurrent(), 'the newest hydration remains current');

element.isConnected = false;
ok(!secondRenderIsCurrent(), 'a response cannot render after navigation detaches its panel');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
