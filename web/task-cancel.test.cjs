const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const fn = name => source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`))[0];

for (const entry of ['footer', 'command', 'form', 'scheduled']) {
  for (const accepted of [false, true]) {
    test(`${entry}: ${accepted ? 'accepting' : 'dismissing'} cancellation confirmation`, async () => {
      const prompts = [], requests = [], reflected = [], feedback = [];
      const elements = new Map();
      const element = key => {
        if (!elements.has(key)) elements.set(key, {
          dataset: { act: 'cancel', label: 'Cancel', canceltrig: 'task' },
          disabled: false, innerHTML: 'Cancel', value: '',
          addEventListener(event, handler) { this[event] = handler; },
          querySelectorAll: selector => selector === '[data-canceltrig]' ? [element('trigger')]
            : selector === '[data-act]' ? [element('button')] : [],
          querySelector: () => null,
        });
        return elements.get(key);
      };
      const context = vm.createContext({
        S: { selected: 'task', view: { taskId: 'task' } },
        $: element, createTransientOverlay: () => ({ ...element('#overlay-root'), remove() {} }), QUICK_TASK_WORKFLOW: 'software-dev',
        confirm: message => { prompts.push(message); return accepted; },
        api: async (url, options) => { requests.push({ url, ...options }); },
        beginActionFeedback: () => feedback.push('start'), finishActionFeedback() {},
        reflectAcceptedTaskAction: (...args) => reflected.push(args),
        taskActionLabel: () => 'Cancel', taskRecord: () => ({ title: 'Scheduled task' }),
        toast() {}, setTimeout() {}, refreshTask() {}, refreshTasks() {},
        wireOrgControls() {}, wirePromptAttachments() {}, wireAttachmentPicker() {},
        renderAttachmentChips() {}, requestTaskFormDefaults() {}, applyCursor() {}, wireQuickComposer() {},
        esc: text => text,
      });
      vm.runInContext(['confirmTaskAction', 'otherAttemptsConfirmation', 'actionToast',
        'wireActions', 'runDeclaredAction', 'openActionForm', 'wireTasksView'].map(fn).join('\n'), context);
      if (entry === 'footer') {
        context.wireActions(context.S.view);
        await element('button').click();
      } else if (entry === 'command') {
        await context.runDeclaredAction({ name: 'cancel' });
      } else if (entry === 'form') {
        context.openActionForm({ name: 'cancel', args: [] });
        await element('#act-send').click();
      } else {
        context.wireTasksView();
        await element('trigger').click({ stopPropagation() {} });
      }
      assert.equal(prompts.length, 1);
      assert.match(prompts[0], /Cancel/);
      assert.equal(requests.length, accepted ? 1 : 0);
      if (accepted) {
        assert.equal(requests[0].url, `/api/tasks/task/${entry === 'scheduled' ? 'cancel-trigger' : 'signal'}`);
        assert.equal(requests[0].method, 'POST');
        assert.deepEqual(JSON.parse(requests[0].body), entry === 'scheduled' ? {} : { signal: 'cancel' });
      } else {
        assert.deepEqual(reflected, []);
        assert.deepEqual(feedback, []);
        assert.equal(element('button').disabled, false);
      }
    });
  }
}

test('routine task actions do not prompt', () => {
  const context = vm.createContext({ confirm: () => assert.fail('unexpected confirmation') });
  vm.runInContext(fn('confirmTaskAction'), context);
  for (const action of ['retry', 'resume', 'confirm']) assert.equal(context.confirmTaskAction(action, {}), true);
});
