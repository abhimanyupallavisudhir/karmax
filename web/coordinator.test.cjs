// A permanent co-ordinator (wiki features/coordinator): the task form's last
// row, after Avatār — a checkbox and its check-in interval in hours.
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

function context() {
  const ctx = vm.createContext({
    esc: (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    policyTip: (text) => `<button class="info-dot" title="${text}">ⓘ</button>`,
  });
  vm.runInContext([constant('COORDINATOR_DEFAULT_HOURS'), constant('COORDINATOR_TIP'), fn('coordinatorSelectable'),
    fn('coordinatorSectionHtml'), fn('readCoordinatorSection'), fn('coordinatorIntervalText')].join('\n'), ctx);
  return ctx;
}

test('the row sits at the very bottom of the form, right after Avatār', () => {
  const avatar = app.indexOf('<section class="tf-section tf-avatar">');
  const coordinator = app.indexOf('<section class="tf-section tf-coordinator">');
  assert.ok(avatar > 0 && coordinator > avatar, 'after the Avatār row');
  assert.match(app.slice(avatar, coordinator + 200), /tf-avatar[\s\S]*?\n\s*\$\{coordinatorSelectable\(fields\)[^\n]*\n\s*<\/div>\n\s*<aside class="tf-side">/,
    'nothing follows it in the main column');
});

test('a checkbox, and when ticked its interval pre-filled with 24 hours', () => {
  const { coordinatorSectionHtml } = context();
  const off = coordinatorSectionHtml(undefined);
  assert.match(off, /<input type="checkbox" class="toggle" id="tf-coordinator" > Permanent co-ordinator<\/label><button class="info-dot" title="Runs the project like its CEO/);
  assert.match(off, /class="tf-coordinator-wake" hidden/);
  assert.match(off, /id="tf-coordinator-hours"[^>]*step="any"[^>]*value="24"/, 'decimals accepted, 24 by default');
  const on = coordinatorSectionHtml({ wakeHours: 1.5 });
  assert.match(on, /id="tf-coordinator" checked/);
  assert.match(on, /class="tf-coordinator-wake" >/);
  assert.match(on, /value="1.5"/);
  // No paragraph beside it: what it does is its tooltip.
  assert.doesNotMatch(on.replace(/title="[^"]*"/g, ''), /CEO|critical/);
});

test('reading the row: nothing unticked; the hours, decimals and commas included; 24 when blank', () => {
  const { readCoordinatorSection } = context();
  const root = (checked, value) => ({ querySelector: (selector) => ({ '#tf-coordinator': { checked }, '#tf-coordinator-hours': { value } })[selector] });
  assert.equal(readCoordinatorSection(root(false, '6')), undefined);
  const read = (value) => JSON.parse(JSON.stringify(readCoordinatorSection(root(true, value))));
  assert.deepEqual(read('6'), { wakeHours: 6 });
  assert.deepEqual(read('0.5'), { wakeHours: 0.5 });
  assert.deepEqual(read('2,5'), { wakeHours: 2.5 });
  assert.deepEqual(read(''), { wakeHours: 24 });
});

test('offered only where the workflow lands branches, and said read-only as an interval', () => {
  const { coordinatorSelectable, coordinatorIntervalText } = context();
  assert.equal(coordinatorSelectable([{ name: 'prompt' }, { name: 'multiPr' }]), true);
  assert.equal(coordinatorSelectable([{ name: 'command' }]), false);
  assert.equal(coordinatorIntervalText({ wakeHours: 24 }), 'every 24 h');
  assert.equal(coordinatorIntervalText({ wakeHours: 0.25 }), 'every 15 min');
});

test('the form sends it with the task, and a resting co-ordinator says when it checks in', () => {
  assert.match(app, /const coordinator = readCoordinatorSection\(\$\('#tf-body'\)\);\n\s*if \(coordinator\) body\.coordinator = coordinator;/);
  assert.match(app, /w\.summary === 'Checks in' \? 'Checks in at' : 'Waiting until'/);
});
