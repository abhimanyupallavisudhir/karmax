const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const fn = name => source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`))[0];

test('task buttons acknowledge immediately, prevent repeated requests, and recover after errors', async () => {
  for (const fail of [false, true]) {
    let click, settle, calls = 0;
    const btn = { disabled: false, dataset: { act: 'confirm', label: 'Done' }, innerHTML: 'Done',
      addEventListener: (_event, handler) => { click = handler; } };
    const feedback = [], toasts = [];
    const context = vm.createContext({
      resourceChoiceWrites: new Map(),
      // No Bigger disk here: the task is not out of disk.
      $: selector => selector === '#bigger-disk' ? null : ({ querySelectorAll: () => selector === '#tp-foot' ? [btn] : [] }),
      confirmTaskAction: () => true,
      beginActionFeedback: control => { assert.equal(control, btn); feedback.push('start'); return 'ticket'; },
      finishActionFeedback: (ticket, success) => { assert.equal(ticket, 'ticket'); feedback.push(success); },
      api: (url, options) => {
        if (!options) {
          assert.equal(url, '/api/tasks/task/attempts');
          return Promise.resolve({ otherAttemptsChoiceAvailable: true, attempts: [{ id: 'task' }] });
        }
        calls++;
        assert.deepEqual(JSON.parse(options.body), { signal: 'confirm' });
        return new Promise((resolve, reject) => { settle = () => fail ? reject(new Error('Offline')) : resolve(); });
      },
      reflectAcceptedTaskAction() {}, toast: message => toasts.push(message),
      setTimeout() {}, refreshTask() {}, refreshTasks() {},
    });
    vm.runInContext([fn('hasOpenPullRequest'), fn('confirmMergeRights'), fn('actionToast'), fn('waitResourceChoices'), fn('otherAttemptsConfirmation'), fn('wireActions')].join('\n'), context);
    context.wireActions({ taskId: 'task' });
    const pending = click();
    assert.deepEqual(feedback, ['start']);
    assert.equal(btn.disabled, true);
    assert.equal(btn.textContent, 'Sending…');
    await click();
    await new Promise(setImmediate); // allow the attempt lookup to finish before the POST
    assert.equal(calls, 1);
    settle(); await pending;
    assert.deepEqual(feedback, ['start', !fail]);
    assert.equal(btn.disabled, false);
    assert.equal(btn.innerHTML, 'Done');
    assert.deepEqual(toasts, [fail ? 'Offline' : 'Confirmation sent']);
  }
});

test('pending attempt choice prevents repeated clicks and dismissing it never confirms', async () => {
  for (const choice of [null, { otherAttempts: 'keep', saveOtherAttemptsDefault: true }, { otherAttempts: 'cancel', saveOtherAttemptsDefault: false }]) {
    let click, choose, choices = 0;
    const btn = { disabled: false, dataset: { act: 'confirm', label: 'Done' }, innerHTML: 'Done',
      addEventListener: (_event, handler) => { click = handler; } };
    const feedback = [], requests = [], toasts = [];
    const context = vm.createContext({
      resourceChoiceWrites: new Map(),
      // No Bigger disk here: the task is not out of disk.
      $: selector => selector === '#bigger-disk' ? null : ({ querySelectorAll: () => selector === '#tp-foot' ? [btn] : [] }),
      confirmTaskAction: () => true,
      otherAttemptsConfirmation: () => { choices++; return new Promise(resolve => { choose = resolve; }); },
      beginActionFeedback: () => { feedback.push('start'); return 'ticket'; },
      finishActionFeedback: (_ticket, success) => feedback.push(success),
      api: async (_url, options) => { requests.push(JSON.parse(options.body)); },
      reflectAcceptedTaskAction() {}, toast: message => toasts.push(message),
      setTimeout() {}, refreshTask() {}, refreshTasks() {},
    });
    vm.runInContext([fn('hasOpenPullRequest'), fn('confirmMergeRights'), fn('actionToast'), fn('waitResourceChoices'), fn('wireActions')].join('\n'), context);
    context.wireActions({ taskId: 'task' });
    const pending = click();
    assert.equal(btn.disabled, true);
    assert.deepEqual(feedback, ['start']);
    await click();
    assert.equal(choices, 1);
    assert.deepEqual(requests, []);
    choose(choice);
    await pending;
    assert.deepEqual(requests, choice ? [{ signal: 'confirm', ...choice }] : []);
    assert.deepEqual(feedback, ['start', choice !== null]);
    assert.deepEqual(toasts, choice ? ['Confirmation sent'] : []);
    assert.equal(btn.disabled, false);
    assert.equal(btn.innerHTML, 'Done');
  }
});

test('finalization feedback survives rendering a fresh task view', () => {
  const context = vm.createContext({});
  vm.runInContext([fn('biggerDiskButton'), fn('taskActions')].join('\n'), context);
  const html = context.taskActions({ state: { finalizing: true }, actions: [] });
  assert.match(html, /Finishing…/);
  assert.match(html, /Saving task output/);
  assert.match(html, /disabled aria-busy="true"/);
  assert.doesNotMatch(html, /data-act=/);
});

test('confirmation waits for resource saves and recovers without confirming a failed save', async () => {
  for (const fail of [false, true]) {
    let click, settle;
    const writes = new Map();
    const requests = [], toasts = [];
    const btn = { disabled: false, dataset: { act: 'confirm', label: 'Confirm' }, innerHTML: 'Confirm',
      addEventListener: (_event, handler) => { click = handler; } };
    const promise = new Promise((resolve, reject) => { settle = () => fail ? reject(new Error('Resource save failed')) : resolve(); })
      .finally(() => writes.delete('task/resource'));
    writes.set('task/resource', { promise });
    const context = vm.createContext({
      resourceChoiceWrites: writes,
      // No Bigger disk here: the task is not out of disk.
      $: selector => selector === '#bigger-disk' ? null : ({ querySelectorAll: () => selector === '#tp-foot' ? [btn] : [] }),
      confirmTaskAction: () => true, otherAttemptsConfirmation: async () => ({}),
      beginActionFeedback() {}, finishActionFeedback() {}, reflectAcceptedTaskAction() {},
      api: async (_url, options) => requests.push(JSON.parse(options.body)),
      toast: message => toasts.push(message), setTimeout() {}, refreshTask() {}, refreshTasks() {},
    });
    vm.runInContext([fn('hasOpenPullRequest'), fn('confirmMergeRights'), fn('actionToast'), fn('waitResourceChoices'), fn('wireActions')].join('\n'), context);
    context.wireActions({ taskId: 'task' });
    const pending = click();
    await new Promise(setImmediate);
    assert.equal(btn.disabled, true);
    assert.equal(btn.textContent, 'Sending…');
    assert.deepEqual(requests, []);
    settle(); await pending;
    assert.deepEqual(requests, fail ? [] : [{ signal: 'confirm' }]);
    assert.deepEqual(toasts, [fail ? 'Resource save failed' : 'Confirmed']);
    assert.equal(btn.disabled, false);
  }
});
