// Avatars are tasks (wiki features/avatars): a setting at the bottom of the task
// form, rows marked ✦ Avatar, forks that say they act with its authorization.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const fn = (name) => {
  const start = app.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  return app.slice(start, app.indexOf('\n}', start) + 2);
};
const constant = (name) => app.match(new RegExp(`^const ${name} = [^\\n]*;$`, 'm'))[0];

test('Avatars are no longer a project tab or a separate editor', () => {
  assert.match(app, /const tabs = \['tasks', 'queue', 'wiki', 'settings'\];/);
  for (const gone of ['openAvatarEditor', 'avatarsView', 'avatarRoute', 'af-avatar'])
    assert.ok(!app.includes(gone), `${gone} is gone`);
});

function section(value) {
  const context = vm.createContext({
    esc: (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    policyTip: (text) => `<button class="info-dot" title="${text}">ⓘ</button>`,
    audienceComboHtml: (className, value) => `<input class="${className}" value="${value}">`,
  });
  vm.runInContext(`${constant('AVATAR_DISCLAIMER')}\n${constant('AVATAR_ROLE_CHOICES')}\n${fn('avatarSectionHtml')}`, context);
  return context.avatarSectionHtml(value);
}

test('the form’s Avatar row: the setting, its red risk label and full disclaimer, then its options', () => {
  const off = section(undefined);
  assert.match(off, /<input type="checkbox" class="toggle" id="tf-avatar" > Avatār/);
  assert.doesNotMatch(off, /automatically grants/, 'what it grants is in the disclaimer tip, not a line beside it');
  assert.match(off, /<span class="risk-chip">! At your own risk<\/span><button class="info-dot" title="Forks of an Avatār act with its authorization/);
  assert.match(off, /class="tf-avatar-options" hidden/);
  assert.match(off, /class="tf-avatar-callers" value="@project"/, 'callable by the project by default');
  const on = section({ callableBy: ['@maintainers', 'user:dev'], forksMayBeAvatars: true });
  assert.match(on, /id="tf-avatar" checked/);
  assert.match(on, /class="tf-avatar-options" >/);
  assert.match(on, /value="@maintainers, user:dev"/);
  assert.match(on, /id="tf-avatar-forks" checked/);
  // Forked as: every role, until some are unticked.
  assert.equal((off.match(/value="(do|responder|confirm|agent)" checked/g) || []).length, 4);
  const some = section({ callableBy: ['@project'], roles: ['responder'] });
  assert.match(some, /value="responder" checked/);
  assert.match(some, /value="do" >/);
});

test('reading the row: nothing unticked, the callers and the forks option ticked', () => {
  const context = vm.createContext({});
  vm.runInContext(`${constant('AVATAR_ROLE_CHOICES')}\n${fn('readAvatarSection')}`, context);
  const root = (checked, callers, forks, roles = ['do', 'responder', 'confirm', 'agent']) => ({ querySelector: (selector) => ({
    '#tf-avatar': { checked }, '.tf-avatar-callers': { value: callers }, '#tf-avatar-forks': { checked: forks } })[selector],
    querySelectorAll: () => roles.map((value) => ({ value })) });
  assert.equal(context.readAvatarSection(root(false, '@project', true)), undefined);
  const read = (...args) => JSON.parse(JSON.stringify(context.readAvatarSection(root(...args))));
  assert.deepEqual(read(true, ' @team:ops, user:dev ', false), { callableBy: ['@team:ops', 'user:dev'] });
  assert.deepEqual(read(true, '', true), { callableBy: ['@project'], forksMayBeAvatars: true });
  assert.deepEqual(read(true, '@project', false, ['responder', 'confirm']), { callableBy: ['@project'], roles: ['responder', 'confirm'] });
});

test('the form saves an Avatar only once its risk is acknowledged, and offers saving one without running', () => {
  assert.match(app, /const avatar = avatarCommitted \? readAvatarSection\(\$\('#tf-body'\)\) : undefined;/);
  assert.match(app, /<button class="btn" id="tf-save-avatar" \$\{values\.avatar \? '' : 'hidden'\}>Save as Avatār without running<\/button>/);
  assert.match(app, /\$\('#tf-save-avatar'\)\?\.addEventListener\('click', \(\) => submitCommitted\(true\)\);/);
  assert.match(app, /\$\('#tf-queue'\)\.addEventListener\('click', \(\) => submitCommitted\(false\)\);/);
  assert.match(fn('confirmAvatar'), /Avatārs automatically grant their authorizations to their future forks\./);
  assert.match(fn('confirmAvatar'), /Don’t show this again/);
});

test('a confirmed “Don’t show this again” is remembered; a cancel is not', async () => {
  const stored = {};
  let overlay;
  const element = () => {
    const listeners = {};
    const children = {};
    const el = {
      className: '', innerHTML: '', listeners,
      addEventListener: (type, handler) => { listeners[type] = handler; },
      querySelector: (selector) => (children[selector] ||= { checked: false, ...element(), focus() {} }),
      remove() { el.removed = true; },
    };
    return el;
  };
  const context = vm.createContext({
    localStorage: { getItem: (key) => stored[key] ?? null, setItem: (key, value) => { stored[key] = value; } },
    document: { createElement: () => (overlay = element()), body: { appendChild() {} } },
    esc: (text) => text,
  });
  vm.runInContext(`${constant('AVATAR_DISCLAIMER')}\n${constant('AVATAR_NOTICE_KEY')}\n${fn('confirmAvatar')}`, context);
  let answer = context.confirmAvatar();
  overlay.querySelector('.avatar-notice-dismiss input').checked = true;
  overlay.querySelector('.avatar-notice-cancel').listeners.click();
  assert.equal(await answer, false);
  assert.deepEqual(stored, {});
  answer = context.confirmAvatar();
  overlay.querySelector('.avatar-notice-dismiss input').checked = true;
  overlay.querySelector('.avatar-notice-ok').listeners.click();
  assert.equal(await answer, true);
  assert.equal(stored['tavya.avatarNoticeDismissed'], '1');
  assert.equal(await context.confirmAvatar(), true, 'no dialog once dismissed');
});

test('an Avatar saved without running rests as ✦ Avatar, with Fork instead of Run', () => {
  const context = vm.createContext({});
  vm.runInContext(fn('restingAvatar'), context);
  assert.equal(context.restingAvatar({ params: { avatar: { callableBy: ['@project'] }, draft: true } }), true);
  assert.equal(context.restingAvatar({ params: { avatar: { callableBy: ['@project'] }, draft: true }, lastView: {} }), false);
  assert.equal(context.restingAvatar({ params: { draft: true } }), false);
  const row = fn('taskRow');
  assert.match(row, /avatar \? avatarChip : '<span class="chip">draft<\/span>'/);
  assert.match(row, /data-fork-avatar="\$\{t\.id\}">\$\{ICON\.fork\}Fork<\/button>/);
});

const hydrateSource = app.slice(app.indexOf('async function hydrateAvatarAvailability('), app.indexOf('\nasync function hydrateProjectSecrets('));

for (const scope of ['organization', 'project']) {
  test(`${scope} settings show Avatars on by default, with the disclaimer, and can turn them off`, async () => {
    const listeners = {};
    const box = { innerHTML: '', querySelector: (selector) => ({ addEventListener: (_, handler) => { listeners[selector] = handler; } }) };
    const writes = [];
    let renders = 0;
    const context = vm.createContext({
      $: () => box,
      api: async (url, options) => {
        if (options) { writes.push({ url, body: JSON.parse(options.body) }); return {}; }
        return scope === 'organization' ? { enabled: true } : { organization: true, project: 'inherit', effective: true };
      },
      AVATAR_DISCLAIMER: 'Forks of an Avatār act with its authorization.',
      loadAvatars: async () => {}, renderMain: () => { renders++; }, toast: () => {},
      policyTip: (text) => `<button class="info-dot" title="${text}">ⓘ</button>`,
      paneError: (_, error) => { throw error; },
    });
    vm.runInContext(hydrateSource, context);
    await context.hydrateAvatarAvailability(scope, 'example');
    assert.match(box.innerHTML, /Disable Avatārs/);
    assert.match(box.innerHTML, /Forks of an Avatār act with its authorization/);
    await listeners['.avatar-availability-toggle']({ currentTarget: {} });
    assert.deepEqual(writes[0], { url: `/api/${scope === 'project' ? 'projects' : 'organizations'}/example/avatar-settings`, body: scope === 'project' ? { value: 'disabled' } : { enabled: false } });
    assert.equal(renders, 1);
  });
}
