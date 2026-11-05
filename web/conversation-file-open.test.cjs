// A file an agent cites (/tasks/<n>/file?path=…&line=…) opens in Files, in its
// task's view, at the cited line; a path the server cannot place goes back to
// the task and says why. Run: node web/conversation-file-open.test.cjs
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
const requests = [], navigations = [], toasts = [];
global.renderRouteLoadingPage = () => {};
global.toast = (message, error) => toasts.push([message, error]);
global.plainError = (message) => message;
global.taskUrl = (taskId) => `/org/project/tasks/${taskId}`;
global.go = (to, options) => { navigations.push([to, options]); };
global.filesRoute = (pid, filePath, view) => `/org/${pid}/files/${filePath}?${view}`;
let answer = { projectId: 'project-1', taskId: 'task-cloud', num: 42, path: 'app/src/app.ts' };
global.api = async (url) => { requests.push(url); if (answer instanceof Error) throw answer; return answer; };

eval(extractFn('openCitedFile'));

(async () => {
  await openCitedFile('task-cloud', { path: '/workspace/app/src/app.ts', line: 12 });
  ok(requests[0] === '/api/tasks/task-cloud/file-location?path=%2Fworkspace%2Fapp%2Fsrc%2Fapp.ts', 'the server places the cited path in the world');
  ok(navigations.length === 1 && navigations[0][0] === '/org/project-1/files/app/src/app.ts?task:42#L12' && navigations[0][1].replace,
    'it opens in Files, in the task’s view, at the line, replacing the permalink');

  answer = new Error('That file is outside the task’s world.');
  await openCitedFile('task-cloud', { path: '/etc/passwd' });
  ok(toasts.length === 1 && /outside/.test(toasts[0][0]) && toasts[0][1], 'a refusal is said, not swallowed');
  ok(navigations[1][0] === '/org/project/tasks/task-cloud' && navigations[1][1].replace, 'and the task opens instead');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
