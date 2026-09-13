const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const fn = name => source.match(new RegExp(`function ${name}\\([^]*?\\n}`))[0];

test('task buttons acknowledge immediately, prevent repeated requests, and recover after errors', async () => {
  for (const fail of [false, true]) {
    let click, settle, calls = 0;
    const btn = { disabled: false, dataset: { act: 'confirm', label: 'Done' }, innerHTML: 'Done',
      addEventListener: (_event, handler) => { click = handler; } };
    const feedback = [], toasts = [];
    const context = vm.createContext({
      $: selector => ({ querySelectorAll: () => selector === '#tp-foot' ? [btn] : [] }),
      confirmTaskAction: () => true,
      beginActionFeedback: control => { assert.equal(control, btn); feedback.push('start'); return 'ticket'; },
      finishActionFeedback: (ticket, success) => { assert.equal(ticket, 'ticket'); feedback.push(success); },
      api: () => { calls++; return new Promise((resolve, reject) => { settle = () => fail ? reject(new Error('Offline')) : resolve(); }); },
      reflectAcceptedTaskAction() {}, toast: message => toasts.push(message),
      setTimeout() {}, refreshTask() {}, refreshTasks() {},
    });
    vm.runInContext([fn('actionToast'), fn('wireActions')].join('\n'), context);
    context.wireActions({ taskId: 'task' });
    const pending = click();
    assert.deepEqual(feedback, ['start']);
    assert.equal(btn.disabled, true);
    assert.equal(btn.textContent, 'Sending…');
    await click();
    assert.equal(calls, 1);
    settle(); await pending;
    assert.deepEqual(feedback, ['start', !fail]);
    assert.equal(btn.disabled, false);
    assert.equal(btn.innerHTML, 'Done');
    assert.deepEqual(toasts, [fail ? 'Offline' : 'Confirmation sent']);
  }
});

test('finalization feedback survives rendering a fresh task view', () => {
  const context = vm.createContext({});
  vm.runInContext(fn('taskActions'), context);
  const html = context.taskActions({ state: { finalizing: true }, actions: [] });
  assert.match(html, /Finishing…/);
  assert.match(html, /Saving task output/);
  assert.match(html, /disabled aria-busy="true"/);
  assert.doesNotMatch(html, /data-act=/);
});
