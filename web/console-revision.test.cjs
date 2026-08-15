// Regression coverage for live deployment revision detection.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
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

const context = {};
vm.createContext(context);
vm.runInContext(extractFn('consoleRevisionChanged'), context);

let pass = 0;
let fail = 0;
const ok = (condition, message) => condition ? pass++ : (fail++, console.error('FAIL:', message));
ok(!context.consoleRevisionChanged(undefined, 'new'), 'the first observed revision establishes the baseline');
ok(!context.consoleRevisionChanged('same', 'same'), 'an unchanged deployment does not reload the console');
ok(context.consoleRevisionChanged('old', 'new'), 'an already-open console detects a newly deployed app.js');
ok(src.includes('setInterval(checkConsoleRevision, 60_000)'), 'the console checks for a deployment while a tab remains open');
ok(src.includes('if (wsHadDropped) checkConsoleRevision();'), 'a deployment websocket reconnect checks immediately');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
