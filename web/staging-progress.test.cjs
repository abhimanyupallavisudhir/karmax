const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const fn = name => source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`))[0];
const esc = source.match(/const esc = [^]*?\n\n/)[0];

test('saving resources shows how far the save has got, and only while that is current', () => {
  const S = { taskEvents: [] };
  const context = vm.createContext({ S });
  vm.runInContext([esc, fn('formatBytes'), fn('liveOnlyEvent'), fn('stagingProgress'), fn('taskActions')].join('\n'), context);
  const view = { taskId: 'task', status: 'active', state: { stagingResources: true } };
  const label = () => context.taskActions(view).match(/<button[^>]*>([^<]*)<\/button>/)[1];
  assert.equal(label(), 'Saving resources…');
  const GiB = 1024 ** 3;
  S.taskEvents.push({ type: 'staging.progress', ts: Date.now() - 5_000,
    payload: { path: 'raw_data', index: 0, count: 2, files: 900, totalFiles: 70751, bytes: 1.5 * GiB, totalBytes: 6 * GiB } });
  S.taskEvents.push({ type: 'agent.activity', ts: Date.now(), payload: {} });
  assert.equal(label(), 'Saving raw_data · 1.5 GB of 6 GB');
  assert.match(context.taskActions(view), /title="Resource 1 of 2"/);
  // Figures a minute old may no longer be true.
  S.taskEvents[0].ts = Date.now() - 61_000;
  assert.equal(label(), 'Saving resources…');
  // Progress is shown in place, never listed as activity.
  assert.equal(context.liveOnlyEvent('staging.progress'), true);
  assert.equal(context.liveOnlyEvent('view.updated'), false);
});
