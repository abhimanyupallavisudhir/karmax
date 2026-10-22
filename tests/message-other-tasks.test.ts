import { expect, it, onTestFinished, vi } from 'vitest';
import { AuthorizationService, projectScope } from '../src/platform/authorization.js';
import { SHIPPED_BUILTIN_PROFILES } from '../src/platform/builtin-profile-history.js';
import { allows } from '../src/platform/capabilities.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { Store } from '../src/store/db.js';

// A Developer's task agent could message only its own tasks and its sub-task
// tree: asking the agent of a teammate's task in the same project (to agree an
// interface, hand over a finding, ask it to rebase) was refused for want of
// task:conversation:message. Developers — people and their agents alike — now
// hold it for every task of their projects; the task's lifecycle stays its owner's.
it('a Developer\'s agent messages any task of its project, and does nothing else to it', async () => {
  const store = await Store.create(':memory:');
  onTestFinished(async () => store.close());
  const authz = await AuthorizationService.create(store);
  const project = await store.createProject('Shared');
  const elsewhere = await store.createProject('Elsewhere');
  for (const [principalId, profileId] of [['user:dev', 'developer'], ['user:viewer', 'viewer']] as const)
    await authz.grant('root', { principalId, scopeKey: projectScope(project.id), profileId });
  const create = (projectId: string, title: string) => store.createTask({ projectId, title,
    workflow: 'software-dev', workflowVersion: '1.30.0', params: { prompt: title } as any });
  const mine = await create(project.id, 'Mine');
  const theirs = await create(project.id, 'Theirs');
  const foreign = await create(elsewhere.id, 'Foreign');
  const view = { title: 'x', workflow: 'software-dev', stage: 'do', status: 'active', messages: [], actions: [], state: {}, updatedAt: 1 };
  for (const task of [theirs, foreign]) await store.saveView(task.id, { ...view, taskId: task.id } as any);

  const tokens = new TokenAuthority(store);
  // How an agent's token is minted: its role's ceiling, attenuated by the
  // authority of the person whose task it is.
  const agentOf = async (principal: string) => (await tokens.mint({ taskId: mine.id, profileId: 'do', role: 'do', principal,
    projectId: project.id, ceiling: ['task:*', 'project:*'], grantorCaps: await authz.capabilities(principal, project.id) })).token;
  const signal = vi.fn(async () => undefined);
  const api = new KarmaxApi({ store, client: { workflow: { getHandle: () => ({ signal }) } } as any, taskQueue: 'test', tokens });

  const developer = await agentOf('user:dev');
  const { message } = await api.messageAgent(developer, theirs.id, 'Let us agree the API shape');
  expect(signal).toHaveBeenCalledWith('followUp', message, undefined);
  // Said as that task, so the agent reading it knows who to answer.
  expect(message).toMatchObject({ text: 'Let us agree the API shape', author: `task:${mine.id}`, authorLabel: `Task #${mine.num}` });
  // Only messages: another task's settings and lifecycle stay its owner's.
  const may = async (token: string, capability: string, taskId: string, projectId = project.id) =>
    (await tokens.check(token, capability, { projectId, taskId })).ok;
  expect(await may(developer, 'task:signal', theirs.id)).toBe(false);
  expect(await may(developer, 'task:edit', theirs.id)).toBe(false);
  // Never across projects, and never for a Viewer's agent.
  await expect(api.messageAgent(developer, foreign.id, 'hi')).rejects.toThrow();
  await expect(api.messageAgent(await agentOf('user:viewer'), theirs.id, 'hi')).rejects.toThrow(/task:conversation:message/);
  expect(signal).toHaveBeenCalledTimes(1);

  // People hold exactly what their agents do.
  expect(allows(await authz.capabilities('user:dev', project.id), 'task:conversation:message')).toBe(true);
  expect(allows(await authz.capabilities('user:viewer', project.id), 'task:conversation:message')).toBe(false);
});

it('an untouched stored Developer profile gains messaging; a customized one is kept', async () => {
  const store = await Store.create(':memory:');
  onTestFinished(async () => store.close());
  const previous = [...SHIPPED_BUILTIN_PROFILES].reverse().find((version) => version.id === 'developer'
    && !version.capabilities.includes('task:conversation:message'))!;
  await store.setAuthorizationProfile('global', { ...previous, capabilities: [...previous.capabilities], builtin: true } as any);
  expect(allows((await (await AuthorizationService.create(store)).profile('developer'))!.capabilities, 'task:conversation:message')).toBe(true);

  const custom = previous.capabilities.filter((capability) => capability !== 'diagnostic:read');
  await store.setAuthorizationProfile('global', { ...previous, capabilities: custom, builtin: true } as any);
  expect((await (await AuthorizationService.create(store)).profile('developer'))!.capabilities).toEqual(custom);
});

// pramana#113: every agent of a person's task tree acts under that person's
// delegation, so its token names them as its human subject. A parent's agent
// messaging its sub-task was therefore said as the person ("Abhimanyu: …"),
// which made the person a speaker the sub-task's reply then mentioned, and
// answered the person's own mentions there as though they had spoken.
it("an agent acting for a person speaks as its task, never as the person", async () => {
  const store = await Store.create(':memory:');
  onTestFinished(async () => store.close());
  const authz = await AuthorizationService.create(store);
  const project = await store.createProject('Shared');
  await authz.grant('root', { principalId: 'user:owner', scopeKey: projectScope(project.id), profileId: 'developer' });
  const create = (title: string) => store.createTask({ projectId: project.id, title,
    workflow: 'software-dev', workflowVersion: '1.30.0', params: { prompt: title } as any });
  const parent = await create('Parent');
  const child = await create('Child');
  await store.saveView(child.id, { title: 'Child', workflow: 'software-dev', stage: 'do', status: 'active',
    messages: [], actions: [], state: {}, updatedAt: 1, taskId: child.id } as any);
  const tokens = new TokenAuthority(store);
  const person = (await tokens.mintPrincipal('user:owner', await authz.capabilities('user:owner', project.id), project.id)).token;
  // How a task the person queued mints its agent's token.
  const delegation = (await tokens.delegateHuman(person, { taskId: parent.id, projectId: project.id }))!;
  const agent = (await tokens.mint({ taskId: parent.id, profileId: 'do', role: 'do', principal: 'user:owner',
    projectId: project.id, ceiling: ['task:*', 'project:*'], grantorCaps: await authz.capabilities('user:owner', project.id),
    delegationId: delegation.id })).token;
  const signal = vi.fn(async () => undefined);
  const api = new KarmaxApi({ store, client: { workflow: { getHandle: () => ({ signal }) } } as any, taskQueue: 'test', tokens });
  const discharge = vi.spyOn(store, 'dischargeMentions');

  const asTask = { author: `task:${parent.id}`, authorLabel: `Task #${parent.num}` };
  expect((await api.messageAgent(agent, child.id, 'Rebase on my branch')).message).toMatchObject(asTask);
  expect((await api.postTaskMessage(agent, child.id, { text: 'Use the new schema', to: ['agent:do'] })).message).toMatchObject(asTask);
  expect(discharge).not.toHaveBeenCalled();
  // The person, speaking themselves, is still the person.
  expect((await api.postTaskMessage(person, child.id, { text: 'Ship it', to: ['agent:do'] })).message)
    .toMatchObject({ author: 'user:owner' });
  expect(discharge).toHaveBeenCalledWith(child.id, 'owner');
});
