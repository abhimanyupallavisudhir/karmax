// The "Created by" line on a task's Parameters: a person (by name, or You), a
// task's agent linked to its task, an Avatār, or tavya's own automation, and
// the app or token it came through when that was not the console.
// Run: node web/task-creator.test.cjs
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  const open = src.indexOf('{', start);
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}
function extractConst(name) {
  const start = src.indexOf(`const ${name} =`);
  if (start < 0) throw new Error(`${name} not found`);
  return src.slice(start, src.indexOf(';\n', start) + 1);
}
global.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
global.S = {
  user: { id: 'me' }, meta: {}, users: [], teams: [], avatars: [],
  organizationMembers: [{ userId: 'u-ada', user: { name: 'Ada Lovelace' } }],
  tasks: [{ id: 't1', projectId: 'p1', createdAt: Date.now() - 3 * 3600_000 }],
};
global.siteName = () => 'tavya';
global.fmtAgo = () => '3h ago';
global.taskRecord = (id) => S.tasks.find((t) => t.id === id);
global.taskUrl = (id, rec) => `/acme/${rec.projectId}/tasks/${rec.num ?? id}`;
eval(`global.SYSTEM_CREATOR_LABEL = ${extractConst('SYSTEM_CREATOR_LABEL').replace(/^const SYSTEM_CREATOR_LABEL =/, '')}`);
for (const fn of ['principalLabel', 'agentRoleLabel', 'numberedTaskTitle', 'taskCreatorHtml']) eval(`global.${fn} = ${extractFn(fn)}`);

let pass = 0;
let fail = 0;
const ok = (condition, message) => condition ? pass++ : (fail++, console.error('FAIL:', message));
const text = (html) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const view = (creator) => ({ taskId: 't1', creator });

ok(taskCreatorHtml(view(undefined)) === '', 'no creator recorded (older tasks): no line');

const person = taskCreatorHtml(view({ createdBy: { kind: 'user', userId: 'u-ada' } }));
ok(text(person) === 'Created by Ada Lovelace 3h ago', `a member by name: ${text(person)}`);
ok(!person.includes('via'), 'the console is not named');
ok(/<time [^>]*datetime=/.test(person), 'when, with the exact time on hover');

ok(text(taskCreatorHtml(view({ createdBy: { kind: 'user', userId: 'me' } }))).startsWith('Created by You'), 'the reader is You');

const cli = taskCreatorHtml(view({ createdBy: { kind: 'user', userId: 'u-ada' }, via: { kind: 'cli', grantId: 'g1', name: 'ada-laptop' } }));
ok(text(cli) === 'Created by Ada Lovelace via ada-laptop 3h ago', `through a CLI login: ${text(cli)}`);
ok(cli.includes('title="Signed-in CLI"'), 'what kind of credential, on hover');
ok(taskCreatorHtml(view({ createdBy: { kind: 'user', userId: 'u-ada' }, via: { kind: 'token', grantId: 'g2', name: 'CI' } })).includes('title="Personal access token"'), 'a personal token says so');
ok(taskCreatorHtml(view({ createdBy: { kind: 'user', userId: 'u-ada' }, via: { kind: 'mcp', grantId: 'g3', name: 'Claude Code' } })).includes('via Claude Code'), 'an MCP app by its name');

const agent = taskCreatorHtml(view({ createdBy: { kind: 'task-agent', taskId: 'src', role: 'do' },
  task: { id: 'src', projectId: 'p2', num: 812, title: 'Plan <launch>' } }));
ok(text(agent) === 'Created by Agent of #812 Plan &lt;launch&gt; 3h ago', `an agent, of its task: ${text(agent)}`);
ok(agent.includes('<a data-spa href="/acme/p2/tasks/812">#812 Plan &lt;launch&gt;</a>'), 'linked to that task (escaped)');
ok(text(taskCreatorHtml(view({ createdBy: { kind: 'task-agent', taskId: 'src', role: 'responder' },
  task: { id: 'src', projectId: 'p2', num: 3, title: 'X' } }))).startsWith('Created by responder agent of #3 X'), 'another role is named');

const hidden = taskCreatorHtml(view({ createdBy: { kind: 'task-agent', taskId: 'src', role: 'do' } }));
ok(text(hidden) === 'Created by Agent 3h ago' && !hidden.includes('<a '), 'a task the reader may not read is neither named nor linked');

const avatar = taskCreatorHtml(view({ createdBy: { kind: 'avatar', avatarId: 'av' }, task: { id: 'av', projectId: 'p1', num: 5, title: 'Ops' } }));
ok(text(avatar).startsWith('Created by Avatār #5 Ops') && avatar.includes('href="/acme/p1/tasks/5"'), `an Avatār, linked: ${text(avatar)}`);

const trigger = taskCreatorHtml(view({ via: { kind: 'system', principal: 'system:triggers' } }));
ok(text(trigger) === 'Created by tavya via Trigger 3h ago', `tavya's automation: ${text(trigger)}`);
ok(text(taskCreatorHtml(view({ createdBy: { kind: 'user', userId: 'u-ada' }, via: { kind: 'system', principal: 'system:triggers' } })))
  === 'Created by Ada Lovelace via Trigger 3h ago', 'a run its series\' creator set up, started by a trigger');

ok(text(taskCreatorHtml(view({ via: { kind: 'cli', grantId: 'g', name: 'laptop' } }))) === 'Created by Someone via laptop 3h ago',
  'a person not recorded (outside the organization) is not passed off as tavya');
ok(src.includes('${taskCreatorHtml(v)}'), 'Parameters shows it');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
