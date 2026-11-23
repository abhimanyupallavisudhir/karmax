import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { AuthorizationService, projectScope } from '../src/platform/authorization.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { ownSubTaskResponses } from '../src/activities/core.js';
import { applicableSubTaskActions } from '../src/domain/sub-task-responses.js';
import { platformToolHandlers, TOOL_SCHEMAS } from '../src/agent/tools.js';
import { GLOBAL_INSTRUCTIONS } from '../src/agent/instructions.js';
import { assembleTaskInput } from '../src/platform/params.js';
import { manifest } from '../src/contrib/manifests.js';

/**
 * A task an agent creates is reviewed by that agent (ConfirmLayer.live) — not
 * by the person it works for, whatever the project's Task defaults say — unless
 * the agent routes its Review itself. Pramana#205: agent-created tasks went to
 * the user, because `@creator` follows the chain of creators to a person.
 */
async function fixture() {
  const store = await Store.create(':memory:');
  const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
  const project = await store.createProject('Site', {}, organization.id);
  const authorization = await AuthorizationService.create(store);
  await authorization.bootstrapOrganizationOwner('system:test', 'owner', organization.id);
  await store.setOrganizationMembership(organization.id, 'dev', 'member');
  await authorization.grant('system:test', { principalId: 'user:dev', scopeKey: projectScope(project.id), profileId: 'developer' });
  const tokens = new TokenAuthority(store);
  const client = { workflow: {
    getHandle: () => ({ executeUpdate: async () => undefined, query: async () => { throw new Error('no live query'); },
      describe: async () => ({ runId: 'run', status: { name: 'RUNNING' } }), signal: async () => undefined }),
    start: async () => ({}),
  } } as any;
  const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, authorization });
  const creator = await store.createTask({ projectId: project.id, title: 'Creator', workflow: 'software-dev',
    workflowVersion: '1.30.0', createdBy: { kind: 'user', userId: 'dev' }, params: { prompt: 'work' } });
  await store.db.prepare('UPDATE tasks SET lastView=? WHERE id=?').run(JSON.stringify({ stage: 'do', status: 'active',
    participants: [{ key: 'do', label: 'Agent', role: 'do', state: 'running', messages: 1,
      spec: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' } }] }), creator.id);
  const held = await authorization.capabilities('user:dev', project.id, organization.id);
  const agent = async (participant = 'do') => (await tokens.mint({ taskId: creator.id, profileId: 'do', role: participant === 'do' ? 'do' : 'agent',
    participant, principal: `task-agent:${creator.id}:do`, projectId: project.id, organizationId: organization.id,
    ceiling: held, grantorCaps: held })).token;
  const human = async () => (await tokens.mintPrincipal('user:dev', held, project.id, undefined, organization.id)).token;
  return { store, project, api, creator, agent, human };
}

const creatorLayer = (taskId: string, role = 'do') =>
  ({ kind: 'agent', provider: 'claude', model: 'claude-opus-5-5', effort: 'high', resumeFrom: { taskId, role }, live: true });

describe('the Review of a task an agent creates', () => {
  it('is the agent that created it, with its own harness, model and effort', async () => {
    const f = await fixture();
    const task = await f.api.createTask(await f.agent(), { projectId: f.project.id, prompt: 'follow up', holdForAuthorization: true });
    expect(task.params.confirm).toEqual({ layers: [creatorLayer(f.creator.id)] });
    expect(task.createdBy).toEqual({ kind: 'task-agent', taskId: f.creator.id, role: 'do' });
  });

  it('overrides the project\'s Task defaults, which are written for people\'s tasks', async () => {
    const f = await fixture();
    await f.store.setSettings(f.project.id, 'software-dev', { confirm: { layers: [{ kind: 'human', audience: ['@maintainers'] }] } });
    const task = await f.api.createTask(await f.agent(), { projectId: f.project.id, prompt: 'follow up' });
    expect(task.params.confirm).toEqual({ layers: [creatorLayer(f.creator.id)] });
  });

  it('is whatever the agent routes it to, people or nobody', async () => {
    const f = await fixture();
    const people = { layers: [{ kind: 'human', audience: ['@creator'] }] };
    expect((await f.api.createTask(await f.agent(), { projectId: f.project.id, prompt: 'x', params: { confirm: people } })).params.confirm).toEqual(people);
    expect((await f.api.createTask(await f.agent(), { projectId: f.project.id, prompt: 'x', params: { confirm: { layers: [] } } })).params.confirm)
      .toEqual({ layers: [] });
  });

  it('names the agent of the task that created it, not its main agent, when another agent of it does', async () => {
    const f = await fixture();
    const task = await f.api.createTask(await f.agent('agent-2'), { projectId: f.project.id, prompt: 'x' });
    expect((task.params.confirm as any).layers[0]).toMatchObject({ kind: 'agent', resumeFrom: { taskId: f.creator.id, role: 'agent-2' }, live: true });
  });

  it('is left to the defaults for a person', async () => {
    const f = await fixture();
    const task = await f.api.createTask(await f.human(), { projectId: f.project.id, prompt: 'mine' });
    expect(task.params.confirm).toBeUndefined();
  });

  it('reaches the workflow with `live` only for a layer that forks a task', () => {
    const fields = { confirm: { layers: [creatorLayer('task_c'), { kind: 'agent', provider: 'claude', live: true }] } };
    const input = assembleTaskInput(manifest('software-dev')!, { prompt: 'x', ...fields } as any,
      { taskId: 't', projectId: 'p', title: 'T', project: { repos: [] } as any });
    expect(input.confirm?.layers).toEqual([creatorLayer('task_c'), { kind: 'agent', provider: 'claude' }]);
  });
});

describe('answering a task that waits for your review', () => {
  it('reaches the task only while it waits for the answering task', async () => {
    const store = await Store.create(':memory:');
    const project = await store.createProject('P', {});
    const reviewer = await store.createTask({ projectId: project.id, title: 'Creator', workflow: 'software-dev', workflowVersion: '1.30.0', params: { prompt: 'x' } });
    const created = await store.createTask({ projectId: project.id, title: 'Created', workflow: 'software-dev', workflowVersion: '1.30.0', params: { prompt: 'x' } });
    const waitOn = (reviewerTask: string) => store.db.prepare('UPDATE tasks SET lastView=? WHERE id=?')
      .run(JSON.stringify({ stage: 'review', status: 'waiting', waitingFor: { kind: 'confirm', reviewerTask } }), created.id);
    await waitOn(reviewer.id);
    expect(await ownSubTaskResponses(store, reviewer.id, [{ childTaskId: created.id, action: 'confirm' }]))
      .toEqual({ kept: [{ childTaskId: created.id, action: 'confirm' }], refused: [] });
    await waitOn('task_someone_else');
    expect(await ownSubTaskResponses(store, reviewer.id, [{ childTaskId: created.id, action: 'confirm' }]))
      .toEqual({ refused: [created.id] });
  });

  it('offers the verdicts on Review, and refuses at once when the task does not wait for you', async () => {
    const waiting = { stage: 'review', status: 'waiting', waitingFor: { kind: 'confirm', reviewerTask: 'task' } };
    expect(applicableSubTaskActions(waiting)).toEqual(['confirm', 'comment', 'cancel']);
    let target: Record<string, unknown> = { ...waiting };
    const responses: unknown[] = [];
    const handlers = platformToolHandlers({ handle: { id: 'task', root: '/w', branch: 'b', base: 'main' } } as any,
      { respondToSubTask: (r: unknown) => { responses.push(r); }, platformRequest: async () => target } as any);
    expect(await handlers.respond_to_sub_task!({ action: 'retry', child_task_id: 'created' })).toMatch(/does not apply now.*confirm \| comment \| cancel/);
    expect(await handlers.respond_to_sub_task!({ action: 'confirm', child_task_id: 'created' })).toMatch(/confirm queued/);
    expect(responses).toEqual([{ childTaskId: 'created', action: 'confirm', text: undefined }]);
    target = { ...waiting, waitingFor: { kind: 'confirm', reviewerTask: 'another' } };
    expect(await handlers.respond_to_sub_task!({ action: 'confirm', child_task_id: 'created' })).toMatch(/not waiting for this task's review/);
    expect(responses).toHaveLength(1);
  });

  it('is what agents are told about the tasks they create', () => {
    const createTask = TOOL_SCHEMAS.find((tool) => tool.name === 'create_task')!;
    expect(createTask.description).toMatch(/Its Review comes to you.*params\.confirm/);
    expect(TOOL_SCHEMAS.find((tool) => tool.name === 'respond_to_sub_task')!.description).toMatch(/a task you created that asks for your review/);
    expect(GLOBAL_INSTRUCTIONS).not.toMatch(/add a fork of yourself as the reviewer/);
    expect(GLOBAL_INSTRUCTIONS).toMatch(/a task you create comes to you for Review while you still work, and to a fork of you once you have finished/);
  });
});
