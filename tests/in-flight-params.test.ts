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
    // `confirm` (the Review route) is `untilUsed` too — consumed by the gate it drives,
    // not by queueing, so it stays editable right up to the moment Review passes.
    paramWindows: {
      target: 'untilUsed' as const,
      confirm: 'untilUsed' as const,
      'agent:do': 'always' as const,
      'agent:merge': 'always' as const,
      'agent:resolve': 'always' as const,
    },
  };
}

const human = (...audience: string[]) => ({ kind: 'human' as const, audience });
/** Workflow input carrying an explicit Review route. */
const routed = (over: { taskId: string; repo: string; prompt: string }, layers: ReturnType<typeof human>[]) =>
  ({ ...input(over), confirm: { layers } });

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

  // ── the Review route (SPEC §5.2) ──
  // It is consumed by the gate it drives, not by queueing, so it stays editable while
  // the task runs — including while the gate is already parked on someone.

  it('re-routes a Review gate that is already parked, and waits on the NEW audience', async () => {
    const repo = await h.makeRepo('reroute');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [routed({ taskId, repo, prompt: '@write r.txt :: hi\n@review done' }, [human('@creator')])],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');
    await expect.poll(async () => (await view(handle)).waitingFor, { timeout: 10_000 })
      .toMatchObject({ kind: 'human', audience: ['@creator'] });

    const v0 = await view(handle);
    expect(v0.editableParams).toContain('confirm'); // NOT frozen at queue
    expect(v0.waitingFor).toMatchObject({ kind: 'human', audience: ['@creator'] });

    // The edit lands on the gate that is already parked — no restart, no lost work.
    expect(await handle.executeUpdate('updateParams', { args: [{ confirm: { layers: [human('@owners')] } }] }))
      .toEqual({ applied: ['confirm'] });
    await expect.poll(async () => (await view(handle)).waitingFor?.audience, { timeout: 10_000 }).toEqual(['@owners']);

    await handle.signal('confirm');
    expect((await handle.result()).stage).toBe('done');
  });

  it('emptying the route while the gate is parked auto-confirms it (the gate re-reads, not the queue)', async () => {
    const repo = await h.makeRepo('reroute-empty');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [routed({ taskId, repo, prompt: '@write e.txt :: hi\n@review done' }, [human('@creator')])],
    });
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');

    // No steps means auto-confirm — and nobody ever clicks Confirm here.
    expect(await handle.executeUpdate('updateParams', { args: [{ confirm: { layers: [] } }] }))
      .toEqual({ applied: ['confirm'] });
    expect((await handle.result()).stage).toBe('done');
    expect((await git(repo, ['show', 'main:e.txt'])).stdout).toContain('hi');
  });

  it('a re-route replays the gate from its FIRST layer — approvals under the old route are not credited', async () => {
    const repo = await h.makeRepo('reroute-replay');
    const taskId = newId('task');
    const handle = await h.client.workflow.start('softwareDev', {
      taskQueue: TASK_QUEUE,
      workflowId: taskId,
      args: [routed({ taskId, repo, prompt: '@write p.txt :: hi\n@review done' }, [human('@creator'), human('@creator')])],
    });
    const detail = async () => (await view(handle)).waitingFor?.detail;
    await expect.poll(detail, { timeout: 15_000 }).toBe('confirm layer 1/2');

    await handle.signal('confirm'); // layer 1 of the OLD route passes
    await expect.poll(detail, { timeout: 10_000 }).toBe('confirm layer 2/2');

    // Swap in a three-layer route: the banked click was for a gate that no longer
    // exists, so the new route plays from its first layer.
    await handle.executeUpdate('updateParams', { args: [{ confirm: { layers: [human('@creator'), human('@creator'), human('@creator')] } }] });
    await expect.poll(detail, { timeout: 10_000 }).toBe('confirm layer 1/3');

    await handle.signal('confirm');
    await expect.poll(detail, { timeout: 10_000 }).toBe('confirm layer 2/3');
    await handle.signal('confirm');
    await expect.poll(detail, { timeout: 10_000 }).toBe('confirm layer 3/3');
    await handle.signal('confirm');
    expect((await handle.result()).stage).toBe('done');
  });

  it('a re-route through the api validates the audience and re-shares it with every attempt', async () => {
    const repo = await h.makeRepo('reroute-api');
    // assertHumanRoutes only bites once the organization actually has people.
    const organization = h.store.createOrganization({ name: 'Acme reroute', ownerUserId: 'owner' });
    const project = h.store.createProject('P', { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false }, organization.id);
    const token = h.tokens.mint({
      taskId: 't', profileId: 'do', principal: 'user:owner',
      ceiling: ['create-task', 'edit-task', 'read-task', 'signal-task'],
      grantorCaps: ['create-task', 'edit-task', 'read-task', 'signal-task'],
    }).token;
    const task = await h.api.createTask(token, {
      projectId: project.id, workflow: 'software-dev', prompt: '@write s.txt :: hi\n@review ok',
    });
    const handle = h.client.workflow.getHandle(task.id);
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');

    // A route nobody can see is rejected platform-side: the deterministic sandbox
    // cannot answer "is user:ghost a human here?", so the gate must never park on one.
    await expect(h.api.updateParams(token, task.id, { confirm: { layers: [human('user:ghost')] } }))
      .rejects.toThrow(/does not resolve to a human/i);
    await expect.poll(async () => (await view(handle)).waitingFor?.audience, { timeout: 10_000 })
      .toEqual(['@creator']); // untouched

    const applied = await h.api.updateParams(token, task.id, { confirm: { layers: [] } });
    expect(applied.applied).toEqual(['confirm']);
    // The route belongs to the logical task, so the shared snapshot moved with it.
    expect(h.store.attemptGroup(task.id)?.confirmer).toEqual({ layers: [] });

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
      prompt: '@write b.txt :: y\n@review ok\n@incomplete',
    });
    const handle = h.client.workflow.getHandle(task.id);
    await expect.poll(async () => {
      const current = await view(handle);
      return `${current.stage}/${current.status}`;
    }, { timeout: 15_000 }).toBe('do/waiting');

    // Target remains editable while Do is waiting and no proposal exists.
    const r = await h.api.updateParams(token, task.id, { target: 'staging' });
    expect(r.applied).toEqual(['target']);
    expect((await view(handle)).targetBranch).toBe('staging');

    await handle.signal('openPr');
    await expect.poll(async () => (await view(handle)).stage, { timeout: 15_000 }).toBe('review');
    // Review is bound to an already-open target/head, so retargeting now is a
    // new proposal and must not mutate this one in place.
    await expect(h.api.updateParams(token, task.id, { target: 'other' })).rejects.toThrow(/edited now|frozen/i);

    // A workflow-accepted agent retune updates the platform's effective-agent
    // snapshot too, so the task page cannot keep showing the queue-time model.
    const tuned = await h.api.updateParams(token, task.id, { 'agent:do': { provider: 'mock', model: 'mock-next', effort: 'high' } });
    expect(tuned.applied).toEqual(['agent:do']);
    expect((await h.api.getTaskView(token, task.id, { live: true }))?.agents?.do).toEqual({ provider: 'mock', model: 'mock-next', effort: 'high' });

    // a frozen field throws with a readable reason (the gateway maps this to 409)
    await expect(h.api.updateParams(token, task.id, { prompt: 'redirect me' })).rejects.toThrow(/edited now|frozen/i);

    await handle.signal('confirm');
    await handle.result();
    const onStaging = await git(repo, ['show', 'staging:b.txt']);
    expect(onStaging.stdout).toContain('y');
  });
});
