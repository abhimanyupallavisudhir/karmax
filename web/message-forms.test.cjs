// Message forms (web/markdown.js parseForm / renderForm): how an agent's
// ```form fence is read, what it may ask for, and how it is drawn.
// Run: node web/message-forms.test.cjs
const assert = require('node:assert/strict');
require('./markdown.js');
const { parseForm, renderForm, renderMarkdown } = globalThis.KarmaxMarkdown;

// A fence's language becomes a class, so the console can find form blocks.
assert.match(renderMarkdown('```form\n{"options":["A"]}\n```'), /<pre class="md-code lang-form"><code>/);
assert.match(renderMarkdown('```JS extra\nx\n```'), /<pre class="md-code lang-js">/);
assert.match(renderMarkdown('```\nx\n```'), /<pre class="md-code"><code>/);

// "Just say A, B or C": a list of options is one quick question.
const quick = parseForm('{"label": "Which database?", "options": ["Postgres", {"value": "sqlite", "label": "SQLite", "hint": "One file"}]}').form;
assert.equal(quick.quick, true);
assert.equal(quick.fields.length, 1);
assert.equal(quick.fields[0].label, 'Which database?');
assert.deepEqual(quick.fields[0].options, [{ value: 'Postgres', label: 'Postgres' }, { value: 'sqlite', label: 'SQLite', hint: 'One file' }]);
const quickHtml = renderForm(quick, { key: 't/m/0', live: true });
assert.match(quickHtml, /<button type="submit" class="btn ask-choice" name="answer" value="Postgres">Postgres<\/button>/);
assert.match(quickHtml, /title="One file"/);
assert.doesNotMatch(renderForm(quick, { key: 't/m/0', live: false }), /value="Postgres">/, 'answered: buttons are disabled');
assert.match(renderForm(quick, { key: 't/m/0', live: false }), /value="Postgres" disabled>/);

// A general form: types are read, guessed and defaulted; labels come from names.
const general = parseForm(JSON.stringify({ title: 'Deploy', fields: [
  { name: 'region', options: ['eu-west', 'us-east'], default: 'eu-west' },
  { name: 'customDomain', placeholder: 'example.com', optional: true },
  { name: 'budget', type: 'number', min: 0 },
  { name: 'features', type: 'choice', multiple: true, options: ['Auth', 'Payments'] },
  { name: 'notes', type: 'textarea', optional: true },
  { name: 'go', type: 'boolean', label: 'Deploy now' },
  { name: 'go' },
  'not a field',
] })).form;
assert.equal(general.quick, false);
assert.deepEqual(general.fields.map((f) => [f.name, f.type, f.label, f.optional]), [
  ['region', 'choice', 'Region', false], ['customDomain', 'text', 'Custom domain', true], ['budget', 'number', 'Budget', false],
  ['features', 'choice', 'Features', false], ['notes', 'paragraph', 'Notes', true], ['go', 'toggle', 'Deploy now', true], ['go_', 'text', 'Go', false],
]);
assert.equal(general.submit, 'Send');
const generalHtml = renderForm(general, { key: 'task/m/1', live: true, values: { budget: 40 } });
assert.match(generalHtml, /<div class="ask-title">Deploy<\/div>/);
assert.match(generalHtml, /type="radio" name="region" value="eu-west" checked required/);
assert.match(generalHtml, /type="checkbox" name="features" value="Auth"/);
assert.match(generalHtml, /<label for="ask-task-m-1-customDomain" class="ask-label">Custom domain <span class="ask-optional">optional<\/span><\/label>/);
assert.match(generalHtml, /type="number"[^>]* min="0"[^>]* value="40"/, 'a draft is put back');
assert.match(generalHtml, /<textarea class="ask-input" id="ask-task-m-1-notes" name="notes" rows="3">/);
assert.match(generalHtml, /<input class="toggle" type="checkbox" id="ask-task-m-1-go" name="go">/);
assert.match(generalHtml, /<button type="submit" class="btn primary ask-submit">Send<\/button>/);

// Untrusted text never becomes markup.
const hostile = parseForm(JSON.stringify({ title: '<img src=x onerror=alert(1)>', fields: [{ name: '"><script>', label: '<b>x</b>', options: ['<i>o</i>'] }] })).form;
const hostileHtml = renderForm(hostile, { key: '"><x', live: true });
assert.doesNotMatch(hostileHtml, /<img|<script|<b>x|<i>o/);
assert.match(hostileHtml, /&lt;img src=x onerror=alert\(1\)&gt;/);

// A secret needs somewhere to go; saves are settings writes by the person, never reads or deletes.
assert.match(parseForm('{"fields":[{"name":"key","type":"secret"}]}').error, /secret/);
assert.match(parseForm('{"fields":[{"name":"key","type":"password"}]}').error, /secret/, 'a password field is a secret');
const secure = parseForm(JSON.stringify({ fields: [{ name: 'key', label: 'OpenAI API key', type: 'secret', default: 'leak?' }],
  save: { method: 'post', path: '/api/projects/p/secrets', body: { name: 'OPENAI_API_KEY', value: '{{key}}' } } })).form;
assert.deepEqual(secure.save, { method: 'POST', path: '/api/projects/p/secrets', body: { name: 'OPENAI_API_KEY', value: '{{key}}' } });
assert.equal(secure.submit, 'Save');
assert.equal(secure.fields[0].default, undefined, 'a secret field has no default to show');
const secureHtml = renderForm(secure, { key: 'k', live: true, values: { key: 'typed' }, note: '<span>Saved to <b>x</b></span>' });
assert.match(secureHtml, /type="password" autocomplete="off" spellcheck="false" data-secret/);
assert.doesNotMatch(secureHtml, /typed/, 'a secret is never written back into the page');
assert.match(secureHtml, /<span class="ask-note"><span>Saved to <b>x<\/b><\/span><\/span>/);
for (const save of [{ method: 'DELETE', path: '/api/projects/p' }, { method: 'GET', path: '/api/projects/p/secrets' },
  { path: 'https://evil.example/api/x' }, { path: '/api/../x' }, { path: '/login' }])
  assert.match(parseForm(JSON.stringify({ fields: [{ name: 'a' }], save })).error, /may not/, JSON.stringify(save));

// Unreadable forms say so instead of vanishing.
assert.match(parseForm('{nope').error, /could not be read/);
assert.match(parseForm('{"fields": []}').error, /nothing/);
assert.match(parseForm('7').error, /could not be read/);
// A bare list of fields is a form too.
assert.equal(parseForm('[{"name": "a"}]').form.fields[0].name, 'a');
console.log('Message forms: ok');
