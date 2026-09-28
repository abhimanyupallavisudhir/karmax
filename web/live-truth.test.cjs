// Regressions for three ways the console used to show something untrue.
//
//  1. A failed search rendered the "No matching tasks" empty state, so a server
//     outage read as a bad query and the user edited a perfectly good one.
//  2. The check-in pane printed the raw waitingFor discriminant — "Waiting for
//     mergeSlot" — in the one place a user watches for progress.
//  3. The task list printed the raw workflow id ("software-dev") while the
//     composer and the task page both print the label ("Software dev").
//
// Run: node web/live-truth.test.cjs
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function extractFn(name) {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0;
  const body = src.indexOf('{', start);
  for (let i = body; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}
function extractConst(name) {
  const start = src.indexOf(`const ${name} =`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = src.indexOf(';', start);
  return src.slice(start, end + 1).replace(/^const /, '');
}

// ── 1. waiting labels never leak the internal enum ───────────────────────────
{
  const ctx = {};
  const code = [
    extractFn('waitingLabel'),
    extractFn('waitingText'),
    extractFn('conversationPresence'),
    // Stubbed: the real one walks the transcript list, which isn't what's under
    // test here — we only need it to agree that "do" is the live role.
    'function liveRoleFor() { return "do"; }',
    'ctx.conversationPresence = conversationPresence; ctx.waitingText = waitingText;',
  ].join('\n');
  new Function('ctx', code)(ctx);

  // Every coordinator wait a user can actually sit behind.
  const concise = {
    mergeSlot: 'Waiting to merge',
    agentSlot: 'Waiting for agent',
    account: 'Waiting for credential',
    subtask: 'Waiting for sub-tasks',
    collaboration: 'Waiting for collaborator',
    confirm: 'Waiting for review',
    responder: 'Waiting for responder',
    human: 'Needs input',
  };
  for (const kind of Object.keys(concise)) {
    const view = { waitingFor: { kind }, agentTurn: undefined, status: 'active', stage: 'do', roles: ['do'] };
    const label = ctx.conversationPresence(view, { role: 'do' }).label;
    assert.strictEqual(label, concise[kind]);
    assert.ok(!/[a-z][A-Z]/.test(label),
      `check-in pane leaked a camelCase enum: ${label}`);
    assert.ok(/^(Waiting|Starting|Needs)/.test(label), `unexpected presence label for ${kind}: ${label}`);
  }
  // Detailed workflow diagnostics do not spill into compact status labels.
  const detailed = ctx.conversationPresence(
    { waitingFor: { kind: 'human', detail: 'your approval' }, status: 'active', roles: ['do'] }, { role: 'do' });
  assert.strictEqual(detailed.label, 'Needs input');
  console.log('ok  waiting labels are human-readable in the check-in pane');
}

// ── 2. the task list uses the workflow label, like every other surface ───────
{
  const ctx = {};
  new Function('ctx', `${extractConst('WORKFLOWS')}\n${extractConst('workflowLabel')}\nctx.workflowLabel = workflowLabel;`)(ctx);
  assert.strictEqual(ctx.workflowLabel('software-dev'), 'Software dev');
  assert.strictEqual(ctx.workflowLabel('goal'), 'Goal (auto-run)');
  // Unknown/hidden workflows (just-do, script-exec are intentionally not offered
  // in the composer) fall back to the id rather than rendering blank.
  assert.strictEqual(ctx.workflowLabel('just-do'), 'just-do');

  assert.ok(!/<span class="wf">\$\{esc\(t\.workflow\)\}/.test(src),
    'task list still renders the raw workflow id; use workflowLabel(t.workflow)');
  console.log('ok  task list renders the workflow label, not the id');
}

// ── 3. a failed search is distinguishable from an empty result ───────────────
{
  assert.ok(/searchFailed: false/.test(src), 'S.searchFailed must be declared in state');
  assert.ok(/S\.searchFailed = true/.test(src), 'runSearch must flag a failed evaluation');
  assert.ok(/S\.searchFailed = false/.test(src), 'a successful evaluation must clear the flag');
  assert.ok(/Search didn.t run/.test(src), 'the failure empty-state copy is missing');
  assert.ok(/id="retry-search"/.test(src) && /#retry-search/.test(src),
    'the failure state must offer a retry that is actually wired up');

  // The "no matches" copy must be reachable only when the search really ran, so
  // the failure flag has to be the FIRST branch of the empty-state ternary.
  assert.ok(/const empty = S\.searchFailed/.test(src),
    'the empty state must test S.searchFailed before falling through to "No matching tasks"');
  console.log('ok  a failed search is not reported as "no matching tasks"');
}

// ── 4. a dropped live socket is surfaced and backfilled ──────────────────────
{
  assert.ok(/ws\.onopen/.test(src), 'no onopen handler: a reconnect cannot backfill');
  assert.ok(/wsHadDropped/.test(src), 'reconnect must know it is recovering from a gap');
  assert.ok(/id="ws-offline"/.test(src), 'no visible indication that live updates are paused');
  const onclose = src.slice(src.indexOf('ws.onclose'), src.indexOf('ws.onclose') + 160);
  assert.ok(/setWsOnline\(false\)/.test(onclose), `onclose must flag the gap: ${onclose}`);
  const css = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');
  assert.ok(/\.ws-offline/.test(css), '.ws-offline has no styling');
  console.log('ok  a dropped websocket is surfaced and backfilled on reconnect');
}

console.log('\nall live-truth regressions pass');
