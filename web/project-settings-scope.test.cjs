const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const fn = (name) => { const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm')); assert.ok(start >= 0, name); return src.slice(start, src.indexOf('\n}', start) + 2); };
test('UI-4: project settings hydration and its handlers stay inside their original panel', () => {
  for (const name of ['Secrets', 'Data', 'Services', 'Environment']) {
    const body = fn('hydrateProject' + name);
    assert.match(body, /beginAsyncElementRender\(box\)/, name);
    assert.match(body, /if \(!renderIsCurrent\(\)\) return;/, name);
    assert.doesNotMatch(body.slice(body.indexOf('try {')), /\$\(/, name);
    assert.match(body, /S\.projectId !== proj\.id/, name);
  }
});
