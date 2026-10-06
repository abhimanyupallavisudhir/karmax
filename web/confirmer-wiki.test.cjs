// Regression coverage for wiki mentions in agents' Instructions.
// Run: node web/confirmer-wiki.test.cjs
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

// Instructions for a Reviewer or Responder accept the same wiki references as
// the task prompt: every Agent block wires its Instructions box to the picker.
const wired = [];
global.S = { projectId: 'project-1' };
global.wireWikiMention = (prompt, projectId) => wired.push([prompt.id, projectId]);
global.wireAgentBox = () => {};
global.wireAgentAuthority = () => {};
eval(extractFn('wireAgentBlock'));
const block = (id) => ({ querySelector: (selector) => (selector === '.ab-instructions' ? { id } : null) });
wireAgentBlock(block('reviewer'), { projectId: 'project-2' });
wireAgentBlock(block('responder'));

let pass = 0;
let fail = 0;
const ok = (condition, message) => condition ? pass++ : (fail++, console.error('FAIL:', message));
ok(JSON.stringify(wired) === JSON.stringify([['reviewer', 'project-2'], ['responder', 'project-1']]),
  'each agent\'s instructions use the shared wiki picker and the block\'s project');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
