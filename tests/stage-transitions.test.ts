import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxApi } from '../src/platform/api.js';
import type { TaskView } from '../src/domain/types.js';
import { QRY_ACCOUNT_TASK_LEASES, QRY_AGENT_QUEUE } from '../src/coordinators/names.js';

function fixture() {
  const store = new Store(':memory:');
  store.claimPersonalOrganization('test');
  const project = store.createProject('Transitions', { repos: ['/tmp'], defaultBase: 'main', defaultTarget: 'main' });
  const tokens = new TokenAuthority();
  const token = tokens.mintPrincipal('user:test', ['*'], project.id).token;
  const starts: Array<{ type: string; options: any }> = [];
  const terminated: string[] = [];
  const signalled: Array<{ id: string; signal: string; args: unknown[] }> = [];
  const hiddenTurnIds = ['hidden-account-turn'];
  const client = {
    workflow: {
      getHandle(id: string) {
        return {
          async terminate(reason: string) { terminated.push(`${id}:${reason}`); },
          async signal(signal: string, ...args: unknown[]) { signalled.push({ id, signal, args }); },
          async executeUpdate(_name: string, options: { args: [string] }) {
            return { workflow: options.args[0] };
          },
          async query(name: string) {
            if (name === QRY_AGENT_QUEUE)
              return { queue: [{ taskId: task.id, turnId: 'hidden-agent-turn' }], current: [] };
            if (name === QRY_ACCOUNT_TASK_LEASES) return hiddenTurnIds;
            throw new Error('no live query');
          },
        };
      },
      async signalWithStart(_type: string, options: any) {
        signalled.push({ id: options.workflowId, signal: options.signal, args: options.signalArgs });
      },
      async start(type: string, options: any) {
        starts.push({ type, options });
        return {};
      },
    },
  } as any;
  const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens });
  const task = store.createTask({
    projectId: project.id,
    title: 'Move me',
    workflow: 'software-dev',
    workflowVersion: '1.4.0',
    params: { prompt: 'work', base: 'main', target: 'main' },
  });
  const view: TaskView = {
    taskId: task.id,
    title: task.title,
    workflow: task.workflow,
    stage: 'do',
    status: 'active',
    messages: [{ id: 'm0', role: 'user', text: 'work', ts: 0 }],
    actions: [],
    state: { turnsSeen: 1 },
    base: 'main',
    targetBranch: 'main',
    updatedAt: 1,
  };
  store.saveView(task.id, view);
  return { store, project, token, api, task, view, starts, terminated, signalled };
}

describe('task stage transitions', () => {
  it('advertises human hold, destructive Draft, and reversible Done before Jayadratha', async () => {
    const f = fixture();
    const view = await f.api.getTaskView(f.token, f.task.id);
    expect(view?.stageTransitions?.map((move) => move.target)).toEqual(['human', 'draft', 'done']);

    f.store.claimAttempt(f.task.id);
    const committed = await f.api.getTaskView(f.token, f.task.id);
    expect(committed?.stageTransitions?.map((move) => move.target)).toEqual(['human', 'done']);
  });

  it('stops activity for manual Done and restores the exact origin on the latest workflow', async () => {
    const f = fixture();
    const done = await f.api.moveTaskStage(f.token, f.task.id, 'done');
    expect(done).toMatchObject({
      stage: 'done',
      status: 'done',
      state: { manuallyDoneFrom: 'do' },
      stageTransitions: [{ target: 'do' }],
    });
    expect(f.terminated[0]).toMatch(/marked done manually/);

    const restored = await f.api.moveTaskStage(f.token, f.task.id, 'do');
    expect(f.starts).toHaveLength(1);
    expect(f.starts[0]!.type).toBe('softwareDev@1.9.0');
    expect(f.starts[0]!.options.args[0].recovery).toMatchObject({ resumeStage: 'do', messages: f.view.messages });
    expect(restored).toMatchObject({ stage: 'do', status: 'active' });
  });

  it('restores cancellation to its remembered stage and supports a cross-cutting human hold', async () => {
    const f = fixture();
    f.store.saveView(f.task.id, {
      ...f.view,
      stage: 'cancelled',
      status: 'cancelled',
      state: { ...f.view.state, cancelled: true, cancelledFrom: 'review' },
    });
    const cancelled = await f.api.getTaskView(f.token, f.task.id);
    expect(cancelled?.stageTransitions?.map((move) => move.target)).toEqual(['review', 'draft', 'done']);

    const restored = await f.api.moveTaskStage(f.token, f.task.id, 'review');
    expect(restored).toMatchObject({ stage: 'review', status: 'active' });
    expect(f.starts[0]!.options.args[0].recovery).toMatchObject({ resumeStage: 'review' });

    const held = await f.api.moveTaskStage(f.token, f.task.id, 'human');
    expect(held).toMatchObject({
      stage: 'review',
      status: 'waiting',
      waitingFor: { kind: 'human' },
    });
    expect(held.stageTransitions?.map((move) => move.target)).toEqual(['review', 'draft', 'done']);
    expect(f.terminated).toHaveLength(1);

    const doneFromHold = await f.api.moveTaskStage(f.token, f.task.id, 'done');
    expect(doneFromHold.state.manuallyDoneFrom).toBe('human');
    expect(doneFromHold.stageTransitions?.map((move) => move.target)).toEqual(['human']);
    const restoredHold = await f.api.moveTaskStage(f.token, f.task.id, 'human');
    expect(restoredHold).toMatchObject({ stage: 'review', status: 'waiting', waitingFor: { kind: 'human' } });
    expect(f.starts.at(-1)!.options.args[0].recovery).toMatchObject({ resumeStage: 'review', pausedForHuman: true });
  });

  it('treats follow-up and Confirm as input that releases a human hold', async () => {
    const follow = fixture();
    follow.store.saveView(follow.task.id, {
      ...follow.view,
      status: 'waiting',
      waitingFor: { kind: 'human', audience: ['@creator'] },
      actions: [{ name: 'followUp', kind: 'signal', label: 'Send follow-up', enabled: true }],
      state: { ...follow.view.state, humanPauseOrigin: 'review' },
      stage: 'review',
    });

    const message = await follow.api.signalTask(follow.token, follow.task.id, 'followUp', 'Please revise this.', 'do');
    expect(message?.text).toBe('Please revise this.');
    expect(follow.starts.at(-1)!.options.args[0].recovery).toMatchObject({ resumeStage: 'do' });
    expect(follow.starts.at(-1)!.options.args[0].recovery.messages.at(-1)).toMatchObject({ text: 'Please revise this.' });
    expect(follow.signalled).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: expect.stringContaining('agent-queue'), signal: 'cancelAgentSlot', args: [{ taskId: follow.task.id, turnId: 'hidden-agent-turn' }] }),
      expect.objectContaining({ id: expect.stringContaining('account-coordinator'), signal: 'cancelAccountLease', args: [{ taskId: follow.task.id, turnId: 'hidden-account-turn' }] }),
    ]));

    const confirm = fixture();
    confirm.store.saveView(confirm.task.id, {
      ...confirm.view,
      status: 'waiting',
      waitingFor: { kind: 'human', audience: ['@creator'] },
      actions: [{ name: 'confirm', kind: 'signal', label: 'Confirm', enabled: true }],
      state: { ...confirm.view.state, humanPauseOrigin: 'review' },
      stage: 'review',
    });
    await confirm.api.signalTask(confirm.token, confirm.task.id, 'confirm');
    expect(confirm.starts.at(-1)!.options.args[0].recovery).toMatchObject({ resumeStage: 'pr' });
  });

  it('resumes a held Do task when Goal mode supplies autonomous direction', async () => {
    const f = fixture();
    f.store.saveView(f.task.id, {
      ...f.view,
      status: 'waiting',
      waitingFor: { kind: 'human', audience: ['@creator'] },
      workflowOptions: ['software-dev', 'goal'],
      workflowSwitchable: true,
      state: { ...f.view.state, humanPauseOrigin: 'do' },
    });

    await f.api.changeWorkflow(f.token, f.task.id, 'goal');

    expect(f.starts.at(-1)!.type).toBe('goal@1.9.0');
    expect(f.starts.at(-1)!.options.args[0]).toMatchObject({ recovery: { resumeStage: 'do' } });
    expect(f.starts.at(-1)!.options.args[0].recovery.messages.at(-1).text).toMatch(/continue autonomously/i);
    expect(f.store.getTask(f.task.id)?.workflow).toBe('goal');
  });

  it('offers held Merge input only on the Merge conversation', async () => {
    const f = fixture();
    f.store.saveView(f.task.id, {
      ...f.view,
      stage: 'merge',
      status: 'waiting',
      waitingFor: { kind: 'human', audience: ['@creator'] },
      transcripts: [
        { role: 'do', label: 'Do agent', messages: f.view.messages },
        { role: 'merge', label: 'Merge agent', messages: [{ id: 'merge-1', role: 'agent', text: 'conflict', ts: 1 }] },
      ],
      actions: [{ name: 'cancel', kind: 'signal', label: 'Cancel', enabled: true }],
      state: { ...f.view.state, humanPauseOrigin: 'merge' },
    });

    const held = await f.api.getTaskView(f.token, f.task.id);
    expect(held?.actions.map((action) => action.name)).toEqual(['followUp', 'cancel']);
    expect(held?.actions[0]?.roles).toEqual(['merge']);
    await expect(f.api.signalTask(f.token, f.task.id, 'followUp', 'wrong agent', 'do'))
      .rejects.toThrow(/waiting on the merge agent/i);
  });

  it('falls back to the Do conversation when the held stage never ran an agent', async () => {
    // Task #350 was paused during `merge` while still queued for its slot, so the
    // merge agent had never run and there was no merge transcript. The hold then
    // resolved to no conversation at all: `followUp` was filtered out and nothing
    // spliced back, leaving a task with 13 hours of Do context and no way to say
    // anything to it — Cancel was the only action. Do always exists once a task
    // has worked, and it owns the context the follow-up is about.
    const f = fixture();
    f.store.saveView(f.task.id, {
      ...f.view,
      stage: 'merge',
      status: 'waiting',
      waitingFor: { kind: 'human', audience: ['@creator'] },
      transcripts: [{ role: 'do', label: 'Do agent', messages: f.view.messages }],
      actions: [{ name: 'cancel', kind: 'signal', label: 'Cancel', enabled: true }],
      state: { ...f.view.state, humanPauseOrigin: 'merge' },
    });

    const held = await f.api.getTaskView(f.token, f.task.id);
    expect(held?.actions.map((action) => action.name)).toEqual(['followUp', 'cancel']);
    expect(held?.actions[0]?.roles).toEqual(['do']);
    await expect(f.api.signalTask(f.token, f.task.id, 'followUp', 'redirect this', 'do'))
      .resolves.toBeDefined();
  });

  it('does not advertise a lossy human hold from the internal Resolve frame', async () => {
    const f = fixture();
    f.store.saveView(f.task.id, {
      ...f.view,
      stage: 'resolve',
      status: 'active',
      transcripts: [
        { role: 'do', label: 'Do agent', messages: f.view.messages },
        { role: 'resolve', label: 'Resolve agent', messages: [{ id: 'resolve-1', role: 'agent', text: 'repairing', ts: 1 }] },
      ],
    });

    const resolving = await f.api.getTaskView(f.token, f.task.id);
    expect(resolving?.stageTransitions?.map((move) => move.target)).toEqual(['draft', 'done']);
  });

  it('moves a draft to Done and back without starting an execution', async () => {
    const f = fixture();
    f.store.updateTaskParams(f.task.id, { ...f.task.params, draft: true });
    const done = await f.api.moveTaskStage(f.token, f.task.id, 'done');
    expect(done.state.manuallyDoneFrom).toBe('draft');
    expect(f.starts).toHaveLength(0);

    const draft = await f.api.moveTaskStage(f.token, f.task.id, 'draft');
    expect(draft).toMatchObject({ stage: 'setup', state: { draft: true } });
    expect(f.store.getTask(f.task.id)?.params.draft).toBe(true);
  });

  it('makes destructive Draft reset a one-shot input to the next Setup', async () => {
    const f = fixture();
    const draft = await f.api.moveTaskStage(f.token, f.task.id, 'draft');
    expect(draft.state.draft).toBe(true);
    expect(f.store.getTask(f.task.id)?.params._discardProgress).toBe(true);

    await f.api.moveTaskStage(f.token, f.task.id, 'do');
    expect(f.starts[0]!.options.args[0].discardProgress).toBe(true);
    expect(f.store.getTask(f.task.id)?.params._discardProgress).toBeUndefined();
  });
});
