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
    // target until PR/merge; merge & resolve agents until their turn runs (SPEC §5.5).
    paramWindows: { target: 'untilUsed' as const, 'agent:merge': 'untilUsed' as const, 'agent:resolve': 'untilUsed' as const },
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

    // the view advertises target + the not-yet-run merge/resolve agents as editable,
    // and NOT the fields already used (prompt, base, the running Do agent)
    const v0 = await view(handle);
    expect(v0.editableParams).toEqual(expect.arrayContaining(['target', 'agent:merge', 'agent:resolve']));
    expect(v0.editableParams).not.toContain('prompt');
    expect(v0.editableParams).not.toContain('base');
    expect(v0.editableParams).not.toContain('agent:do');

    // a target edit is accepted and reflected in the view
    const applied = await handle.executeUpdate('updateParams', { args: [{ target: 'release' }] });
    expect(applied).toEqual({ applied: ['target'] });
    expect((await view(handle)).targetBranch).toBe('release');

    // the merge agent (runs later) can be swapped in-flight before its turn
    const appliedMerge = await handle.executeUpdate('updateParams', { args: [{ 'agent:merge': { provider: 'mock', model: 'mock' } }] });
    expect(appliedMerge).toEqual({ applied: ['agent:merge'] });

    // fields already used are REJECTED (a real update rejection, not a silent no-op)
    await expect(handle.executeUpdate('updateParams', { args: [{ prompt: 'nope' }] })).rejects.toThrow();
    await expect(handle.executeUpdate('updateParams', { args: [{ base: 'other' }] })).rejects.toThrow();
    await expect(handle.executeUpdate('updateParams', { args: [{ 'agent:do': { provider: 'mock' } }] })).rejects.toThrow();

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
