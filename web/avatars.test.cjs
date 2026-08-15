const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');

test('Avatars are a project tab directly after Wiki', () => {
  assert.match(app, /const tabs = \['tasks', 'queue', 'wiki', 'avatars', 'settings'\]/);
});

test('Avatar creation keeps the common path small and custom policy progressive', () => {
  assert.match(app, /Name<\/span><input id="avatar-name"/);
  assert.match(app, /Instructions<\/span><textarea id="avatar-prompt"/);
  assert.match(app, /<details class="settings-disclosure avatar-customize"/);
  assert.match(app, /Full delegation from you/);
});

test('existing agent controls expose callable Avatars', () => {
  assert.match(app, /class="af-avatar" aria-label="Agent identity"/);
  assert.match(app, /Project\/default agent/);
  assert.match(css, /\.af-avatar-note/);
});
