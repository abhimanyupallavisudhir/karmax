// A `${…}` inside a '…' or "…" string is printed literally — the console once
// showed "Task defaults ${policyTip(`How new tasks begin…`)}" as its heading.
// Interpolation needs a template literal, so no plain string may hold one.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const ts = require('typescript');

const offenders = [];
for (const name of fs.readdirSync(__dirname).filter((file) => file.endsWith('.js'))) {
  const text = fs.readFileSync(`${__dirname}/${name}`, 'utf8');
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const visit = (node) => {
    if (ts.isStringLiteral(node) && /\$\{[^}]*\}/.test(node.text)) {
      offenders.push(`web/${name}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${node.text.slice(0, 80)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
assert.deepEqual(offenders, [], `placeholders in plain strings are shown literally:\n${offenders.join('\n')}`);
console.log('ok  no ${…} placeholder sits in a plain string');
