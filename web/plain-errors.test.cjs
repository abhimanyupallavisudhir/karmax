// People read what happened and what to do; the exact text stays available.
// Run: node web/plain-errors.test.cjs
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
function extract(name, kind = 'function') {
  const start = kind === 'function' ? src.indexOf(`function ${name}(`) : src.indexOf(`const ${name} = `);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  const open = src.indexOf(kind === 'function' ? '{' : '[', start);
  for (let i = open; i < src.length; i++) {
    if ('{['.includes(src[i])) depth++;
    else if ('}]'.includes(src[i]) && --depth === 0) return src.slice(start, i + 1) + (kind === 'function' ? '' : ';');
  }
  throw new Error(`unterminated ${name}`);
}
global.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
eval(`${extract('CAPABILITY_ACTIONS', 'const')}; global.CAPABILITY_ACTIONS = CAPABILITY_ACTIONS;`);
global.globalRoute = () => '/org/settings';
for (const fn of ['permissionSentence', 'plainError', 'plainTaskError', 'toolsDidNotStart', 'setupFix', 'setupFixHtml', 'taskErrorHtml']) eval(`global.${fn} = ${extract(fn)}`);

let passed = 0;
const eq = (actual, expected, label) => { assert.strictEqual(actual, expected, label); passed++; };

// Requests the browser could not make, or the server could not answer.
eq(plainError(new TypeError('Failed to fetch')), 'Can’t reach tavya. Check your internet connection and try again.', 'Chrome network failure');
eq(plainError('NetworkError when attempting to fetch resource.'), 'Can’t reach tavya. Check your internet connection and try again.', 'Firefox network failure');
eq(plainError('HTTP 502'), 'tavya is busy or restarting. Try again in a moment.', 'proxy 502');
eq(plainError('runtime is not ready'), 'tavya is busy or restarting. Try again in a moment.', 'booting runtime');
eq(plainError('HTTP 500'), 'Something went wrong on our side. Try again in a moment.', 'bare 500');
eq(plainError('unauthorized'), 'You were signed out. Sign in again to continue.', 'signed out');
eq(plainError('too many requests; try again later'), 'Too many requests at once. Wait a few seconds and try again.', '429');
eq(plainError('upload too large (> 2097152 bytes)'), 'That file is too big. The limit is 2 MB.', '413 names the limit');
eq(plainError('Workflow Update failed'), 'This task couldn’t take that change just now. Refresh the page and try again.', 'Temporal update');

// Permission refusals name the action and who can help, never capability ids.
const refused = 'missing capability task:create in project "Web" (proj_abc) of organization "Acme" (org_1). Your authorization there is Viewer; Developer and above have it. Ask for it with request_permission (capabilities: ["task:create"]).';
eq(plainError(refused), 'You don’t have permission to start tasks here. Ask an admin to make you a Developer.', 'route refusal');
eq(plainError({ message: 'denied: review:approve', code: 'capability_denied' }), 'You don’t have permission to approve work here. Ask an admin for access.', 'API refusal');
eq(plainError('missing capability organization:edit across the installation. Your authorization there is Developer; Administrator and above have it.'),
  'You don’t have permission to change this organization. Ask an admin to make you an Administrator.', 'article follows the role');

// Messages already meant for people pass through, minus agent plumbing.
eq(plainError('Project name is required'), 'Project name is required', 'plain message unchanged');
eq(plainError('Activity task failed → Repository acme/web is archived'), 'Repository acme/web is archived', 'activity prefix dropped');
eq(plainError('GitHub can’t see task_abc1 (repo_x9y8)'), 'GitHub can’t see task_abc1', 'internal ids dropped');
eq(plainError(''), 'Something went wrong. Try again.', 'empty');
eq(plainError('Repository creation failed: name already exists on this account'),
  'A GitHub repository with that name already exists. Choose another name, or add the existing one from the list.', 'existing repo name');

// GitHub's raw answers, as the server passes them through, read as words.
eq(plainError('GitHub API 403: {"message":"Resource not accessible by integration","documentation_url":"https://docs.github.com/rest/repos/repos#create-a-repository-for-the-authenticated-user","status":"403"}'),
  'tavya’s GitHub app isn’t allowed to do that. An admin of that GitHub account may need to approve its permissions on GitHub.', 'integration refusal');
eq(plainError('GitHub API 502: <html>Bad gateway</html>'), 'GitHub isn’t responding right now. Try again in a moment.', 'GitHub outage');
eq(plainError('GitHub API 422: {"message":"Validation Failed","errors":[]}'), 'GitHub said: Validation Failed', 'other refusals keep only the message');

// Task failures: a plain summary, with the exact text kept as details.
const oom = plainTaskError('Activity task failed → agent turn interrupted by SIGKILL: host out of memory — the agent was likely killed by the OS OOM killer');
eq(oom.summary, 'The task’s computer ran out of memory. Retry, or choose a bigger computer in Parameters.', 'OOM summary');
assert.match(oom.detail, /SIGKILL/); passed++;
const retrying = plainTaskError('infrastructure: Activity task failed → Claude Agent SDK stream ended unexpectedly without a successful result event — retrying do in 30s (1/5)');
eq(retrying.summary, 'The connection to the AI model dropped. Retry usually fixes this. tavya will try again in 30s (attempt 1 of 5).', 'retry is said in words');
eq(plainTaskError('Activity task failed → Sandbox is probably not running anymore').summary, 'The task’s computer stopped responding. Retry usually fixes this.', 'sandbox');
eq(plainTaskError('… the conversation is larger than the model\'s context window even in a fresh session').summary,
  'The conversation grew too long for the AI model. Send a shorter message, or start a new task.', 'context window');
eq(plainTaskError('Out of disk: this task\'s computer filled its 20 GB disk. Bigger disk fixes it (POST /api/tasks/task_1/bigger-disk). Last error: ENOSPC').summary,
  'Out of disk: this task\'s computer filled its 20 GB disk. Bigger disk fixes it.', 'disk keeps its own words, minus the API path');
const plain = plainTaskError('GitHub account octo can’t see acme/web. Ask an admin of acme/web to add octo as a collaborator, then Retry.');
eq(plain.detail, '', 'nothing hidden when the summary is the message');
assert.ok(!taskErrorHtml(plain.summary).includes('<details'), 'no Details fold without details'); passed++;
assert.ok(taskErrorHtml('No computer is connected: connect one under Settings → Computers.').includes('<a class="btn sm setup-fix" data-spa href="/org/settings#settings-computers">Connect a computer</a>'), 'a setting that unblocks the task is one click away'); passed++;
assert.ok(taskErrorHtml('Activity task failed → envd timeout').includes('<details class="error-details"><summary>Details</summary>'), 'Details fold holds the exact text'); passed++;

// A tool that did not start (DharmaArtha's #5): said in words, never "Check Agent tools settings".
for (const raw of ['Activity task failed → MCP connections could not start: chrome-devtools (failed). Check Agent tools settings.',
  "The agent's tools didn't start: chrome-devtools (failed), linear (needs-auth)"]) {
  const tools = plainTaskError(raw);
  assert.match(tools.summary, /^The agent’s tools didn’t start \((chrome-devtools|chrome-devtools, linear)\)\. Retry carries on without them/, raw); passed++;
  assert.ok(!/Check Agent tools settings/.test(tools.summary)); passed++;
}
// An error with nothing more specific to say suggests Retry; one with its own fix or advice does not.
assert.ok(taskErrorHtml('Activity task failed → something unexpected').includes('something unexpected. Press Retry to try again.'), 'generic errors suggest Retry'); passed++;
assert.ok(!taskErrorHtml('No computer is connected: connect one under Settings → Computers.').includes('Press Retry'), 'a setting is the fix, not Retry'); passed++;
assert.ok(!taskErrorHtml('Activity task failed → stream ended unexpectedly').includes('Press Retry to try again'), 'specific advice stays as written'); passed++;

// pramana#155 (2026-11-01): another operation held the task's computer past the wait.
assert.match(plainTaskError('Could not publish resources: file lock admission timed out Nothing was lost; Retry publishes again.').summary,
  /^The task’s computer was busy with another operation \(starting, saving or parking it\)\. Retry usually fixes this\.$/); passed++;

console.log(`${passed} passed, 0 failed`);
