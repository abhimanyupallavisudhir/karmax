import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootHarness, Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { git } from '../src/world/git.js';
import { newId } from '../src/util/id.js';

// In-flight task-parameter edits (SPEC §4.5/§5.5): a field's declared `mutable`
// window decides whether a queued task still accepts an edit. `target` is
// `preMerge` (editable until it's load-bearing); prompt/base/agents are `queue`
// (frozen once the workflow starts). The window travels into the workflow as
// `paramWindows`, and the update validator enforces it.

const view = (h: any) => h.query('view') as Promise<any>;

/** Direct workflow input, incl. the windows the assembler (assembleTaskInput) carries. */
function input(over: { taskId: string; repo: string; prompt: string; target?: string }) {
  return {
    taskId: over.taskId,
    projectId: 'p1',
    title: 'Task',
    prompt: over.prompt,
    base: 'main',
    target: over.target ?? 'main',
    project: { repos: [over.repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false },
    // A concrete Do agent so its provider is pinned (a mid-flight provider swap is
    // rejected; only model/effort retune, SPEC §5.5).
    agents: { do: { provider: 'mock' as const } },
    // target until PR/merge; every agent's model+effort is retunable in-flight
    // ('always'), while an identity swap is gated by the workflow validator (SPEC §5.5).
    paramWindows: {
      target: 'untilUsed' as const,
      'agent:do': 'always' as const,
      'agent:merge': 'always' as const,
      'agent:resolve': 'always' as const,
    },
  };
}

describe('in-flight param edits (SPEC §4.5/§5.5)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await bootHarness('mock');
  }, 60_000);
  afterAll(async () => {
    await h?.stop();
  });

  it('accepts a target edit in Review, rejects frozen fields, and merges into the NEW target', async () => {
    const repo = await h.makeRepo('paramedit');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [input({ taskId, repo, prompt: 'Add a file.\n@write feat.txt :: hello\n@review done' })],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');

    // the view advertises target + all three agents (their model/effort is retunable
    // in-flight), and NOT the fields already used (prompt, base)
    const v0 = await view(handle);
    expect(v0.editableParams).toEqual(expect.arrayContaining(['target', 'agent:do', 'agent:merge', 'agent:resolve']));
    expect(v0.editableParams).not.toContain('prompt');
    expect(v0.editableParams).not.toContain('base');

    // a target edit is accepted and reflected in the view
    const applied = await handle.executeUpdate('updateParams', { args: [{ target: 'release' }] });
    expect(applied).toEqual({ applied: ['target'] });
    expect((await view(handle)).targetBranch).toBe('release');

    // the merge agent (runs later) can be swapped in-flight before its turn
    const appliedMerge = await handle.executeUpdate('updateParams', { args: [{ 'agent:merge': { provider: 'mock', model: 'mock' } }] });
    expect(appliedMerge).toEqual({ applied: ['agent:merge'] });

    // the Do agent's model/effort CAN be retuned in-flight — it lands on the next turn
    const appliedDo = await handle.executeUpdate('updateParams', { args: [{ 'agent:do': { provider: 'mock', model: 'mock-fast', effort: 'high' } }] });
    expect(appliedDo).toEqual({ applied: ['agent:do'] });

    // fields already used are REJECTED (a real update rejection, not a silent no-op)
    await expect(handle.executeUpdate('updateParams', { args: [{ prompt: 'nope' }] })).rejects.toThrow();
    await expect(handle.executeUpdate('updateParams', { args: [{ base: 'other' }] })).rejects.toThrow();
    // but the Do agent's IDENTITY (provider) is frozen mid-flight — retune, don't swap
    await expect(handle.executeUpdate('updateParams', { args: [{ 'agent:do': { provider: 'codex' } }] })).rejects.toThrow();

    // confirm → the EDITED target is what actually gets merged into
    await handle.signal('confirm');
    const result = await handle.result();
    expect(result.stage).toBe('done');
    const onRelease = await git(repo, ['show', 'release:feat.txt']);
    expect(onRelease.code).toBe(0);
    expect(onRelease.stdout).toContain('hello');
    const onMain = await git(repo, ['show', 'main:feat.txt']);
    expect(onMain.code).not.toBe(0); // the work did NOT land on the original target

    // past the point of no return: no edits accepted
    await expect(handle.executeUpdate('updateParams', { args: [{ target: 'x' }] })).rejects.toThrow();
  });

  it('a Do-agent model/effort retune lands on the NEXT turn (a follow-up), not the running one', async () => {
    const repo = await h.makeRepo('paramedit-do');
    const taskId = newId('task');
    // Turn one echoes its model/effort, then parks at Review awaiting a follow-up.
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [input({ taskId, repo, prompt: '@profile\n@review turn-one' })],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');

    // The first turn ran on the pinned default (model undefined on the bare spec).
    const doMsgs1 = (await view(handle)).transcripts.find((t: any) => t.role === 'do').messages;
    expect(doMsgs1.some((m: any) => m.text.includes('profile: (none)/(none)'))).toBe(true);

    // Retune the Do agent mid-flight — provider stays 'mock', model/effort change.
    const applied = await handle.executeUpdate('updateParams', {
      args: [{ 'agent:do': { provider: 'mock', model: 'mock-turbo', effort: 'high' } }],
    });
    expect(applied).toEqual({ applied: ['agent:do'] });

    // A follow-up re-enters Do; that turn must run on the NEW model/effort.
    await handle.signal('followUp', { id: 'f1', role: 'user', text: '@profile\n@review turn-two', ts: 0 }, 'do');
    await expect
      .poll(
        async () => {
          const doMsgs = (await view(handle)).transcripts.find((t: any) => t.role === 'do')?.messages ?? [];
          return doMsgs.some((m: any) => m.text.includes('profile: mock-turbo/high'));
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    await handle.signal('confirm');
    expect((await handle.result()).stage).toBe('done');
  });

  it('the setTarget shim keeps its legacy boolean contract', async () => {
    const repo = await h.makeRepo('paramedit2');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [input({ taskId, repo, prompt: '@write a.txt :: x\n@review ok' })],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');
    expect(await handle.executeUpdate('setTarget', { args: ['dev'] })).toBe(true);
    expect((await view(handle)).targetBranch).toBe('dev');
    await handle.signal('confirm');
    await handle.result();
  });

  it('the assembler carries windows so an api-created task accepts target edits and errors on frozen', async () => {
    const repo = await h.makeRepo('paramedit3');
    const token = h.tokens.mint({
      taskId: 't',
      profileId: 'do',
      principal: 'user:a',
      ceiling: ['create-task', 'edit-task', 'read-task', 'signal-task'],
      grantorCaps: ['create-task', 'edit-task', 'read-task', 'signal-task'],
    }).token;
    const project = h.store.createProject('P', { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false });
    const task = await h.api.createTask(token, {
      projectId: project.id,
      workflow: 'software-dev',
      prompt: '@write b.txt :: y\n@review ok',
    });
    const handle = h.client.workflow.getHandle(task.id);
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');

    // target edit accepted through the api (validates assembleTaskInput → paramWindows)
    const r = await h.api.updateParams(token, task.id, { target: 'staging' });
    expect(r.applied).toEqual(['target']);
    expect((await view(handle)).targetBranch).toBe('staging');

    // a frozen field throws with a readable reason (the gateway maps this to 409)
    await expect(h.api.updateParams(token, task.id, { prompt: 'redirect me' })).rejects.toThrow(/edited now|frozen/i);

    await handle.signal('confirm');
    await handle.result();
    const onStaging = await git(repo, ['show', 'staging:b.txt']);
    expect(onStaging.stdout).toContain('y');
  });
});
