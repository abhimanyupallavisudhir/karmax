import { afterEach, expect, it, vi } from 'vitest';
import { Context } from '@temporalio/activity';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { TOOL_SCHEMAS, platformToolHandlers } from '../src/agent/tools.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';

afterEach(() => { vi.restoreAllMocks(); });

// PL-11: create_sub_task used to take only a title and a prompt, so a child
// always ran its parent's agent. An agent wanting a batch on another provider
// had to create detached tasks with create_task, losing the parent's
// supervision (#367 did exactly that for #368–#381). The tool now takes
// create_task's `params`, merged over what the child inherits.

/** A parent whose Do agent is a Claude profile, with fake adapters that record
 * which provider and model each turn really ran on. Nothing reaches a model. */
async function fixture() {
  const store = await Store.create(':memory:');
  const project = await store.createProject('Sub-task params');
  await store.upsertProfile({ id: 'parent-claude', name: 'Parent', role: 'do', provider: 'claude', model: 'claude-parent' });
  const parent = await store.createTask({ projectId: project.id, title: 'Parent', workflow: 'software-dev',
    workflowVersion: '1.26.0', params: { prompt: 'work' } as any });
  const worlds = new WorldRegistry();
  const worldsToClose: { destroy(): Promise<void> }[] = [];
  let activityId = 'turn';
  vi.spyOn(Context, 'current').mockImplementation(() => ({
    info: { attempt: 1, activityId, workflowExecution: { workflowId: parent.id, runId: 'run' } },
    cancellationSignal: new AbortController().signal, heartbeat: () => {},
  }) as any);
  const ran: { taskId: string; provider: string; model?: string; effort?: string }[] = [];
  const toolResults: string[] = [];
  let parentCalls: Record<string, unknown>[] = [];
  const adapter = (provider: 'claude' | 'codex') => ({
    provider,
    async runTurn(input: any, ctx: any) {
      ran.push({ taskId: input.world.handle.id, provider: input.profile.provider, model: input.profile.model, effort: input.profile.effort });
      // The parent's agent calls the real tool handler, as every rail does.
      if (input.world.handle.id === parent.id) {
        const tools = platformToolHandlers(input.world, ctx);
        for (const call of parentCalls) {
          try { toolResults.push(await tools.create_sub_task!(call)); }
          catch (error) { toolResults.push(`error: ${(error as Error).message}`); }
        }
      }
      return { termination: { kind: 'success', status: 'end_turn' }, output: 'done' };
    },
  });
  const core = makeCoreActivities({ store, worlds,
    adapters: new Map([['claude', adapter('claude')], ['codex', adapter('codex')]]) as any,
    profiles: new ProfileResolver(store, 'claude') });
  const turn = async (taskId: string, task: any) => {
    const world = await worlds.create('memory', { taskId, base: 'main' });
    worldsToClose.push(world);
    activityId = `turn-${taskId}`;
    return core.runAgentTurn({ taskId, role: 'do', agentTurnId: `${taskId}#0`, agentSlotGranted: true, worldHandle: world.handle,
      messages: [{ id: 'm0', role: 'user', text: task.prompt, ts: 0 }], task } as any);
  };
  const parentInput = { taskId: parent.id, projectId: project.id, title: 'Parent', prompt: 'work', project: {},
    workflow: 'software-dev', profiles: { do: 'parent-claude' } };
  /** Run the parent's turn with these create_sub_task calls, then spawn what it queued
   *  exactly as software-dev's spawnSubTasks does, and run each child's Do turn. */
  const spawn = async (calls: Record<string, unknown>[]) => {
    parentCalls = calls;
    const result = await turn(parent.id, parentInput);
    const children = [];
    for (const [index, s] of (result.subTasks ?? []).entries()) {
      activityId = `prepare-${index}`;
      const child = await core.prepareChildTask({ parentTaskId: parent.id, projectId: project.id, title: s.title, prompt: s.prompt,
        base: 'parent-branch', target: 'parent-branch', project: {}, profiles: parentInput.profiles, parentBranch: 'parent-branch',
        ...(s.params ? { params: s.params } : {}) });
      await turn(child.taskId, child);
      children.push(child);
    }
    return { result, children };
  };
  const close = async () => { for (const world of worldsToClose) await world.destroy(); await store.close(); };
  return { store, project, parent, ran, toolResults, spawn, close };
}

it('PL-11: create_sub_task params choosing another agent spawn a child whose Do stage runs that agent', async () => {
  const f = await fixture();
  try {
    const { result, children } = await f.spawn([{ title: 'Batch', prompt: 'on codex',
      params: { 'agent:do': { provider: 'codex', model: 'gpt-5.5', effort: 'high' } } }]);
    expect(f.toolResults[0]).toMatch(/^sub-task queued/);
    expect(result.subTasks).toEqual([{ title: 'Batch', prompt: 'on codex',
      params: { 'agent:do': { provider: 'codex', model: 'gpt-5.5', effort: 'high' } } }]);
    const [child] = children;
    expect(f.ran.find((r) => r.taskId === child!.taskId)).toEqual(
      { taskId: child!.taskId, provider: 'codex', model: 'gpt-5.5', effort: 'high' });
    // The choice is the child's own task-form value, so the task record (and a
    // restarted run, which re-resolves it) keeps it.
    expect((await f.store.getTask(child!.taskId))!.params['agent:do']).toEqual({ provider: 'codex', model: 'gpt-5.5', effort: 'high' });
    // Authorization is unchanged: the parent's branch and the inherited grant.
    expect(child).toMatchObject({ base: 'parent-branch', target: 'parent-branch', parentTaskId: f.parent.id,
      grantPrincipal: `task:${f.parent.id}`, authorizationProfile: 'inherited-child' });
  } finally { await f.close(); }
});

it('PL-11: a child created without params still inherits its parent\'s agent', async () => {
  const f = await fixture();
  try {
    const { result, children } = await f.spawn([{ title: 'Same agent', prompt: 'inherit' }]);
    expect(result.subTasks).toEqual([{ title: 'Same agent', prompt: 'inherit' }]);
    const [child] = children;
    expect(child!.agents).toBeUndefined();
    expect(f.ran.find((r) => r.taskId === child!.taskId)).toMatchObject({ provider: 'claude', model: 'claude-parent' });
    expect((await f.store.getTask(child!.taskId))!.params['agent:do']).toBeUndefined();
  } finally { await f.close(); }
});

it('PL-11: an invalid or unavailable agent, or a field a sub-task cannot set, is refused with a tool error and no child is created', async () => {
  const f = await fixture();
  try {
    await f.store.setOrganizationUsagePolicy(f.project.organizationId ?? 'org_personal', { allowedModels: ['gpt-5.5', 'claude-parent'] });
    const refused: [Record<string, unknown>, RegExp][] = [
      [{ 'agent:do': { provider: 'gemini' } }, /unknown agent provider "gemini"/],
      [{ 'agent:do': { provider: 'codex', effort: 'extreme' } }, /invalid reasoning effort "extreme"/],
      [{ 'agent:do': { provider: 'codex', model: 'o3' } }, /model o3 is not allowed by the organization/],
      [{ 'agent:do': { avatarId: 'avatar_missing' } }, /the selected Avatar is not available in this project/],
      [{ 'agent:do': { provider: 'codex', resumeFrom: { taskId: f.parent.id } } }, /"resumeFrom" cannot be set on a sub-task/],
      [{ 'agent:do': 'codex' }, /"agent:do" must be an agent spec/],
      [{ agent: { provider: 'codex' } }, /unknown field "agent"/],
      [{ base: 'elsewhere' }, /"base" cannot be set on a sub-task/],
      [{ target: 'main' }, /"target" cannot be set on a sub-task/],
      [{ confirm: { layers: [] } }, /"confirm" cannot be set on a sub-task/],
      [{ _authorization: { capabilities: ['*'] } }, /unknown field "_authorization"/],
    ];
    const { result } = await f.spawn(refused.map(([params], index) => ({ title: `Bad ${index}`, prompt: 'x', params })));
    expect(f.toolResults).toHaveLength(refused.length);
    refused.forEach(([, message], index) => expect(f.toolResults[index]).toMatch(message));
    expect(result.subTasks).toBeUndefined();
    expect(await f.store.childTasks(f.parent.id)).toEqual([]);
  } finally { await f.close(); }
});

it('PL-11: create_sub_task advertises the same params as create_task', () => {
  const schema = TOOL_SCHEMAS.find((tool) => tool.name === 'create_sub_task')!;
  expect(schema.parameters.properties.params).toMatchObject({ type: 'object' });
  expect(schema.parameters.required).toEqual(['title', 'prompt']);
  expect(schema.description).toMatch(/params/);
});

it('PL-11: create_task refuses the same invalid agent before creating anything', async () => {
  const store = await Store.create(':memory:');
  try {
    const project = await store.createProject('Create task');
    const tokens = new TokenAuthority();
    const token = (await tokens.mintPrincipal('user:test', ['*'], project.id)).token;
    const starts: unknown[] = [];
    const api = new KarmaxApi({ store, client: { workflow: { start: async (...args: unknown[]) => { starts.push(args); } } } as any,
      taskQueue: 'test', tokens });
    await expect(api.createTask(token, { projectId: project.id, title: 'Bad', prompt: 'x',
      params: { 'agent:do': { provider: 'gemini' } } })).rejects.toThrow(/unknown agent provider "gemini"/);
    expect(starts).toEqual([]);
    expect(await store.listTasks(project.id)).toEqual([]);
  } finally { await store.close(); }
});
