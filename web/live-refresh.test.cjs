// Regression checks for the browser-side load-shedding contract.
// Run: node web/live-refresh.test.cjs
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  const open = src.indexOf('{', start);
  for (let index = open; index < src.length; index++) {
    if (src[index] === '{') depth++;
    else if (src[index] === '}' && --depth === 0) return src.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

let passed = 0;
let failed = 0;
function ok(condition, message) {
  if (condition) passed++;
  else {
    failed++;
    console.error('FAIL:', message);
  }
}

global.S = {
  tasks: [{ id: '308', lastView: { stage: 'do', status: 'active' } }],
};
eval(extractFn('patchTaskListFromEvent'));
ok(
  patchTaskListFromEvent({
    taskId: '308',
    type: 'view.updated',
    payload: {
      stage: 'do',
      status: 'waiting',
      waitingFor: 'agentSlot',
      waitingDetail: 'Starting agent',
      waitingProvider: 'codex',
      waitingResetAt: null,
      agentTurn: null,
    },
  }),
  'view.updated applies a compact startup transition',
);
ok(S.tasks[0].lastView.waitingFor.detail === 'Starting agent',
  'compact startup transitions retain their authoritative wait detail');
ok(
  patchTaskListFromEvent({
    taskId: '308',
    type: 'view.updated',
    payload: { stage: 'do', status: 'active', waitingFor: null, agentTurn: 'running', agentRole: 'do' },
  }),
  'view.updated patches an existing list row',
);
ok(S.tasks[0].lastView.status === 'active', 'the list status is updated locally');
ok(S.tasks[0].lastView.waitingFor === undefined, 'the stale wait reason is removed');
ok(S.tasks[0].lastView.agentTurn.state === 'running', 'the live agent state is projected locally');

const ws = extractFn('connectWs');
ok(!ws.includes("['view.updated', 'task.responsibility-changed'"), 'view updates do not reload collaboration endpoints');
ok(ws.includes('LIST_RELOAD_EVENTS.has(ev.type)'), 'only structural events schedule a full list reload');

const open = extractFn('openTask');
ok(open.includes('/events?since=0&limit=300'), 'initial task history is bounded');
ok(open.indexOf('renderTaskPage();') < open.indexOf('await details'), 'the compact task view paints before secondary resources finish');

const refresh = extractFn('refreshTasks');
ok(refresh.includes('if (taskRefreshPromise)') && refresh.includes('taskRefreshQueued = true'),
  'full task refreshes are single-flight and queue a post-mutation follow-up pass');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
