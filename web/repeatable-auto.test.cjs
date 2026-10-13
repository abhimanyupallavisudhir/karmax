// #616: the form ticks Repeatable for a schedule or a new event trigger, and
// must untick it again when that is cleared — unless the person set the box.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const fn = (name) => { const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm')); return src.slice(start, src.indexOf('\n}', start) + 2); };
const constant = (name) => { const start = src.indexOf(`const ${name} =`); return src.slice(start, src.indexOf('];', start) + 2); };

function form({ fresh = true, checked = false } = {}) {
  const listeners = {};
  const el = (props = {}) => ({ value: '', dataset: {}, addEventListener: (type, f) => { (listeners[props.id] ||= {})[type] = f; }, ...props });
  const nodes = {
    'trig-repeatable': el({ id: 'trig-repeatable', checked, disabled: false }),
    'ev-type': el({ id: 'ev-type' }),
    'ev-trigger': el({ id: 'ev-trigger', dataset: fresh ? { fresh: '1' } : {} }),
  };
  const ctx = vm.createContext({ $: (sel) => nodes[sel.slice(1)] ?? (nodes[sel.slice(1)] = el({ id: sel.slice(1) })) });
  vm.runInContext(`${constant('CRON_FIELDS')}\n${fn('readCronCells')}\n${fn('syncAutoRepeatable')}\n${fn('wireScheduleBuilder')}`, ctx);
  ctx.wireScheduleBuilder();
  const box = nodes['trig-repeatable'];
  const cron = (value) => { ctx.$('#' + vm.runInContext('CRON_FIELDS[0].id', ctx)).value = value; ctx.syncAutoRepeatable(); };
  const eventType = (value) => { nodes['ev-type'].value = value; ctx.syncAutoRepeatable(); };
  const click = (value) => { box.checked = value; listeners['trig-repeatable'].change({ target: box }); };
  return { box, cron, eventType, click };
}

test('a schedule ticks and locks Repeatable; clearing it unticks and unlocks', () => {
  const f = form();
  f.cron('0');
  assert.equal(f.box.checked, true);
  assert.equal(f.box.disabled, true);
  f.cron('');
  assert.equal(f.box.checked, false);
  assert.equal(f.box.disabled, false);
});

test('a new event type ticks Repeatable; clearing it unticks', () => {
  const f = form();
  f.eventType('github.issues.labeled');
  assert.equal(f.box.checked, true);
  f.eventType('');
  assert.equal(f.box.checked, false);
});

test('a box the person set stays as they set it', () => {
  const ticked = form();
  ticked.click(true);
  ticked.cron('0');
  ticked.cron('');
  assert.equal(ticked.box.checked, true);

  const unticked = form();
  unticked.eventType('a.b');
  unticked.click(false);
  unticked.eventType('c.d');
  assert.equal(unticked.box.checked, false);
});

test('a task saved as repeatable keeps the box; an existing event trigger does not tick it', () => {
  const saved = form({ checked: true });
  saved.cron('');
  assert.equal(saved.box.checked, true);
  const existing = form({ fresh: false });
  existing.eventType('a.b');
  assert.equal(existing.box.checked, false);
});
