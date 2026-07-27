// Regression coverage for provider-native model labels and descriptions.
// Run: node web/model-picker.test.cjs
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

global.S = {
  modelCatalog: {
    claude: [{
      id: 'opus[1m]',
      displayName: 'Opus (1M context)',
      description: 'Opus 5 with 1M context',
      effort: ['low', 'high'],
    }],
  },
};
global.MODELS = { claude: ['default'] };
eval(extractFn('modelOptions'));
eval(extractFn('normalizeComboOption'));

let pass = 0;
let fail = 0;
const ok = (condition, message) => condition ? pass++ : (fail++, console.error('FAIL:', message));

const options = modelOptions('claude');
ok(options[0].id === 'opus[1m]', 'keeps the SDK model object rather than flattening it to an id');

const rendered = normalizeComboOption(options[0]);
ok(rendered.value === 'opus[1m]', 'uses the provider model id as the submitted value');
ok(rendered.label === 'Opus (1M context)', 'surfaces the provider display name');
ok(rendered.description.includes('Opus 5'), 'surfaces the concrete model named by the provider description');

const fallback = normalizeComboOption('default');
ok(fallback.value === 'default' && fallback.label === 'default', 'continues to support string fallbacks');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
