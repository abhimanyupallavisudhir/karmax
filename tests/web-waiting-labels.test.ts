import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const app = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8');

function extractFunction(name: string): string {
  const start = app.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const open = app.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}' && --depth === 0) return app.slice(start, i + 1);
  }
  throw new Error(`${name} is unterminated`);
}

function extractConst(name: string): string {
  const start = app.indexOf(`const ${name} =`);
  if (start < 0) throw new Error(`${name} not found`);
  return app.slice(start, app.indexOf(';', start) + 1);
}

const context = vm.createContext({
  esc: (value: unknown) => String(value),
  pipeline: () => '',
  liveRoleFor: () => 'do',
  // `cancelling` holds the tasks whose cancel click has not yet been reflected by
  // the server; the list patcher reads it through pendingCancellationView().
  S: { tasks: [], cancelling: new Set<string>() },
});
vm.runInContext(
  [
    extractFunction('patchLifecycleView'),
    extractFunction('patchTaskListFromEvent'),
    extractFunction('pendingCancellationView'),
    extractFunction('waitingLabel'),
    extractFunction('waitingText'),
    extractFunction('waitDeadline'),
    extractFunction('agentTurnStateText'),
    extractFunction('humanWaitDetail'),
    extractFunction('conversationTextKey'),
    extractFunction('conversationInputRequest'),
    extractConst('PARKED_WAITS'),
    extractFunction('stageLabel'),
    extractFunction('runSubRow'),
    extractFunction('runPageRow'),
    extractFunction('conversationPresence'),
  ].join('\n'),
  context,
);

const stageLabel = context.stageLabel as (view: Record<string, any>) => string;
const waitDeadline = context.waitDeadline as (until: number) => string;
const waitingText = context.waitingText as (wait: Record<string, any>) => string;
const agentTurnStateText = context.agentTurnStateText as (view: Record<string, any>) => string;
const humanWaitDetail = context.humanWaitDetail as (view: Record<string, any>) => string;
const conversationInputRequest = context.conversationInputRequest as (
  view: Record<string, any>,
  entries: Array<Record<string, any>>,
) => string;
const runSubRow = context.runSubRow as (run: Record<string, any>) => string;
const runPageRow = context.runPageRow as (run: Record<string, any>) => string;
const conversationPresence = context.conversationPresence as (
  view: Record<string, any>,
  turn: Record<string, any>,
) => { label: string; tone: string };
const patchTaskListFromEvent = context.patchTaskListFromEvent as (event: Record<string, any>) => boolean;

describe('waiting labels in task summaries', () => {
  it('shows the public input stage while retaining other pipeline stages', () => {
    expect(stageLabel({
      stage: 'do',
      status: 'waiting',
      state: { humanPauseOrigin: 'do' },
      waitingFor: { kind: 'human', detail: 'The agent finished its turn.' },
    })).toBe('Needs input');
    expect(stageLabel({
      stage: 'review',
      status: 'waiting',
      state: {},
      waitingFor: { kind: 'human', detail: 'Review this proposal.' },
    })).toBe('Needs input');
    expect(stageLabel({
      stage: 'merge',
      status: 'waiting',
      state: {},
      waitingFor: {
        kind: 'human',
        summary: 'GitHub Actions approval required',
        detail: 'GitHub returned action_required for CI run 410.',
      },
    })).toBe('GitHub Actions approval required');
    // A turn parked on its credential is not working (task 384 read "working"
    // for hours behind an exhausted login).
    expect(stageLabel({
      stage: 'do',
      status: 'waiting',
      state: {},
      waitingFor: { kind: 'account', provider: 'claude', detail: 'Every allowed credential needs attention — sign in again or add one' },
    })).toBe('Waiting for credential');
    expect(stageLabel({
      stage: 'do',
      status: 'waiting',
      state: {},
      waitingFor: { kind: 'account', provider: 'codex', earliestResetAt: Date.now() + 60_000 },
    })).toBe('Waiting for quota');
    expect(stageLabel({
      stage: 'do',
      status: 'waiting',
      state: {},
      waitingFor: { kind: 'agentSlot', provider: 'claude', detail: 'Starting agent' },
    })).toBe('working');
    expect(stageLabel({
      stage: 'merge',
      status: 'waiting',
      state: { mergeGranted: false },
      waitingFor: { kind: 'github', detail: 'Waiting for CI while retaining the front landing spot.' },
    })).toBe('landing');
  });

  it.each([
    'GitHub Actions action required',
    'GitHub Actions failure needs inspection',
    'GitHub Actions inspection unavailable',
  ])('preserves the structured status %s despite misleading diagnostic text', (summary) => {
    const detail = 'tests/billing.test.ts: expected "recent account payments have failed"; requires approval';
    expect(waitingText({ kind: 'human', summary, detail })).toBe(summary);
    expect(stageLabel({ stage: 'merge', status: 'waiting', state: {},
      waitingFor: { kind: 'human', summary, detail } })).toBe(summary);
    expect(waitingText({ kind: 'human', detail })).toBe('Needs input');
  });

  it('projects verbose workflow details to short wait labels', () => {
    expect(waitingText({
      kind: 'agentSlot',
    })).toBe('Waiting for agent');
    expect(waitingText({
      kind: 'agentSlot',
      detail: 'Starting agent',
    })).toBe('Waiting for agent');
    expect(waitingText({
      kind: 'agentSlot',
      detail: 'Waiting for host capacity to run the agent',
    })).toBe('Waiting for agent');
    expect(waitingText({
      kind: 'shell',
      detail: '2 background jobs still running',
    })).toBe('Waiting for command');
    expect(waitingText({
      kind: 'mergeSlot',
      detail: 'Waiting to merge into main',
    })).toBe('Waiting to merge');
    expect(waitingText({
      kind: 'github',
      detail: 'Waiting for CI on the exact pull-request head while this task retains the front landing slot.',
    })).toBe('Waiting for CI');
    expect(waitingText({
      kind: 'human',
      detail: 'A long internal explanation of the decision needed',
    })).toBe('Needs input');
    expect(waitingText({
      kind: 'human',
      summary: '  GitHub Actions billing\n action required  ',
      detail: 'A long provider annotation and full failed-job inspection',
    })).toBe('GitHub Actions billing action required');
    expect(waitingText({
      kind: 'responder',
      detail: 'The response agent is answering the working agent',
    })).toBe('Waiting for responder');
    // Noon today: "a minute from now" is tomorrow when the suite runs at 23:59.
    const soon = new Date().setHours(12, 0, 0, 0);
    const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    // A job wait names its deadline: the agent resumes by then even if the job hangs.
    expect(waitingText({ kind: 'job', detail: 'Waiting for job-0123abcd', until: soon }))
      .toBe(`Waiting for job until ${clock(soon)}`);
    expect(waitingText({ kind: 'job', detail: 'Waiting for job-0123abcd' })).toBe('Waiting for job');
    // A job the agent named is shown by its name.
    expect(waitingText({ kind: 'job', detail: 'Waiting for job-0123abcd', summary: 'render', until: soon }))
      .toBe(`Waiting for render until ${clock(soon)}`);
    expect(waitingText({ kind: 'job', summary: 'render, test suite' })).toBe('Waiting for render, test suite');
    // A timed pause reads like every other wait with a deadline.
    expect(waitingText({ kind: 'timer', until: soon }))
      .toBe(`Waiting until ${clock(soon)}`);
    expect(waitingText({ kind: 'timer' })).toBe('Waiting');
    // An agent that paused for an answer needs input, and says when it carries on without one.
    expect(waitingText({ kind: 'human', detail: 'Which region?', until: soon }))
      .toBe(`Needs input until ${clock(soon)}`);
    // A pause may end on another day; a bare clock time would read as today.
    const later = soon + 3 * 86_400_000;
    const day = new Date(later).toLocaleDateString([], { weekday: 'short' });
    expect(waitingText({ kind: 'timer', until: later })).toContain(day);
  });

  // Task 433 read "working" for nine hours while its agent had paused itself
  // until the next morning; nothing was working, and nothing said when it would resume.
  it('shows a pause the agent chose instead of "working"', () => {
    const until = Date.now() + 525 * 60_000;
    const timer = { kind: 'timer', detail: 'Waiting 525 min', until };
    expect(stageLabel({ stage: 'do', status: 'waiting', state: {}, waitingFor: timer }))
      .toBe(waitingText(timer));
    const job = { kind: 'job', detail: 'Waiting for job-5a1d7bab', until };
    expect(stageLabel({ stage: 'do', status: 'waiting', state: {}, waitingFor: job }))
      .toBe(waitingText(job));
    expect(stageLabel({ stage: 'do', status: 'active', state: {}, waitingFor: timer })).toBe('working');
    const ask = { kind: 'human', detail: 'Which region?', audience: ['@creator'], until };
    expect(stageLabel({ stage: 'do', status: 'waiting', state: {}, waitingFor: ask }))
      .toBe(`Needs input until ${waitDeadline(until)}`);
  });

  // legibench3#18 read "working" through 23 minutes of identical infrastructure
  // failures; between attempts nothing runs, and the chip says when it will.
  it('shows when a stage that failed on infrastructure runs again, in any stage', () => {
    const until = Date.now() + 10 * 60_000;
    const retry = { kind: 'retry', detail: 'Retry 5 of 5', until };
    expect(waitingText(retry)).toBe(`Retrying at ${waitDeadline(until)}`);
    expect(waitingText({ kind: 'retry' })).toBe('Retrying');
    for (const stage of ['setup', 'do', 'review', 'merge'])
      expect(stageLabel({ stage, status: 'waiting', state: {}, waitingFor: retry })).toBe(waitingText(retry));
    context.S.tasks = [{ id: 'task-1', lastView: { stage: 'do', status: 'active' } }];
    expect(patchTaskListFromEvent({ taskId: 'task-1', type: 'view.updated',
      payload: { stage: 'do', status: 'waiting', agentTurn: null, waitingFor: 'retry', waitingUntil: until } })).toBe(true);
    expect(stageLabel(context.S.tasks[0].lastView)).toBe(`Retrying at ${waitDeadline(until)}`);
  });

  // Likewise a turn that ended to wait on other tasks: the chip names them.
  it('names the tasks a parked agent waits on', () => {
    for (const [kind, label] of [['subtask', 'Waiting for sub-tasks'], ['collaboration', 'Waiting for collaborator'], ['parent', 'Waiting for parent']]) {
      expect(stageLabel({ stage: 'do', status: 'waiting', state: {}, waitingFor: { kind } })).toBe(label);
    }
    // A sub-task asking its parent says when it carries on without an answer.
    const until = new Date().setHours(12, 0, 0, 0);
    expect(stageLabel({ stage: 'do', status: 'waiting', state: {}, waitingFor: { kind: 'parent', detail: 'Which region?', until } }))
      .toBe(`Waiting for parent until ${waitDeadline(until)}`);
    // A child held at Review for its parent is still in review.
    expect(stageLabel({ stage: 'review', status: 'waiting', state: {}, waitingFor: { kind: 'parent' } })).toBe('review');
    // Work still running inside the turn, or about to start one, is working.
    for (const kind of ['agentSlot', 'subagent', 'shell']) {
      expect(stageLabel({ stage: 'do', status: 'waiting', state: {}, waitingFor: { kind } })).toBe('working');
    }
  });

  it('keeps an actionable admission failure in the agent-turn card', () => {
    expect(agentTurnStateText({
      agentTurn: { state: 'waiting-slot' },
      waitingFor: {
        kind: 'agentSlot',
        detail: 'Free allows 1 organization user, but this organization has 2.',
      },
    })).toBe('Free allows 1 organization user, but this organization has 2.');
    expect(agentTurnStateText({ agentTurn: { state: 'waiting-slot' } }))
      .toBe('waiting for an agent slot');
    expect(agentTurnStateText({ agentTurn: { state: 'running' } })).toBe('running');
  });

  it('retains the concrete question for a targeted human hold', () => {
    expect(humanWaitDetail({
      status: 'waiting',
      waitingFor: { kind: 'human', detail: '  Choose the release window.  ' },
    })).toBe('Choose the release window.');
    expect(humanWaitDetail({
      status: 'waiting',
      waitingFor: { kind: 'agentSlot', detail: 'Internal queue detail' },
    })).toBe('');
    expect(humanWaitDetail({
      status: 'active',
      waitingFor: { kind: 'human', detail: 'Stale question' },
    })).toBe('');
  });

  it('does not repeat the visible final agent reply as an input request', () => {
    const view = {
      status: 'waiting',
      waitingFor: {
        kind: 'human',
        detail: 'The tests pass.\r\nPlease choose a release window.',
      },
    };
    expect(conversationInputRequest(view, [
      { type: 'message', message: { role: 'user', text: 'Check the release.' } },
      { type: 'activity', activity: { kind: 'message', title: 'The tests pass.\nPlease choose a release window.' } },
      { type: 'activity', activity: { kind: 'turn', title: 'Agent finished working' } },
    ])).toBe('');
  });

  it('keeps a separate targeted question in the conversation', () => {
    const view = {
      status: 'waiting',
      waitingFor: { kind: 'human', detail: 'Choose the release window.' },
    };
    expect(conversationInputRequest(view, [
      { type: 'message', message: { role: 'agent', text: 'The release build is ready.' } },
    ])).toBe('Choose the release window.');
    expect(conversationInputRequest(view, [])).toBe('Choose the release window.');
  });

  it('keeps ordinary and legacy merge-stage labels intact', () => {
    expect(stageLabel({ stage: 'do', state: {} })).toBe('working');
    expect(stageLabel({ stage: 'do', status: 'active', waitingFor: { kind: 'human' }, state: {} })).toBe('working');
    expect(stageLabel({ stage: 'merge', state: { mergeGranted: false } })).toBe('landing');
    expect(stageLabel({ stage: 'setup', state: { draft: true } })).toBe('draft');
  });

  it('keeps repeatable-run summaries on their stable stage', () => {
    const run = {
      id: 'run-1',
      title: 'Scheduled task',
      createdAt: 0,
      lastView: {
        stage: 'do',
        status: 'waiting',
        state: {},
        waitingFor: { kind: 'agentSlot', detail: 'Starting agent' },
      },
    };
    expect(runSubRow(run)).toContain('<span class="chip waiting">working</span>');
    expect(runPageRow(run)).toContain('<span class="chip waiting">working</span>');
  });

  it('uses the truthful startup state in agent conversations', () => {
    expect(conversationPresence(
      { agentTurn: { role: 'do', state: 'waiting-slot' } },
      { role: 'do' },
    ).label).toBe('Starting agent');
    expect(conversationPresence(
      {
        agentTurn: { role: 'do', state: 'waiting-slot' },
        waitingFor: { detail: 'Waiting for host capacity to start agent' },
      },
      { role: 'do' },
    ).label).toBe('Waiting for progress');
  });

  it('keeps authoritative wait details in compact live task updates', () => {
    context.S.tasks = [{
      id: 'task-1',
      lastView: { stage: 'do', status: 'active' },
    }];
    expect(patchTaskListFromEvent({
      taskId: 'task-1',
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
    })).toBe(true);

    const view = context.S.tasks[0].lastView;
    expect(view.waitingFor).toEqual({
      kind: 'agentSlot',
      detail: 'Starting agent',
      provider: 'codex',
    });
    expect(stageLabel(view)).toBe('working');

    expect(patchTaskListFromEvent({
      taskId: 'task-1',
      type: 'view.updated',
      payload: {
        stage: 'merge',
        status: 'waiting',
        waitingFor: 'human',
        waitingDetail: 'GitHub annotation: Actions is disabled for this repository. Full evidence follows.',
        waitingSummary: 'GitHub Actions is disabled',
        waitingProvider: null,
        waitingResetAt: null,
        agentTurn: null,
      },
    })).toBe(true);
    expect(context.S.tasks[0].lastView.waitingFor).toEqual({
      kind: 'human',
      detail: 'GitHub annotation: Actions is disabled for this repository. Full evidence follows.',
      summary: 'GitHub Actions is disabled',
    });
    expect(stageLabel(context.S.tasks[0].lastView)).toBe('GitHub Actions is disabled');

    // A new question on the same hold is a new label, not a duplicate frame.
    expect(patchTaskListFromEvent({
      taskId: 'task-1', type: 'view.updated',
      payload: { stage: 'merge', status: 'waiting', waitingFor: 'human', waitingSummary: 'Approve the deploy?' },
    })).toBe(true);
    expect(stageLabel(context.S.tasks[0].lastView)).toBe('Approve the deploy?');
  });

  it('keeps a pause deadline in compact live task updates', () => {
    const until = new Date();
    until.setHours(23, 45, 0, 0);
    context.S.tasks = [{ id: 'task-1', lastView: { stage: 'do', status: 'active' } }];
    const pause = (payload: Record<string, unknown>) => patchTaskListFromEvent({ taskId: 'task-1', type: 'view.updated',
      payload: { stage: 'do', status: 'waiting', agentTurn: null, ...payload } });
    expect(pause({ waitingFor: 'timer', waitingUntil: until.getTime() })).toBe(true);
    expect(stageLabel(context.S.tasks[0].lastView)).toBe(`Waiting until ${waitDeadline(until.getTime())}`);
    expect(pause({ waitingFor: 'job', waitingUntil: until.getTime() + 60_000 })).toBe(true);
    expect(stageLabel(context.S.tasks[0].lastView)).toMatch(/^Waiting for job until /);
    expect(pause({ waitingFor: 'job', waitingSummary: 'render', waitingUntil: until.getTime() })).toBe(true);
    expect(stageLabel(context.S.tasks[0].lastView)).toMatch(/^Waiting for render until /);
    expect(pause({ waitingFor: 'human', waitingDetail: 'Which region?', waitingUntil: until.getTime() })).toBe(true);
    expect(stageLabel(context.S.tasks[0].lastView)).toBe(`Needs input until ${waitDeadline(until.getTime())}`);
  });
});
