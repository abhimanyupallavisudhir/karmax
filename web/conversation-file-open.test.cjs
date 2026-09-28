// A file-handoff permalink prepares the right local-opening primitive for the
// deployment: host materialization on a local install, portable Git checkout
// instructions on a hosted one. Run: node web/conversation-file-open.test.cjs
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function extractFn(name) {
  const start = src.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  const open = src.indexOf('{', start);
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

let pass = 0, fail = 0;
const ok = (condition, message) => condition ? pass++ : (fail++, console.error('FAIL:', message));
const requests = [];
let local = true;
global.hostLocal = () => local;
global.taskFileKey = (v, target) => `${v.taskId}/${target.path}/${local ? 'host' : 'portable'}`;
global.renderTaskFilePage = () => {};
global.api = async (...args) => {
  requests.push(args);
  return local
    ? { path: '/tmp/local/app.ts', command: "code --goto '/tmp/local/app.ts:12'", materialized: true }
    : { workspace: 'karmax-42', file: { repository: 'app', relativePath: 'src/app.ts' }, openScript: 'git clone …' };
};
global.S = { selected: 'task-cloud', taskFile: { path: '/workspace/src/app.ts', line: 12 }, taskFileLoad: null };

eval(extractFn('hydrateTaskFilePage'));

(async () => {
  const view = { taskId: 'task-cloud' };
  const target = { path: '/workspace/src/app.ts', line: 12 };
  await hydrateTaskFilePage(view, target, taskFileKey(view, target));
  ok(requests[0][0] === '/api/tasks/task-cloud/open-command', 'a local install asks the host to materialize and resolve the file');
  ok(S.taskFileLoad.status === 'ready' && S.taskFileLoad.result.materialized, 'the materialized editor command becomes the page result');

  local = false;
  S.taskFileLoad = null;
  await hydrateTaskFilePage(view, target, taskFileKey(view, target));
  ok(requests[1][0] === '/api/tasks/task-cloud/file-checkout', 'a hosted install asks for portable checkout-and-open instructions');
  ok(S.taskFileLoad.result.openScript === 'git clone …', 'the portable script becomes the page result');

  // Links minted before the view knew its wiki folder still land in the wiki.
  const navigations = [];
  global.go = (to, options) => { navigations.push([to, options]); };
  global.taskRecord = () => ({ projectId: 'project-1' });
  global.wikiRoute = (pid, view, entry) => `/${pid}/wiki?${view}#${entry}`;
  global.api = async () => ({ wiki: { path: 'reviews/2026-09-26' } });
  S.taskFileLoad = null;
  const wikiView = { taskId: 'task-cloud', num: 367 };
  const wikiTarget = { path: 'app-wiki/reviews/2026-09-26/SKILL.md' };
  await hydrateTaskFilePage(wikiView, wikiTarget, taskFileKey(wikiView, wikiTarget));
  ok(navigations.length === 1 && navigations[0][0] === '/project-1/wiki?task:367#reviews/2026-09-26' && navigations[0][1].replace,
    'a wiki file opens its entry in the wiki view, replacing the handoff page');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
