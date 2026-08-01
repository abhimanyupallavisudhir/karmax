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

const context = vm.createContext({
  esc: (value: unknown) => String(value),
  pipeline: () => '',
  liveRoleFor: () => 'do',
  // `cancelling` holds the tasks whose cancel click has not yet been confirmed by
  // the server; pendingCancellationView consults it on every patch.
  S: { tasks: [], cancelling: new Set() },
});
vm.runInContext(
  [
    extractFunction('patchTaskListFromEvent'),
    // patchTaskListFromEvent calls this; without it the compact-update test threw
    // a ReferenceError from inside the vm rather than exercising the labels.
    extractFunction('pendingCancellationView'),
    extractFunction('waitingProviderLabel'),
    extractFunction('waitingLabel'),
    extractFunction('waitingText'),
    extractFunction('stageLabel'),
    extractFunction('runSubRow'),
    extractFunction('runPageRow'),
    extractFunction('conversationPresence'),
  ].join('\n'),
  context,
);

const stageLabel = context.stageLabel as (view: Record<string, any>) => string;
const waitingText = context.waitingText as (wait: Record<string, any>) => string;
const runSubRow = context.runSubRow as (run: Record<string, any>) => string;
const runPageRow = context.runPageRow as (run: Record<string, any>) => string;
const conversationPresence = context.conversationPresence as (
  view: Record<string, any>,
  turn: Record<string, any>,
) => { label: string; tone: string };
const patchTaskListFromEvent = context.patchTaskListFromEvent as (event: Record<string, any>) => boolean;

describe('waiting labels in task summaries', () => {
  it('shows the wait reason instead of the pipeline stage', () => {
    expect(stageLabel({
      stage: 'do',
      status: 'waiting',
      state: {},
      waitingFor: { kind: 'account', provider: 'claude' },
    })).toBe('Waiting for a Claude login to become available');
  });

  it('normalizes both complete wait details and noun-phrase details', () => {
    expect(waitingText({
      kind: 'agentSlot',
    })).toBe('Starting agent');
    expect(waitingText({
      kind: 'agentSlot',
      detail: 'Starting agent',
    })).toBe('Starting agent');
    expect(waitingText({
      kind: 'agentSlot',
      detail: 'Waiting for host capacity to run the agent',
    })).toBe('Waiting for host capacity to run the agent');
    expect(waitingText({
      kind: 'shell',
      detail: '2 background jobs still running',
    })).toBe('Waiting for 2 background jobs still running');
    expect(waitingText({
      kind: 'mergeSlot',
      detail: 'Waiting to merge into main',
    })).toBe('Waiting to merge into main');
  });

  it('keeps ordinary and legacy merge-stage labels intact', () => {
    expect(stageLabel({ stage: 'do', state: {} })).toBe('do');
    expect(stageLabel({ stage: 'merge', state: { mergeGranted: false } })).toBe('merge queued');
    expect(stageLabel({ stage: 'setup', state: { draft: true } })).toBe('draft');
  });

  it('uses the shared wait label in repeatable-run summaries', () => {
    const run = {
      id: 'run-1',
      title: 'Scheduled task',
      createdAt: 0,
      lastView: {
        stage: 'do',
        status: 'waiting',
        state: {},
        waitingFor: { kind: 'parent' },
      },
    };
    expect(runSubRow(run)).toContain('Waiting for the parent task to respond');
    expect(runPageRow(run)).toContain('Waiting for the parent task to respond');
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
    ).label).toBe('Waiting for host capacity to start agent');
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
    expect(stageLabel(view)).toBe('Starting agent');
  });
});
