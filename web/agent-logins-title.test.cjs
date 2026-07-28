// The per-task credential-precedence control lists the agent logins, so its
// section is titled "Agent logins" (not the vaguer "Credentials", which also
// collides with the separate "Vault credentials" button).
// Run: node web/agent-logins-title.test.cjs
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  const signatureEnd = src.indexOf(') {', start);
  const open = src.indexOf('{', signatureEnd);
  for (let index = open; index < src.length; index++) {
    if (src[index] === '{') depth++;
    else if (src[index] === '}' && --depth === 0) return src.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

let passed = 0;
let failed = 0;
function ok(condition, message) {
  if (condition) passed++;
  else {
    failed++;
    console.error('FAIL:', message);
  }
}

// Task detail page — the Parameters tab renders the same control.
global.paramsSection = () => '';
global.authorizationSection = () => '';
eval(extractFn('parametersTab'));
const tab = parametersTab({});
ok(/<div class="section-h">Agent logins<\/div>/.test(tab), 'Parameters tab titles the section "Agent logins"');
ok(!/<div class="section-h">Credentials<\/div>/.test(tab), 'Parameters tab no longer titles it "Credentials"');

// New-task form (openTaskForm) label.
ok(/>Agent logins<\/label>/.test(src), 'new-task form labels the control "Agent logins"');

// Series page (renderSeriesPage) details summary. The title is what's load-bearing
// here; the trailing gloss is free to be reworded.
ok(/<summary>Agent logins —/.test(src), 'series page summary is titled "Agent logins"');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
