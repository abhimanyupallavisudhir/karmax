// A task's status is a glyph and its label, coloured by who has the ball, and
// never a pill (pills are tags). The sidebar marks a project with a box.
// Screens: design/project-icon-status/shoot.cjs. Run: node web/task-status.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const css = fs.readFileSync(`${__dirname}/styles.css`, 'utf8');
function fn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const open = src.indexOf('{', start);
  for (let i = open, depth = 0; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}
const ctx = vm.createContext({ esc: (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'), ACCOUNT_PROVIDER_LABELS: { claude: 'Claude' } });
vm.runInContext([src.match(/const PARKED_WAITS = [^\n]*/)[0],
  ...['accountWaitReason', 'waitingLabel', 'waitDeadline', 'waitingText', 'stageLabel', 'statusTone', 'statusHtml', 'viewStatusHtml'].map(fn)].join('\n'), ctx);
const label = (html) => [...html.matchAll(/class="status-label">([^<]*)</g)].map((m) => m[1]);

test('the colour says who has the ball', () => {
  const tone = (v) => ctx.statusTone(v);
  // An agent working, at any stage, and through a passing wait inside one.
  assert.equal(tone({ stage: 'do', status: 'active' }), 'working');
  assert.equal(tone({ stage: 'merge', status: 'active' }), 'working');
  assert.equal(tone({ stage: 'do', status: 'waiting', waitingFor: { kind: 'agentSlot' } }), 'working');
  assert.equal(tone({ stage: 'merge', status: 'waiting', waitingFor: { kind: 'github', detail: 'checks' } }), 'working');
  // A person asked for something.
  assert.equal(tone({ stage: 'review', status: 'waiting', waitingFor: { kind: 'human' } }), 'human');
  assert.equal(tone({ stage: 'review', status: 'waiting', waitingFor: { kind: 'confirm' } }), 'human');
  assert.equal(tone({ stage: 'escalated', status: 'blocked' }), 'human');
  assert.equal(tone({ stage: 'do', status: 'waiting', waitingFor: { kind: 'account', reason: 'login' } }), 'human', 'a missing login needs a person');
  // Nobody yet: time, quota, a job, a retry, other tasks.
  for (const waitingFor of [{ kind: 'timer' }, { kind: 'job', summary: 'render' }, { kind: 'subtask' }, { kind: 'retry' }, { kind: 'account', reason: 'quota' }])
    assert.equal(tone({ stage: 'do', status: 'waiting', waitingFor }), 'waiting', JSON.stringify(waitingFor));
  // Over.
  assert.equal(tone({ stage: 'done', status: 'done' }), 'done');
  assert.equal(tone({ stage: 'failed', status: 'failed' }), 'failed');
  assert.equal(tone({ stage: 'do', status: 'waiting', waitingFor: { kind: 'human', reason: 'error' } }), 'failed', 'stopped on an error');
  assert.equal(tone({ stage: 'do', status: 'active', outOfDisk: true }), 'failed');
  assert.equal(tone({ stage: 'cancelled', status: 'cancelled' }), 'stopped');
  assert.equal(tone({ stage: 'setup', state: { draft: true } }), 'draft');
  assert.equal(tone(undefined), 'working');
});

test('a status is a glyph and its label, never a chip', () => {
  const html = ctx.statusHtml('Needs input', 'human', { title: 'Waiting for "you"', className: 'attention escalated' });
  assert.match(html, /^<span class="status human attention escalated" title="Waiting for &quot;you&quot;"><svg [^>]*aria-hidden="true">/);
  assert.deepEqual(label(html), ['Needs input']);
  assert.doesNotMatch(html, /\bchip\b/);
  assert.match(ctx.statusHtml('Odd', 'nonsense'), /class="status working"/, 'an unknown tone falls back to working');
  for (const tone of ['working', 'human', 'waiting', 'done', 'failed', 'stopped', 'draft'])
    assert.match(ctx.statusHtml('x', tone), new RegExp(`class="status ${tone}"><svg`), tone);
});

test('a pending approval is said once', () => {
  // A plain hold on a person that is really an approval reads as one.
  assert.deepEqual(label(ctx.viewStatusHtml({ stage: 'do', status: 'waiting', waitingFor: { kind: 'human' }, approvalRequests: 1 })), ['Needs approval']);
  // Otherwise it is a second ask beside what the task is doing.
  assert.deepEqual(label(ctx.viewStatusHtml({ stage: 'do', status: 'active', approvalRequests: 1 })), ['Working', 'Needs approval']);
  assert.deepEqual(label(ctx.viewStatusHtml({ stage: 'do', status: 'active' })), ['Working']);
});

test('no task status is drawn as a pill any more', () => {
  for (const legacy of ['chip ${status}', 'chip approval-needed">approval needed', 'chip approval-needed">Approval needed', 'class="chip attention', 'awaitingApprovalChip'])
    assert.ok(!src.includes(legacy), `still renders ${legacy}`);
  assert.match(css, /\.status\.human \{ --status: var\(--working\)/, 'a person’s turn is amber in every look');
  assert.match(css, /\.status:is\(\.working, \.waiting\) \{ --status: var\(--accent\)/, 'a task carrying on by itself is accent, waiting or not');
  assert.doesNotMatch(css, /\.status\.waiting \{[^}]*ink-3|\.seg\.current\.waiting \{ background: var\(--ink-3\)/, 'waiting is never grey like a draft');
  assert.match(css, /\.pipeline \.seg\.current\.working \{ animation: pulse/, 'only working pulses: a wait is the same colour, still');
});

test('a project is marked with a box, not a checklist', () => {
  const icon = src.match(/^ {2}project: '(<svg[^']*)',$/m)?.[1];
  assert.ok(icon, 'ICON.project exists');
  assert.ok(icon.includes('m3.3 7 8.7 5 8.7-5'), 'the box’s lid');
  assert.ok(!icon.includes('m3 6 1.5 1.5'), 'no checkmarks');
});
