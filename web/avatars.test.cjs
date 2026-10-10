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

const vm = require('node:vm');
const hydrateSource = app.slice(app.indexOf('async function hydrateAvatarAvailability('), app.indexOf('\nasync function hydrateProjectSecrets('));

for (const scope of ['organization', 'project']) {
  test(`${scope} Experimental buttons save explicit enablement and refresh the UI`, async () => {
    const listeners = {};
    const box = { innerHTML: '', querySelector: (selector) => ({ addEventListener: (_, fn) => { listeners[selector] = fn; } }) };
    const writes = [];
    let renders = 0;
    const context = vm.createContext({
      $: () => box,
      api: async (url, options) => {
        if (options) { writes.push({ url, body: JSON.parse(options.body) }); return {}; }
        return scope === 'organization' ? { enabled: false } : { organization: false, project: 'inherit', effective: false };
      },
      loadAvatars: async () => {}, renderMain: () => { renders++; }, toast: () => {},
      policyTip: (text) => `<button class="info-dot" title="${text}">ⓘ</button>`,
      paneError: (_, error) => { throw error; },
    });
    vm.runInContext(hydrateSource, context);
    await context.hydrateAvatarAvailability(scope, 'example');
    assert.match(box.innerHTML, /Enable Avatars/);
    assert.match(box.innerHTML, /Disabled by default/);
    await listeners['.avatar-availability-toggle']({ currentTarget: {} });
    assert.deepEqual(writes[0], { url: `/api/${scope === 'project' ? 'projects' : 'organizations'}/example/avatar-settings`, body: scope === 'project' ? { value: 'enabled' } : { enabled: true } });
    assert.equal(renders, 1);
    if (scope === 'project') {
      await listeners['.avatar-availability-inherit']({ currentTarget: {} });
      assert.deepEqual(writes[1].body, { value: 'inherit' });
    }
  });
}

test('disabled empty projects hide the Avatar tab and settings place Experimental under Advanced', () => {
  const source = app.match(/const tabs = \['tasks', 'queue', 'wiki', 'avatars', 'settings'\][\s\S]*?;/)[0];
  for (const effective of [false, true]) {
    const tabs = vm.runInNewContext(`${source}; tabs`, { S: { avatarAvailability: { effective }, avatars: [] } });
    assert.equal(tabs.includes('avatars'), effective);
  }
  for (const prefix of ['project', 'settings']) {
    assert.ok(!app.includes(`href="#${prefix}-experimental"`), 'Experimental has no separate navigation entry');
    const advanced = app.indexOf(`<div class="settings-section-title" id="${prefix}-advanced"`);
    const experimental = app.indexOf(`<div class="settings-section-title" id="${prefix}-experimental"`);
    assert.ok(advanced >= 0 && experimental > advanced, 'Experimental follows Advanced');
    assert.equal((app.slice(advanced, experimental).match(/settings-section-title/g) || []).length, 1,
      'Experimental belongs to the Advanced pane');
  }
});
