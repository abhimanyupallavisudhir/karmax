// Regression coverage for wiki mentions in Agent-review prompt fields.
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

const prompts = [{ id: 'first' }, { id: 'second' }];
const wired = [];
global.S = { projectId: 'project-1' };
global.wireWikiMention = (prompt, projectId) => wired.push([prompt.id, projectId]);

eval(extractFn('wireConfirmerWikiPrompts'));
wireConfirmerWikiPrompts({ querySelectorAll: (selector) => (selector === '.cf-prompt' ? prompts : []) });

let pass = 0;
let fail = 0;
const ok = (condition, message) => condition ? pass++ : (fail++, console.error('FAIL:', message));
ok(JSON.stringify(wired) === JSON.stringify([['first', 'project-1'], ['second', 'project-1']]), 'every review prompt uses the shared wiki picker and current project');

const wireConfirmer = extractFn('wireConfirmerField');
const resetConfirmer = extractFn('resetConfirmerField');
ok(wireConfirmer.includes('wireConfirmerWikiPrompts(row)'), 'newly added review layers are wired');
ok(wireConfirmer.includes('wireConfirmerWikiPrompts(box)'), 'initial review layers are wired');
ok(resetConfirmer.includes('wireConfirmerWikiPrompts(list)'), 'reset/re-rendered review layers are wired');
ok(src.includes('Type @ to add context from the wiki.'), 'the field advertises wiki context search');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
