const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const fn = name => source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`))[0];

const cancellationCases = ['cancel', 'finish'].flatMap(signal =>
  (signal === 'cancel' ? ['footer', 'command', 'form', 'scheduled'] : ['footer', 'command', 'form'])
    .map(entry => [signal, entry]));
for (const [signal, entry] of cancellationCases) {
  for (const accepted of [false, true]) {
    test(`${signal} ${entry}: ${accepted ? 'accepting' : 'dismissing'} cancellation confirmation`, async () => {
      const prompts = [], requests = [], reflected = [], feedback = [];
      const elements = new Map();
      const element = key => {
        if (!elements.has(key)) elements.set(key, {
          dataset: { act: signal, label: 'Cancel', canceltrig: 'task' },
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
        wireOrgControls() {}, wireTaskStore() {}, scrollToHashedTagSection() {}, wirePromptAttachments() {}, wireAttachmentPicker() {},
        renderAttachmentChips() {}, requestTaskFormDefaults() {}, applyCursor() {}, wireNewTaskComposer() {}, wireInboxNotices() {},
        esc: text => text,
      });
      vm.runInContext(['confirmTaskAction', 'hasOpenPullRequest', 'confirmMergeRights', 'otherAttemptsConfirmation', 'actionToast',
        'wireActions', 'runDeclaredAction', 'openActionForm', 'wireTasksView', 'wireRowAsks', 'isCrossProjectList'].map(fn).join('\n'), context);
      if (entry === 'footer') {
        context.wireActions(context.S.view);
        await element('button').click();
      } else if (entry === 'command') {
        await context.runDeclaredAction({ name: signal, label: 'Cancel' });
      } else if (entry === 'form') {
        context.openActionForm({ name: signal, label: 'Cancel', args: [] });
        await element('#act-send').click();
      } else {
        context.wireTasksView();
        await element('trigger').click({ stopPropagation() {} });
      }
      assert.equal(prompts.length, 1);
      assert.match(prompts[0], /Cancel this (?:scheduled )?task\?/);
      assert.doesNotMatch(prompts[0], /Finish/);
      if (signal === 'finish') assert.match(prompts[0], /[Aa]pproved.*may still land/);
      assert.equal(requests.length, accepted ? 1 : 0);
      if (accepted) {
        assert.equal(requests[0].url, `/api/tasks/task/${entry === 'scheduled' ? 'cancel-trigger' : 'signal'}`);
        assert.equal(requests[0].method, 'POST');
        assert.deepEqual(JSON.parse(requests[0].body), entry === 'scheduled' ? {} : { signal });
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

test('cancellation after a landing keeps the Cancel label, including older task views', () => {
  const context = vm.createContext({ esc: text => text });
  vm.runInContext(['taskActionLabel', 'taskActionTip', 'biggerDiskButton', 'taskActions', 'actionToast'].map(fn).join('\n'), context);
  for (const label of ['Finish', 'Cancel']) {
    const action = { name: 'finish', label, enabled: true, danger: true };
    const view = { actions: [action] };
    assert.equal(context.taskActionLabel(view, action), 'Cancel');
    const html = context.taskActions(view);
    assert.match(html, /data-act="finish" data-label="Cancel"/);
    assert.doesNotMatch(html, /Finish/);
    assert.match(context.taskActionTip(view, action), /[Aa]pproved.*may still land/);
    assert.equal(context.actionToast(action.name, context.taskActionLabel(view, action)), 'Cancelling');
  }
});
